// src/ai/anthropic/metrics-hud.ts
import type { EventBus } from "../../core/bus.js";
import type { AIStreamMessage, SystemEventMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import { config, getMaxContext } from "../../config/index.js";
import type { AnthropicSessionFactory } from "./factory.js";
import { log } from "../../logger/index.js";
import { DEFAULT_SESSION } from "../../core/constants.js";

const STREAMING_VERBS = [
  "Analyzing", "Bloviating", "Cogitating", "Deliberating", "Elaborating",
  "Formulating", "Generating", "Hypothesizing", "Inferring", "Juggling",
  "Kernelizing", "Lucubrating", "Musing", "Noodling", "Orchestrating",
  "Pontificating", "Quantifying", "Reasoning", "Synthesizing", "Transmuting",
];

interface RequestSnapshot {
  seq: number;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Per-sessionId bucket — holds accumulated usage stats and a ring buffer of
 * request snapshots. One bucket is created on first observed usage event for
 * a given sessionId, and dropped on `session.closed`.
 */
interface SessionBucket {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  requestCount: number;
  lastRequestTokens: number;
  lastCacheRead: number;
  lastCacheCreate: number;
  lastModel: string | null;
  /** Timestamp of the last usage event that set lastModel. Drives the
   *  "most recent model across buckets" aggregation — without it, the
   *  aggregate picked the last-INSERTED bucket's model (Map iteration
   *  order), showing stale models when background plugin-owned sessions
   *  ran on a different model than the active chat. */
  lastModelAt: number;
  requestHistory: RequestSnapshot[];
}

/** Ring buffer size per session — renderer displays last 25 bars. */
const MAX_REQUEST_HISTORY_PER_SESSION = 25;

/** Special scope value = aggregate of every bucket. Default. */
const SCOPE_ALL = "ALL";

export class AnthropicMetricsHud implements Piece {
  readonly id = "token-counter";
  readonly name = "Anthropic Usage";

  private bus!: EventBus;
  private unsubs: Array<() => void> = [];

  /** Per-session buckets. Key = sessionId ("main" or any plugin-owned sessionId). */
  private buckets = new Map<string, SessionBucket>();

  /** Current HUD scope: "ALL" (aggregate) or a specific sessionId. */
  private currentScope: string = SCOPE_ALL;

  /** Compaction stats — global (not per-session) for now. */
  private compactionCount = 0;
  private lastCompactionEngine: string | null = null;

  private factory: AnthropicSessionFactory;

  // Streaming state (main session only — visual feedback for the chat)
  private streamingActive = false;
  private streamingStartMs = 0;
  private streamingVerb = "";
  private streamingOutputChars = 0;
  private streamingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(factory: AnthropicSessionFactory) {
    this.factory = factory;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Primary telemetry channel — Anthropic-specific, sessionId-scoped.
    // Emitted by AnthropicSession.streamFromAPI after every API response.
    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.anthropic.usage") return;
      const sessionId = (msg.data.sessionId as string) ?? DEFAULT_SESSION;
      this.recordUsage(sessionId, msg.data);
    }));

    // Eviction — SessionManager publishes this when a session is closed.
    // We drop the bucket so it disappears from dropdowns and memory.
    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "session.closed") return;
      const sessionId = msg.data.sessionId as string;
      if (!sessionId) return;
      if (this.buckets.delete(sessionId)) {
        log.info({ sessionId }, "AnthropicMetrics: bucket evicted");
        // If the current scope just disappeared, fall back to ALL.
        if (this.currentScope === sessionId) this.currentScope = SCOPE_ALL;
        this.pushHudUpdate();
      }
    }));

    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "compaction") return;
      this.compactionCount++;
      this.lastCompactionEngine = (msg.data.engine as string) ?? null;
      log.info({ count: this.compactionCount, engine: this.lastCompactionEngine }, "AnthropicMetrics: compaction recorded");
      this.pushHudUpdate();
    }));

    // Track streaming state from ai.stream events (main session only — visual feedback)
    this.unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      // NOTE: streaming indicator still tracks only the default session —
      // multi-session streaming state is F6 (HUD truth) territory.
      if (msg.target !== DEFAULT_SESSION) return;

      switch (msg.event) {
        case "delta":
          if (!this.streamingActive) {
            this.streamingActive = true;
            this.streamingStartMs = Date.now();
            this.streamingOutputChars = 0;
            this.streamingVerb = STREAMING_VERBS[Math.floor(Math.random() * STREAMING_VERBS.length)];
            this.startStreamingTimer();
          }
          this.streamingOutputChars += (msg.text ?? "").length;
          break;

        case "tool_start":
          // Tools starting — pause streaming display, keep timer for elapsed
          if (!this.streamingActive) {
            this.streamingActive = true;
            this.streamingStartMs = Date.now();
            this.streamingOutputChars = 0;
            this.streamingVerb = "Executing";
            this.startStreamingTimer();
          }
          break;

        case "complete":
        case "error":
        case "aborted":
          this.streamingActive = false;
          this.stopStreamingTimer();
          this.pushHudUpdate();
          break;
      }
    }));

    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "panel",
        name: this.name,
        status: "running",
        data: this.getData(),
        position: { x: 1660, y: 100 },
        size: { width: 280, height: 380 },
      },
    });

    log.info("AnthropicMetricsHud: started");
  }

  async stop(): Promise<void> {
    this.stopStreamingTimer();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.buckets.clear();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("AnthropicMetricsHud: stopped");
  }

  /**
   * Change the HUD scope (ALL or a specific sessionId). Re-publishes the
   * panel data immediately so the UI updates.
   */
  setScope(scope: string): void {
    if (scope !== SCOPE_ALL && !this.buckets.has(scope)) {
      log.warn({ scope, available: [...this.buckets.keys()] }, "AnthropicMetrics: unknown scope, ignoring");
      return;
    }
    this.currentScope = scope;
    log.info({ scope }, "AnthropicMetrics: scope changed");
    this.pushHudUpdate();
  }

  getScope(): string {
    return this.currentScope;
  }

  /** List sessionIds that have at least one bucket with data. */
  getAvailableScopes(): string[] {
    return [...this.buckets.keys()].sort();
  }

  private getOrCreateBucket(sessionId: string): SessionBucket {
    let b = this.buckets.get(sessionId);
    if (!b) {
      b = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation: 0,
        cacheRead: 0,
        requestCount: 0,
        lastRequestTokens: 0,
        lastCacheRead: 0,
        lastCacheCreate: 0,
        lastModel: null,
        lastModelAt: 0,
        requestHistory: [],
      };
      this.buckets.set(sessionId, b);
    }
    return b;
  }

  private recordUsage(sessionId: string, d: Record<string, unknown>): void {
    const reqInput = (d.input_tokens as number) ?? 0;
    const reqOutput = (d.output_tokens as number) ?? 0;
    const reqCacheCreate = (d.cache_creation_input_tokens as number) ?? 0;
    const reqCacheRead = (d.cache_read_input_tokens as number) ?? 0;

    const b = this.getOrCreateBucket(sessionId);
    b.inputTokens += reqInput;
    b.outputTokens += reqOutput;
    b.cacheCreation += reqCacheCreate;
    b.cacheRead += reqCacheRead;
    b.lastRequestTokens = reqInput + reqCacheCreate + reqCacheRead;
    b.lastCacheRead = reqCacheRead;
    b.lastCacheCreate = reqCacheCreate;
    if (d.model) {
      b.lastModel = d.model as string;
      b.lastModelAt = Date.now();
    }
    b.requestCount++;

    b.requestHistory.push({
      seq: b.requestCount,
      timestamp: Date.now(),
      inputTokens: reqInput,
      outputTokens: reqOutput,
      cacheRead: reqCacheRead,
      cacheCreation: reqCacheCreate,
    });
    if (b.requestHistory.length > MAX_REQUEST_HISTORY_PER_SESSION) {
      b.requestHistory.shift();
    }

    log.debug({
      sessionId,
      in: reqInput, out: reqOutput,
      cacheNew: reqCacheCreate, cacheHit: reqCacheRead,
    }, "AnthropicMetrics: recorded");

    // Only push HUD update if this event affects the current scope view.
    if (this.currentScope === SCOPE_ALL || this.currentScope === sessionId) {
      this.pushHudUpdate();
    }
  }

  private startStreamingTimer(): void {
    if (this.streamingTimer) return;
    this.streamingTimer = setInterval(() => {
      this.pushHudUpdate();
    }, 1000);
  }

  private stopStreamingTimer(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
  }

  private pushHudUpdate(): void {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: "running",
    });
  }

  /**
   * Build the renderer payload for the current scope.
   * Shape is IDENTICAL to the pre-refactor getData() so TokenCounterRenderer
   * continues to work without changes. The new fields (scope, availableScopes)
   * are additive and consumed only by the scope selector in the renderer.
   */
  getData(): Record<string, unknown> {
    const view = this.computeScopeView();
    const maxContext = getMaxContext(view.lastModel ?? undefined);
    const cachePct = view.lastRequestTokens > 0 ? view.lastCacheRead / view.lastRequestTokens : 0;
    const contextPct = view.lastRequestTokens / maxContext;

    // Static system/tools breakdown — same for every session in this provider.
    const totalInputTokens = view.lastRequestTokens;
    const breakdown = this.factory.getTokenBreakdown();
    const systemTokens = breakdown.systemTokens;
    const toolsTokens = breakdown.toolsTokens;
    const staticTokens = systemTokens + toolsTokens;
    const messagesTokens = Math.max(0, totalInputTokens - staticTokens);

    return {
      model: view.lastModel ?? config.model,
      // Session accumulated totals (in-scope)
      inputTokens: view.inputTokens,
      outputTokens: view.outputTokens,
      sessionInputTokens: view.inputTokens,
      sessionOutputTokens: view.outputTokens,
      cacheCreation: view.cacheCreation,
      cacheRead: view.cacheRead,
      cachePct,
      // Context snapshot (current window usage from last request)
      contextTokens: view.lastRequestTokens,
      contextPct,
      maxContext,
      requestCount: view.requestCount,
      systemTokens,
      toolsTokens,
      messagesTokens,
      compactionCount: this.compactionCount,
      lastCompactionEngine: this.lastCompactionEngine,
      // Streaming state — startMs is stable (doesn't change per tick), elapsed computed by frontend
      streaming: this.streamingActive,
      streamingVerb: this.streamingVerb,
      streamingStartMs: this.streamingActive ? this.streamingStartMs : 0,
      streamingOutputChars: this.streamingOutputChars,
      // Per-request history for sparkline
      requestHistory: view.requestHistory,
      // NEW: scope selector state
      scope: this.currentScope,
      availableScopes: this.getAvailableScopes(),
    };
  }

  /**
   * Return the bucket (or aggregate) currently being displayed.
   * For SCOPE_ALL, sums every bucket and merges histories sorted by timestamp.
   */
  private computeScopeView(): SessionBucket {
    if (this.currentScope !== SCOPE_ALL) {
      return this.buckets.get(this.currentScope) ?? this.emptyBucket();
    }
    return this.aggregateAll();
  }

  private aggregateAll(): SessionBucket {
    const agg = this.emptyBucket();
    const allHistory: RequestSnapshot[] = [];

    for (const b of this.buckets.values()) {
      agg.inputTokens += b.inputTokens;
      agg.outputTokens += b.outputTokens;
      agg.cacheCreation += b.cacheCreation;
      agg.cacheRead += b.cacheRead;
      agg.requestCount += b.requestCount;
      allHistory.push(...b.requestHistory);
    }

    // Merge all histories sorted by timestamp, re-sequence, keep the most recent window.
    allHistory.sort((a, b) => a.timestamp - b.timestamp);
    const sliced = allHistory.slice(-MAX_REQUEST_HISTORY_PER_SESSION);
    agg.requestHistory = sliced.map((snap, i) => ({ ...snap, seq: i + 1 }));

    // "Last request" in ALL scope = most recent snapshot across all sessions.
    const last = sliced[sliced.length - 1];
    if (last) {
      agg.lastRequestTokens = last.inputTokens + last.cacheRead + last.cacheCreation;
      agg.lastCacheRead = last.cacheRead;
      agg.lastCacheCreate = last.cacheCreation;
    }

    // lastModel = model from the bucket with the most RECENT usage event.
    // Comparing by lastModelAt (not Map insertion order) — otherwise any
    // later-created background bucket (any plugin-owned session) would
    // shadow the active session's model in the HUD display.
    let newestAt = -1;
    for (const b of this.buckets.values()) {
      if (b.lastModel && b.lastModelAt > newestAt) {
        newestAt = b.lastModelAt;
        agg.lastModel = b.lastModel;
      }
    }

    return agg;
  }

  private emptyBucket(): SessionBucket {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      requestCount: 0,
      lastRequestTokens: 0,
      lastCacheRead: 0,
      lastCacheCreate: 0,
      lastModel: null,
      lastModelAt: 0,
      requestHistory: [],
    };
  }
}
