// src/capabilities/executor-context.test.ts
//
// BDD: docs/features/bdd/observability-tracing.feature (F4, item 17)
//   - "Executor injects __traceId into tool input"
//   - "MCP handler strips executor context fields before calling the server"
//     (the strip is a shared pure helper used by mcp/manager and loader)
import { describe, it, expect } from "vitest";
import { EventBus } from "../core/bus.js";
import { CapabilityRegistry } from "./registry.js";
import { CapabilityExecutor, stripExecutorContext } from "./executor.js";
import type { CapabilityResultMessage } from "../core/types.js";

describe("stripExecutorContext (item 17 — leak prevention)", () => {
  it("removes all executor-injected fields and preserves the rest", () => {
    const out = stripExecutorContext({
      query: "x",
      limit: 5,
      __sessionId: "main",
      __toolUseId: "tu_1",
      __traceId: "feed1234",
    });
    expect(out).toEqual({ query: "x", limit: 5 });
  });

  it("is a no-op on inputs without context fields", () => {
    expect(stripExecutorContext({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("CapabilityExecutor injects __traceId (item 17)", () => {
  it("handler receives __traceId from the capability.request message", async () => {
    const bus = new EventBus();
    const registry = new CapabilityRegistry();
    let seen: Record<string, unknown> | undefined;
    registry.register({
      name: "probe",
      description: "captures input",
      input_schema: { type: "object", properties: {} },
      handler: async (input) => { seen = input; return { ok: true }; },
    });

    const executor = new CapabilityExecutor(registry);
    await executor.start(bus);

    const done = new Promise<CapabilityResultMessage>((resolve) => {
      bus.subscribe<CapabilityResultMessage>("capability.result", (m) => resolve(m));
    });

    bus.publish({
      channel: "capability.request",
      source: "test",
      target: "main",
      traceId: "feed1234",
      calls: [{ id: "tu_probe", name: "probe", input: { q: "hi" } }],
    } as any);

    await done;
    expect(seen?.__traceId).toBe("feed1234");
    expect(seen?.__sessionId).toBe("main");
    expect(seen?.__toolUseId).toBe("tu_probe");
    expect(seen?.q).toBe("hi");

    await executor.stop();
  });
});
