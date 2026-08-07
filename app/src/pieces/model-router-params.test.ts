import { describe, it, expect, vi } from "vitest";

// CRITICAL: mock conversation-store BEFORE importing model-router.ts.
// model-router.ts statically imports conversation-store.js, whose SESSIONS_DIR
// is a MODULE-LEVEL CONST computed from JARVIS_HOME at IMPORT TIME — before any
// beforeEach can override the env var. Without this mock, this test would read
// AND WRITE Sir's REAL ~/.jarvis/sessions/main.route.json (discovered 2026-08-07
// via an actual production file corruption + recovery from the live process's
// in-memory route — see mission Gearbox Task 6 postmortem). This test validates
// ROUTER LOGIC (does it call session.setStickyModelOverride/setStickyParams
// correctly) — disk persistence itself is Task 5's job (route-params-persist.test.ts),
// already covered with a genuinely isolated temp-dir + dynamic-import pattern.
vi.mock("../core/conversation-store.js", () => ({
  saveRouteState: vi.fn(),
  loadRouteState: vi.fn(() => null),
}));

import { ModelRouterPiece } from "./model-router.js";

function fakeSessions(session: any) {
  return {
    peek: () => ({ session }),
    setBus() {},
    onSessionCreated() {},
  } as any;
}

function fakeBus() {
  return { publish: vi.fn(), subscribe: vi.fn() } as any;
}

/** Build a router with .start() already called against a no-op bus, so
 *  emitSwitch/emitBanner (which publish on this.bus) don't crash. */
function mkRouter(session: any) {
  const r = new ModelRouterPiece(fakeSessions(session));
  r.start(fakeBus());
  return r;
}

describe("ModelRouter params (effort) — mission Gearbox", () => {
  it("applies model + params atomically on the live session", () => {
    const session = {
      setStickyModelOverride: vi.fn(),
      setStickyParams: vi.fn(),
      measureContext: () => ({ totalTokensEst: 0 }),
    };
    const r = mkRouter(session);
    r.setStickyModel("main", "claude-opus-4-8", "test", { effort: "high" });
    expect(session.setStickyModelOverride).toHaveBeenCalledWith("claude-opus-4-8");
    expect(session.setStickyParams).toHaveBeenCalledWith({ effort: "high" });
  });

  it("no error when session lacks setStickyParams", () => {
    const session = {
      setStickyModelOverride: vi.fn(),
      measureContext: () => ({ totalTokensEst: 0 }),
    };
    const r = mkRouter(session);
    expect(() => r.setStickyModel("main", "claude-opus-4-8", "test", { effort: "high" })).not.toThrow();
    expect(session.setStickyModelOverride).toHaveBeenCalledWith("claude-opus-4-8");
  });

  it("persists params in the route", () => {
    const session = { setStickyModelOverride: vi.fn(), setStickyParams: vi.fn(), measureContext: () => ({ totalTokensEst: 0 }) };
    const r = mkRouter(session);
    const route = r.setStickyModel("main", "claude-opus-4-8", "test", { effort: "medium" });
    expect(route.params).toEqual({ effort: "medium" });
  });

  it("changing only effort (same model) still applies and updates the route", () => {
    const session = { setStickyModelOverride: vi.fn(), setStickyParams: vi.fn(), measureContext: () => ({ totalTokensEst: 0 }) };
    const r = mkRouter(session);
    r.setStickyModel("main", "claude-opus-4-8", "first", { effort: "high" });
    const route = r.setStickyModel("main", "claude-opus-4-8", "second", { effort: "low" });
    expect(route.params).toEqual({ effort: "low" });
    expect(session.setStickyParams).toHaveBeenCalledWith({ effort: "low" });
  });
});
