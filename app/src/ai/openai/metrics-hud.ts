// src/ai/openai/metrics-hud.ts
// Uses piece id "token-counter" (same as AnthropicMetricsHud) so that ModelPicker
// and TokenCounterRenderer work without changes when switching to OpenAI.
import type { EventBus } from "../../core/bus.js";
import type { SystemEventMessage, AIStreamMessage } from "../../core/types.js";
import type { Piece } from "../../core/piece.js";
import type { OpenAISessionFactory } from "./factory.js";
import { config } from "../../config/index.js";
import { log } from "../../logger/index.js";

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

interface SessionBucket {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  lastRequestTokens: number;
  lastModel: string | null;
  requestHistory: RequestSnapshot[];
}

const MAX_REQUEST_HISTORY = 25;

// OpenAI context windows per model
const MAX_CONTEXT: Record<string, number> = {
  "gpt-4o":      128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1":     1047576,
  "o3":          200000,
  "o4-mini":     200000,
};

function getMaxContext(model: string): number {
  return MAX_CONTEXT[model] ?? 128000;
}

export class OpenAIMetricsHud implements Piece {
  // Same id as AnthropicMetricsHud — ModelPicker reads "token-counter"
  readonly id = "token-counter";
  readonly name = "OpenAI Usage";

  private bus!: EventBus;
  private factory: OpenAISessionFactory;
  private unsubs: Array<() => void> = [];
  private hudAdded = false;

  // Per-session buckets
  private buckets = new Map<string, SessionBucket>();
  private globalSeq = 0;

  // Streaming state
  private streamingActive = false;
  private streamingStartMs = 0;
  private streamingVerb = "";
  private streamingOutputChars = 0;
  private streamingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(factory: OpenAISessionFactory) {
    this.factory = factory;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Listen to OpenAI usage events emitted by OpenAISession
    this.unsubs.push(this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "api.openai.usage") return;
      const d = msg.data as any;
      this.onUsage(d.sessionId ?? "main", d.model ?? config.model, d.input_tokens ?? 0, d.output_tokens ?? 0);
    }));

    // Listen to ai.stream for streaming state (visual feedback)
    this.unsubs.push(this.bus.subscribe<AIStreamMessage>("ai.stream", (msg: any) => {
      const type = msg.type ?? msg.event;

      if (type === "delta" && msg.text !== undefined) {
        if (!this.streamingActive) {
          this.streamingActive = true;
          this.streamingStartMs = Date.now();
          this.streamingOutputChars = 0;
          this.streamingVerb = (msg.data as any)?.streamingVerb
            ?? STREAMING_VERBS[Math.floor(Math.random() * STREAMING_VERBS.length)];
          this.startStreamingTimer();
        }
        this.streamingOutputChars += (msg.text ?? "").length;
      }

      if (type === "tool_start") {
        if (!this.streamingActive) {
          this.streamingActive = true;
          this.streamingStartMs = Date.now();
          this.streamingOutputChars = 0;
          this.streamingVerb = "Executing";
          this.startStreamingTimer();
        }
      }

      if (type === "message_complete" || type === "aborted" || type === "error") {
        this.streamingActive = false;
        this.stopStreamingTimer();
        this.publishHud();
      }
    }));

    // Publish initial HUD panel
    this.publishHud(true);
    log.info("OpenAIMetricsHud: started");
  }

  async stop(): Promise<void> {
    this.stopStreamingTimer();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    } as any);
    this.hudAdded = false;
    log.info("OpenAIMetricsHud: stopped");
  }

  private onUsage(sessionId: string, model: string, inputTokens: number, outputTokens: number): void {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = {
        inputTokens: 0, outputTokens: 0, requestCount: 0,
        lastRequestTokens: 0, lastModel: null, requestHistory: [],
      };
      this.buckets.set(sessionId, bucket);
    }

    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.requestCount++;
    bucket.lastRequestTokens = inputTokens;
    bucket.lastModel = model;

    this.globalSeq++;
    const snapshot: RequestSnapshot = {
      seq: this.globalSeq,
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
      cacheRead: 0,
      cacheCreation: 0,
    };
    bucket.requestHistory.push(snapshot);
    if (bucket.requestHistory.length > MAX_REQUEST_HISTORY) {
      bucket.requestHistory.shift();
    }

    this.publishHud();
  }

  private startStreamingTimer(): void {
    if (this.streamingTimer) return;
    this.streamingTimer = setInterval(() => this.publishHud(), 1000);
  }

  private stopStreamingTimer(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer);
      this.streamingTimer = null;
    }
  }

  private publishHud(forceAdd = false): void {
    const data = this.getData();
    if (!this.hudAdded || forceAdd) {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "add",
        pieceId: this.id,
        piece: {
          pieceId: this.id,
          type: "panel",
          name: "Anthropic Usage",   // same name as Anthropic HUD so position is restored
          status: "running",
          data,
          position: { x: 1463, y: 21 },
          size: { width: 361, height: 474 },
        },
      } as any);
      this.hudAdded = true;
    } else {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data,
        status: "running",
      } as any);
    }
  }

  getData(): Record<string, unknown> {
    // Aggregate all session buckets
    let totalInput = 0, totalOutput = 0, totalRequests = 0;
    let lastRequestTokens = 0, lastModel: string | null = null;
    const allHistory: RequestSnapshot[] = [];

    for (const b of this.buckets.values()) {
      totalInput += b.inputTokens;
      totalOutput += b.outputTokens;
      totalRequests += b.requestCount;
      if (b.lastRequestTokens > 0) lastRequestTokens = b.lastRequestTokens;
      if (b.lastModel) lastModel = b.lastModel;
      allHistory.push(...b.requestHistory);
    }

    allHistory.sort((a, b) => a.timestamp - b.timestamp);
    const requestHistory = allHistory.slice(-MAX_REQUEST_HISTORY);

    const model = lastModel ?? config.model;
    const maxContext = getMaxContext(model);
    const contextPct = maxContext > 0 ? lastRequestTokens / maxContext : 0;

    const breakdown = this.factory.getTokenBreakdown();
    const systemTokens = breakdown.systemTokens;
    const toolsTokens = breakdown.toolsTokens;
    const messagesTokens = Math.max(0, lastRequestTokens - systemTokens - toolsTokens);

    return {
      model,
      sessionInputTokens: totalInput,
      sessionOutputTokens: totalOutput,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheCreation: 0,
      cacheRead: 0,
      cachePct: 0,
      contextTokens: lastRequestTokens,
      contextPct,
      maxContext,
      requestCount: totalRequests,
      systemTokens,
      toolsTokens,
      messagesTokens,
      compactionCount: 0,
      lastCompactionEngine: null,
      streaming: this.streamingActive,
      streamingVerb: this.streamingVerb,
      streamingStartMs: this.streamingActive ? this.streamingStartMs : 0,
      streamingOutputChars: this.streamingOutputChars,
      requestHistory,
      scope: "ALL",
      availableScopes: [],
    };
  }
}
