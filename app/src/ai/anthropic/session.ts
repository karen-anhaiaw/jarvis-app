// src/ai/anthropic/session.ts
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam, ToolResultBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import type { EventBus } from "../../core/bus.js";
import { log } from "../../logger/index.js";
import { config } from "../../config/index.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";
import { sanitizeMessages } from "./sanitize-messages.js";
import { unescapeToolInput } from "./unescape-tool-input.js";
import { logUsage } from "./usage-log.js";
import { load as loadSettings, getCompactionSettings } from "../../core/settings.js";
import { archivePreCompactBackup } from "../../core/conversation-store.js";
import { getMaxContext, getMaxOutput, supportsLongContext } from "../../config/index.js";

/** Local (client) tool wire shape. */
type LocalCapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
/** Server tool wire shape — type + name only; Anthropic owns the schema. */
type ServerCapabilityDef = { type: string; name: string };
/** Union of both tool wire shapes as returned by CapabilityRegistry.getDefinitions(). */
type CapabilityDef = LocalCapabilityDef | ServerCapabilityDef;
type SystemPrompt = string | TextBlockParam[];

/**
 * Model used for "utility" calls — summarization, classification, title gen, etc.
 * Always Haiku regardless of session sticky. Read once on each utility call from
 * settings.models.routing.utility, falling back to this constant if missing.
 *
 * Rationale: utility calls are isolated single-shot prompts. They don't share the
 * cache pool of the main loop, so using a cheap model is pure win.
 */
const UTILITY_MODEL_DEFAULT = "claude-haiku-4-5";

function loadUtilityModel(): string {
  try {
    const s = loadSettings() as any;
    return s?.models?.routing?.utility ?? UTILITY_MODEL_DEFAULT;
  } catch {
    return UTILITY_MODEL_DEFAULT;
  }
}

export class AnthropicSession implements AISession {
  private _sessionId: string;
  get sessionId(): string { return this._sessionId; }
  private client: Anthropic;
  private getBaseModel: () => string;
  /**
   * Per-call model override. When set, the next API call uses this model
   * instead of the session default, and the override is consumed (cleared
   * after use). Set by ModelRouter via setNextModelOverride().
   */
  private nextModelOverride?: string;
  /**
   * Sticky model override. When set, ALL subsequent API calls use this model
   * (including tool-loop continuations) until cleared. Wins over base, loses
   * to nextModelOverride (per-call still takes precedence within the same call).
   */
  private stickyModelOverride?: string;
  private getSystemPrompt: () => SystemPrompt;
  /** Raw tool registry getter — returns ALL tools without filtering. */
  private getRawTools: () => CapabilityDef[];
  /**
   * Per-session tool filter. When set, tools are filtered on every API call.
   * `undefined` = no filter (all tools visible).
   */
  private toolFilter?: (toolName: string) => boolean;
  /**
   * Per-session tool result size cap (chars). When set, any tool_result whose
   * serialized content exceeds this limit is truncated with a notice appended.
   * `undefined` = no limit (default, full result injected into context).
   * Use for sessions with tight token budgets (e.g. Slack connector, Haiku-tier plugin sessions).
   */
  private toolResultMaxChars?: number;
  private messages: MessageParam[] = [];
  private label: string;
  /** Trace id of the CURRENT turn — set by JarvisCore (duck-typed, F4.17)
   *  right before sendAndStream/continueAndStream so session-internal logs
   *  correlate with the bus/core logs of the same turn. Deliberately NOT on
   *  the AISession interface: app-internal concern, no plugin contract. */
  private turnTraceId?: string;
  /** High-effort tier flag — set once at construction by the FACTORY (F3.12).
   *  true → API effort "max" + usage-log tier "xhigh"; false → "high".
   *  Immutable: effort policy is session-creation policy, never per-turn. */
  private readonly highEffort: boolean;
  private abortController?: AbortController;
  private contextInjector?: (sessionId: string) => string[] | Promise<string[]>;
  private bus?: EventBus;
  private betaDisabledUntil = 0;
  private static BETA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private consecutiveFallbacks = 0;
  private static MAX_CONSECUTIVE_FALLBACKS = 2;
  /**
   * Sliding-window compaction config — all units are LOGICAL TURNS, not raw
   * messages or API calls.
   *
   * A logical turn is "one real user prompt + everything the assistant does in
   * response (including the full tool loop)". Tool-loop iterations do NOT
   * count as turns — an assistant that runs 30 tool_use rounds before the
   * final text answer is still ONE turn. Turn boundaries are detected by
   * scanning the history for `user` messages whose first content block is NOT
   * a `tool_result` (see findUserTurnStarts).
   *
   * Defaults: start at turn 30, fire every 10 turns, compact the 10 oldest
   * turns into a single summary. Conservative — the goal is to keep context
   * healthy proactively, not to aggressively compress everything.
   */
  private static SLIDING_START_TURN = 30;
  private static SLIDING_INTERVAL = 10;
  private static SLIDING_CHUNK_TURNS = 10;
  /**
   * Real total input tokens from the LAST API response (input + cache_read + cache_create).
   * Set after every successful response. Used by measureContext() to override the
   * char/4 heuristic with the truth — chars/4 systematically underestimates by 3-4x
   * when tools and structured content are involved (Anthropic tokenizer counts JSON,
   * cache_control markers, and structured blocks differently from raw text).
   */
  private lastRealInputTokens = 0;
  /**
   * Snapshot of lastRealInputTokens taken at the START of each API turn (before the
   * response arrives). Used to detect abrupt context growth in a single turn (e.g. a
   * large log dump or tool result). Reset to 0 after compaction — when history is
   * replaced the previous baseline is no longer meaningful, so the growth check skips
   * the first turn post-compaction (previousRealInputTokens == 0 → skip).
   */
  private previousRealInputTokens = 0;

  constructor(opts: {
    model: string | (() => string);
    systemPrompt: string | (() => SystemPrompt);
    getTools: () => CapabilityDef[];
    label: string;
    bus?: EventBus;
    /** If provided (e.g. restoring a saved conversation), reuse this UUID;
     *  otherwise generate a fresh one. Either way, it is fixed for the lifetime
     *  of this session and embedded in defaultHeaders below. */
    restoredSessionId?: string;
    /** High-effort tier: "xhigh" reasoning + "max" output effort. Set by the
     *  FACTORY (policy lives there, next to other session-creation policy) —
     *  the provider must not know magic session names (F3.12: the old code
     *  hardcoded `label === "main"` here). Default: false (standard tier). */
    highEffort?: boolean;
  }) {
    this._sessionId = opts.restoredSessionId ?? crypto.randomUUID();
    this.highEffort = opts.highEffort ?? false;
    // Explicit auth: pass apiKey/baseURL from process.env (which provider.ts
    // populates from settings.user.json) so the SDK doesn't auto-read a
    // conflicting ANTHROPIC_AUTH_TOKEN — when both env vars are set, the SDK
    // sends Authorization: Bearer using AUTH_TOKEN, which a LiteLLM/Bedrock
    // gateway may prefer over x-api-key. Passing authToken: null disables
    // that side entirely.
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      authToken: null,
      defaultHeaders: {
        "User-Agent": "claude-cli/2.1.112 (external, cli)",
        "X-Claude-Code-Session-Id": this._sessionId,
        "x-app": "cli",
        "x-llm-application-name": "claude_code",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    const model = opts.model;
    this.getBaseModel = typeof model === "function" ? model : () => model;
    this.getSystemPrompt = typeof opts.systemPrompt === "function"
      ? opts.systemPrompt
      : () => opts.systemPrompt as SystemPrompt;
    this.getRawTools = opts.getTools;
    this.label = opts.label;
    this.bus = opts.bus;
    log.info({ label: this.label, sessionId: this.sessionId }, "AnthropicSession: created");
  }

  /**
   * Publish Anthropic-specific usage telemetry keyed by sessionId (= this.label).
   * Consumed by AnthropicMetricsHud which buckets metrics per session.
   * Emits on every API response that carries a `message.usage` payload.
   */
  private emitAnthropicUsage(
    modelUsed: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      iterations?: number;
    },
  ): void {
    // Persistent JSONL log for offline cost analysis. Independent of the
    // bus and the metrics HUD — fires every API response, even if no one
    // is subscribed.
    // `modelUsed` is captured at request time, BEFORE the per-call override
    // is consumed, so the log accurately reflects which model was billed.
    logUsage({
      sessionId: this.label,
      instanceId: this.sessionId,
      effort: this.highEffort ? "xhigh" : "high",
      model: modelUsed,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      iterations: usage.iterations,
    });

    // Cache the REAL total input — this is what Anthropic actually billed and what
    // matters for routing decisions. measureContext() will prefer this over heuristics.
    this.lastRealInputTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);

    if (!this.bus) return;
    this.bus.publish({
      channel: "system.event",
      source: "anthropic-session",
      event: "api.anthropic.usage",
      data: {
        sessionId: this.label,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        model: modelUsed,
      },
    });
  }

  setContextInjector(injector: (sessionId: string) => string[]): void {
    this.contextInjector = injector;
  }

  /** Set the trace id for the upcoming turn (F4.17). Called by JarvisCore via
   *  duck-typing; pass undefined to clear. Used purely for log correlation. */
  setTurnTraceId(traceId: string | undefined): void {
    this.turnTraceId = traceId;
  }

  /**
   * Resolve the model to use for the NEXT API call. Priority:
   *   1. nextModelOverride (per-call, consumed after read)
   *   2. stickyModelOverride (persists until cleared)
   *   3. base model (session default, dynamic via config.model)
   *
   * Per-call override is consumed atomically — the second `getModel()` within
   * the same API turn (e.g. compaction summary call) sees the sticky/base.
   * That's intentional: routing decisions are per-turn, not per-internal-call.
   */
  private getModel(): string {
    if (this.nextModelOverride) {
      const m = this.nextModelOverride;
      this.nextModelOverride = undefined;
      return m;
    }
    if (this.stickyModelOverride) return this.stickyModelOverride;
    return this.getBaseModel();
  }

  /**
   * Set a one-shot model for the next API turn. Consumed on first read
   * inside the next streamFromAPI call.
   */
  setNextModelOverride(model: string | undefined): void {
    this.nextModelOverride = model || undefined;
  }

  /**
   * Set a sticky model that wins over the base until cleared. Use for
   * "this whole conversation should be Sonnet" scenarios. Pass undefined
   * to clear and revert to base.
   */
  setStickyModelOverride(model: string | undefined): void {
    this.stickyModelOverride = model || undefined;
  }

  /** Returns the currently effective model without consuming any override. */
  peekModel(): string {
    return this.nextModelOverride ?? this.stickyModelOverride ?? this.getBaseModel();
  }

  /**
   * Set a per-session tool filter. Called by plugins (e.g. a session-orchestrator)
   * to restrict the visible tool surface based on role configuration.
   * Pass `undefined` to clear (reverts to all tools visible).
   */
  setToolFilter(filter: ((toolName: string) => boolean) | undefined): void {
    this.toolFilter = filter;
  }

  /**
   * Set a per-session cap on tool result size injected into context.
   * Results exceeding `maxChars` are truncated; a notice is appended so the
   * LLM knows the result was cut. Pass `undefined` to remove the cap.
   */
  setToolResultMaxChars(maxChars: number | undefined): void {
    this.toolResultMaxChars = maxChars;
  }

  /**
   * Effective tools for this session — raw registry filtered by `toolFilter`.
   * Called from every site that previously used `this.getTools()` directly.
   * Logs filter stats once per filtered call so we can audit drift.
   */
  private getTools(): CapabilityDef[] {
    const raw = this.getRawTools();
    const model = this.getBaseModel();

    // Server tools (web_fetch, web_search) require models that support programmatic
    // tool calling. Haiku models reject them with a 400 error when allowed_callers
    // is set. Filter them out for Haiku variants to prevent unnecessary failures.
    const isHaiku = model.includes("haiku");
    // ServerCapabilityDef has a `type` field (e.g. "web_search_20260209") while
    // LocalCapabilityDef has `input_schema`. Haiku rejects server tools with
    // allowed_callers, so filter them out entirely for Haiku models.
    const tools = isHaiku
      ? raw.filter((t) => !("type" in t))
      : raw;

    if (!this.toolFilter) return tools;
    return tools.filter((t) => this.toolFilter!(t.name));
  }

  async *sendAndStream(prompt: string | import("../types.js").PromptBlock[], images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
    const promptBlocks: Array<{ type: "text"; text: string }> = Array.isArray(prompt)
      ? prompt
      : [{ type: "text", text: prompt }];
    const promptPreviewText = promptBlocks.map(b => b.text).join(" ").slice(0, 120);

    log.info({
      label: this.label,
      traceId: this.turnTraceId,
      promptLength: promptBlocks.reduce((n, b) => n + b.text.length, 0),
      promptPreview: promptPreviewText,
      promptBlocks: promptBlocks.length,
      images: images?.length ?? 0,
      messageCountBefore: this.messages.length,
      lastMessageRole: this.messages[this.messages.length - 1]?.role,
    }, "AnthropicSession: sendAndStream (entry)");

    // Build user message content — prepend ephemeral context block if available.
    // Concat approach: memory block + prompt in one user message content array.
    // No extra messages, no alternation issues, no markers needed.
    const memoryBlocks = this.contextInjector ? await this.contextInjector(this.label) : [];
    const memoryText = memoryBlocks.join("\n\n").trim();

    // Cache control on message content is OWNED EXCLUSIVELY by this provider.
    // Plugins (Mnemosyne, Skills, etc.) inject pure content — they do NOT set
    // cache_control. Memory blocks here are pushed without any cache marker.
    // The single rolling cache breakpoint for messages is placed later in
    // placeMessageCacheBreakpoint() (called from streamFromAPI), anchored to
    // the LAST STABLE turn (assistant just produced output). That way the
    // breakpoint position is deterministic and does not drift with every
    // memory injection, preventing the cache-write storms observed when the
    // ephemeral marker rode along with each turn's volatile memory text.
    //
    // Belt-and-suspenders: still strip any cache_control leftovers in case
    // a plugin (or older code path) snuck one in.
    this.stripAllMessageCacheControl();

    if (images && images.length > 0) {
      const content: ContentBlockParam[] = [];
      if (memoryText) {
        content.push({ type: "text", text: memoryText } as any);
      }
      // Prompt blocks (may be multiple for inter-session context separation)
      for (const block of promptBlocks) {
        content.push({ type: "text", text: block.text });
      }
      for (const img of images) {
        content.push({
          type: "image" as any,
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        } as any);
        content.push({ type: "text", text: `[${img.label}]` });
      }
      this.messages.push({ role: "user", content });
    } else if (memoryText) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: memoryText } as any,
          ...promptBlocks.map(b => ({ type: "text" as const, text: b.text })),
        ],
      });
    } else if (promptBlocks.length === 1) {
      // Single block — keep the simple string form (no array wrapping needed)
      this.messages.push({ role: "user", content: promptBlocks[0].text });
    } else {
      // Multiple blocks (e.g. [SYSTEM] context + actual prompt)
      this.messages.push({
        role: "user",
        content: promptBlocks.map(b => ({ type: "text" as const, text: b.text })),
      });
    }

    // Detect alternation violations — Anthropic API rejects two consecutive
    // user messages (or two consecutive assistants) with HTTP 400. This pass
    // is read-only: we log the offending sequence so diagnosis is one grep
    // away. The actual fix lives in sanitizeMessages / setMessages, not here.
    this.warnIfBadAlternation();

    yield* this.streamFromAPI();
  }

  /**
   * Remove cache_control from every block in every message in the history.
   *
   * This provider owns cache_control placement on `messages` exclusively.
   * Other layers (plugins, pieces, Mnemosyne, Skills) inject content as plain
   * blocks. Before every API call we wipe any cache_control that may have
   * leaked in (defensive — kept even after refactor in case third-party code
   * still adds it) and then re-place the single rolling message breakpoint
   * deterministically in placeMessageCacheBreakpoint().
   *
   * Why we strip ALL messages (not only user):
   *   - Assistant tool_use blocks could in theory carry cache_control.
   *   - Tool_result blocks in user messages could too.
   *   We just clean everything; the placement step puts back the single
   *   marker the provider wants.
   */
  private stripAllMessageCacheControl(): void {
    let stripped = 0;
    for (const m of this.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as any[]) {
        if (block && typeof block === "object" && block.cache_control) {
          delete block.cache_control;
          stripped++;
        }
      }
    }
    if (stripped > 0) {
      log.debug({ label: this.label, stripped }, "AnthropicSession: stripped cache_control from message history");
    }
  }

  /**
   * Place exactly ONE cache_control marker on the messages array, anchored
   * to a stable boundary so the breakpoint position is deterministic across
   * turns. A stable position means the next request can hit the cache fully
   * up to that point — the only delta to pay for is whatever was added
   * AFTER the breakpoint (which is the natural, minimal cache write).
   *
   * Anchor strategy:
   *   - Find the last assistant message in the history (the most recent
   *     completed model turn).
   *   - Attach cache_control to the LAST content block of that message.
   *   - This guarantees that the entire stable history (everything up to
   *     and including the last assistant response) is cached, and the new
   *     user turn (which contains volatile memory injections) lives AFTER
   *     the cache point so it doesn't break the cache.
   *
   * Edge cases:
   *   - No assistant message yet (first turn): no breakpoint added.
   *     Cost is the same as if we had added one — the first call always
   *     pays full input cost regardless.
   *   - Last assistant message has only tool_use blocks: still works, the
   *     cache_control just sits on the tool_use, which Anthropic accepts.
   *
   * Total breakpoints in the request:
   *   - 2 in system blocks (factory.ts BP1+BP2)
   *   - 1 on the last tool definition (BP3)
   *   - 1 here on the last assistant message (BP4)
   *   Total: 4 — exactly Anthropic's limit, all stable.
   */
  private placeMessageCacheBreakpoint(): void {
    // Block types that do NOT support cache_control — Anthropic API rejects
    // cache_control on thinking/redacted_thinking blocks (returns 400
    // "Extra inputs are not permitted"). This surfaces when claude-fable-5 or
    // other thinking-capable models leave a thinking block as the last content
    // block in an assistant message.
    const NON_CACHEABLE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

    // Find the most recent assistant message (scan from the end).
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant") continue;
      if (!Array.isArray(m.content) || m.content.length === 0) continue;

      // Walk backwards through blocks to find the last cacheable one.
      // Thinking/redacted_thinking blocks don't accept cache_control.
      let anchorBlock: any | undefined;
      for (let j = m.content.length - 1; j >= 0; j--) {
        const block = m.content[j] as any;
        if (block && typeof block === "object" && !NON_CACHEABLE_BLOCK_TYPES.has(block.type)) {
          anchorBlock = block;
          break;
        }
      }

      if (anchorBlock) {
        anchorBlock.cache_control = { type: "ephemeral" };
        log.debug({
          label: this.label,
          anchorMsgIdx: i,
          anchorBlockType: anchorBlock.type,
          msgsAfterAnchor: this.messages.length - 1 - i,
        }, "AnthropicSession: placed message cache breakpoint");
      } else {
        // All blocks are non-cacheable (all thinking) — skip this message.
        log.debug({
          label: this.label,
          anchorMsgIdx: i,
        }, "AnthropicSession: skipping message cache breakpoint (all blocks are non-cacheable thinking blocks)");
      }
      return;
    }
    // No assistant message yet — nothing to anchor to. The system + tools
    // breakpoints still apply, and the next assistant turn will create the
    // anchor for subsequent caching.
    log.debug({ label: this.label }, "AnthropicSession: no assistant message yet, skipping message cache breakpoint");
  }

  /**
   * Walk the message array and warn if there are consecutive same-role messages.
   * Anthropic requires strict user/assistant alternation. Repeated user roles
   * almost always mean a previous turn failed silently and the next prompt
   * was pushed without an assistant reply — a class of bug that's worth
   * loud-logging the moment it happens.
   */
  private warnIfBadAlternation(): void {
    const violations: Array<{ at: number; role: string; preview: string }> = [];
    for (let i = 1; i < this.messages.length; i++) {
      const cur = this.messages[i];
      const prev = this.messages[i - 1];
      if (cur.role === prev.role) {
        const text = typeof cur.content === "string"
          ? cur.content
          : Array.isArray(cur.content)
            ? cur.content.map((b: any) => b?.text ?? `[${b?.type}]`).join(" ")
            : "";
        violations.push({ at: i, role: cur.role, preview: text.slice(0, 80) });
      }
    }
    if (violations.length > 0) {
      log.warn({
        label: this.label,
        violations,
        totalMessages: this.messages.length,
      }, "AnthropicSession: BAD ALTERNATION — consecutive same-role messages detected (will likely cause API 400)");
    }
  }

  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void {
    log.info({
      label: this.label,
      toolCalls: toolCalls.map(tc => tc.name),
      results: results.map(r => ({
        id: r.tool_use_id,
        contentType: typeof r.content === 'string' ? 'string' : Array.isArray(r.content) ? `array[${r.content.length}]` : typeof r.content,
        isError: r.is_error,
        preview: typeof r.content === 'string' ? r.content.slice(0, 100) : JSON.stringify(r.content).slice(0, 100),
      })),
    }, "AnthropicSession: addToolResults");

    // NOTE: We do NOT push an assistant tool_use message here.
    // The assistant message (including any tool_use blocks) is already pushed
    // by streamFromAPI with the original message.content preserved.
    // Rebuilding tool_use blocks here would create duplicate IDs in history
    // whenever the API returns a mixed response (text + tool_use) with a
    // stop_reason that allows the streamFromAPI push to happen.

    // Two defensive dedups, both targeting the API's
    // "Found multiple 'tool_result' blocks with id" rejection:
    //
    //   1. Drop entries from `results` whose tool_use_id is already
    //      represented by a tool_result block somewhere in history. This
    //      catches stale capability.result messages from a previously-aborted
    //      tool that race in while the session is back in waiting_tools for
    //      a different tool. (cleanupAbortedTools may have already injected
    //      a synthetic placeholder for the aborted id — accepting the late
    //      real result would create a duplicate.)
    //
    //   2. Drop duplicates inside the same `results` array (keep first).
    //      Should be a no-op in practice but cheap insurance against an
    //      executor that retries internally without dedup.
    const existingResultIds = this.collectExistingToolResultIds();
    const seenInBatch = new Set<string>();
    const skippedStale: string[] = [];
    const skippedDupInBatch: string[] = [];
    const filteredResults: CapabilityResult[] = [];
    for (const r of results) {
      const id = r.tool_use_id;
      if (existingResultIds.has(id)) {
        skippedStale.push(id);
        continue;
      }
      if (seenInBatch.has(id)) {
        skippedDupInBatch.push(id);
        continue;
      }
      seenInBatch.add(id);
      filteredResults.push(r);
    }
    if (skippedStale.length > 0 || skippedDupInBatch.length > 0) {
      log.warn(
        { label: this.label, skippedStale, skippedDupInBatch },
        "AnthropicSession: addToolResults dropped duplicate/stale tool_result entries",
      );
    }

    if (filteredResults.length === 0) {
      log.info(
        { label: this.label },
        "AnthropicSession: addToolResults — all results already represented in history, skipping push",
      );
      return;
    }

    const maxChars = this.toolResultMaxChars;
    const toolResultBlocks: ToolResultBlockParam[] = filteredResults.map(r => {
      let content = r.content as ToolResultBlockParam["content"];
      if (maxChars !== undefined) {
        // Serialize → cap → deserialize so the LLM sees a truncated but valid string.
        const raw = typeof content === "string" ? content : JSON.stringify(content);
        if (raw.length > maxChars) {
          content = raw.slice(0, maxChars)
            + `\n\n[...truncated — result exceeded ${maxChars} chars. Request a smaller scope or use a summary tool.]`;
        }
      }
      return {
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content,
        is_error: r.is_error,
      };
    });
    this.messages.push({ role: "user", content: toolResultBlocks });
  }

  /**
   * Walk the message history and return every `tool_use_id` that already
   * appears in a `tool_result` block. Used by addToolResults to skip stale
   * or duplicate results that would otherwise corrupt the message shape.
   */
  private collectExistingToolResultIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of this.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as any[]) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          ids.add(block.tool_use_id);
        }
      }
    }
    return ids;
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      // Don't clear abortController here — streamFromAPI catch needs to check .signal.aborted
      // It gets cleared at the end of streamFromAPI after successful completion
      log.info({ label: this.label }, "AnthropicSession: aborted");
    }
  }

  cleanupAbortedTools(pendingCalls: CapabilityCall[]): void {
    this.messages = cleanupAbortedToolMessages(this.messages, pendingCalls);
    log.info(
      { label: this.label, messageCount: this.messages.length },
      "AnthropicSession: cleaned up aborted tools",
    );
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "AnthropicSession: closed");
    this.messages = [];
  }

  getMessages(): unknown[] {
    // Filter out any injected ephemeral messages before exposing the history
    // (defensive — they're normally removed before saves, but if a save races
    // with an in-flight API call, this prevents leaking them to disk and
    // accumulating across restarts).
    return this.messages.filter((m: any) => {
      if (!Array.isArray(m.content)) return true;
      return !m.content.some((b: any) => b?._injected === true);
    });
  }

  setMessages(messages: unknown[]): void {
    this.messages = sanitizeMessages(messages as MessageParam[]);
    log.info(
      { label: this.label, restored: this.messages.length, original: messages.length },
      "AnthropicSession: messages restored",
    );
  }

  /**
   * Build the list of Anthropic beta headers for THIS turn.
   * Combines:
   *  - context-1m-2025-08-07 → for models that support 1M (opus 4.6/4.7, sonnet 4.6)
   *  - compact-2026-01-12    → for server-side compaction (Engine A)
   *
   * The 1M header is independent of compaction — we want it whenever the
   * model supports it, even if compaction is disabled or in cooldown.
   */
  private getBetaHeaders(model: string): string[] {
    const betas: string[] = [];
    if (supportsLongContext(model)) {
      betas.push("context-1m-2025-08-07");
    }
    return betas;
  }

  private getCompactionConfig(): {
    useCompaction: boolean;
    contextManagement?: Record<string, unknown>;
  } {
    // Engine A (server-side compact-2026-01-12 beta) is intentionally disabled.
    // It compacts silently without any visible summary or user notification,
    // causing undetected context loss. Engine B (fallbackCompact / doCompact)
    // is the only active compaction path — it produces a visible summary in chat.
    return { useCompaction: false };
  }

  /**
   * Force compaction (Engine B) regardless of token threshold.
   * Called by the /compact slash command. Skips threshold checks and
   * consecutive fallback guards — always runs if there are messages to compact.
   */
  async *forceCompact(): AsyncGenerator<AIStreamEvent, void> {
    if (this.messages.length === 0) return;

    const ctx = this.measureContext();
    const tokensBefore = ctx.totalTokensEst;

    log.info({ label: this.label, tokensBefore, messageCount: ctx.messageCount }, "AnthropicSession: forced compaction requested");

    yield* this.doCompact(tokensBefore, "forced");
  }

  private async *fallbackCompact(lastInputTokens: number): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled) return;

    // Use the session's effective model to determine the correct context window.
    // getMaxContext() without args falls back to config.model (the global/main model),
    // which is wrong for plugin-owned sessions that may use a different model — they would
    // get 200K instead of 1M, causing premature compaction at ~160K tokens.
    const maxCtx = getMaxContext(this.stickyModelOverride ?? this.getBaseModel());
    // Trigger at 80% of the context window — down from 95% to give the summarizer
    // enough headroom to produce a good summary before the session is full.
    const safetyThreshold = Math.floor(maxCtx * 0.80);

    if (lastInputTokens < safetyThreshold) {
      this.consecutiveFallbacks = 0;
      return;
    }

    if (this.consecutiveFallbacks >= AnthropicSession.MAX_CONSECUTIVE_FALLBACKS) {
      log.warn({ label: this.label, consecutiveFallbacks: this.consecutiveFallbacks }, "AnthropicSession: max fallback attempts reached, skipping");
      yield {
        type: "compaction",
        compaction: {
          summary: "Context too large even after compaction — consider starting a new session.",
          engine: "fallback",
          tokensBefore: lastInputTokens,
          tokensAfter: lastInputTokens,
        },
      };
      return;
    }

    this.consecutiveFallbacks++;

    log.info({ label: this.label, tokensBefore: lastInputTokens, threshold: safetyThreshold }, "AnthropicSession: Engine B threshold compaction triggered");

    yield* this.doCompact(lastInputTokens, "threshold");
  }

  /**
   * Sliding-window compaction — proactive, incremental, turn-aware.
   *
   * Unit of work is a LOGICAL TURN, not a message or an API call. A turn is
   * "one real user prompt + everything the assistant does in response (the
   * entire tool loop until a final non-tool_use stop)". Tool-loop iterations
   * are part of the turn that started them, they don't count separately.
   *
   * Runs after `SLIDING_START_TURN` turns, then every `SLIDING_INTERVAL` turns.
   * Compacts the `SLIDING_CHUNK_TURNS` oldest turns into a summary block
   * prepended before the remaining turns. The summary is additive — it does
   * NOT replace previous summaries or recent messages.
   *
   * Structure after compaction:
   *   [existing summaries...] [new sliding summary] [recent turns...]
   *
   * The slice boundary is, by construction, the start of a fresh user prompt
   * (`turnStarts[SLIDING_CHUNK_TURNS]`). This eliminates the orphan
   * `tool_use` / `tool_result` failure mode at the boundary — there is no way
   * to cut a tool pair when you only ever slice between turns.
   *
   * Caller MUST gate on `stop_reason !== "tool_use"` so this doesn't fire in
   * the middle of an ongoing tool loop (the assistant hasn't finished yet,
   * so the "current turn" is still being built).
   */
  private async *slidingWindowCompact(stopReason: string | undefined): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled) return;

    // Don't fire mid-tool-loop — the current turn isn't done yet. Compaction
    // must wait until the assistant produces a non-tool_use stop_reason
    // (end_turn, max_tokens, stop_sequence, etc.).
    if (stopReason === 'tool_use') return;

    // Count turns from the message history (not from an in-memory counter)
    // so the schedule survives restore — a session loaded from disk picks up
    // exactly where it left off.
    const turnStarts = this.findUserTurnStarts();
    const turnCount = turnStarts.length;

    if (turnCount < AnthropicSession.SLIDING_START_TURN) return;
    if ((turnCount - AnthropicSession.SLIDING_START_TURN) % AnthropicSession.SLIDING_INTERVAL !== 0) return;

    // Need enough turns: chunk to compact + at least 1 turn remaining after.
    if (turnCount < AnthropicSession.SLIDING_CHUNK_TURNS + 1) return;

    // Split at the start of the (N+1)-th turn. By definition this is a
    // non-tool_result user message — a fresh user prompt — so the boundary is
    // automatically safe (no tool_use/tool_result pair can ever be cut here).
    const splitAt = turnStarts[AnthropicSession.SLIDING_CHUNK_TURNS];

    const tokensBefore = this.lastRealInputTokens || this.measureContext().totalTokensEst;

    log.info(
      {
        label: this.label,
        userTurns: turnCount,
        messageCount: this.messages.length,
        compactingTurns: AnthropicSession.SLIDING_CHUNK_TURNS,
        splitAt,
      },
      'AnthropicSession: sliding-window compaction triggered'
    );

    yield {
      type: 'compaction_start',
      compactionStart: {
        // NOTE: type system only allows 'fallback' here — 'sliding-window' is a compaction
        // event engine value. compaction_start.engine is a separate field used only for
        // the pending banner. The reason field already carries 'sliding-window'.
        engine: 'fallback',
        tokensBefore,
        reason: 'sliding-window',
      },
    };

    try {
      // Extract the oldest `splitAt` messages — i.e., the first
      // SLIDING_CHUNK_TURNS complete logical turns. The split is guaranteed
      // to fall on a turn boundary, so we can't cut a tool_use/tool_result
      // pair here. Still sanitize defensively to absorb any pre-existing
      // orphans inside the chunk (legacy history, restored sessions, residue
      // from a previously aborted turn).
      // Guard: the API requires messages to start with a user turn.
      // If the oldest messages start with an assistant (e.g. restored session,
      // prior compaction left an assistant-first slice), drop leading assistant
      // messages before sanitizing — they carry no unmatched tool_results so
      // dropping them is safe.
      const rawChunk = this.messages.slice(0, splitAt);
      const firstUserIdx = rawChunk.findIndex((m) => m.role === "user");
      const trimmedChunk = firstUserIdx > 0 ? rawChunk.slice(firstUserIdx) : rawChunk;
      const toCompact = sanitizeMessages(trimmedChunk);
      const remaining = this.messages.slice(splitAt);

      // Same prompt-shape hardening as doCompact (F-compact-2.2/2.3):
      // instruction guaranteed as final user content + <summary> prefill.
      // The sliding chunk can also end in a tool_result user message when the
      // sanitized slice carries an orphan-patched tail — the conditional
      // instruction bug applied here too.
      const msgs = AnthropicSession.buildSummarizerTail(toCompact);

      const compactionModel = this.stickyModelOverride ?? this.getBaseModel();
      // Sliding-window prompt is purpose-built for token reduction, NOT narrative summary.
      // Goal: extract and compress ONLY what is operationally relevant — decisions, tasks,
      // objectives, findings, errors, commands, artifacts. Drop conversation filler.
      // Intentionally separate from the user-configurable full-compact instructions.
      const SLIDING_SYSTEM_PROMPT =
        'You are a context compressor. Reduce token count while preserving ALL operationally ' +
        'relevant information from the conversation segment. Use terse structured format:\n\n' +
        '- OBJECTIVES: active goals and tasks in progress\n' +
        '- DECISIONS: architectural, technical, or strategic choices made\n' +
        '- FINDINGS: discoveries, root causes, confirmed facts, investigation results\n' +
        '- ARTIFACTS: file paths, function names, commands, configs, schemas, IDs produced\n' +
        '- ERRORS: failures encountered and their resolutions or current status\n' +
        '- PENDING: unresolved questions, blocked items, next steps explicitly mentioned\n\n' +
        'Drop: greetings, acknowledgements, repetition, conversational filler, ' +
        'reformulations of already-captured content.\n\n' +
        'Output ONLY the compressed content inside <summary></summary> tags. ' +
        'Be as dense as possible — every token must earn its place.';

      log.info({ label: this.label, compactionModel, compactingMessages: toCompact.length }, 'AnthropicSession: sliding-window summary call');

      const summaryResponse = await this.client.messages.create({
        model: compactionModel,
        max_tokens: 4096, // sliding summaries are partial — less content than full compaction
        system: SLIDING_SYSTEM_PROMPT,
        messages: msgs,
        // Prefill requires thinking disabled — see buildSummarizerTail/doCompact.
        thinking: { type: 'disabled' },
      });

      const summaryText = summaryResponse.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');

      const summary = AnthropicSession.extractSummary(summaryText);

      // Prepend summary as a synthetic user/assistant pair, keep remaining messages intact.
      // The synthetic user message starts with plain text (NOT a tool_result), so it
      // counts as a fresh turn start for the next sliding-window cycle —
      // findUserTurnStarts will pick it up as turn #1 of the new history.
      // Run sanitizeMessages as a final defensive pass — the turn-aware split
      // already prevents orphans across the boundary, but if `remaining` itself
      // carries pre-existing orphans (legacy history, abort residue) we patch
      // them here rather than crashing the next API call.
      this.messages = sanitizeMessages([
        { role: 'user', content: `[Conversation summary — first ${AnthropicSession.SLIDING_CHUNK_TURNS} turns]\n\n${summary}` },
        { role: 'assistant', content: 'Understood. I have the summary of our earlier conversation.' },
        ...remaining,
      ]);

      // injectedContextCount tracks ephemeral blocks — sliding window doesn't wipe all
      // messages, so we leave it as-is. The stale cache_control cleanup on the next
      // sendAndStream will handle any ephemeral markers in remaining messages.

      // Use measureContext() on the new message array for tokensAfter.
      // The previous inline chars/4 heuristic was dead code (result unused) and
      // underestimated by 3-4x — removed to avoid log confusion.
      const ctxAfter = this.measureContext();
      const tokensAfterFinal = ctxAfter.totalTokensEst;

      log.info(
        { label: this.label, tokensBefore, tokensAfter: tokensAfterFinal, summaryLength: summary.length, remainingMessages: remaining.length },
        'AnthropicSession: sliding-window compaction complete'
      );

      yield {
        type: 'compaction',
        compaction: {
          summary,
          engine: 'sliding-window',
          tokensBefore,
          tokensAfter: tokensAfterFinal,
        },
      };
    } catch (err) {
      log.error({ label: this.label, err }, 'AnthropicSession: sliding-window compaction failed');
    }
  }

  /**
   * True iff `msg` is a user message whose first content block is a `tool_result`.
   *
   * Used as the building block for `findUserTurnStarts` (a tool_result-leading
   * user message is a continuation of an ongoing tool loop, NOT a new turn).
   */
  private startsWithToolResult(msg: MessageParam): boolean {
    if (msg.role !== 'user') return false;
    if (typeof msg.content === 'string') return false;
    if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
    return (msg.content[0] as any)?.type === 'tool_result';
  }

  /**
   * Indices in `this.messages` that mark the start of a logical turn.
   *
   * A turn begins with a `user` message that is NOT a `tool_result`
   * continuation. Every tool_result-leading user message is part of the turn
   * started by the previous fresh user prompt, regardless of how many
   * tool_use/tool_result rounds the assistant runs.
   *
   * Returned indices are monotonically increasing. The slice boundary
   * `messages.slice(0, turnStarts[N])` covers exactly the first N turns —
   * which is what the sliding window relies on for a tool-pair-safe split.
   */
  private findUserTurnStarts(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role !== 'user') continue;
      if (this.startsWithToolResult(m)) continue;
      out.push(i);
    }
    return out;
  }

  /**
   * Abrupt-growth compaction — independent of the absolute threshold.
   * Triggers when a single turn increases context by more than 15% (e.g. a large
   * log dump, trace output, or tool result). Does NOT increment consecutiveFallbacks
   * because it is a distinct trigger path — it should not interfere with the
   * consecutive-fallback guard on the absolute-threshold path.
   *
   * Skipped when previousRealInputTokens is 0 (fresh session or just post-compaction)
   * to avoid false positives on the very first turn.
   */
  private async *growthCompact(lastInputTokens: number): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    if (!settings.enabled) return;

    // Skip on first turn after session start or post-compaction (no valid baseline).
    if (this.previousRealInputTokens === 0) return;

    // Growth compaction temporarily disabled — threshold of 15% was too aggressive,
    // firing on normal turns with large tool results. Re-enable once a better
    // absolute-growth threshold is designed.
    return;

    log.info(
      { label: this.label, previousTokens: this.previousRealInputTokens, currentTokens: lastInputTokens },
      "AnthropicSession: Engine B abrupt-growth compaction triggered"
    );

    yield* this.doCompact(lastInputTokens, "growth");
  }

  /** The instruction that MUST terminate every summarizer request's user content. */
  private static readonly SUMMARIZE_INSTRUCTION = "Please summarize the conversation above.";

  /** Assistant prefill that forces the summarizer into summary-continuation mode. */
  private static readonly SUMMARY_PREFILL = "<summary>";

  /**
   * Guarantee the summarize instruction is the FINAL user content of a
   * summarizer request, then terminate with the `<summary>` assistant prefill.
   *
   * WHY (incident #2, 2026-06-10): the old code only appended the instruction
   * when the history happened to end with an assistant message. When sanitize
   * stripped a trailing orphan tool_use, the history ended in a user
   * tool_result, the instruction was silently skipped, and the summarizer
   * role-played the conversation instead of summarizing — replacing 416k
   * tokens of history with 84 chars of fiction containing a hallucinated
   * user instruction.
   *
   * Three tail shapes, all producing NEW message objects (the input array
   * shares message references with the live history — mutating them would
   * corrupt `this.messages`):
   *   - trailing assistant    → push a new user message with the instruction
   *   - trailing user string  → merge the instruction into the string content
   *   - trailing user blocks  → append a text block after the tool_results
   *     (keeps the no-consecutive-user-message shape)
   *
   * The prefill makes roleplay structurally impossible: the model can only
   * CONTINUE a summary. Prefill requires thinking to be disabled — the two
   * API features are mutually exclusive (see callSummarizer).
   */
  private static buildSummarizerTail(msgs: MessageParam[]): MessageParam[] {
    if (msgs.length === 0) return msgs; // degenerate — upstream guards prevent this
    const out = [...msgs];
    const last = out[out.length - 1];
    if (last.role === "assistant") {
      out.push({ role: "user", content: AnthropicSession.SUMMARIZE_INSTRUCTION });
    } else if (typeof last.content === "string") {
      out[out.length - 1] = { ...last, content: `${last.content}\n\n${AnthropicSession.SUMMARIZE_INSTRUCTION}` };
    } else if (Array.isArray(last.content)) {
      out[out.length - 1] = { ...last, content: [...last.content, { type: "text", text: AnthropicSession.SUMMARIZE_INSTRUCTION }] };
    } else {
      out.push({ role: "user", content: AnthropicSession.SUMMARIZE_INSTRUCTION });
    }
    // NOTE: assistant prefill is NOT added here. Some Claude models (e.g.
    // claude-sonnet-4-6 and later) reject assistant message prefill with a
    // 400 error ("This model does not support assistant message prefill").
    // The summarizer instruction already ends with "Wrap in <summary></summary>"
    // so extractSummary handles both prefilled and non-prefilled responses.
    return out;
  }

  /**
   * Extract the summary body from a summarizer response.
   *
   * The request prefills the assistant turn with `<summary>`, so a
   * well-behaved response contains ONLY the body + closing tag. Prepend the
   * prefilled tag before matching so the regex sees a complete pair. Some
   * models re-emit the opening tag anyway — strip leading duplicates from
   * the captured body. No closing tag (max_tokens truncation, tag-averse
   * model) → fall back to the raw trimmed text: with the prefill in place,
   * the whole response IS summary content by construction.
   */
  private static extractSummary(text: string): string {
    const combined = `${AnthropicSession.SUMMARY_PREFILL}${text}`;
    const match = combined.match(/<summary>([\s\S]*?)<\/summary>/);
    const body = match ? match[1] : text;
    return body.replace(/^(\s*<summary>)+/i, "").trim();
  }

  /**
   * Core compaction logic shared by fallbackCompact, growthCompact and
   * forceCompact. Sends messages to a summarizer, replaces history with the
   * summary.
   *
   * FAILURE SEMANTICS (added after the 2026-06-10 incident — a forced
   * compaction on a 734k-token session received an EMPTY summarizer response
   * and replaced the entire history with it, unrecoverably):
   *
   *   1. History is NEVER replaced unless the summarizer returned a usable
   *      summary (empty / whitespace-only / suspiciously-short = failure).
   *   2. stop_reason "max_tokens" with zero text (adaptive-thinking models,
   *      e.g. fable, can burn the whole budget on thinking blocks) gets
   *      exactly ONE retry with a 4x budget clamped to the model ceiling.
   *   3. The full pre-compaction history is archived to sessions/archive/
   *      BEFORE replacement. If the backup write fails, compaction ABORTS —
   *      an oversized context is recoverable, destroyed history is not.
   *   4. Every failure path yields `compaction_failed` so the UI resolves the
   *      pending banner — the catch no longer swallows errors invisibly.
   *   5. Messages are sanitized before the summarizer call. This used to be
   *      the ONLY call site sending history to the API without
   *      sanitizeMessages — orphan tool_use blocks made the summarizer 400
   *      while the main loop kept working, so automatic compaction failed
   *      silently until the context ballooned.
   */
  private async *doCompact(tokensBefore: number, reason: "forced" | "threshold" | "growth"): AsyncGenerator<AIStreamEvent, void> {
    const settings = getCompactionSettings(loadSettings());
    const instructions = settings.instructions ||
      "Summarize this conversation preserving key decisions, code, and progress.";

    // Signal start to the UI BEFORE the (potentially long) summary call.
    // Engine B is the only path that emits this — Engine A is server-side
    // and effectively instantaneous from the client's perspective.
    yield {
      type: "compaction_start",
      compactionStart: {
        engine: "fallback",
        tokensBefore,
        reason,
      },
    };

    try {
      // Sanitize a COPY before the summarizer call (in-memory history is not
      // mutated — the main loop sanitizes independently right before its own
      // API calls). buildSummarizerTail then guarantees the summarize
      // instruction is the final user content REGARDLESS of how the history
      // ends, and appends the <summary> prefill (F-compact-2.2/2.3 — the
      // conditional instruction was the root cause of incident #2's roleplay).
      // Guard: API requires messages to start with a user turn.
      // Drop leading assistant messages before sanitizing (same fix as sliding-window).
      const rawHistory = [...this.messages];
      const firstUser = rawHistory.findIndex((m) => m.role === "user");
      const trimmedHistory = firstUser > 0 ? rawHistory.slice(firstUser) : rawHistory;
      const msgs = AnthropicSession.buildSummarizerTail(sanitizeMessages(trimmedHistory));

      // Use the session's current model for compaction — same client, same model.
      // The utility model (Haiku) was too weak for large contexts (~1M tokens)
      // and would silently truncate, producing summaries that barely reduced context.
      const compactionModel = this.stickyModelOverride ?? this.getBaseModel();
      log.info({ label: this.label, compactionModel }, "AnthropicSession: compaction summary using session model");

      // Summary is short prose — doesn't need the full output budget. The
      // retry path quadruples this when thinking exhausts it (see below).
      const BASE_MAX_TOKENS = 8192;

      /**
       * One summarizer round-trip + full diagnostics. The 2026-06-10 incident
       * was undiagnosable because none of this was recorded: the call bypassed
       * usage.log and the response shape (stop_reason / block types) was never
       * logged — `summaryLength: 0` was the only trace.
       */
      const callSummarizer = async (maxTokens: number) => {
        const response = await this.client.messages.create({
          model: compactionModel,
          max_tokens: maxTokens,
          system: `You are a conversation summarizer. ${instructions}\nWrap your summary in <summary></summary> tags.`,
          messages: msgs,
          // Prefill and extended thinking are mutually exclusive API features
          // — and thinking burned the output budget here anyway (the
          // max_tokens retry below exists for exactly that, kept as defense
          // in depth for providers that ignore this flag).
          thinking: { type: "disabled" },
        });

        const text = response.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        // The request ends with the <summary> prefill — extraction prepends
        // it back before matching (see extractSummary).
        const summary = AnthropicSession.extractSummary(text);

        const stopReason = (response as any).stop_reason as string | undefined;
        const blockTypes = response.content.map((b: any) => b.type);
        const usage = (response as any).usage;

        log.info({
          label: this.label,
          compactionModel,
          maxTokens,
          stopReason,
          blockTypes,
          summaryLength: summary.length,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
        }, "AnthropicSession: compaction summarizer response");

        // Summarizer calls are real billed API usage — record them like every
        // other call so cost analysis and incident forensics see them.
        if (usage) {
          logUsage({
            sessionId: this.label,
            instanceId: this.sessionId,
            effort: this.highEffort ? "xhigh" : "high",
            model: compactionModel,
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          });
        }

        return { summary, stopReason, blockTypes };
      };

      let result = await callSummarizer(BASE_MAX_TOKENS);

      // Thinking-budget exhaustion: adaptive-thinking models can spend the
      // entire max_tokens budget on thinking blocks and return ZERO text
      // (stop_reason "max_tokens"). Exactly one retry with a 4x budget,
      // clamped to the model's output ceiling.
      if (result.summary.length === 0 && result.stopReason === "max_tokens") {
        const retryBudget = Math.min(BASE_MAX_TOKENS * 4, getMaxOutput(compactionModel));
        log.warn(
          { label: this.label, retryBudget, blockTypes: result.blockTypes },
          "AnthropicSession: summarizer exhausted max_tokens with no text — retrying with larger budget",
        );
        result = await callSummarizer(retryBudget);
      }

      // ── Empty-summary guard ─────────────────────────────────────────────
      // An empty summary is ALWAYS a failure. The short-summary floor is
      // PROPORTIONAL to context size (F-compact-2.4) — a large context cannot
      // legitimately summarize to a tweet. Incident #2: 84 chars passed the
      // old absolute 50-char floor for a 416k-token context. Small sessions
      // (≤10k tokens) keep no floor — they can summarize to a sentence.
      const LARGE_CONTEXT_TOKENS = 10_000;
      const minSummaryChars = tokensBefore > 200_000 ? 800 : tokensBefore > 50_000 ? 300 : 50;
      const empty = result.summary.length === 0;
      const tooShort = !empty && tokensBefore > LARGE_CONTEXT_TOKENS && result.summary.length < minSummaryChars;
      if (empty || tooShort) {
        const failReason = `summarizer returned ${empty ? "an empty" : "a suspiciously short"} summary `
          + `(${result.summary.length} chars for ~${tokensBefore} tokens, floor=${minSummaryChars}, stop_reason=${result.stopReason ?? "?"}, `
          + `blocks=[${result.blockTypes.join(",")}]) — history preserved`;
        log.error(
          { label: this.label, tokensBefore, summaryLength: result.summary.length, stopReason: result.stopReason, blockTypes: result.blockTypes },
          "AnthropicSession: compaction ABORTED — unusable summary, history preserved",
        );
        yield {
          type: "compaction_failed",
          compactionFailed: { engine: "fallback", reason: failReason, tokensBefore },
        };
        return;
      }

      // ── Pre-compact backup ──────────────────────────────────────────────
      // Archive the FULL history BEFORE replacing it. If the write fails,
      // ABORT: an oversized context is recoverable, destroyed history is not.
      if (!archivePreCompactBackup(this.label, this.messages)) {
        const failReason = "pre-compaction backup write failed — compaction aborted, history preserved";
        log.error({ label: this.label, tokensBefore }, "AnthropicSession: compaction ABORTED — backup failed");
        yield {
          type: "compaction_failed",
          compactionFailed: { engine: "fallback", reason: failReason, tokensBefore },
        };
        return;
      }

      const summary = result.summary;

      // Replace message history with summary
      this.injectedContextCount = 0; // compaction wipes all messages — reset ephemeral tracking
      // Reset growth baseline — history was just replaced, so the old token count
      // is no longer a valid baseline. The next turn will skip the growth check.
      this.previousRealInputTokens = 0;
      this.messages = [
        { role: "user", content: `[Previous conversation summary]\n\n${summary}` },
        { role: "assistant", content: "Understood. I have the context from our previous conversation. How would you like to proceed?" },
      ];

      const tokensAfter = Math.ceil(summary.length / 4); // rough estimate

      log.info({ label: this.label, tokensBefore, tokensAfterEstimate: tokensAfter, summaryLength: summary.length }, "AnthropicSession: Engine B compaction complete");

      yield {
        type: "compaction",
        compaction: {
          summary,
          engine: "fallback",
          tokensBefore,
          tokensAfter,
        },
      };
    } catch (err) {
      log.error({ label: this.label, err }, "AnthropicSession: Engine B compaction failed");
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "compaction_failed",
        compactionFailed: {
          engine: "fallback",
          reason: `summarizer call failed: ${msg.slice(0, 300)}`,
          tokensBefore,
        },
      };
    }
  }

  measureContext(): { systemChars: number; messagesChars: number; messageCount: number; toolsChars: number; totalTokensEst: number } {
    // System prompt size
    const sys = this.getSystemPrompt();
    const systemChars = typeof sys === "string"
      ? sys.length
      : Array.isArray(sys)
        ? sys.reduce((sum, b) => sum + ((b as any).text?.length ?? 0), 0)
        : 0;

    // Messages size. Per-block accounting (F-compact-2.5):
    //   - image blocks: flat 6,400 chars (≈1.6k tokens at chars/4). Anthropic
    //     bills images by DIMENSIONS, not bytes — the base64 payload (100k+
    //     chars for a screenshot) must never leak into the estimate.
    //   - tool_result blocks: recurse into nested content (string or block
    //     array). Before this, everything inside a tool_result contributed
    //     ZERO chars, hiding tool-heavy histories from the heuristic.
    //   - everything else: text length, or JSON length of tool_use input.
    const IMAGE_BLOCK_EST_CHARS = 6_400;
    const blockChars = (b: any): number => {
      if (b?.type === "image") return IMAGE_BLOCK_EST_CHARS;
      if (b?.type === "tool_result") {
        if (typeof b.content === "string") return b.content.length;
        if (Array.isArray(b.content)) return b.content.reduce((s: number, ib: any) => s + blockChars(ib), 0);
        return 0;
      }
      return b?.text?.length ?? (b?.input ? JSON.stringify(b.input).length : 0);
    };
    const messagesChars = this.messages.reduce((sum, m) => {
      if (typeof m.content === "string") return sum + m.content.length;
      if (Array.isArray(m.content)) return sum + m.content.reduce((s, b: any) => s + blockChars(b), 0);
      return sum;
    }, 0);

    // Tools size
    const rawTools = this.getTools();
    const toolsChars = JSON.stringify(rawTools).length;

    // Heuristic estimate (chars/4). Used as fallback before any API response
    // has been received for this session, OR when it gives a HIGHER number
    // than the real measurement (e.g. lots of new content was just appended
    // since the last API call).
    const heuristicEst = Math.ceil((systemChars + messagesChars + toolsChars) / 4);

    // Prefer the REAL total input tokens from the last API response when available.
    // chars/4 systematically underestimates 3-4x when tools/structured content are
    // involved. Take the MAX of the two — gives the routing layer the most
    // pessimistic (= safest for cost) estimate.
    const totalTokensEst = this.lastRealInputTokens > 0
      ? Math.max(this.lastRealInputTokens, heuristicEst)
      : heuristicEst;

    return {
      systemChars,
      messagesChars,
      messageCount: this.messages.length,
      toolsChars,
      totalTokensEst,
    };
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    // Snapshot the current token count BEFORE the API call so growthCompact can
    // compare previous vs current after the response arrives.
    this.previousRealInputTokens = this.lastRealInputTokens;
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    // Defensive sanitization right before every API call.
    //
    // Why here and not only on restore: long-running sessions accumulate two
    // classes of API-rejecting shape errors that can't all be prevented at
    // the push sites — they emerge from races between abort, capability.result,
    // compaction, and new prompts:
    //
    //   - orphan tool_use without a matching tool_result
    //     (e.g. abort fired AFTER streamFromAPI pushed the assistant message
    //      but BEFORE state reached waiting_tools, so cleanupAbortedTools
    //      never ran for that id)
    //   - duplicate tool_result blocks for the same tool_use_id
    //     (e.g. cleanupAbortedTools injected a synthetic placeholder and
    //      the real capability.result later raced in via handleToolResult
    //      while a new turn had the session back in waiting_tools)
    //
    // Both produce HTTP 400 from Anthropic and brick the session permanently
    // unless somebody manually edits the saved history file. sanitizeMessages
    // is idempotent and side-effect-free, so running it on every turn is
    // cheap insurance — it's a no-op on a clean history.
    const sanitized = sanitizeMessages(this.messages);
    if (sanitized.length !== this.messages.length) {
      log.warn(
        { label: this.label, before: this.messages.length, after: sanitized.length },
        "AnthropicSession: sanitizer changed message count before API call",
      );
    }
    this.messages = sanitized;

    // Apply this provider's cache breakpoint policy. Strip any cache_control
    // that may have leaked into messages (defensive — Mnemosyne and other
    // plugins now inject pure content, but old saved sessions or third-party
    // injectors might still carry markers) and then place exactly ONE
    // ephemeral breakpoint anchored to the last completed assistant turn.
    // See placeMessageCacheBreakpoint() for the rationale.
    this.stripAllMessageCacheControl();
    this.placeMessageCacheBreakpoint();

    const ctx = this.measureContext();
    log.info({
      label: this.label,
      traceId: this.turnTraceId,
      messageCount: ctx.messageCount,
      toolCount: toolNames.length,
      context: {
        systemChars: ctx.systemChars,
        messagesChars: ctx.messagesChars,
        toolsChars: ctx.toolsChars,
        totalTokensEst: ctx.totalTokensEst,
      },
    }, "AnthropicSession: calling API");

    // Detailed message structure only at debug level
    log.debug({ label: this.label, tools: toolNames, messages: this.messages.map((m, i) => {
      const role = m.role;
      if (typeof m.content === "string") return { i, role, type: "text", length: m.content.length };
      if (Array.isArray(m.content)) return { i, role, blocks: m.content.map((b: any) => ({ type: b.type, ...(b.type === "tool_use" ? { name: b.name } : {}), ...(b.type === "tool_result" ? { tool_use_id: b.tool_use_id } : {}) })) };
      return { i, role };
    }) }, "AnthropicSession: message structure");

    // Resolve the model ONCE for this turn. getModel() consumes nextModelOverride;
    // we then reuse `modelForCall` for every internal API call (beta + standard +
    // logging) so the whole turn uses one consistent model.
    const modelForCall = this.getModel();
    const maxOutForCall = getMaxOutput(modelForCall);
    log.info({ label: this.label, model: modelForCall }, "AnthropicSession: model resolved for this turn");

    try {
      // Build the tools array for the API call.
      // - Local tools: full Anthropic.Tool shape (name, description, input_schema).
      // - Server tools: { type, name } only — Anthropic resolves schema internally.
      // Cache breakpoint (BP1) goes on the LAST entry regardless of kind.
      const tools: any[] | undefined = rawTools.length > 0
        ? rawTools.map((t, i) => ({
            ...t,
            ...(i === rawTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
          }))
        : undefined;

      this.abortController = new AbortController();

      const betaHeaders = this.getBetaHeaders(modelForCall);
      const betas: string[] = [...betaHeaders];
      // effort is only supported by Sonnet and Opus — Haiku rejects it.
      const modelSupportsEffort = !modelForCall.includes("haiku");
      if (modelSupportsEffort && !betas.includes("effort-2025-11-24")) {
        betas.push("effort-2025-11-24");
      }

      // effort: "max" for high-effort sessions (factory marks the default
      // session), "high" for background sessions. NOTE: some models don't support
      // "xhigh" — use "max" which is universally accepted by all models that
      // support the effort-2025-11-24 beta header.
      const effort = modelSupportsEffort ? (this.highEffort ? "max" : "high") : undefined;

      // metadata.user_id: mirrors CC pattern — session_id for backend cache optimization
      const metadata = { user_id: JSON.stringify({ session_id: this.sessionId }) };

      let message: any | undefined;

      // Beta path: used whenever any beta header is needed (1M context,
      // server-side compaction, or both). The beta endpoint is a strict
      // superset of the standard endpoint when no betas are passed, so we
      // ONLY take this branch when there's actually a beta to enable —
      // otherwise we use the standard endpoint to keep the path simple.
      if (betas.length > 0) {
        try {
          log.info({
            label: this.label,
            model: modelForCall,
            betas,
          }, "AnthropicSession: attempting beta API call");
          const betaStream = (this.client.beta.messages as any).stream({
            model: modelForCall,
            max_tokens: maxOutForCall,
            system: this.getSystemPrompt(),
            messages: this.messages,
            tools,
            // NOTE: top-level cache_control intentionally removed — this provider
            // owns explicit cache_control placement on (a) BP1+BP2 = the two
            // system blocks (factory.ts), (b) BP3 = the last tool definition,
            // and (c) BP4 = the last assistant message in history (placed by
            // placeMessageCacheBreakpoint above). That uses Anthropic's full
            // 4-breakpoint budget for stable, deterministic positions.
            betas,
            metadata,
            ...(effort !== undefined ? { output_config: { effort } } : {}),

          }, { signal: this.abortController.signal });

          betaStream.on("text", () => {});
          message = await betaStream.finalMessage();
        } catch (betaErr: any) {
          const status = betaErr?.status ?? betaErr?.response?.status;
          const errMsg = String(betaErr?.message ?? betaErr ?? "");
          const isNetworkError = /terminated|socket|ECONNRESET|ETIMEDOUT|other side closed/i.test(errMsg);
          const isBetaError = status === 400 || /beta|compact|context-1m/i.test(errMsg) || isNetworkError;
          if (isBetaError) {
            log.warn({ label: this.label, status, err: errMsg, betas }, "AnthropicSession: beta API failed, falling back to standard API");
            this.betaDisabledUntil = Date.now() + AnthropicSession.BETA_COOLDOWN_MS;
            message = undefined; // fall through to standard path
          } else {
            throw betaErr; // non-beta error, propagate
          }
        }
      }

      // Standard path (no betas needed, or beta fallback)
      if (!message) {
        const stream = this.client.messages.stream({
          model: modelForCall,
          max_tokens: maxOutForCall,
          system: this.getSystemPrompt(),
          messages: this.messages,
          tools,
          // top-level cache_control removed — see comment in beta path above.
          metadata,
          ...(effort !== undefined ? { output_config: { effort } } : {}),
        } as any, { signal: this.abortController.signal });

        stream.on("text", () => {});
        message = await stream.finalMessage();
      }

      // Process response content
      const toolCalls: CapabilityCall[] = [];
      let fullText = "";
      let compactionSummary: string | undefined;

      for (const block of message.content) {
        if (block.type === "text") {
          fullText += block.text;
        } else if (block.type === "tool_use") {
          // Sanitize literal `\uXXXX` escapes in string leaves of the input.
          // Opus occasionally emits double-escaped Unicode in tool_use JSON
          // (e.g. "Ter\\u00e7a" instead of "Terça") — without this pass the
          // user-visible strings (jarvis_ask_choice questions, HUD labels)
          // would render with literal escape sequences. See
          // unescape-tool-input.ts for the full rationale.
          const cleanInput = unescapeToolInput(
            block.input as Record<string, unknown>,
          );
          const tc: CapabilityCall = { id: block.id, name: block.name, input: cleanInput };
          toolCalls.push(tc);
        } else if (block.type === "server_tool_use") {
          // Server tool executed by Anthropic internally — no tool_result needed.
          // The matching server_tool_result block follows in the same turn.
          // We do NOT add to toolCalls — no round-trip back to the API required.
          log.info(
            { label: this.label, tool: (block as any).name, id: (block as any).id },
            "AnthropicSession: server_tool_use (executed server-side, no round-trip)",
          );
        } else if (block.type === "compaction") {
          compactionSummary = (block as any).content;
        }
      }

      // Yield text and tool_use events
      if (fullText) {
        yield { type: "text_delta", text: fullText };
      }
      for (const tc of toolCalls) {
        yield { type: "tool_use", toolUse: tc };
      }

      // Handle compaction
      if (compactionSummary) {
        const iterationsArr = (message.usage as any)?.iterations;
        const tokensBefore = iterationsArr?.[0]?.input_tokens ?? message.usage?.input_tokens ?? 0;
        const tokensAfter = message.usage?.input_tokens ?? 0;

        // Replace message history with compacted context.
        // CRITICAL: filter out 'compaction' blocks — they are valid in API
        // OUTPUT but rejected as INPUT (Anthropic API v2026-01-12). Keep only
        // text/tool_use blocks so subsequent turns don't fail with 400.
        this.injectedContextCount = 0; // compaction wipes all messages — reset ephemeral tracking
        const sanitized = (message.content as any[]).filter(b => b?.type !== "compaction");
        this.messages = sanitized.length > 0
          ? [{ role: "assistant", content: sanitized }]
          : [{ role: "assistant", content: [{ type: "text", text: `[Previous conversation compacted by Anthropic API]\n${compactionSummary}` }] }];

        yield {
          type: "compaction",
          compaction: {
            summary: compactionSummary,
            engine: "api",
            tokensBefore,
            tokensAfter,
          },
        };

        log.info({
          label: this.label,
          engine: "api",
          tokensBefore,
          tokensAfter,
          reduction: tokensBefore > 0 ? `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%` : "N/A",
        }, "AnthropicSession: compaction applied");
      }

      // Push assistant message to history whenever there's content to preserve,
      // unless compaction already replaced the history above.
      // This includes stop_reason === "tool_use" (so the tool_use blocks are
      // persisted before addToolResults appends the matching tool_result).
      //
      // ABORT GUARD: if the AbortController fired while the API was still
      // generating (race between ESC and finalMessage() resolving), the turn
      // was cancelled mid-flight. Do NOT push the assistant message — it would
      // leave an orphan tool_use in history with no matching tool_result,
      // causing a 400 on every subsequent turn. consumeStream already handles
      // the stale-turn check by comparing traceId, but the push here happens
      // INSIDE streamFromAPI, before consumeStream gets to run the guard.
      const wasAborted = this.abortController?.signal.aborted ?? false;
      if (!wasAborted && message.stop_reason !== "compaction" && !compactionSummary && message.content.length > 0) {
        this.messages.push({ role: "assistant", content: message.content });
      } else if (wasAborted) {
        log.info(
          { label: this.label, stopReason: message.stop_reason, toolUseCount: toolCalls.length },
          "AnthropicSession: skipping assistant message push — turn was aborted (prevents orphan tool_use)",
        );
      }

      const iterations = (message.usage as any)?.iterations;
      const usage = message.usage ? {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: (message.usage as any).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: (message.usage as any).cache_read_input_tokens ?? 0,
        ...(iterations ? { iterations } : {}),
      } : undefined;

      // Emit provider-specific, sessionId-scoped usage telemetry.
      // This is the primary channel for Anthropic metrics going forward;
      // the generic `api.usage` (published by JarvisCore) remains for backcompat.
      // Pass `modelForCall` so the log records the actual billed model, not
      // whatever the dynamic config has drifted to since the request started.
      if (usage) this.emitAnthropicUsage(modelForCall, usage);

      // pause_turn: Anthropic paused a long-running server-tool turn.
      // Continue by re-calling streamFromAPI with the current history
      // (the assistant message was already pushed above). This is transparent
      // to the caller — the turn resumes without a new user message.
      if (message.stop_reason === "pause_turn") {
        log.info({ label: this.label }, "AnthropicSession: pause_turn — continuing server-tool turn");
        if (usage) this.emitAnthropicUsage(modelForCall, usage);
        yield { type: "message_complete", stopReason: "pause_turn" as AIStreamEvent["stopReason"], usage };
        yield* this.streamFromAPI();
        return;
      }

      yield {
        type: "message_complete",
        stopReason: message.stop_reason as AIStreamEvent["stopReason"],
        usage,
      };

      // Engine B: check if compaction is needed (only if Engine A didn't trigger).
      // Three independent triggers, checked in priority order:
      //   1. Sliding window (proactive, turn-based) — slidingWindowCompact
      //   2. Absolute threshold (80% of context window) — fallbackCompact
      //   3. Abrupt growth (>15% increase in a single turn) — growthCompact
      // Only one runs per turn: first trigger that fires wins, others skip.
      //
      // Sliding-window receives stop_reason and self-gates: it bails out when
      // stop_reason === "tool_use" so it never fires mid-tool-loop. Threshold
      // and growth checks DO run on every API response because they protect
      // against context overflow regardless of turn structure.
      if (!compactionSummary && usage) {
        const totalInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

        // 1. Sliding window — proactive turn-based compaction
        let compacted = false;
        for await (const evt of this.slidingWindowCompact(message.stop_reason as string | undefined)) {
          yield evt;
          if (evt.type === "compaction") compacted = true;
        }

        // 2. Absolute threshold — only if sliding window didn't already compact
        if (!compacted) {
          for await (const evt of this.fallbackCompact(totalInput)) {
            yield evt;
            if (evt.type === "compaction") compacted = true;
          }
        }

        // 3. Abrupt growth — only if neither of the above fired
        if (!compacted) {
          yield* this.growthCompact(totalInput);
        }
      }

      const ctxAfter = this.measureContext();
      log.info({
        label: this.label,
        traceId: this.turnTraceId,
        ms: Date.now() - t0,
        stopReason: message.stop_reason,
        toolCalls: toolCalls.length,
        toolCallNames: toolCalls.map(tc => tc.name),
        textLength: fullText.length,
        textPreview: fullText.slice(0, 300),
        usage,
        contextAfter: {
          messageCount: ctxAfter.messageCount,
          systemChars: ctxAfter.systemChars,
          messagesChars: ctxAfter.messagesChars,
          totalTokensEst: ctxAfter.totalTokensEst,
        },
      }, "AnthropicSession: API call complete");

      this.abortController = undefined;

    } catch (err: any) {
      // Detect abort — either via our own AbortController or native AbortError
      // from the fetch/stream layer (name === "AbortError" or message contains "aborted").
      const errMsg = String(err?.message ?? err ?? "");
      const isAbort = this.abortController?.signal.aborted
        || err?.name === "AbortError"
        || /request was aborted|aborted/i.test(errMsg);
      if (isAbort) {
        log.info({ label: this.label }, "AnthropicSession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }

      // Detect "Could not process image" errors and recover by stripping images
      if (errMsg.includes("Could not process image")) {
        log.warn({ label: this.label }, "AnthropicSession: image processing error detected, stripping images from history and retrying");
        const stripped = this.stripImagesFromMessages();
        if (stripped > 0) {
          log.info({ label: this.label, strippedImages: stripped }, "AnthropicSession: images stripped, retrying API call");
          yield* this.streamFromAPI();
          return;
        }
        // If no images were found to strip, fall through to normal error
        log.warn({ label: this.label }, "AnthropicSession: no images found to strip despite image error");
      }

      log.error({ label: this.label, traceId: this.turnTraceId, err }, "AnthropicSession: API error");
      // Build a human-readable error string from the Anthropic SDK error shape.
      // err.status  → HTTP status code (e.g. 529, 529, 400)
      // err.error   → { type: 'error', error: { type: '...', message: '...' } }
      // err.message → "<status> <raw JSON body>"  (SDK default)
      const humanError = (() => {
        const status = (err as any)?.status as number | undefined;
        const inner = (err as any)?.error?.error; // { type, message }
        if (inner?.message) {
          const label = inner.type
            ? inner.type.replace(/_/g, ' ')
            : 'API error';
          return status
            ? `[${status}] ${label}: ${inner.message}`
            : `${label}: ${inner.message}`;
        }
        // Fallback: strip the raw JSON body from err.message if present
        const rawMsg = String((err as any)?.message ?? err ?? '');
        const stripped = rawMsg.replace(/^(Error:\s*)?\d+\s*/, '').replace(/^\{.*\}$/, '').trim();
        return stripped || rawMsg.slice(0, 200);
      })();
      yield { type: "error", error: humanError };
    }
  }

  /**
   * Walk all messages and replace image blocks with a text placeholder.
   * Returns the number of images stripped.
   */
  /**
   * Inject ephemeral context from message-mode skills.
   * Memory blocks from contextInjector are concatenated into the user message
   * as an ephemeral block — no extra messages, no alternation issues.
   * This field is kept for compaction reset only (no longer tracks injected messages).
   */
  private injectedContextCount = 0; // kept for compaction reset compat

  private stripImagesFromMessages(): number {
    let count = 0;
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (let i = msg.content.length - 1; i >= 0; i--) {
        const block = msg.content[i] as any;
        if (block.type === "image") {
          msg.content.splice(i, 1, {
            type: "text",
            text: "[Image removed: could not be processed by API]",
          } as any);
          count++;
        }
      }
    }
    return count;
  }
}
