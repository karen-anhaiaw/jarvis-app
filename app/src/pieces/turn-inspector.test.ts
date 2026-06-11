/**
 * TurnInspectorPiece tests — consumes the public turn.summary contract
 * (docs/features/bdd/turn-tracker.feature, "Ring buffer / derived metrics").
 * Uses a REAL EventBus: the piece must work as any plugin would.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../core/bus.js";
import { TurnInspectorPiece } from "./turn-inspector.js";
import type { HudUpdateMessage, TurnSummary } from "../core/types.js";

function makeSummary(partial: Partial<TurnSummary>): TurnSummary {
  return {
    traceId: "t0",
    sessionId: "main",
    source: "chat-input",
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    roundTrips: 1,
    outcome: "completed",
    textChars: 10,
    tools: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalInput: 1, total: 2 },
    ...partial,
  };
}

describe("TurnInspectorPiece", () => {
  let bus: EventBus;
  let piece: TurnInspectorPiece;
  let hudUpdates: HudUpdateMessage[];

  beforeEach(async () => {
    bus = new EventBus();
    hudUpdates = [];
    bus.subscribe<HudUpdateMessage>("hud.update", (msg) => {
      if (msg.pieceId === "turn-inspector") hudUpdates.push(msg);
    });
    piece = new TurnInspectorPiece();
    await piece.start(bus);
  });

  it("registers its HUD panel on start (action add)", () => {
    expect(hudUpdates).toHaveLength(1);
    expect(hudUpdates[0].action).toBe("add");
    expect(hudUpdates[0].piece?.data).toMatchObject({ turns: [], aggregates: { count: 0 } });
  });

  it("consumes turn.summary and publishes an update with the turn", async () => {
    bus.publish({
      channel: "system.event",
      source: "jarvis-core",
      event: "turn.summary",
      data: makeSummary({ traceId: "tA", costUsd: 0.5 }) as unknown as Record<string, unknown>,
    });
    await new Promise(r => setTimeout(r, 0)); // bus delivery is sync, but be safe

    const last = hudUpdates.at(-1)!;
    expect(last.action).toBe("update");
    const data = last.data as { turns: TurnSummary[]; aggregates: Record<string, unknown> };
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0].traceId).toBe("tA");
    expect(data.aggregates).toMatchObject({ count: 1, completed: 1, totalCostUsd: 0.5, avgCostUsd: 0.5 });
  });

  it("ignores unrelated system.events", async () => {
    bus.publish({
      channel: "system.event",
      source: "x",
      event: "api.usage",
      data: { whatever: true },
    });
    await new Promise(r => setTimeout(r, 0));
    expect(hudUpdates).toHaveLength(1); // only the initial add
  });

  it("derives percentiles and outcome counts across turns", async () => {
    const turns: Array<Partial<TurnSummary>> = [
      { traceId: "t1", outcome: "completed", ttftMs: 100, tools: [
        { name: "bash", toolUseId: "a", durationMs: 10, isError: false },
        { name: "bash", toolUseId: "b", durationMs: 20, isError: false },
        { name: "bash", toolUseId: "c", durationMs: 30, isError: false },
        { name: "bash", toolUseId: "d", durationMs: 40, isError: false },
        { name: "bash", toolUseId: "e", durationMs: 100, isError: false },
      ] },
      { traceId: "t2", outcome: "aborted", ttftMs: 300 },
      { traceId: "t3", outcome: "error" },
    ];
    for (const t of turns) {
      bus.publish({
        channel: "system.event",
        source: "jarvis-core",
        event: "turn.summary",
        data: makeSummary(t) as unknown as Record<string, unknown>,
      });
    }
    await new Promise(r => setTimeout(r, 0));

    const data = hudUpdates.at(-1)!.data as { turns: TurnSummary[]; aggregates: Record<string, unknown> };
    expect(data.turns[0].traceId).toBe("t3"); // newest first
    expect(data.aggregates).toMatchObject({
      count: 3, completed: 1, aborted: 1, errors: 1,
      avgTtftMs: 200, toolP50Ms: 30, toolP95Ms: 100, toolCount: 5,
    });
  });

  it("unregisters the panel on stop", async () => {
    await piece.stop();
    expect(hudUpdates.at(-1)!.action).toBe("remove");
  });
});
