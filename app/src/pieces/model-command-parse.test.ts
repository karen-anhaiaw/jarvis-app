import { describe, it, expect, vi } from "vitest";

// SAFETY (see model-router-params.test.ts / Task 6 postmortem, 2026-08-07):
// model-router.ts statically imports conversation-store.js, whose SESSIONS_DIR
// is a module-level const resolved from JARVIS_HOME at IMPORT TIME. Mock it
// unconditionally so this file NEVER touches the real ~/.jarvis/sessions dir,
// regardless of what parseModelCommand itself needs (it needs nothing — it's
// a pure string parser — but the import chain still pulls conversation-store in).
vi.mock("../core/conversation-store.js", () => ({
  saveRouteState: vi.fn(),
  loadRouteState: vi.fn(() => null),
}));

import { parseModelCommand } from "./model-router.js";

describe("parseModelCommand", () => {
  it("parses id + JSON params", () => {
    expect(parseModelCommand('claude-opus-4-8 {"effort":"high"}')).toEqual({
      model: "claude-opus-4-8",
      params: { effort: "high" },
    });
  });

  it("parses bare id", () => {
    expect(parseModelCommand("claude-haiku-4-5")).toEqual({
      model: "claude-haiku-4-5",
      params: undefined,
    });
  });

  it("bad JSON → model kept, params undefined", () => {
    expect(parseModelCommand("claude-opus-4-8 {effort:high")).toEqual({
      model: "claude-opus-4-8",
      params: undefined,
    });
  });

  it("alias + JSON", () => {
    expect(parseModelCommand('opus {"effort":"low"}')).toEqual({
      model: "opus",
      params: { effort: "low" },
    });
  });

  it("empty string", () => {
    expect(parseModelCommand("")).toEqual({ model: "", params: undefined });
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelCommand('  claude-opus-4-8   {"effort":"max"}  ')).toEqual({
      model: "claude-opus-4-8",
      params: { effort: "max" },
    });
  });
});
