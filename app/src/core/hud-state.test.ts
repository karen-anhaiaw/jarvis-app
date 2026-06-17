/**
 * HudState tests — implements the backend scenarios from
 * docs/features/bdd/hud-truth.feature (F6, Pillar A).
 *
 * Frontend scenarios (gap detect → resync, staleness rendering) have no UI
 * test runner in this repo — validated live (documented in the feature doc).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { EventBus } from "./bus.js";
import { HudState } from "./hud-state.js";
import type { HudPieceData } from "./piece.js";
import { log } from "../logger/index.js";

// ─── Harness ───────────────────────────────────────────────────────────

let bus: EventBus;
let hud: HudState;
let written: any[];
let now: number;

/** Fake SSE client capturing every delta written. */
function fakeClient(): ServerResponse {
  return {
    write: (s: string) => {
      const m = /^data: (.*)\n\n$/s.exec(s);
      if (m) written.push(JSON.parse(m[1]));
      return true;
    },
  } as unknown as ServerResponse;
}

function makePiece(pieceId: string, data: Record<string, unknown>): HudPieceData {
  return {
    pieceId,
    type: "panel",
    name: pieceId,
    status: "running",
    data,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    // ephemeral: skip settings-layout lookup so tests don't read user settings
    ephemeral: true,
  } as HudPieceData;
}

function add(pieceId: string, data: Record<string, unknown>) {
  bus.publish({ channel: "hud.update", source: "test", action: "add", pieceId, piece: makePiece(pieceId, data) });
}
function update(pieceId: string, data: Record<string, unknown>) {
  bus.publish({ channel: "hud.update", source: "test", action: "update", pieceId, data });
}
function remove(pieceId: string) {
  bus.publish({ channel: "hud.update", source: "test", action: "remove", pieceId });
}

const deltasFor = (id: string) => written.filter(d => d.pieceId === id);

beforeEach(() => {
  bus = new EventBus();
  written = [];
  now = 100_000;
  hud = new HudState(bus, { now: () => now });
  hud.addStreamClient(fakeClient());
});

// ─── Monotonic rev ─────────────────────────────────────────────────────

describe("HudState — monotonic rev per panel", () => {
  it("every pushed delta carries a per-panel monotonic rev", () => {
    add("p1", { a: 1 });
    update("p1", { a: 2 });
    update("p1", { a: 3 });
    expect(deltasFor("p1").map(d => d.rev)).toEqual([1, 2, 3]);
  });

  it("unchanged updates do not consume revs", () => {
    add("p1", { a: 1 });
    update("p1", { a: 1 });
    expect(deltasFor("p1")).toHaveLength(1);
    expect(deltasFor("p1").at(-1)!.rev).toBe(1);
  });

  it("remove carries the next rev and re-add continues the sequence", () => {
    add("p1", { a: 1 });
    remove("p1");
    add("p1", { a: 9 });
    const revs = deltasFor("p1").map(d => d.rev);
    expect(revs).toEqual([1, 2, 3]);
    const last = deltasFor("p1").at(-1)!;
    expect(last.action).toBe("set");
    expect(last.component.data).toEqual({ a: 9 });
  });

  it("revs are independent per panel", () => {
    add("p1", { a: 1 });
    add("p2", { b: 1 });
    update("p2", { b: 2 });
    expect(deltasFor("p1").at(-1)!.rev).toBe(1);
    expect(deltasFor("p2").at(-1)!.rev).toBe(2);
  });

  it("the full snapshot exposes each component's current rev", () => {
    add("p1", { a: 1 });
    update("p1", { a: 2 });
    update("p1", { a: 3 });
    const state = hud.getState() as { components: Array<{ id: string; rev: number }> };
    expect(state.components.find(c => c.id === "p1")!.rev).toBe(3);
  });

  it("rev follows content even with zero SSE clients (snapshot consistency)", () => {
    const lonely = new HudState(bus, { now: () => now });
    // no client attached — pushes are skipped but content/rev must advance
    add("pX", { a: 1 });
    update("pX", { a: 2 });
    const state = lonely.getState() as { components: Array<{ id: string; rev: number }> };
    expect(state.components.find(c => c.id === "pX")!.rev).toBe(2);
  });
});

// ─── updatedAt ─────────────────────────────────────────────────────────

describe("HudState — updatedAt stamps content changes only", () => {
  it("stamped on add and on real content change only", () => {
    add("p1", { a: 1 });
    let comp = (hud.getState() as any).components.find((c: any) => c.id === "p1");
    expect(comp.updatedAt).toBe(100_000);

    now += 5000;
    update("p1", { a: 1 }); // identical — no restamp
    comp = (hud.getState() as any).components.find((c: any) => c.id === "p1");
    expect(comp.updatedAt).toBe(100_000);

    update("p1", { a: 2 }); // real change
    comp = (hud.getState() as any).components.find((c: any) => c.id === "p1");
    expect(comp.updatedAt).toBe(105_000);
  });

  it("updatedAt never causes a push by itself", () => {
    add("p1", { a: 1 });
    now += 60_000;
    update("p1", { a: 1 });
    expect(deltasFor("p1")).toHaveLength(1);
  });
});

// ─── Reactor pull-direct ───────────────────────────────────────────────

describe("HudState — reactor pull-direct", () => {
  it("uses the registered source instead of the panel copy", () => {
    add("jarvis-core", { status: "online", coreLabel: "ONLINE" });
    hud.setReactorSource(() => ({ status: "processing", coreLabel: "PROCESSING", coreSubLabel: "" }));
    const state = hud.getState() as any;
    expect(state.reactor).toEqual({ status: "processing", coreLabel: "PROCESSING", coreSubLabel: "" });
  });

  it("a throwing source falls back to the panel copy", () => {
    add("jarvis-core", { status: "online", coreLabel: "ONLINE" });
    hud.setReactorSource(() => { throw new Error("boom"); });
    const state = hud.getState() as any;
    expect(state.reactor).toEqual({ status: "online", coreLabel: "ONLINE", coreSubLabel: "" });
  });
});

// ─── Reconciliation ────────────────────────────────────────────────────

describe("HudState — reconciliation loop", () => {
  it("a lost add is healed by the tick", () => {
    const warnSpy = vi.spyOn(log, "warn");
    hud.registerProducer("p9", () => makePiece("p9", { healed: true }));
    // p9 never added — simulates the lost-add failure mode
    hud.reconcile();

    const state = hud.getState() as any;
    expect(state.components.find((c: any) => c.id === "p9")).toBeDefined();
    const last = deltasFor("p9").at(-1)!;
    expect(last.action).toBe("set");
    expect(last.component.data).toEqual({ healed: true });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceId: "p9" }),
      expect.stringContaining("reconcile"),
    );
    warnSpy.mockRestore();
  });

  it("content drift is healed by the tick", () => {
    add("p1", { a: 1 });
    hud.registerProducer("p1", () => makePiece("p1", { a: 42 }));
    hud.reconcile();
    expect(deltasFor("p1").at(-1)!.component.data).toEqual({ a: 42 });
  });

  it("a healthy system pushes zero deltas on a tick", () => {
    add("p1", { a: 1 });
    hud.registerProducer("p1", () => makePiece("p1", { a: 1 }));
    const before = written.length;
    hud.reconcile();
    expect(written.length).toBe(before);
  });

  it("a producer returning undefined is skipped", () => {
    hud.registerProducer("p1", () => undefined);
    const before = written.length;
    hud.reconcile();
    expect(written.length).toBe(before);
  });

  it("reactor drift is pushed on the tick", () => {
    add("jarvis-core", { status: "online", coreLabel: "ONLINE" });
    let status = "online";
    hud.setReactorSource(() => ({ status, coreLabel: status.toUpperCase(), coreSubLabel: "" }));
    hud.reconcile(); // settle baseline
    const before = written.length;

    status = "processing";
    hud.reconcile();
    expect(written.length).toBeGreaterThan(before);
    const last = written.at(-1)!;
    expect(last.reactor).toEqual({ status: "processing", coreLabel: "PROCESSING", coreSubLabel: "" });
  });

  it("update for an unknown pieceId logs a warning instead of silence", () => {
    const warnSpy = vi.spyOn(log, "warn");
    update("ghost", { a: 1 });
    expect(deltasFor("ghost")).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceId: "ghost" }),
      expect.stringContaining("unknown"),
    );
    warnSpy.mockRestore();
  });

  it("start/stop reconciliation drives ticks on the interval", () => {
    vi.useFakeTimers();
    try {
      hud.registerProducer("pT", () => makePiece("pT", { tick: true }));
      hud.startReconciliation(10_000);
      expect((hud.getState() as any).components.find((c: any) => c.id === "pT")).toBeUndefined();
      vi.advanceTimersByTime(10_000);
      expect((hud.getState() as any).components.find((c: any) => c.id === "pT")).toBeDefined();
      hud.stopReconciliation();
      remove("pT");
      vi.advanceTimersByTime(30_000);
      // stopped — no resurrection
      expect((hud.getState() as any).components.find((c: any) => c.id === "pT")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
