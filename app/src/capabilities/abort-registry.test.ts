// src/capabilities/abort-registry.test.ts
// Tests mirror docs/features/bdd/abort-registry.feature scenarios 1:1.
import { describe, it, expect, beforeEach } from "vitest";
import { AbortRegistry } from "./abort-registry.js";
import { EventBus } from "../core/bus.js";

describe("AbortRegistry", () => {
  let reg: AbortRegistry;

  beforeEach(() => {
    reg = new AbortRegistry();
  });

  // ── Registration & release ─────────────────────────────────────────────

  it("register returns a live signal", () => {
    const signal = reg.register("main", "tool-1");
    expect(signal.aborted).toBe(false);
    expect(reg.activeCount("main")).toBe(1);
  });

  it("release removes the controller without aborting", () => {
    const s1 = reg.register("main", "tool-1");
    reg.release("main", "tool-1");
    expect(reg.activeCount("main")).toBe(0);
    expect(s1.aborted).toBe(false);
  });

  it("missing toolUseId falls back to a unique key (no collision)", () => {
    reg.register("main", undefined);
    reg.register("main", undefined);
    expect(reg.activeCount("main")).toBe(2);
  });

  // ── The core fix: parallel tools all abort ─────────────────────────────

  it("abort kills ALL parallel tools of the session", () => {
    const s1 = reg.register("main", "tool-1");
    const s2 = reg.register("main", "tool-2");
    const s3 = reg.register("main", "tool-3");

    const aborted = reg.abortSession("main");

    expect(aborted).toBe(3);
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(true);
    expect(reg.activeCount("main")).toBe(0);
  });

  it("abort is session-isolated", () => {
    const s1 = reg.register("main", "tool-1");
    const s9 = reg.register("bg-alice", "tool-9");

    reg.abortSession("main");

    expect(s1.aborted).toBe(true);
    expect(s9.aborted).toBe(false);
    expect(reg.activeCount("bg-alice")).toBe(1);
  });

  it("abort on a session with no tools is a safe no-op", () => {
    expect(reg.abortSession("ghost")).toBe(0);
  });

  it("released tools are not aborted later", () => {
    const s1 = reg.register("main", "tool-1");
    reg.release("main", "tool-1");

    const aborted = reg.abortSession("main");

    expect(aborted).toBe(0);
    expect(s1.aborted).toBe(false);
  });

  // ── Bus wiring ──────────────────────────────────────────────────────────

  it("ai.stream aborted event aborts the target session's tools", () => {
    const bus = new EventBus();
    reg.wire(bus);
    const s1 = reg.register("main", "tool-1");
    const s2 = reg.register("main", "tool-2");

    bus.publish({ channel: "ai.stream", source: "test", target: "main", event: "aborted" } as any);

    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
  });

  it("ai.stream aborted without target is ignored", () => {
    const bus = new EventBus();
    reg.wire(bus);
    const s1 = reg.register("main", "tool-1");

    bus.publish({ channel: "ai.stream", source: "test", event: "aborted" } as any);

    expect(s1.aborted).toBe(false);
  });

  it("other ai.stream events do not abort", () => {
    const bus = new EventBus();
    reg.wire(bus);
    const s1 = reg.register("main", "tool-1");

    bus.publish({ channel: "ai.stream", source: "test", target: "main", event: "complete" } as any);

    expect(s1.aborted).toBe(false);
  });

  // ── Idempotence / double wiring guard ──────────────────────────────────

  it("wire is idempotent — double wiring aborts each signal once, no throw", () => {
    const bus = new EventBus();
    reg.wire(bus);
    reg.wire(bus); // second call must be a no-op
    const s1 = reg.register("main", "tool-1");

    bus.publish({ channel: "ai.stream", source: "test", target: "main", event: "aborted" } as any);

    expect(s1.aborted).toBe(true);
    expect(reg.activeCount("main")).toBe(0);
  });
});
