// src/capabilities/registry.test.ts
//
// BDD: docs/features/bdd/declarative-tool-categories.feature (F3.15)
//
// Categories are DECLARATIVE — each tool's owner sets `category` at
// registration. The registry keeps only structural fallbacks ("mcp__" prefix
// → "mcp", else "general") and must NOT maintain per-tool name lists.
import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "./registry.js";

const noop = async () => ({});

function reg(): CapabilityRegistry {
  return new CapabilityRegistry();
}

function categoryOf(r: CapabilityRegistry, name: string): string | undefined {
  return r.getSlashCommands().find((c) => c.name === name)?.category;
}

describe("CapabilityRegistry — declarative tool categories (F3.15)", () => {
  it("returns the explicit category declared at registration", () => {
    const r = reg();
    r.register({
      name: "cron_create",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: noop,
      category: "cron",
    });
    expect(categoryOf(r, "cron_create")).toBe("cron");
  });

  it("falls back to 'mcp' for mcp__-prefixed names without explicit category", () => {
    const r = reg();
    r.register({
      name: "mcp__github__search",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: noop,
    });
    expect(categoryOf(r, "mcp__github__search")).toBe("mcp");
  });

  it("falls back to 'general' for names without category and without mcp prefix", () => {
    const r = reg();
    r.register({
      name: "whatever_tool",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: noop,
    });
    expect(categoryOf(r, "whatever_tool")).toBe("general");
  });

  it("explicit category wins over the mcp prefix fallback", () => {
    const r = reg();
    r.register({
      name: "mcp__srv__tool",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: noop,
      category: "custom",
    });
    expect(categoryOf(r, "mcp__srv__tool")).toBe("custom");
  });

  it("plugin slash commands keep their source as category (unchanged behavior)", () => {
    const r = reg();
    r.registerSlashCommand({
      name: "my-skill",
      description: "x",
      source: "skills",
      handler: async () => ({ message: "ok" }),
    });
    expect(categoryOf(r, "my-skill")).toBe("skills");
  });
});

// ─── Per-call durationMs (F5 turn-tracker) ─────────────────────────────
// BDD: docs/features/bdd/turn-tracker.feature — "Tool duration plumbing"

describe("CapabilityRegistry — per-call durationMs (F5)", () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  it("stamps per-call durationMs on success results", async () => {
    const r = new CapabilityRegistry();
    r.register({
      name: "sleepy",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: async () => { await sleep(50); return { ok: true }; },
    });
    const [res] = await r.execute([{ id: "tu1", name: "sleepy", input: {} }]);
    expect(res.durationMs).toBeGreaterThanOrEqual(45); // timer slack
    expect(res.is_error).toBeUndefined();
  });

  it("durations are independent per call in a parallel batch", async () => {
    const r = new CapabilityRegistry();
    r.register({
      name: "fast",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({ ok: true }),
    });
    r.register({
      name: "slow",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: async () => { await sleep(80); return { ok: true }; },
    });
    const [fast, slow] = await r.execute([
      { id: "f", name: "fast", input: {} },
      { id: "s", name: "slow", input: {} },
    ]);
    // The fast tool must NOT inherit the batch (Promise.all) wall time.
    expect(fast.durationMs!).toBeLessThan(50);
    expect(slow.durationMs!).toBeGreaterThanOrEqual(75);
  });

  it("stamps durationMs on handler errors too", async () => {
    const r = new CapabilityRegistry();
    r.register({
      name: "boom",
      description: "x",
      input_schema: { type: "object", properties: {} },
      handler: async () => { throw new Error("boom"); },
    });
    const [res] = await r.execute([{ id: "b", name: "boom", input: {} }]);
    expect(res.is_error).toBe(true);
    expect(typeof res.durationMs).toBe("number");
  });

  it("unknown capability fast-fail has NO durationMs (never ran)", async () => {
    const r = new CapabilityRegistry();
    const [res] = await r.execute([{ id: "u", name: "nope", input: {} }]);
    expect(res.is_error).toBe(true);
    expect(res.durationMs).toBeUndefined();
  });
});
