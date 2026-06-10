// src/core/cron-fire-plan.test.ts
// Mirrors docs/features/bdd/phantom-sessions.feature (G2 scenarios).
// Pure-function tests — no settings persistence, no timers, no bus.
import { describe, it, expect } from "vitest";
import { planPromptFire, planDelegateReply } from "./cron-piece.js";
import { DEFAULT_SESSION } from "./constants.js";

describe("cron fire-time target validation (G2)", () => {
  const aliveSet = (ids: string[]) => (id: string) => ids.includes(id);

  // ── planPromptFire ──────────────────────────────────────────────────────

  it("fires for a live target", () => {
    expect(planPromptFire("actor-alice", aliveSet(["actor-alice"]))).toEqual({ action: "fire" });
  });

  it("skips with warning for a dead target", () => {
    expect(planPromptFire("actor-dead", aliveSet([]))).toEqual({ action: "skip-warn" });
  });

  it("always fires for the default session even when not yet materialized", () => {
    // After a restart, DEFAULT_SESSION may not be in the SessionManager yet —
    // creating it on demand is by design (it owns the default prompt).
    expect(planPromptFire(DEFAULT_SESSION, aliveSet([]))).toEqual({ action: "fire" });
  });

  // ── planDelegateReply ───────────────────────────────────────────────────

  it("delivers to a live reply_to without redirect", () => {
    expect(planDelegateReply("actor-alice", aliveSet(["actor-alice"])))
      .toEqual({ target: "actor-alice", redirected: false });
  });

  it("redirects a dead reply_to to the default session", () => {
    expect(planDelegateReply("actor-dead", aliveSet([])))
      .toEqual({ target: DEFAULT_SESSION, redirected: true });
  });

  it("default session reply_to is never redirected", () => {
    expect(planDelegateReply(DEFAULT_SESSION, aliveSet([])))
      .toEqual({ target: DEFAULT_SESSION, redirected: false });
  });
});
