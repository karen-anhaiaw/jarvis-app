// src/ai/system-prompt.ts
//
// Single source of truth for the JARVIS base system prompt, and the single
// composer used by every OpenAI-compatible provider.
//
// WHY THIS MODULE EXISTS
//   jarvis-system.md used to be read by AnthropicSessionFactory ONLY. The
//   OpenAI and DeepSeek providers each carried their own copy-pasted lambda
//   that assembled the system prompt from core context + plugin instructions +
//   plugin context + jarvis.md — and never included the base prompt at all.
//
//   Running on OpenAI or DeepSeek therefore meant running with NO system
//   prompt: no identity, no Asimov's laws, no architecture. Confirmed live on
//   a Windows host over gRPC — factory "OpenAISessionFactory", basePrompt
//   absent, while ~/.jarvis/jarvis-system.md sat unread at 15331 bytes. It went
//   unnoticed on macOS because that host runs Anthropic.
//
//   Knowing where the base prompt comes from is the router's concern, not each
//   factory's. ProviderConfig now carries getBasePrompt(), so every provider —
//   present and future — inherits it instead of having to remember.
//
// ORDERING IS LOAD-BEARING (prefix cache)
//   Anthropic marks cache breakpoints explicitly with cache_control. OpenAI has
//   no such control: its caching is automatic and keyed on a byte-identical
//   prompt PREFIX. Anything volatile placed early invalidates everything after
//   it, so the cache never engages.
//
//   getPluginContext is per-session, per-turn state — the most volatile input
//   we have. The old lambda placed it in the middle, which guaranteed a fresh
//   prefix on every single request and killed caching outright. Here it goes
//   LAST, after every stable section, so the prefix survives between turns.

import { existsSync, readFileSync } from "node:fs";
import { config } from "../config/index.js";
import { log } from "../logger/index.js";

/**
 * Used when jarvis-system.md cannot be read. Exported so callers (and tests)
 * can tell a real prompt from a degraded one instead of guessing from length.
 */
export const FALLBACK_BASE_PROMPT =
  "You are JARVIS, an AI assistant created by Mr. Stark. Be helpful, concise, and precise. Address the user as Sir.";

/**
 * Reads the base system prompt from disk (default: ~/.jarvis/jarvis-system.md).
 * Never throws — logs loudly and degrades to FALLBACK_BASE_PROMPT.
 */
export function loadBasePrompt(path: string = config.systemPromptPath): string {
  if (!existsSync(path)) {
    log.warn({ path }, "System prompt file not found — running on the fallback prompt");
    return FALLBACK_BASE_PROMPT;
  }
  const content = readFileSync(path, "utf-8");
  log.info({ path, size: content.length }, "System prompt loaded");
  return content;
}

/** The slice of ProviderConfig this composer needs. Structural on purpose — no import cycle. */
export interface SystemPromptSources {
  getBasePrompt: () => string;
  getCoreContext: () => string[];
  getPluginInstructions: () => string[];
  getPluginContext: (sessionId?: string) => string[];
  getInstructions: () => { content: string; filename: string };
}

const SEP = "\n\n---\n\n";

/**
 * Builds the full system prompt string for OpenAI-compatible providers.
 *
 * Section order — stable first, volatile last, so the prefix stays cacheable:
 *   1. base prompt        (jarvis-system.md — changes only on release)
 *   2. core context       (piece systemContext — stable within a boot)
 *   3. plugin instructions(stable within a boot)
 *   4. jarvis.md          (user instructions — stable within a boot)
 *   5. plugin context     (PER-TURN state — must be last)
 */
export function composeSystemPrompt(sources: SystemPromptSources, sessionId?: string): string {
  const { content: instructions, filename } = sources.getInstructions();

  const sections = [
    sources.getBasePrompt(),
    sources.getCoreContext().filter(Boolean).join(SEP),
    sources.getPluginInstructions().filter(Boolean).join("\n\n"),
    instructions ? `# ${filename || "instructions"}\n\n${instructions}` : "",
    // Volatile — always last. See ORDERING IS LOAD-BEARING above.
    sources.getPluginContext(sessionId).filter(Boolean).join("\n\n"),
  ];

  return sections.filter((s) => s && s.trim().length > 0).join(SEP);
}
