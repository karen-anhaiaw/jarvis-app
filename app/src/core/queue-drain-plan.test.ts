// src/core/queue-drain-plan.test.ts
// Mirrors docs/features/bdd/inter-session-messaging.feature (drainQueue / F2.6).
import { describe, it, expect } from "vitest";
import { planQueueDrain, type QueuedDrainItem } from "./jarvis.js";

const item = (over: Partial<QueuedDrainItem>): QueuedDrainItem => ({
  text: "t",
  source: "chat-input",
  systems: [],
  ...over,
});

describe("planQueueDrain — segmented drain (F2.6)", () => {
  const live = (ids: string[]) => (id: string) => ids.includes(id);

  it("plain user messages combine into one dispatch", () => {
    const q = [item({ text: "a" }), item({ text: "b" }), item({ text: "c" })];
    const plan = planQueueDrain(q, live([]));
    expect(plan.mode).toBe("combine");
    expect((plan as any).items).toHaveLength(3);
  });

  it("head with replyTo dispatches solo", () => {
    const q = [item({ source: "bg-alice", replyTo: "main" }), item({})];
    const plan = planQueueDrain(q, live(["bg-alice"]));
    expect(plan).toEqual({ mode: "solo", item: q[0] });
  });

  it("head inter-session fire-and-forget (live source) dispatches solo", () => {
    const q = [item({ source: "bg-alpha" })];
    const plan = planQueueDrain(q, live(["bg-alpha"]));
    expect(plan).toEqual({ mode: "solo", item: q[0] });
  });

  it("mixed queue: combine stops at the first solo-needing message", () => {
    const q = [
      item({ text: "p1" }),
      item({ text: "p2" }),
      item({ source: "bg-x", replyTo: "main", text: "r" }),
      item({ text: "p3" }),
    ];
    const plan = planQueueDrain(q, live(["bg-x"]));
    expect(plan.mode).toBe("combine");
    expect((plan as any).items.map((i: QueuedDrainItem) => i.text)).toEqual(["p1", "p2"]);
  });

  it("internal sources (cron/jarvis-core) combine even when not in live set", () => {
    const q = [item({ source: "cron", text: "[CRON] tick" }), item({ source: "jarvis-core", text: "x" })];
    const plan = planQueueDrain(q, live([]));
    expect(plan.mode).toBe("combine");
    expect((plan as any).items).toHaveLength(2);
  });

  it("non-session plugin source without replyTo combines (no attribution needed)", () => {
    const q = [item({ source: "plugin-source", text: "memory note" }), item({ text: "user msg" })];
    const plan = planQueueDrain(q, live([]));
    expect(plan.mode).toBe("combine");
    expect((plan as any).items).toHaveLength(2);
  });

  it("any message with replyTo needs solo regardless of source", () => {
    const q = [item({ source: "some-plugin", replyTo: "main" })];
    const plan = planQueueDrain(q, live([]));
    expect(plan.mode).toBe("solo");
  });
});
