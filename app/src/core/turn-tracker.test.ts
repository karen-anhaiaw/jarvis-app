/**
 * TurnTracker unit tests — implements the scenarios from
 * docs/features/bdd/turn-tracker.feature (F5, Pillar B).
 *
 * The tracker is tested standalone with a capturing publish fn and a fake
 * clock — no EventBus, no JarvisCore. The jarvis.ts hook sites are covered
 * by the lifecycle semantics here (begin/firstDelta/roundTrip/tools/close);
 * wiring correctness is asserted by typecheck + live validation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TurnTracker } from "./turn-tracker.js";
import type { TurnSummary } from "@jarvis/core";
import { estimateCostUsd } from "../ai/pricing.js";

// ─── Harness ───────────────────────────────────────────────────────────

let published: Array<{ event: string; data: TurnSummary }> = [];
let now = 1_000_000;
const clock = () => now;

function makeTracker(capacity?: number): TurnTracker {
  published = [];
  now = 1_000_000;
  return new TurnTracker({
    publish: (msg: any) => {
      if (msg.channel === "system.event") {
        published.push({ event: msg.event, data: msg.data as TurnSummary });
      }
    },
    now: clock,
    capacity,
  });
}

const summaries = () => published.filter(p => p.event === "turn.summary").map(p => p.data);

// ─── Lifecycle ─────────────────────────────────────────────────────────

describe("TurnTracker — lifecycle", () => {
  let tracker: TurnTracker;
  beforeEach(() => { tracker = makeTracker(); });

  it("simple text-only turn produces a completed summary", () => {
    tracker.begin("main", "t1", "chat-input");
    now += 120;
    tracker.textDelta("main", "t1", 5);
    now += 200;
    tracker.roundTrip("main", "t1", {
      input_tokens: 100, output_tokens: 50,
      cache_read_input_tokens: 1000, cache_creation_input_tokens: 200,
    }, "end_turn", "claude-opus-4-8");
    tracker.complete("main", "t1");

    expect(summaries()).toHaveLength(1);
    const s = summaries()[0];
    expect(s.outcome).toBe("completed");
    expect(s.traceId).toBe("t1");
    expect(s.sessionId).toBe("main");
    expect(s.source).toBe("chat-input");
    expect(s.roundTrips).toBe(1);
    expect(s.ttftMs).toBe(120);
    expect(s.usage).toEqual({
      input: 100, output: 50, cacheRead: 1000, cacheWrite: 200,
      totalInput: 1300, total: 1350,
    });
    expect(s.stopReason).toBe("end_turn");
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.tools).toEqual([]);
    expect(s.textChars).toBe(5);
    expect(s.durationMs).toBe(320);
    expect(s.endedAt - s.startedAt).toBe(320);
  });

  it("turn with one tool loop accumulates usage and tool stats", () => {
    tracker.begin("main", "t2", "chat-input");
    tracker.roundTrip("main", "t2", { input_tokens: 100, output_tokens: 20 }, "tool_use", "m");
    tracker.toolsDispatched("main", "t2", [
      { id: "tu1", name: "bash" },
      { id: "tu2", name: "read_file" },
    ]);
    tracker.toolsCompleted("main", "t2", [
      { tool_use_id: "tu1", durationMs: 350 },
      { tool_use_id: "tu2", durationMs: 80, is_error: true },
    ]);
    tracker.roundTrip("main", "t2", { input_tokens: 200, output_tokens: 60 }, "end_turn", "m");
    tracker.complete("main", "t2");

    const s = summaries()[0];
    expect(s.roundTrips).toBe(2);
    expect(s.usage.input).toBe(300);
    expect(s.usage.output).toBe(80);
    expect(s.tools).toHaveLength(2);
    const bash = s.tools.find(t => t.name === "bash")!;
    expect(bash).toMatchObject({ toolUseId: "tu1", durationMs: 350, isError: false });
    const rf = s.tools.find(t => t.name === "read_file")!;
    expect(rf).toMatchObject({ toolUseId: "tu2", durationMs: 80, isError: true });
    expect(s.stopReason).toBe("end_turn");
  });

  it("aborted turn closes with outcome aborted and keeps partial data", () => {
    tracker.begin("main", "t3", "chat-input");
    tracker.roundTrip("main", "t3", { input_tokens: 100, output_tokens: 20 }, "tool_use", "m");
    tracker.toolsDispatched("main", "t3", [{ id: "tu9", name: "bash" }]);
    tracker.abort("main", "t3");

    expect(summaries()).toHaveLength(1);
    const s = summaries()[0];
    expect(s.outcome).toBe("aborted");
    expect(s.roundTrips).toBe(1);
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0].durationMs).toBeUndefined();
    expect(s.tools[0].isError).toBe(false);
  });

  it("abort without traceId closes whatever turn is open for the session", () => {
    tracker.begin("main", "t3b", "chat-input");
    tracker.abort("main");
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].traceId).toBe("t3b");
    expect(summaries()[0].outcome).toBe("aborted");
  });

  it("provider error closes the turn with outcome error", () => {
    tracker.begin("main", "t4", "cron");
    tracker.error("main", "t4", "boom");
    const s = summaries()[0];
    expect(s.outcome).toBe("error");
    expect(s.error).toBe("boom");
    expect(s.source).toBe("cron");
  });
});

// ─── Idempotence / guards ──────────────────────────────────────────────

describe("TurnTracker — idempotence and guards", () => {
  let tracker: TurnTracker;
  beforeEach(() => { tracker = makeTracker(); });

  it("closing a turn twice publishes only one summary", () => {
    tracker.begin("main", "t5", "chat-input");
    tracker.complete("main", "t5");
    tracker.abort("main", "t5");
    expect(summaries()).toHaveLength(1);
  });

  it("closing an unknown trace is a no-op", () => {
    tracker.complete("main", "ghost");
    expect(summaries()).toHaveLength(0);
  });

  it("accumulation events for a stale traceId are ignored", () => {
    tracker.begin("main", "t6", "chat-input");
    tracker.roundTrip("main", "stale", { input_tokens: 999, output_tokens: 999 }, "end_turn", "m");
    tracker.textDelta("main", "stale", 100);
    tracker.complete("main", "t6");
    const s = summaries()[0];
    expect(s.usage.input).toBe(0);
    expect(s.usage.output).toBe(0);
    expect(s.textChars).toBe(0);
    expect(s.ttftMs).toBeUndefined();
  });

  it("a new begin for the same session force-closes a leaked open turn", () => {
    tracker.begin("main", "t7", "chat-input");
    tracker.begin("main", "t8", "chat-input");

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].traceId).toBe("t7");
    expect(summaries()[0].outcome).toBe("error");
    expect(summaries()[0].error).toBe("superseded");
    expect(tracker.openTraceId("main")).toBe("t8");
  });

  it("concurrent sessions track independent turns", () => {
    tracker.begin("main", "tA", "chat-input");
    tracker.begin("bg-alice", "tB", "bus");
    tracker.complete("main", "tA");

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].traceId).toBe("tA");
    expect(tracker.openTraceId("bg-alice")).toBe("tB");
  });

  it("never throws when publish fails", () => {
    const t = new TurnTracker({
      publish: () => { throw new Error("bus down"); },
      now: clock,
    });
    t.begin("main", "tX", "chat-input");
    expect(() => t.complete("main", "tX")).not.toThrow();
  });
});

// ─── TTFT ──────────────────────────────────────────────────────────────

describe("TurnTracker — TTFT", () => {
  let tracker: TurnTracker;
  beforeEach(() => { tracker = makeTracker(); });

  it("only the first delta sets TTFT", () => {
    tracker.begin("main", "t9", "chat-input");
    now += 100;
    tracker.textDelta("main", "t9", 3);
    now += 400;
    tracker.textDelta("main", "t9", 3);
    tracker.complete("main", "t9");
    expect(summaries()[0].ttftMs).toBe(100);
    expect(summaries()[0].textChars).toBe(6);
  });

  it("a turn with no text deltas has no ttftMs", () => {
    tracker.begin("main", "t10", "chat-input");
    tracker.complete("main", "t10");
    expect(summaries()[0].ttftMs).toBeUndefined();
  });
});

// ─── Cost estimation (pricing module) ──────────────────────────────────

describe("pricing — estimateCostUsd", () => {
  const oneM = {
    input_tokens: 1_000_000, output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
  };

  it("opus family", () => {
    expect(estimateCostUsd("claude-opus-4-8", oneM)).toBeCloseTo(110.25, 6);
  });
  it("sonnet family", () => {
    expect(estimateCostUsd("claude-sonnet-4-6", oneM)).toBeCloseTo(22.05, 6);
  });
  it("haiku family", () => {
    expect(estimateCostUsd("claude-haiku-4-5", oneM)).toBeCloseTo(5.88, 6);
  });
  it("unknown family yields undefined", () => {
    expect(estimateCostUsd("claude-fable-5", {
      input_tokens: 1000, output_tokens: 1000,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    })).toBeUndefined();
  });
  it("undefined model yields undefined", () => {
    expect(estimateCostUsd(undefined, oneM)).toBeUndefined();
  });

  it("summary costUsd is computed for known families and absent for unknown", () => {
    const tracker = makeTracker();
    tracker.begin("main", "tc1", "chat-input");
    tracker.roundTrip("main", "tc1", { input_tokens: 1_000_000, output_tokens: 0 }, "end_turn", "claude-sonnet-4-6");
    tracker.complete("main", "tc1");

    tracker.begin("main", "tc2", "chat-input");
    tracker.roundTrip("main", "tc2", { input_tokens: 1_000_000, output_tokens: 0 }, "end_turn", "claude-fable-5");
    tracker.complete("main", "tc2");

    const [s1, s2] = summaries();
    expect(s1.costUsd).toBeCloseTo(3.0, 6);
    expect(s2.costUsd).toBeUndefined();
  });
});

// ─── Ring buffer / derived metrics ─────────────────────────────────────

describe("TurnTracker — ring buffer and percentiles", () => {
  it("keeps only the last N summaries, newest first", () => {
    const tracker = makeTracker(3);
    for (let i = 1; i <= 5; i++) {
      tracker.begin("main", `t${i}`, "chat-input");
      tracker.complete("main", `t${i}`);
    }
    const recent = tracker.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map(s => s.traceId)).toEqual(["t5", "t4", "t3"]);
  });

  it("recent(n) limits the slice", () => {
    const tracker = makeTracker(10);
    for (let i = 1; i <= 4; i++) {
      tracker.begin("main", `t${i}`, "chat-input");
      tracker.complete("main", `t${i}`);
    }
    expect(tracker.recent(2).map(s => s.traceId)).toEqual(["t4", "t3"]);
  });

  it("percentile helper computes p50 and p95 over tool durations", () => {
    const tracker = makeTracker();
    const durations = [10, 20, 30, 40, 100];
    tracker.begin("main", "tp", "chat-input");
    tracker.toolsDispatched("main", "tp", durations.map((_, i) => ({ id: `tu${i}`, name: "bash" })));
    tracker.toolsCompleted("main", "tp", durations.map((d, i) => ({ tool_use_id: `tu${i}`, durationMs: d })));
    tracker.complete("main", "tp");

    const p = tracker.toolLatencyPercentiles();
    expect(p.p50).toBe(30);
    expect(p.p95).toBe(100);
    expect(p.count).toBe(5);
  });

  it("percentiles over empty data are undefined", () => {
    const tracker = makeTracker();
    const p = tracker.toolLatencyPercentiles();
    expect(p.p50).toBeUndefined();
    expect(p.p95).toBeUndefined();
    expect(p.count).toBe(0);
  });
});
