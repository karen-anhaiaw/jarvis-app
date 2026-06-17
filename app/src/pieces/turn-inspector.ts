/**
 * @module pieces/turn-inspector
 * @see docs/features/turn-tracker.md (design decisions #8, #9)
 * @see docs/modules/pieces/turn-inspector.md
 *
 * Turn Inspector — HUD panel with the timeline of recent turns + derived
 * metrics (avg TTFT, tool latency p50/p95, cost/turn, error rate).
 *
 * Pure bus consumer: subscribes to `system.event: turn.summary` (public
 * @jarvis/core 0.8.0 contract) and keeps its OWN ring buffer. Deliberately
 * decoupled from the TurnTracker instance inside JarvisCore — the piece
 * consumes the same event any plugin could, which keeps the public contract
 * exercised by the core product itself (dogfooding) and the piece trivially
 * removable.
 *
 * WHY aggregates live here and not in the provider metrics HUD: turn metrics
 * are provider-agnostic (any model, any provider); the Anthropic metrics
 * panel is provider-scoped. Consumers wanting the aggregates can read this
 * panel's `data` from GET /hud or the SSE stream.
 */
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { SystemEventMessage, TurnSummary } from "../core/types.js";
import { nearestRankPercentile } from "../core/turn-tracker.js";
import { log } from "../logger/index.js";

/** Ring buffer size — matches the tracker default; renderer shows fewer. */
const BUFFER_SIZE = 50;

export class TurnInspectorPiece implements Piece {
  readonly id = "turn-inspector";
  readonly name = "Turn Inspector";

  private bus!: EventBus;
  /** Newest FIRST (renderer consumes top-down). */
  private turns: TurnSummary[] = [];
  private added = false;

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    this.bus.subscribe<SystemEventMessage>("system.event", (msg) => {
      if (msg.event !== "turn.summary") return;
      // data is TurnSummary by the 0.8.0 contract; defensive copy not needed
      // (tracker builds a fresh object per close).
      this.turns.unshift(msg.data as unknown as TurnSummary);
      if (this.turns.length > BUFFER_SIZE) this.turns.length = BUFFER_SIZE;
      this.publishPanel();
    });

    this.publishPanel();
    log.info("TurnInspector: started");
  }

  async stop(): Promise<void> {
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("TurnInspector: stopped");
  }

  /**
   * Derived metrics over the buffer. All numbers 0-defaulted; percentiles
   * undefined when no tool durations exist (renderer shows "—").
   */
  private aggregates(): Record<string, unknown> {
    const completed = this.turns.filter(t => t.outcome === "completed").length;
    const aborted = this.turns.filter(t => t.outcome === "aborted").length;
    const errors = this.turns.filter(t => t.outcome === "error").length;

    const ttfts = this.turns.map(t => t.ttftMs).filter((v): v is number => typeof v === "number");
    const avgTtftMs = ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : undefined;

    const toolDurations = this.turns
      .flatMap(t => t.tools)
      .map(t => t.durationMs)
      .filter((d): d is number => typeof d === "number")
      .sort((a, b) => a - b);

    const costs = this.turns.map(t => t.costUsd).filter((v): v is number => typeof v === "number");
    const totalCostUsd = costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : undefined;

    return {
      count: this.turns.length,
      completed,
      aborted,
      errors,
      avgTtftMs,
      toolP50Ms: nearestRankPercentile(toolDurations, 0.5),
      toolP95Ms: nearestRankPercentile(toolDurations, 0.95),
      toolCount: toolDurations.length,
      totalCostUsd,
      avgCostUsd: costs.length > 0 ? Math.round((totalCostUsd! / costs.length) * 1e6) / 1e6 : undefined,
    };
  }

  /** First publish = add, subsequent = update (HUD flow convention). */
  private publishPanel(): void {
    const data = {
      turns: this.turns,
      aggregates: this.aggregates(),
    };

    if (!this.added) {
      this.added = true;
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
          data,
          position: { x: 1680, y: 130 },
          size: { width: 240, height: 220 },
        },
      });
    } else {
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action: "update",
        pieceId: this.id,
        data,
        status: "running",
      });
    }
  }
}
