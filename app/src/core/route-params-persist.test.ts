import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("route params persistence (mission Gearbox)", () => {
  beforeEach(() => {
    process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), "jarvis-"));
  });

  it("round-trips params through save/load", async () => {
    const { saveRouteState, loadRouteState } = await import("./conversation-store.js");
    saveRouteState("main", { sticky: "claude-opus-4-8", switchCount: 1, params: { effort: "low" } });
    const r = loadRouteState("main");
    expect(r?.sticky).toBe("claude-opus-4-8");
    expect(r?.params).toEqual({ effort: "low" });
  });

  it("tolerates a legacy route file with no params", async () => {
    const { saveRouteState, loadRouteState } = await import("./conversation-store.js");
    saveRouteState("leg", { sticky: "claude-sonnet-4-6", switchCount: 0 });
    const r = loadRouteState("leg");
    expect(r?.params).toBeUndefined();
  });
});
