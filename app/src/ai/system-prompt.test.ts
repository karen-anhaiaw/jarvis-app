// src/ai/system-prompt.test.ts
//
// TDD — RED first.
//
// BUG BEING FIXED
//   jarvis-system.md was read by AnthropicSessionFactory ONLY. The OpenAI and
//   DeepSeek providers each carried their own copy-pasted lambda that composed
//   the system prompt from core context + plugin instructions + plugin context
//   + jarvis.md — and simply never included the base prompt.
//
//   Consequence: running on OpenAI or DeepSeek, JARVIS booted with no system
//   prompt at all. No identity, no Asimov's laws, no architecture — 15k chars
//   of contract silently absent. Confirmed live on Windows over gRPC:
//     factory: "OpenAISessionFactory", basePromptLength: null
//   while ~/.jarvis/jarvis-system.md sat there at 15331 bytes, unread.
//
//   It went unnoticed on macOS because that host runs Anthropic.
//
// ROOT FIX (not a patch in each provider)
//   Knowing where the base prompt comes from is the ROUTER's job, not each
//   factory's. ProviderConfig gains getBasePrompt(), so every provider — present
//   and future — inherits it. And the duplicated lambda becomes one shared
//   composeSystemPrompt(), so the two OpenAI-compatible providers cannot drift
//   apart again.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function cfg(over: Partial<Record<string, unknown>> = {}) {
  return {
    getTools: () => [],
    getBasePrompt: () => "BASE_PROMPT_MARKER",
    getCoreContext: () => ["CORE_A", "CORE_B"],
    getPluginInstructions: () => ["PLUGIN_INSTR"],
    getPluginContext: () => ["PLUGIN_CTX"],
    getInstructions: () => ({ content: "JARVIS_MD_BODY", filename: "jarvis.md" }),
    ...over,
  } as any;
}

describe("composeSystemPrompt — the single composer for OpenAI-compatible providers", () => {
  it("includes the base prompt — the exact regression that broke OpenAI and DeepSeek", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    expect(composeSystemPrompt(cfg())).toContain("BASE_PROMPT_MARKER");
  });

  it("puts the base prompt FIRST, before any context", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const out = composeSystemPrompt(cfg());
    expect(out.indexOf("BASE_PROMPT_MARKER")).toBeLessThan(out.indexOf("CORE_A"));
  });

  it("still carries core context, plugin instructions, plugin context and jarvis.md", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const out = composeSystemPrompt(cfg());
    for (const marker of ["CORE_A", "CORE_B", "PLUGIN_INSTR", "PLUGIN_CTX", "JARVIS_MD_BODY"]) {
      expect(out, `must contain ${marker}`).toContain(marker);
    }
    expect(out).toContain("# jarvis.md");
  });

  it("emits the base prompt even when every other section is empty", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const out = composeSystemPrompt(
      cfg({
        getCoreContext: () => [],
        getPluginInstructions: () => [],
        getPluginContext: () => [],
        getInstructions: () => ({ content: "", filename: "" }),
      }),
    );
    expect(out.trim()).toBe("BASE_PROMPT_MARKER");
  });

  it("drops empty sections instead of leaving dangling separators", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const out = composeSystemPrompt(cfg({ getPluginContext: () => [], getPluginInstructions: () => [] }));
    expect(out).not.toMatch(/---\s*\n\s*---/);
  });

  // ── prefix-cache invariant ────────────────────────────────────────────────
  //
  // OpenAI has no explicit cache_control; its caching is AUTOMATIC and keyed on
  // a byte-identical prompt PREFIX. Anything volatile placed early invalidates
  // everything after it, so the cache never engages.
  //
  // getPluginContext is per-session, per-turn state — the single most volatile
  // input. The copy-pasted lambda in openai/provider.ts and deepseek/provider.ts
  // placed it in the MIDDLE, before jarvis.md, which guaranteed a fresh prefix
  // on every request. Ordering stable → volatile is what makes caching possible.
  it("orders stable content first and volatile plugin context LAST (prefix cache)", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const out = composeSystemPrompt(cfg());
    const volatileAt = out.indexOf("PLUGIN_CTX");
    for (const stable of ["BASE_PROMPT_MARKER", "CORE_A", "PLUGIN_INSTR", "JARVIS_MD_BODY"]) {
      expect(volatileAt, `${stable} must come before the volatile plugin context`).toBeGreaterThan(
        out.indexOf(stable),
      );
    }
  });

  it("keeps the prefix byte-identical when only the volatile section changes", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    const a = composeSystemPrompt(cfg({ getPluginContext: () => ["TURN_ONE"] }));
    const b = composeSystemPrompt(cfg({ getPluginContext: () => ["TURN_TWO_LONGER"] }));
    const prefix = a.slice(0, a.indexOf("TURN_ONE"));
    expect(b.startsWith(prefix), "the stable prefix must survive a volatile change").toBe(true);
  });

  it("passes sessionId through to getPluginContext — per-session state must not be lost", async () => {
    const { composeSystemPrompt } = await import("./system-prompt.js");
    let seen: string | undefined = "NOT_CALLED";
    composeSystemPrompt(cfg({ getPluginContext: (sid?: string) => { seen = sid; return []; } }), "actor-fix");
    expect(seen).toBe("actor-fix");
  });
});

describe("loadBasePrompt — reads jarvis-system.md, never fails silently", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sysprompt-"));
    file = path.join(dir, "jarvis-system.md");
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the file content when the file exists", async () => {
    fs.writeFileSync(file, "# JARVIS\nreal contract\n", "utf-8");
    const { loadBasePrompt } = await import("./system-prompt.js");
    expect(loadBasePrompt(file)).toContain("real contract");
  });

  it("falls back to a minimal prompt when the file is missing", async () => {
    const { loadBasePrompt } = await import("./system-prompt.js");
    const out = loadBasePrompt(path.join(dir, "does-not-exist.md"));
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("JARVIS");
  });

  it("the fallback is identifiably a fallback, not silently passed off as the real thing", async () => {
    const { loadBasePrompt, FALLBACK_BASE_PROMPT } = await import("./system-prompt.js");
    expect(loadBasePrompt(path.join(dir, "nope.md"))).toBe(FALLBACK_BASE_PROMPT);
  });
});
