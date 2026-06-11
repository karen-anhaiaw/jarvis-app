/**
 * @module ai/pricing
 * @see docs/features/turn-tracker.md (design decision #6)
 *
 * Server-side cost ESTIMATION by model family.
 *
 * WHY a family table and not per-model ids: model ids rotate (claude-opus-4-8,
 * claude-opus-4-7, …) but pricing is stable per family tier. Substring match
 * on the family keyword keeps the table tiny and future-proof.
 *
 * WHY undefined for unknown families: internal/aliased models (e.g.
 * "claude-fable-5") have no public price. Fabricating a number would corrupt
 * cost aggregates silently — consumers must render "—" instead. This is an
 * explicit, documented contract of TurnSummary.costUsd.
 *
 * Cache rates follow the Anthropic convention relative to the input rate:
 *   cache write (5m) = 1.25 × input    cache read = 0.1 × input
 *
 * All rates in USD per million tokens.
 */

interface FamilyRate {
  match: RegExp;
  /** USD per MTok. */
  input: number;
  output: number;
}

/** Order matters only for exotic ids matching two keywords — none today. */
const FAMILIES: FamilyRate[] = [
  { match: /opus/i, input: 15, output: 75 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /haiku/i, input: 0.8, output: 4 },
];

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Estimate the USD cost of a usage block for a given model id.
 * Returns undefined when the model is absent or its family is unknown —
 * NEVER a fabricated number (see module doc).
 */
export function estimateCostUsd(model: string | undefined, usage: UsageTokens): number | undefined {
  if (!model) return undefined;
  const family = FAMILIES.find(f => f.match.test(model));
  if (!family) return undefined;

  const perTok = 1 / 1_000_000;
  const cost =
    (usage.input_tokens ?? 0) * family.input * perTok +
    (usage.output_tokens ?? 0) * family.output * perTok +
    (usage.cache_creation_input_tokens ?? 0) * family.input * 1.25 * perTok +
    (usage.cache_read_input_tokens ?? 0) * family.input * 0.1 * perTok;

  // Round to micro-dollars: keeps JSON clean and absorbs float noise.
  return Math.round(cost * 1e6) / 1e6;
}
