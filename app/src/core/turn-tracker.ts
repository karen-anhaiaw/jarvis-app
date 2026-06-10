/**
 * @module core/turn-tracker
 * @see docs/features/turn-tracker.md
 * @see docs/features/bdd/turn-tracker.feature
 * @see docs/modules/core/turn-tracker.md
 *
 * Per-turn lifecycle aggregation (F5, Pillar B — mission jarvis-fix).
 *
 * One TurnSummary per conversation turn (= one traceId), published as
 * `system.event: turn.summary` when the turn closes. JarvisCore calls the
 * tracker methods DIRECTLY at its hook sites (begin / textDelta / roundTrip /
 * toolsDispatched / toolsCompleted / complete / abort / error).
 *
 * WHY in-process and not a bus subscriber: the stale-turn guards
 * (currentTrace mismatch after abort) live in JarvisCore. A bus-subscribing
 * tracker would race them and double-count aborted turns; direct calls
 * inherit the guards for free. The tracker is the PUBLISHER of turn.summary,
 * never a consumer of other events.
 *
 * Invariants (tested):
 * - Exactly one summary per traceId; closing twice is a no-op.
 * - Accumulation calls with a traceId that doesn't match the session's open
 *   turn are silently ignored (stale events after abort).
 * - All usage numbers default to 0 — consumers never see NaN.
 * - A tool's durationMs is ABSENT (not 0) when its result never arrived.
 * - The tracker NEVER throws into JarvisCore paths — every public method is
 *   wrapped; a failing bus publish is logged and swallowed.
 */
import type { TurnSummary, TurnToolStat } from "./types.js";
import { estimateCostUsd, type UsageTokens } from "../ai/pricing.js";
import { log } from "../logger/index.js";

/** Minimal publisher contract — EventBus satisfies it; tests inject a stub. */
interface Publisher {
  publish(msg: Record<string, unknown>): void;
}

interface OpenTurn {
  traceId: string;
  sessionId: string;
  source: string;
  startedAt: number;
  firstDeltaAt?: number;
  roundTrips: number;
  model?: string;
  stopReason?: string;
  textChars: number;
  tools: Map<string, TurnToolStat>; // keyed by toolUseId, insertion-ordered
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface TurnTrackerOptions {
  /** Bus (or stub) used to publish system.event turn.summary. Optional —
   *  a tracker without a publisher still aggregates (recent()/percentiles). */
  publish?: Publisher["publish"];
  /** Clock override for tests. */
  now?: () => number;
  /** Ring buffer capacity (default 50). */
  capacity?: number;
}

const DEFAULT_CAPACITY = 50;

export class TurnTracker {
  private open = new Map<string, OpenTurn>(); // sessionId → open turn
  private buffer: TurnSummary[] = [];          // newest LAST internally
  private readonly publishFn?: Publisher["publish"];
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(opts: TurnTrackerOptions = {}) {
    this.publishFn = opts.publish;
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
  }

  // ─── Lifecycle hooks (called by JarvisCore) ──────────────────────────

  /**
   * Open a turn. If the session already has an open turn (leaked — should
   * not happen given core guards), it is force-closed as error:"superseded"
   * so the invariant "one summary per traceId" still holds for BOTH turns.
   */
  begin(sessionId: string, traceId: string, source: string): void {
    try {
      const leaked = this.open.get(sessionId);
      if (leaked) {
        log.warn({ sessionId, leakedTraceId: leaked.traceId, newTraceId: traceId },
          "TurnTracker: begin over an open turn — force-closing as superseded");
        this.close(leaked, "error", "superseded");
      }
      this.open.set(sessionId, {
        traceId,
        sessionId,
        source,
        startedAt: this.now(),
        roundTrips: 0,
        textChars: 0,
        tools: new Map(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    } catch (err) {
      log.error({ err, sessionId, traceId }, "TurnTracker: begin failed");
    }
  }

  /** Accumulate streamed text; the FIRST call stamps TTFT. */
  textDelta(sessionId: string, traceId: string, chars: number): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    if (t.firstDeltaAt === undefined) t.firstDeltaAt = this.now();
    t.textChars += chars;
  }

  /** One API round-trip finished (message_complete). Usage accumulates. */
  roundTrip(sessionId: string, traceId: string, usage: UsageTokens | undefined, stopReason?: string, model?: string): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    t.roundTrips += 1;
    if (usage) {
      t.usage.input += usage.input_tokens ?? 0;
      t.usage.output += usage.output_tokens ?? 0;
      t.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
      t.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    }
    if (stopReason) t.stopReason = stopReason;
    if (model) t.model = model;
  }

  /** Tools dispatched for this turn — registered as pending (no duration). */
  toolsDispatched(sessionId: string, traceId: string, calls: Array<{ id: string; name: string }>): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    for (const c of calls) {
      t.tools.set(c.id, { name: c.name, toolUseId: c.id, isError: false });
    }
  }

  /** Tool results arrived — stamp duration/error per toolUseId. */
  toolsCompleted(
    sessionId: string,
    traceId: string,
    results: Array<{ tool_use_id: string; is_error?: boolean; durationMs?: number }>,
  ): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    for (const r of results) {
      const stat = t.tools.get(r.tool_use_id);
      if (!stat) continue; // result for a tool we never saw — ignore
      if (typeof r.durationMs === "number") stat.durationMs = r.durationMs;
      stat.isError = r.is_error === true;
    }
  }

  /** Turn finished normally (text-only branch reached). */
  complete(sessionId: string, traceId: string): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    this.open.delete(sessionId);
    this.close(t, "completed");
  }

  /**
   * Turn aborted by the user. traceId optional: abortSession may run after
   * currentTrace was already cleared — omitting it closes whatever turn is
   * open for the session.
   */
  abort(sessionId: string, traceId?: string): void {
    const t = traceId ? this.match(sessionId, traceId) : this.open.get(sessionId);
    if (!t) return;
    this.open.delete(sessionId);
    this.close(t, "aborted");
  }

  /** Provider/dispatch error ended the turn. */
  error(sessionId: string, traceId: string, message: string): void {
    const t = this.match(sessionId, traceId);
    if (!t) return;
    this.open.delete(sessionId);
    this.close(t, "error", message);
  }

  // ─── Introspection (turn-inspector piece, tests) ─────────────────────

  /** TraceId of the session's open turn, if any. */
  openTraceId(sessionId: string): string | undefined {
    return this.open.get(sessionId)?.traceId;
  }

  /** Newest-first slice of closed summaries. */
  recent(n?: number): TurnSummary[] {
    const reversed = [...this.buffer].reverse();
    return typeof n === "number" ? reversed.slice(0, n) : reversed;
  }

  /**
   * Nearest-rank percentiles over ALL tool durations in the buffer.
   * count = number of tool executions with a measured duration.
   */
  toolLatencyPercentiles(): { p50?: number; p95?: number; count: number } {
    const durations = this.buffer
      .flatMap(s => s.tools)
      .map(t => t.durationMs)
      .filter((d): d is number => typeof d === "number")
      .sort((a, b) => a - b);
    if (durations.length === 0) return { count: 0 };
    const rank = (p: number) => durations[Math.max(0, Math.ceil(p * durations.length) - 1)];
    return { p50: rank(0.5), p95: rank(0.95), count: durations.length };
  }

  // ─── Internals ───────────────────────────────────────────────────────

  /** Open turn for the session IF the traceId matches — else undefined. */
  private match(sessionId: string, traceId: string): OpenTurn | undefined {
    const t = this.open.get(sessionId);
    return t && t.traceId === traceId ? t : undefined;
  }

  /** Build the summary, buffer it, publish it, log it. Never throws. */
  private close(t: OpenTurn, outcome: TurnSummary["outcome"], error?: string): void {
    try {
      const endedAt = this.now();
      const totalInput = t.usage.input + t.usage.cacheRead + t.usage.cacheWrite;
      const summary: TurnSummary = {
        traceId: t.traceId,
        sessionId: t.sessionId,
        source: t.source,
        startedAt: t.startedAt,
        endedAt,
        durationMs: endedAt - t.startedAt,
        ...(t.firstDeltaAt !== undefined ? { ttftMs: t.firstDeltaAt - t.startedAt } : {}),
        roundTrips: t.roundTrips,
        ...(t.model ? { model: t.model } : {}),
        ...(t.stopReason ? { stopReason: t.stopReason } : {}),
        outcome,
        ...(error ? { error } : {}),
        textChars: t.textChars,
        tools: [...t.tools.values()],
        usage: {
          input: t.usage.input,
          output: t.usage.output,
          cacheRead: t.usage.cacheRead,
          cacheWrite: t.usage.cacheWrite,
          totalInput,
          total: totalInput + t.usage.output,
        },
      };
      const costUsd = estimateCostUsd(t.model, {
        input_tokens: t.usage.input,
        output_tokens: t.usage.output,
        cache_read_input_tokens: t.usage.cacheRead,
        cache_creation_input_tokens: t.usage.cacheWrite,
      });
      if (costUsd !== undefined) summary.costUsd = costUsd;

      this.buffer.push(summary);
      if (this.buffer.length > this.capacity) {
        this.buffer.splice(0, this.buffer.length - this.capacity);
      }

      log.info({
        traceId: summary.traceId,
        sessionId: summary.sessionId,
        outcome: summary.outcome,
        durationMs: summary.durationMs,
        ttftMs: summary.ttftMs,
        roundTrips: summary.roundTrips,
        tools: summary.tools.length,
        totalTokens: summary.usage.total,
        costUsd: summary.costUsd,
      }, "TurnTracker: turn closed");

      this.publishFn?.({
        channel: "system.event",
        source: "jarvis-core",
        event: "turn.summary",
        data: summary as unknown as Record<string, unknown>,
        traceId: summary.traceId,
      });
    } catch (err) {
      // Tracking must never break a live turn — log and move on.
      log.error({ err, traceId: t.traceId, sessionId: t.sessionId }, "TurnTracker: close failed");
    }
  }
}
