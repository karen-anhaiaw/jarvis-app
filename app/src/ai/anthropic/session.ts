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
import { getMaxContext, getMaxOutput, supportsLongContext } from "../../config/index.js";

type CapabilityDef = { name: string; description: string; input_schema: Record<string, unknown> };
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
  private messages: MessageParam[] = [];
  private label: string;
  private abortController?: AbortController;
  private contextInjector?: (sessionId: string) => string[] | Promise<string[]>;
  private bus?: EventBus;
  private betaDisabledUntil = 0;
  private static BETA_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  private consecutiveFallbacks = 0;
  private static MAX_CONSECUTIVE_FALLBACKS = 2;
  /**
   * Real total input tokens from the LAST API response (input + cache_read + cache_create).
   * Set after every successful response. Used by measureContext() to override the
   * char/4 heuristic with the truth — chars/4 systematically underestimates by 3-4x
   * when tools and structured content are involved (Anthropic tokenizer counts JSON,
   * cache_control markers, and structured blocks differently from raw text).
   */
  private lastRealInputTokens = 0;

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
  }) {
    this._sessionId = opts.restoredSessionId ?? crypto.randomUUID();
    // One Anthropic client per session, with NuLLM/LiteLLM identity headers
    // mirroring Claude Code CLI so traffic is attributed to the `claude_code`
    // bucket in nullm_vendor_usage_by_event (AI Tools Dashboard pipeline).
    // X-Claude-Code-Session-Id is set here once and reused for every request
    // this session ever issues — no per-call header overrides needed.
    this.client = new Anthropic({
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
      effort: this.label === "main" ? "xhigh" : "high",
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
   * Set a per-session tool filter. Called by plugins (e.g. actor-runner) to
   * restrict the visible tool surface based on role configuration.
   * Pass `undefined` to clear (reverts to all tools visible).
   */
  setToolFilter(filter: ((toolName: string) => boolean) | undefined): void {
    this.toolFilter = filter;
  }

  /**
   * Effective tools for this session — raw registry filtered by `toolFilter`.
   * Called from every site that previously used `this.getTools()` directly.
   * Logs filter stats once per filtered call so we can audit drift.
   */
  private getTools(): CapabilityDef[] {
    const raw = this.getRawTools();
    if (!this.toolFilter) return raw;
    return raw.filter((t) => this.toolFilter!(t.name));
  }

  async *sendAndStream(prompt: string | import("../types.js").PromptBlock[], images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
    const promptBlocks: Array<{ type: "text"; text: string }> = Array.isArray(prompt)
      ? prompt
      : [{ type: "text", text: prompt }];
    const promptPreviewText = promptBlocks.map(b => b.text).join(" ").slice(0, 120);

    log.info({
      label: this.label,
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

    // Strip cache_control from any prior memory blocks in the history.
    // We add a fresh ephemeral cache_control on the new memory block below,
    // and Anthropic enforces a hard limit of 4 cache_control blocks per request
    // (system + tools + messages combined). Old memory blocks shouldn't keep
    // their cache_control — they're stale, won't get cache hits, and just eat
    // breakpoints. Only the most recent memory block (this turn) is worth caching.
    if (memoryText) {
      this.stripStaleMemoryCacheControl();
    }

    if (images && images.length > 0) {
      const content: ContentBlockParam[] = [];
      if (memoryText) {
        content.push({ type: "text", text: memoryText, cache_control: { type: "ephemeral" } } as any);
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
          { type: "text", text: memoryText, cache_control: { type: "ephemeral" } } as any,
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
   * Remove cache_control from old memory/context text blocks in history.
   *
   * Background: every turn that injects memory adds a `cache_control: ephemeral`
   * marker on the memory text block. Without cleanup these accumulate, and
   * Anthropic rejects requests with more than 4 cache_control blocks total
   * (system + tools + messages). The actor pool was hitting "Found 6" / "Found 5"
   * after a few dozen turns.
   *
   * Strategy: a memory block is identifiable as a user-role text block whose
   * text starts with "<system-reminder>" (the wrapper Mnemosyne uses) AND
   * carries cache_control. Strip the marker — leave the text intact so the
   * model still sees the past memories, just without paying for a stale
   * cache breakpoint.
   *
   * We also strip any other text blocks in user messages that have
   * cache_control set, to be defensive against future injectors that follow
   * the same pattern.
   */
  private stripStaleMemoryCacheControl(): void {
    let stripped = 0;
    for (const m of this.messages) {
      if (m.role !== "user") continue;
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as any[]) {
        if (block?.type === "text" && block?.cache_control) {
          delete block.cache_control;
          stripped++;
        }
      }
    }
    if (stripped > 0) {
      log.info({ label: this.label, stripped }, "AnthropicSession: stripped stale cache_control markers from prior memory blocks");
    }
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

    const toolResultBlocks: ToolResultBlockParam[] = results.map(r => ({
      type: "tool_result" as const,
      tool_use_id: r.tool_use_id,
      content: r.content as ToolResultBlockParam["content"],
      is_error: r.is_error,
    }));
    this.messages.push({ role: "user", content: toolResultBlocks });
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

    const maxCtx = getMaxContext();
    const safetyThreshold = Math.floor(maxCtx * 0.95);

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

    log.info({ label: this.label, tokensBefore: lastInputTokens, threshold: safetyThreshold }, "AnthropicSession: Engine B fallback compaction triggered");

    yield* this.doCompact(lastInputTokens, "threshold");
  }

  /**
   * Core compaction logic shared by both fallbackCompact and forceCompact.
   * Sends messages to a summarizer, replaces history with the summary.
   */
  private async *doCompact(tokensBefore: number, reason: "forced" | "threshold"): AsyncGenerator<AIStreamEvent, void> {
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
      // Ensure messages end with a user message (API requirement)
      const msgs = [...this.messages];
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
        msgs.push({ role: "user", content: "Please summarize the conversation above." });
      }

      // Compaction is a UTILITY call: summary doesn't share cache pool with
      // the main loop. Force Haiku regardless of session sticky to capture
      // the price gap (~$3 → ~$0.20 on a 200k context).
      const utilityModel = loadUtilityModel();
      log.info({ label: this.label, utilityModel }, "AnthropicSession: compaction summary using utility model");

      const summaryResponse = await this.client.messages.create({
        model: utilityModel,
        max_tokens: 8192, // summary is short prose, doesn't need the full output budget
        system: `You are a conversation summarizer. ${instructions}\nWrap your summary in <summary></summary> tags.`,
        messages: msgs,
      });

      const summaryText = summaryResponse.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      // Extract content between <summary> tags, or use full text
      const match = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
      const summary = match ? match[1].trim() : summaryText.trim();

      // Replace message history with summary
      this.injectedContextCount = 0; // compaction wipes all messages — reset ephemeral tracking
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

    // Messages size
    const messagesChars = this.messages.reduce((sum, m) => {
      if (typeof m.content === "string") return sum + m.content.length;
      if (Array.isArray(m.content)) return sum + m.content.reduce((s, b: any) => s + (b.text?.length ?? (b.input ? JSON.stringify(b.input).length : 0)), 0);
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
    const rawTools = this.getTools();
    const toolNames = rawTools.map((t: any) => t.name);

    const ctx = this.measureContext();
    log.info({
      label: this.label,
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
      // Add cache_control (BP1) to the last tool definition
      const tools: Anthropic.Tool[] | undefined = rawTools.length > 0
        ? rawTools.map((t, i) => ({
            ...t,
            ...(i === rawTools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
          })) as Anthropic.Tool[]
        : undefined;

      this.abortController = new AbortController();

      const betaHeaders = this.getBetaHeaders(modelForCall);
      const betas: string[] = [...betaHeaders];
      // effort is only supported by Sonnet and Opus — Haiku rejects it.
      const modelSupportsEffort = !modelForCall.includes("haiku");
      if (modelSupportsEffort && !betas.includes("effort-2025-11-24")) {
        betas.push("effort-2025-11-24");
      }

      // effort: "max" for main session (highest available), "high" for actors/subagents.
      // NOTE: some models don't support "xhigh" — use "max" which is universally
      // accepted by all models that support the effort-2025-11-24 beta header.
      const effort = modelSupportsEffort ? (this.label === "main" ? "max" : "high") : undefined;

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
            // NOTE: top-level cache_control intentionally removed — it added an extra
            // cache breakpoint on top of the explicit cache_control we already place on
            // (a) the last system block, (b) the last tool, and (c) the ephemeral
            // memory block prepended to the user message. Combined, that pushed us over
            // Anthropic's hard limit of 4 cache_control blocks per request.
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
      if (message.stop_reason !== "compaction" && !compactionSummary && message.content.length > 0) {
        this.messages.push({ role: "assistant", content: message.content });
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

      yield {
        type: "message_complete",
        stopReason: message.stop_reason as AIStreamEvent["stopReason"],
        usage,
      };

      // Engine B: check if fallback compaction needed (only if Engine A didn't trigger)
      if (!compactionSummary && usage) {
        const totalInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        yield* this.fallbackCompact(totalInput);
      }

      const ctxAfter = this.measureContext();
      log.info({
        label: this.label,
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
      if (this.abortController?.signal.aborted) {
        log.info({ label: this.label }, "AnthropicSession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }

      // Detect "Could not process image" errors and recover by stripping images
      const errMsg = String(err?.message ?? err ?? "");
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

      log.error({ label: this.label, err }, "AnthropicSession: API error");
      yield { type: "error", error: String(err) };
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
