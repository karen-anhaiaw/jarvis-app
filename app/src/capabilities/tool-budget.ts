// src/capabilities/tool-budget.ts
//
// The tool-trimming ALGORITHM. It owns no policy and no limit.
//
// OWNERSHIP (Sir, 2026-07-30)
//   "na implementação do modelo, ela recebe as tools e decide o que vai enviar
//   para api" — and then, asked to disambiguate: "tier é interno ao modelo, na
//   implementação dele".
//
//   So BOTH the limit AND the tier policy belong to the provider implementation.
//   Two earlier proposals were rejected:
//     · a central model→limit map — one place obliged to know every model,
//       stale on each new release;
//     · a `tier` field on CapabilityDefinition — that would make tiering a
//       registry concern, and the registry deliberately knows nothing about
//       individual tools (see registry.ts on `category`: "the registry must not
//       know tool names").
//
//   What survives here is only what is genuinely universal: the order of
//   sacrifice, the counting, and determinism. Letting each provider reimplement
//   that is exactly how OpenAI and DeepSeek ended up with the same copy-pasted
//   system-prompt lambda and therefore the same bug in two places.
//
// DETERMINISM IS LOAD-BEARING
//   OpenAI's prompt cache keys on a byte-identical prefix and the tools array is
//   part of the request. A selection that varied between calls would silently
//   destroy the caching. Partitioning preserves the caller's order; nothing is
//   sorted or shuffled.

import { log } from "../logger/index.js";

/**
 * Priority tiers, most protected first. A tool is dropped only once every tool
 * of a lower-priority tier is already gone.
 *
 * The MEANING of each tier is the provider's to decide — this module only knows
 * that core outranks piece, and piece outranks mcp.
 */
export const TIER_PRIORITY = ["core", "piece", "mcp"] as const;
export type ToolTier = (typeof TIER_PRIORITY)[number];

/** Provider-owned policy: given a tool, which tier does it belong to. */
export type ClassifyTool<T> = (tool: T) => ToolTier;

export interface DroppedByTier {
  core: number;
  piece: number;
  mcp: number;
}

export interface BudgetResult<T> {
  /** The tools to send, ordered core → piece → mcp. */
  tools: T[];
  /** True when anything was removed. */
  trimmed: boolean;
  /** How many were removed, per tier — a bare total hides WHAT was lost. */
  dropped: DroppedByTier;
  /**
   * True when the core tier alone exceeds the budget. Truncating is still less
   * bad than exceeding — over the cap the API rejects the ENTIRE request — but
   * this is a configuration failure and the caller must be able to shout about
   * it rather than degrade in silence.
   */
  coreOverflow: boolean;
}

/**
 * Chooses which tools to send, honouring tier priority and the caller's limit.
 * Pure and deterministic.
 *
 * @param tools    every candidate, in the caller's order
 * @param limit    maximum entries the provider accepts. `undefined` means no
 *                 limit and nothing is trimmed. `0` means send none — distinct
 *                 from `undefined`, which is why this is not a truthiness check.
 * @param classify provider-owned tier policy
 */
export function selectWithinBudget<T>(
  tools: T[],
  limit: number | undefined,
  classify: ClassifyTool<T>,
): BudgetResult<T> {
  const zero: DroppedByTier = { core: 0, piece: 0, mcp: 0 };

  if (limit === undefined) {
    return { tools, trimmed: false, dropped: { ...zero }, coreOverflow: false };
  }

  // Partition preserving the caller's order — no sort, no shuffle (determinism).
  const byTier: Record<ToolTier, T[]> = { core: [], piece: [], mcp: [] };
  for (const tool of tools) byTier[classify(tool)].push(tool);

  const ordered = TIER_PRIORITY.flatMap((tier) => byTier[tier]);
  const kept = ordered.slice(0, Math.max(0, limit));

  const keptByTier: DroppedByTier = { ...zero };
  for (const tool of kept) keptByTier[classify(tool)]++;

  return {
    tools: kept,
    trimmed: kept.length < tools.length,
    dropped: {
      core: byTier.core.length - keptByTier.core,
      piece: byTier.piece.length - keptByTier.piece,
      mcp: byTier.mcp.length - keptByTier.mcp,
    },
    coreOverflow: byTier.core.length > limit,
  };
}

/**
 * Logs a trim with the per-tier breakdown. Core loss is an ERROR, not a warning:
 * it means JARVIS is shipping without its own essential tools.
 */
export function logBudget(result: BudgetResult<unknown>, ctx: { label?: string; limit: number }): void {
  if (!result.trimmed) return;
  const payload = { ...ctx, kept: result.tools.length, dropped: result.dropped };
  if (result.coreOverflow) {
    log.error(payload, "tool-budget: CORE tools dropped — limit is below the number of essential tools");
  } else {
    log.warn(payload, "tool-budget: tool list exceeds the provider limit — trimmed (mcp first, then piece)");
  }
}
