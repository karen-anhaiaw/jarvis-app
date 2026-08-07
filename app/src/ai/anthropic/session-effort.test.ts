import { describe, it, expect } from "vitest";
import { AnthropicSession } from "./session.js";

const noTools = () => [];

function mk(highEffort: boolean, model = "claude-opus-4-8") {
  return new AnthropicSession({
    model,
    systemPrompt: "x",
    getTools: noTools,
    label: "t",
    highEffort,
  });
}

describe("AnthropicSession effort resolution", () => {
  it("seed max when highEffort true", () => {
    expect((mk(true) as any).resolveEffort("claude-opus-4-8")).toBe("max");
  });

  it("seed high when highEffort false", () => {
    expect((mk(false) as any).resolveEffort("claude-opus-4-8")).toBe("high");
  });

  it("stickyParams.effort overrides seed", () => {
    const s = mk(true);
    s.setStickyParams({ effort: "low" });
    expect((s as any).resolveEffort("claude-opus-4-8")).toBe("low");
  });

  it("clearing sticky reverts to seed", () => {
    const s = mk(true);
    s.setStickyParams({ effort: "low" });
    s.setStickyParams(undefined);
    expect((s as any).resolveEffort("claude-opus-4-8")).toBe("max");
  });

  it("haiku resolves to undefined even with sticky effort", () => {
    const s = mk(true, "claude-haiku-4-5");
    s.setStickyParams({ effort: "max" });
    expect((s as any).resolveEffort("claude-haiku-4-5")).toBeUndefined();
  });

  it("peekParams returns a copy (no external mutation)", () => {
    const s = mk(true);
    s.setStickyParams({ effort: "high" });
    const p = s.peekParams();
    expect(p).toEqual({ effort: "high" });
    p.effort = "low";
    expect(s.peekParams()).toEqual({ effort: "high" });
  });
});
