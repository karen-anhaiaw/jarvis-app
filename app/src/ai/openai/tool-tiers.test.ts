// src/ai/openai/tool-tiers.test.ts
//
// TDD — RED first.
//
// The OpenAI implementation owns its tool-priority policy (Sir: "tier é interno
// ao modelo, na implementação dele"). Since getDefinitions() hands over only
// { name, description, input_schema } — no category, no origin — the policy has
// to classify BY NAME.
//
// That is a real staleness risk, and the LAST test in this file is what makes it
// survivable: it scans app/capabilities/*.json and fails if any shipped
// capability is missing from CORE_TOOL_NAMES. Add a capability without listing
// it and CI goes red, instead of the tool being quietly droppable in production.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** app/capabilities/ — three levels up from src/ai/openai/ */
const CAPABILITIES_DIR = join(here, "..", "..", "..", "capabilities");

describe("classifyForOpenAI — the provider's own tier policy", () => {
  it("classifies shipped essentials as core", async () => {
    const { classifyForOpenAI } = await import("./tool-tiers.js");
    for (const name of ["read_file", "write_file", "bash", "grep", "glob"]) {
      expect(classifyForOpenAI({ name }), `${name} must be core`).toBe("core");
    }
  });

  it("classifies MCP server tools as mcp via the mcp__ prefix", async () => {
    const { classifyForOpenAI } = await import("./tool-tiers.js");
    expect(classifyForOpenAI({ name: "mcp__slack__slack_send_message" })).toBe("mcp");
  });

  it("classifies MCP MANAGEMENT tools as piece, not mcp", async () => {
    const { classifyForOpenAI } = await import("./tool-tiers.js");
    // These are JARVIS infrastructure, not server content. Dropping them would
    // remove the ability to fix an MCP problem exactly when too many MCP tools
    // are the problem. They carry no mcp__ prefix, so they land in piece.
    for (const name of ["mcp_list", "mcp_connect", "mcp_login", "mcp_disconnect", "mcp_refresh"]) {
      expect(classifyForOpenAI({ name }), `${name} must be piece`).toBe("piece");
    }
  });

  it("classifies piece and plugin tools as piece", async () => {
    const { classifyForOpenAI } = await import("./tool-tiers.js");
    for (const name of ["cron_create", "model_set", "jarvis_eval", "canvas_draw", "memory_search"]) {
      expect(classifyForOpenAI({ name })).toBe("piece");
    }
  });

  it("falls back to piece — never core — for an unknown name", async () => {
    const { classifyForOpenAI } = await import("./tool-tiers.js");
    // A tool must be listed explicitly to earn protection, so an omission
    // degrades gracefully instead of silently entering the protected tier.
    expect(classifyForOpenAI({ name: "something_invented_tomorrow" })).toBe("piece");
  });

  it("exposes OpenAI's documented 128-entry cap", async () => {
    const { OPENAI_MAX_TOOLS } = await import("./tool-tiers.js");
    expect(OPENAI_MAX_TOOLS).toBe(128);
  });
});

describe("GUARD — CORE_TOOL_NAMES must not drift from app/capabilities/*.json", () => {
  it("lists every shipped capability as core", async () => {
    const { CORE_TOOL_NAMES } = await import("./tool-tiers.js");

    const shipped = readdirSync(CAPABILITIES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const raw = JSON.parse(readFileSync(join(CAPABILITIES_DIR, f), "utf-8"));
        return raw.name as string;
      })
      .filter(Boolean);

    expect(shipped.length, "expected to find capability JSONs — is the path right?").toBeGreaterThan(0);

    const missing = shipped.filter((name) => !CORE_TOOL_NAMES.has(name));
    expect(
      missing,
      `these shipped capabilities are NOT classified as core, so the budget may drop them: ${missing.join(", ")}. ` +
        "Add them to CORE_TOOL_NAMES in tool-tiers.ts.",
    ).toEqual([]);
  });

  it("does not list names that no longer ship", async () => {
    const { CORE_TOOL_NAMES } = await import("./tool-tiers.js");

    const shipped = new Set(
      readdirSync(CAPABILITIES_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(CAPABILITIES_DIR, f), "utf-8")).name as string)
        .filter(Boolean),
    );

    const stale = [...CORE_TOOL_NAMES].filter((name) => !shipped.has(name));
    expect(stale, `CORE_TOOL_NAMES contains names with no capability JSON: ${stale.join(", ")}`).toEqual([]);
  });
});
