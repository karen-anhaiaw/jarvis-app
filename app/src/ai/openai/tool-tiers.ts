// src/ai/openai/tool-tiers.ts
//
// The OpenAI implementation's OWN tool-priority policy, plus its own limit.
//
// WHY THIS LIVES HERE AND NOT IN THE REGISTRY (Sir, 2026-07-30)
//   "tier é interno ao modelo, na implementação dele."
//
//   The registry deliberately knows nothing about individual tools — see the
//   note on `category` in registry.ts: "the registry must not know tool names".
//   Putting a `tier` field there would have made trimming a registry concern.
//   Instead the party that suffers the constraint declares both the limit and
//   the priority: OpenAI Chat Completions is what rejects a `tools` array over
//   128 entries, so OpenAI is what decides who survives.
//
//   Consequence, stated plainly: getDefinitions() hands over only
//   { name, description, input_schema } — no category, no origin. So this policy
//   classifies BY NAME, which means it can go stale when a new capability is
//   added. That risk is not accepted on trust: tool-tiers.test.ts scans
//   app/capabilities/*.json and FAILS if any shipped capability is not
//   classified as core. The list cannot silently drift.
//
// DeepSeek inherits this automatically — it reuses OpenAISession wholesale.

import type { ToolTier } from "../../capabilities/tool-budget.js";

/**
 * OpenAI Chat Completions rejects requests whose `tools` array exceeds this
 * many entries ("Invalid 'tools': array too long"). JARVIS routinely exposes
 * more once several MCP servers are connected.
 */
export const OPENAI_MAX_TOOLS = 128;

/**
 * The essentials — JARVIS is not JARVIS without these. Mirrors the capabilities
 * shipped in app/capabilities/*.json; the guard test keeps the two in step.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // filesystem
  "bash",
  "edit_file",
  "glob",
  "grep",
  "list_dir",
  "multi_edit_file",
  "read_file",
  "write_file",
  // web
  "web_fetch",
  "web_search",
  "web_fetch_local",
  "web_search_local",
  // execution / system / hud
  "code_execution",
  "jarvis_reset",
  "hud_screenshot",
]);

/**
 * Tier policy for the OpenAI-compatible providers.
 *
 *   core   the shipped essentials above
 *   mcp    tools exposed by connected MCP servers — the `mcp__` prefix is
 *          assigned by McpManager when it registers them
 *   piece  everything else: piece and plugin tools, INCLUDING MCP MANAGEMENT
 *          (mcp_list, mcp_connect, mcp_login). Those are JARVIS infrastructure,
 *          not server content — dropping them would remove the ability to fix an
 *          MCP problem at precisely the moment too many MCP tools ARE the
 *          problem. Note they do NOT carry the `mcp__` prefix, so they land here
 *          naturally.
 *
 * Unknown names fall to `piece`, never to `core`: a tool must be listed
 * explicitly to earn protection, so an omission degrades gracefully instead of
 * silently promoting something into the protected tier.
 */
export function classifyForOpenAI(tool: { name: string }): ToolTier {
  if (CORE_TOOL_NAMES.has(tool.name)) return "core";
  if (tool.name.startsWith("mcp__")) return "mcp";
  return "piece";
}
