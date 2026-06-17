// src/ai/anthropic/session-inspector.test.ts
// Mirrors docs/features/bdd/phantom-sessions.feature (G1 scenarios).
//
// Key contract: inspector tools must use peek() — NEVER get() — because
// SessionManager.get() lazily CREATES sessions (phantom generator G1).
// The mock's get() throws to prove the tools never touch the creating path.
import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityRegistry } from "../../capabilities/registry.js";
import { registerSessionInspectorTools } from "./session-inspector.js";

function makeMocks(existing: Record<string, { messages: unknown[] }>) {
  const sessions = {
    peek: (id: string) =>
      existing[id]
        ? { session: { getMessages: () => existing[id].messages }, stateStack: [], createdAt: 123 }
        : undefined,
    get: (_id: string) => {
      throw new Error("PHANTOM ALERT: inspector called get() — must use peek()");
    },
    has: (id: string) => !!existing[id],
    listActive: () => Object.keys(existing),
    getState: (_id: string) => "idle",
  };
  const factory = {
    getTokenBreakdown: () => ({ systemTokens: 100, toolsTokens: 200 }),
    buildSystemBlocks: () => [],
    getToolDefinitions: () => [],
  };
  return { sessions, factory };
}

async function callTool(registry: CapabilityRegistry, name: string, input: Record<string, unknown>) {
  const results = await registry.execute([{ id: "t1", name, input }]);
  return JSON.parse(results[0].content as string);
}

describe("session-inspector phantom guard (G1)", () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it("session_info on an unknown session returns an error and creates nothing", async () => {
    const { sessions, factory } = makeMocks({ main: { messages: [] } });
    registerSessionInspectorTools(registry, sessions as any, factory as any);

    const out = await callTool(registry, "session_info", { session_id: "ghost-x" });

    expect(out.error).toContain("not found");
    expect(out.available).toEqual(["main"]);
    // get() throwing would have produced a different error — peek path proven.
  });

  it("session_info on an existing session returns metadata", async () => {
    const { sessions, factory } = makeMocks({ main: { messages: [{ role: "user" }, { role: "assistant" }] } });
    registerSessionInspectorTools(registry, sessions as any, factory as any);

    const out = await callTool(registry, "session_info", { session_id: "main" });

    expect(out.sessionId).toBe("main");
    expect(out.messageCount).toBe(2);
    expect(out.error).toBeUndefined();
  });

  it("session_get_messages on an unknown session returns an error and creates nothing", async () => {
    const { sessions, factory } = makeMocks({ main: { messages: [] } });
    registerSessionInspectorTools(registry, sessions as any, factory as any);

    const out = await callTool(registry, "session_get_messages", { session_id: "ghost-y" });

    expect(out.error).toContain("not found");
    expect(out.available).toEqual(["main"]);
  });

  it("session_get_messages on an existing session returns history slice", async () => {
    const msgs = [1, 2, 3, 4].map(i => ({ role: i % 2 ? "user" : "assistant", content: `m${i}` }));
    const { sessions, factory } = makeMocks({ main: { messages: msgs } });
    registerSessionInspectorTools(registry, sessions as any, factory as any);

    const out = await callTool(registry, "session_get_messages", { session_id: "main" });

    expect(out.total).toBe(4);
    expect(out.messages).toHaveLength(4);
  });

  it("defaults to the calling session (__sessionId) when session_id is omitted", async () => {
    const { sessions, factory } = makeMocks({ "actor-alice": { messages: [{ role: "user" }] } });
    registerSessionInspectorTools(registry, sessions as any, factory as any);

    const out = await callTool(registry, "session_info", { __sessionId: "actor-alice" });

    expect(out.sessionId).toBe("actor-alice");
    expect(out.messageCount).toBe(1);
  });
});
