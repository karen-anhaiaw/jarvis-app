// src/capabilities/tool-budget.test.ts
//
// TDD — RED first.
//
// WHAT THIS IS
//   A provider-agnostic tool SELECTION algorithm. The LIMIT itself is NOT here:
//   it belongs to whichever provider implementation suffers the constraint
//   (Sir, 2026-07-30: "na implementação do modelo, ela recebe as tools e decide
//   o que vai enviar para api"). OpenAI Chat Completions rejects a `tools` array
//   over 128 entries, so the OpenAI session passes 128. Anthropic documents no
//   such cap, so it passes nothing and no trimming happens.
//
//   A central model→limit map was the first proposal and was rejected: it would
//   be a single place required to know about every model, going stale on every
//   new release. Same principle already applied twice in this codebase — the
//   tool's OWNER declares its category, the ROUTER owns getBasePrompt. The party
//   that has the constraint declares it.
//
// TIER PRIORITY: core → piece → mcp
//   core  the file-system / web / execution capabilities from capabilities/*.json
//   piece tools registered by pieces and plugins — including MCP MANAGEMENT
//         (mcp_list, mcp_connect, mcp_login). Those are JARVIS infrastructure,
//         not server content: dropping them would remove the ability to fix an
//         MCP problem exactly when too many MCP tools are the problem.
//   mcp   tools exposed by connected MCP servers
//
// DETERMINISM IS LOAD-BEARING
//   OpenAI's prompt cache keys on a byte-identical prefix, and the tools array
//   is part of the request. A selection that varies between calls would destroy
//   the cache that was just repaired. Same input MUST yield the same output.

import { describe, it, expect } from "vitest";

type Tool = { name: string; description: string; input_schema: Record<string, unknown>; tier?: string };

const t = (name: string, tier?: string): Tool => ({
  name,
  description: `desc of ${name}`,
  input_schema: { type: "object", properties: {} },
  ...(tier ? { tier } : {}),
});

/** Test-local classifier. In production the POLICY lives in the provider
 *  implementation (see ai/openai/tool-tiers.ts) — this module only owns the
 *  algorithm, so the tests supply their own policy. */
const cls = (x: Tool) =>
  (x.tier as "core" | "piece" | "mcp" | undefined) ??
  (x.name.startsWith("mcp__") ? "mcp" as const : "piece" as const);

describe("selectWithinBudget — core survives, mcp yields first", () => {
  it("passes everything through untouched when the total fits", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [t("read_file", "core"), t("cron_create", "piece"), t("mcp__x__y")];
    const r = selectWithinBudget(tools, 10, cls);
    expect(r.tools).toEqual(tools);
    expect(r.trimmed).toBe(false);
  });

  it("passes everything through when no limit is given (Anthropic case)", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = Array.from({ length: 500 }, (_, i) => t(`mcp__srv__t${i}`));
    const r = selectWithinBudget(tools, undefined, cls);
    expect(r.tools).toHaveLength(500);
    expect(r.trimmed).toBe(false);
  });

  it("drops mcp first, keeping every core and piece tool", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [
      ...Array.from({ length: 5 }, (_, i) => t(`core_${i}`, "core")),
      ...Array.from({ length: 3 }, (_, i) => t(`piece_${i}`, "piece")),
      ...Array.from({ length: 20 }, (_, i) => t(`mcp__srv__${i}`)),
    ];
    const r = selectWithinBudget(tools, 10, cls);
    const names = r.tools.map((x) => x.name);
    expect(r.tools).toHaveLength(10);
    for (let i = 0; i < 5; i++) expect(names).toContain(`core_${i}`);
    for (let i = 0; i < 3; i++) expect(names).toContain(`piece_${i}`);
    expect(r.dropped.mcp).toBe(18);
    expect(r.dropped.piece).toBe(0);
    expect(r.dropped.core).toBe(0);
  });

  it("sacrifices piece tools only after every mcp tool is gone", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [
      ...Array.from({ length: 4 }, (_, i) => t(`core_${i}`, "core")),
      ...Array.from({ length: 10 }, (_, i) => t(`piece_${i}`, "piece")),
      ...Array.from({ length: 10 }, (_, i) => t(`mcp__srv__${i}`)),
    ];
    const r = selectWithinBudget(tools, 8, cls);
    expect(r.dropped.mcp).toBe(10);
    expect(r.dropped.piece).toBe(6);
    expect(r.dropped.core).toBe(0);
    expect(r.tools.filter((x) => x.name.startsWith("core_"))).toHaveLength(4);
  });

  it("emits tiers in order: core, then piece, then mcp", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [t("mcp__a__b"), t("piece_x", "piece"), t("core_y", "core")];
    const r = selectWithinBudget(tools, 3, cls);
    expect(r.tools.map((x) => x.name)).toEqual(["core_y", "piece_x", "mcp__a__b"]);
  });

  it("reports core overflow instead of pretending it fits", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    // Pathological: core alone exceeds the budget. Truncating is still better
    // than exceeding — over the cap the API rejects the WHOLE request — but the
    // caller must be able to scream about it rather than degrade in silence.
    const tools = Array.from({ length: 12 }, (_, i) => t(`core_${i}`, "core"));
    const r = selectWithinBudget(tools, 5, cls);
    expect(r.tools).toHaveLength(5);
    expect(r.dropped.core).toBe(7);
    expect(r.coreOverflow).toBe(true);
  });

  it("does not flag coreOverflow when core fits", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const r = selectWithinBudget([t("core_a", "core"), t("mcp__x__y")], 1, cls);
    expect(r.coreOverflow).toBe(false);
  });

  it("is DETERMINISTIC — identical input yields byte-identical output (prefix cache)", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [
      ...Array.from({ length: 6 }, (_, i) => t(`mcp__srv__${i}`)),
      ...Array.from({ length: 4 }, (_, i) => t(`core_${i}`, "core")),
      ...Array.from({ length: 5 }, (_, i) => t(`piece_${i}`, "piece")),
    ];
    const a = selectWithinBudget(tools, 9, cls);
    const b = selectWithinBudget(tools, 9, cls);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });

  it("preserves registration order WITHIN a tier — no sorting, no shuffling", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const tools = [t("zebra", "core"), t("apple", "core"), t("mango", "core")];
    const r = selectWithinBudget(tools, 3, cls);
    expect(r.tools.map((x) => x.name)).toEqual(["zebra", "apple", "mango"]);
  });

  it("treats a limit of zero as trim-everything, not as no-limit", async () => {
    const { selectWithinBudget } = await import("./tool-budget.js");
    const r = selectWithinBudget([t("core_a", "core")], 0, cls);
    expect(r.tools).toHaveLength(0);
    expect(r.trimmed).toBe(true);
  });
});
