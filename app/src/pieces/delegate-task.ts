// src/pieces/delegate-task.ts
//
// `delegate_task` capability — spawn a short-lived AISession in a cheap
// model, run an exploratory/read task, capture the answer, kill the session.
//
// The KEY behavior: the main caller's session never loads raw tool_results
// from the worker. The main session only sees the worker's final summary as
// the capability result (~hundreds of tokens), instead of the tens of
// thousands of tokens the raw read_file/grep would produce.
//
// This is the highest-ROI optimization in the cost-reduction mission:
//   - Worker runs in Sonnet/Haiku (configurable per call) — base cost is low.
//   - Worker's context dies with the worker — no recurring cache_read in main.
//   - Main session keeps its sticky model intact (this is NOT a switch).
//
// Design choices:
//   - Uses the existing AnthropicSessionFactory.createWithPrompt() — same
//     code path as plugin-owned sessions. The worker IS registered in SessionManager
//     so its history survives for inspection via the HUD panel (click ⤢ on the
//     delegate block). Session is marked ephemeral=true so it is NOT persisted
//     to disk. Cleanup: removed from SessionManager when the HUD panel is closed
//     OR when the session has been idle for DELEGATE_IDLE_CLEANUP_MS.
//   - Tools available to the worker = same tool registry as the main session.
//     The role's system prompt should constrain the worker to read-only ops
//     (default role comes from settings delegate.defaultRole; fallback "generic").
//   - Tool calls inside the worker still flow through the bus normally
//     (capability.request / capability.result), so file reads, greps, etc.
//     work the same as in main.
//
// Limitations:
//   - Anthropic-only (uses AnthropicSessionFactory directly). OpenAI provider
//     would need its own implementation if/when we add this there.
//   - Worker has no isolation guard: if you grant `Edit` tools, it CAN write
//     files. The role system prompt is what enforces read-only behavior.

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Piece } from "../core/piece.js";
import type { EventBus } from "../core/bus.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { AISessionFactory } from "../ai/types.js";
import type { SessionManager } from "../core/session-manager.js";
import { AnthropicSessionFactory } from "../ai/anthropic/factory.js";
import { getProviderForModel } from "../config/index.js";
import { load as loadSettings } from "../core/settings.js";
import { log } from "../logger/index.js";

/** Worker sessions idle longer than this are auto-evicted from SessionManager. */
const DELEGATE_IDLE_CLEANUP_MS = 10 * 60 * 1000; // 10 minutes

export interface DelegateTaskOptions {
  /** Provides the AI factory — re-resolved on each call so model swaps stick. */
  getFactory: () => AISessionFactory;
  /** Provides the factory for a specific model (cross-provider delegates). */
  getFactoryForModel?: (model: string) => AISessionFactory;
  /** Capability registry — used to execute tools the worker calls. */
  registry: CapabilityRegistry;
  /** Roles directory — defaults to ~/.jarvis/roles */
  rolesDir?: string;
  /** SessionManager — used to register workers so HUD can open their chat.
   *  Optional: if not provided, workers remain unregistered (old behavior). */
  sessions?: SessionManager;
}



interface RoleDefinition {
  id: string;
  name?: string;
  description?: string;
  preferred_model?: string;
  body: string;
}

/** Read a role file (~/.jarvis/roles/<id>.md). Returns null if not found. */
function loadRole(roleId: string, rolesDir: string): RoleDefinition | null {
  const path = join(rolesDir, `${roleId}.md`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    // Naive YAML frontmatter parse (--- ... ---)
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) {
      return { id: roleId, body: raw };
    }
    const [, yaml, body] = m;
    const meta: Record<string, string> = {};
    for (const line of yaml.split("\n")) {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    return {
      id: roleId,
      name: meta.name,
      description: meta.description,
      preferred_model: meta.preferred_model,
      body: body.trim(),
    };
  } catch (err) {
    log.warn({ roleId, err }, "DelegateTask: role load failed");
    return null;
  }
}

export interface DelegateRunOptions {
  task: string;
  role?: string;
  model?: string;
  fire_and_forget?: boolean;
}

export class DelegateTaskPiece implements Piece {
  readonly id = "delegate-task";
  readonly name = "DelegateTask";

  private opts: DelegateTaskOptions;
  private rolesDir: string;
  private bus!: EventBus;
  /** workerLabel → cleanup timer handle. */
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: DelegateTaskOptions) {
    this.opts = opts;
    this.rolesDir = opts.rolesDir ?? join(homedir(), ".jarvis", "roles");
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.opts.registry.register({
      name: "delegate_task",
      description:
        "Delegate a task to an ephemeral worker running in a CHEAPER model. " +
        "Use when you need to run tools, read large files, explore code, or execute multi-step work WITHOUT loading the raw content into your own context. " +
        "The worker runs autonomously in ITS OWN context, then returns a summary. " +
        "Your main session never pays cache for the raw bytes. " +
        "Set fire_and_forget=true to return immediately without waiting for the result (use for background tasks). " +
        "Examples: " +
        "(1) summarize a 5000-line file's responsibility. " +
        "(2) find all callers of a function across a codebase. " +
        "(3) review a PR and post results to Slack. " +
        "(4) run a long investigation in the background.",
      input_schema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Clear, self-contained task description for the worker. Be specific about WHAT you want as the final answer — the worker only returns text.",
          },
          model: {
            type: "string",
            description: "Optional model override. Use 'haiku' for trivial extraction, 'sonnet' for default exploration, full model id for control. Defaults to role's preferred_model or 'claude-sonnet-4-6'.",
          },
          role: {
            type: "string",
            description: "Optional role to use as the worker's system prompt (file in ~/.jarvis/roles/). Defaults to settings delegate.defaultRole (fallback 'generic').",
          },
          fire_and_forget: {
            type: "boolean",
            description: "If true, return immediately without waiting for the worker to finish. Use for background tasks where you don't need the result inline.",
          },
        },
        required: ["task"],
      },
      handler: async (input) => this.handleDelegate(input),
    });
    log.info("DelegateTask: registered delegate_task capability");
  }

  async stop(): Promise<void> {
    // Cancel all pending cleanup timers.
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
  }

  /** Public API — callable by other pieces (e.g. CronPiece in delegate mode). */
  async runDelegate(opts: DelegateRunOptions): Promise<{ summary: string; error?: string }> {
    const result = await this.handleDelegate({
      task: opts.task,
      role: opts.role,
      model: opts.model,
      fire_and_forget: opts.fire_and_forget,
    }) as any;
    return {
      summary: result.summary ?? result.partialOutput ?? "",
      error: result.error,
    };
  }

  private async handleDelegate(input: Record<string, unknown>): Promise<unknown> {
    const task = String(input.task ?? "").trim();
    if (!task) return { error: "task is required" };

    // Default role: settings-driven (settings.user.json → delegate.defaultRole)
    // with a stack-agnostic fallback. Personal role names must never be
    // hardcoded in core (F3.13).
    const roleId = String(input.role ?? loadSettings().delegate?.defaultRole ?? "generic");
    const modelArg = input.model ? String(input.model) : undefined;
    const fireAndForget = Boolean(input.fire_and_forget);

    const role = loadRole(roleId, this.rolesDir);
    if (!role) {
      return { error: `Unknown role: ${roleId}. Place a markdown file at ${this.rolesDir}/${roleId}.md` };
    }

    // Resolve effective model: explicit arg > role preferred > sonnet default.
    const aliases: Record<string, string> = {
      opus: "claude-opus-4-7",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5",
    };
    const effectiveModel = aliases[modelArg ?? ""] ?? modelArg ?? role.preferred_model ?? "claude-sonnet-4-6";

    const workerLabel = `delegate-${randomUUID().slice(0, 8)}`;
    log.info(
      { workerLabel, roleId, model: effectiveModel, taskPreview: task.slice(0, 100) },
      "DelegateTask: spawning worker",
    );

    // Emit tool_progress with the workerLabel so ChatTimeline shows ⤢ while running.
    // Delayed 150ms: tool_start is emitted synchronously by jarvis.ts before the
    // capability.request is published. The handler is invoked asynchronously by the
    // executor after capability.request. But the SSE flush to the browser can still
    // race. 150ms gives the browser enough time to receive tool_start and create the
    // capability entry before the progress chunk arrives.
    const toolUseId = input.__toolUseId ? String(input.__toolUseId) : workerLabel;
    const callerSession = input.__sessionId ? String(input.__sessionId) : "main";
    const progressTimer = setTimeout(() => {
      this.bus.publish({
        channel: "ai.stream",
        source: this.id,
        target: callerSession,
        event: "tool_progress",
        toolId: toolUseId,
        chunk: `__delegate_worker:${workerLabel}`,
      } as any);
    }, 150);

    // Register the HUD panel (hidden). User opens via ⤢ in the chat block.
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: `delegate-chat-${workerLabel}`,
      piece: {
        pieceId: `delegate-chat-${workerLabel}`,
        type: "panel",
        name: `⚡ ${workerLabel}`,
        status: "running",
        data: {
          sessionId: workerLabel,
          assistantLabel: workerLabel.toUpperCase(),
          features: {
            slashMenu: false,
            images: false,
            compaction: false,
            modelPicker: false,
          },
        },
        position: { x: 120, y: 120 },
        size: { width: 480, height: 400 },
        ephemeral: true,
        visible: false,   // hidden — user clicks ⤢ in chat block to open
        renderer: { plugin: null as unknown as string, file: "ChatPanel" },
      },
    });

    // Resolve factory: use model-specific factory if available (cross-provider)
    const factory = this.opts.getFactoryForModel
      ? this.opts.getFactoryForModel(effectiveModel)
      : this.opts.getFactory();

    // Build the worker's system prompt = role body (as the base override).
    const session = factory.createWithPrompt({
      label: workerLabel,
      basePromptOverride: role.body,
    });

    // Pin the worker to its specific model — this beats the global config.
    if ((session as any).setStickyModelOverride) {
      (session as any).setStickyModelOverride(effectiveModel);
    }

    // Register in SessionManager so HUD ChatPanel can stream from it.
    const sm = this.opts.sessions;
    if (sm) {
      // Inject directly — worker already has the right factory/prompt.
      // We use the internal map directly to avoid triggering factory.create().
      (sm as any).sessions.set(workerLabel, { session, stateStack: [], createdAt: Date.now() });
      sm.setEphemeral(workerLabel, true);
      log.debug({ workerLabel }, "DelegateTask: registered in SessionManager");
    }

    const t0 = Date.now();
    let collectedText = "";
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0;
    let aborted = false;
    let workerError: string | undefined;

    try {
      // Route the task through session-dispatcher by publishing ai.request with
      // target=workerLabel. The dispatcher handles the full tool-call loop,
      // emits all ai.stream events (delta, tool_start, tool_done, complete, etc.)
      // so the HUD ChatPanel for this worker session updates live — identical to
      // any other session. We collect the final text by listening on ai.stream.
      //
      // fire_and_forget: publish and return immediately — worker keeps running
      // in the background. The HUD panel stays open for inspection.
      if (fireAndForget) {
        this.bus.publish({
          channel: "ai.request",
          source: "delegate-task",
          target: workerLabel,
          text: task,
        });
        clearTimeout(progressTimer);
        return { fired: true, worker: workerLabel };
      }

      await new Promise<void>((resolve) => {
        const unsub = this.bus.subscribe("ai.stream", (msg: any) => {
          if (msg.target !== workerLabel) return;
          if (msg.event === "delta" && msg.text) {
            collectedText += msg.text;
          } else if (msg.event === "complete") {
            // complete carries the full turn text; prefer accumulated deltas
            if (!collectedText && msg.text) collectedText = msg.text;
            // collect usage if embedded
            if (msg.usage) {
              totalIn += msg.usage.input_tokens ?? 0;
              totalOut += msg.usage.output_tokens ?? 0;
              totalCacheR += msg.usage.cache_read_input_tokens ?? 0;
              totalCacheW += msg.usage.cache_creation_input_tokens ?? 0;
            }
            unsub();
            resolve();
          } else if (msg.event === "error") {
            workerError = msg.error;
            unsub();
            resolve();
          }
        });

        this.bus.publish({
          channel: "ai.request",
          source: "delegate-task",
          target: workerLabel,
          text: task,
        });
      });
    } catch (err: any) {
      log.error({ workerLabel, err: err?.message ?? err }, "DelegateTask: worker crashed");
      return {
        error: `Worker failed: ${err?.message ?? err}`,
        partialOutput: collectedText.slice(0, 2000),
      };
    } finally {
      // Session is kept alive for HUD inspection — closed after idle timeout.
      // session.close() is deferred; the try-block already broke out of the loop.
      if (sm) {
        const timer = setTimeout(() => {
          try { session.close(); } catch {}
          (sm as any).sessions.delete(workerLabel);
          this.cleanupTimers.delete(workerLabel);
          // Remove the HUD panel too.
          this.bus.publish({
            channel: "hud.update",
            source: this.id,
            action: "remove",
            pieceId: `delegate-chat-${workerLabel}`,
          });
          log.debug({ workerLabel }, "DelegateTask: worker evicted after idle timeout");
        }, DELEGATE_IDLE_CLEANUP_MS);
        this.cleanupTimers.set(workerLabel, timer);
      } else {
        // No SessionManager wired — close immediately (original behavior).
        try { session.close(); } catch {}
      }
    }

    const ms = Date.now() - t0;
    const summary = collectedText.trim();

    if (workerError) {
      return { error: workerError, partialOutput: summary };
    }

    log.info(
      {
        workerLabel,
        ms,
        chars: summary.length,
        usage: { in: totalIn, out: totalOut, cache_r: totalCacheR, cache_w: totalCacheW },
        aborted,
      },
      "DelegateTask: worker finished",
    );

    return {
      summary,
      worker: {
        label: workerLabel,
        role: roleId,
        model: effectiveModel,
        durationMs: ms,
        aborted,
      },
      tokens: {
        input: totalIn,
        output: totalOut,
        cache_read: totalCacheR,
        cache_write: totalCacheW,
      },
    };
  }
}
