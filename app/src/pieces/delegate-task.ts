// src/pieces/delegate-task.ts
//
// `delegate_read_task` capability — spawn a short-lived AISession in a cheap
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
import type { AISessionFactory, AIStreamEvent, CapabilityCall, CapabilityResult } from "../ai/types.js";
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

/** Hard cap on iterations to prevent runaway worker. */
const MAX_ITERATIONS = 30;
/** Hard cap on wall-clock seconds. */
const DEFAULT_TIMEOUT_S = 120;

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
  timeout_seconds?: number;
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
      name: "delegate_read_task",
      description:
        "Delegate a READ-ONLY exploration task to an ephemeral worker running in a CHEAPER model. " +
        "Use when you need to read large files, run extensive grep, or explore code WITHOUT loading the raw content into your own context. " +
        "The worker reads/searches/explores in ITS OWN context, then returns ONLY a summary (typically 100-1000 tokens). " +
        "Your main session never pays cache for the raw bytes. " +
        "Examples: " +
        "(1) summarize a 5000-line file's responsibility. " +
        "(2) find all callers of a function across a codebase. " +
        "(3) explore an unfamiliar service before designing changes.",
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
          timeout_seconds: {
            type: "number",
            description: `Wall-clock timeout. Default ${DEFAULT_TIMEOUT_S}s.`,
          },
        },
        required: ["task"],
      },
      handler: async (input) => this.handleDelegate(input),
    });
    log.info("DelegateTask: registered delegate_read_task capability");
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
      timeout_seconds: opts.timeout_seconds,
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
    const timeoutMs = Math.min(600, Math.max(10, Number(input.timeout_seconds ?? DEFAULT_TIMEOUT_S))) * 1000;

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

    // Open the worker chat panel immediately — same pattern as actor.openActorChat().
    // The panel appears as a floating ChatPanel showing the worker's live session.
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
        },
        position: { x: 120, y: 120 },
        size: { width: 480, height: 400 },
        ephemeral: true,
        visible: true,
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
    const deadline = t0 + timeoutMs;
    let iterations = 0;
    let collectedText = "";
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0;
    let aborted = false;

    try {
      // Initial prompt
      let stream: AsyncGenerator<AIStreamEvent, void> = session.sendAndStream(task);

      while (true) {
        if (Date.now() > deadline) {
          aborted = true;
          log.warn({ workerLabel, ms: Date.now() - t0 }, "DelegateTask: timeout");
          break;
        }
        if (++iterations > MAX_ITERATIONS) {
          aborted = true;
          log.warn({ workerLabel, iterations }, "DelegateTask: max iterations");
          break;
        }

        const pendingTools: CapabilityCall[] = [];
        let stopReason: string | undefined;

        for await (const evt of stream) {
          if (evt.type === "text_delta" && evt.text) {
            collectedText += evt.text;
          } else if (evt.type === "tool_use" && evt.toolUse) {
            pendingTools.push(evt.toolUse);
          } else if (evt.type === "message_complete") {
            stopReason = evt.stopReason;
            const u = evt.usage;
            if (u) {
              totalIn += u.input_tokens ?? 0;
              totalOut += u.output_tokens ?? 0;
              totalCacheR += u.cache_read_input_tokens ?? 0;
              totalCacheW += u.cache_creation_input_tokens ?? 0;
            }
          } else if (evt.type === "error") {
            log.warn({ workerLabel, error: evt.error }, "DelegateTask: stream error");
            aborted = true;
            stopReason = "error";
          }
        }

        if (stopReason !== "tool_use" || pendingTools.length === 0) {
          // Terminal: model finished without further tool calls.
          break;
        }

        // Execute tools and feed results back.
        const results: CapabilityResult[] = await this.opts.registry.execute(pendingTools);
        session.addToolResults(pendingTools, results);
        // continueAndStream re-enters the API with the tool_results appended
        stream = session.continueAndStream();
      }
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

    log.info(
      {
        workerLabel,
        ms,
        iterations,
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
        iterations,
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
