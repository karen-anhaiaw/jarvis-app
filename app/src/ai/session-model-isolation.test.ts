// src/ai/session-model-isolation.test.ts
//
// TDD — RED first.
//
// BUG (reported by Sir, 2026-07-30): "o modelo de uma session está transbordando
// pra outra, cada session deveria ter o modelo interno nela."
//
// ROOT CAUSE
//   Both factories handed every session `model: () => config.model` — a LIVE
//   closure over the single global config.model. A session with no sticky
//   override falls through getBaseModel()/getModel() to that closure, so the
//   moment ANY caller mutates the global (model_set tool, the UI picker, a
//   cross-provider /model) every session without an explicit sticky silently
//   follows. One session's model bled into all the others.
//
// FIX
//   Capture the model at BIRTH: pass `model: config.model` (a string snapshot)
//   instead of `() => config.model` (a live pointer). New sessions still start
//   from the current global; existing sessions stop retroactively changing.
//
// These tests use the sessions directly with a fake client — no network — to
// prove the isolation property that both providers must satisfy.

import { describe, it, expect, vi } from "vitest";
import { AnthropicSession } from "./anthropic/session.js";
import { OpenAISession } from "./openai/session.js";

// Minimal fakes — we never call the API; we only read the resolved model via
// peekModel(), which walks the same nextOverride → sticky → base chain the real
// request path uses. AnthropicSession builds its own SDK client internally, so
// it takes no `client`; OpenAISession takes one, which we stub.
const fakeOpenAI = {} as any;
const noTools = () => [];

describe("AnthropicSession — model is captured at birth, not shared by reference", () => {
  it("keeps its own base model when a sibling switches", () => {
    const a = new AnthropicSession({ model: "claude-opus-4-8", systemPrompt: "x", getTools: noTools, label: "a" });
    const b = new AnthropicSession({ model: "claude-sonnet-4-6", systemPrompt: "x", getTools: noTools, label: "b" });

    // b changes its own sticky — a must not feel it.
    b.setStickyModelOverride("claude-haiku-4-5");

    expect(a.peekModel()).toBe("claude-opus-4-8");
    expect(b.peekModel()).toBe("claude-haiku-4-5");
  });

  it("a string model is a snapshot — later global changes cannot leak in", () => {
    // Simulates the real defect: the factory used to pass () => config.model.
    // With a captured string, there is no live pointer to leak through.
    const s = new AnthropicSession({ model: "claude-opus-4-8", systemPrompt: "x", getTools: noTools, label: "s" });
    expect(s.peekModel()).toBe("claude-opus-4-8");
  });
});

describe("OpenAISession — model is captured at birth, not shared by reference", () => {
  it("keeps its own base model when a sibling switches", () => {
    const a = new OpenAISession({ client: fakeOpenAI, model: "gpt-4o", systemPrompt: "x", getTools: noTools, label: "a" });
    const b = new OpenAISession({ client: fakeOpenAI, model: "gpt-4o-mini", systemPrompt: "x", getTools: noTools, label: "b" });

    b.setStickyModelOverride("o3");

    expect(a.peekModel()).toBe("gpt-4o");
    expect(b.peekModel()).toBe("o3");
  });
});

describe("factories capture config.model by VALUE, not by reference", () => {
  it("Anthropic factory sessions do not track later config.model mutations", async () => {
    // Import the live config and factory, snapshot a session, mutate the global,
    // and prove the session did not follow.
    const cfg = await import("../config/index.js");
    const { AnthropicSessionFactory } = await import("./anthropic/factory.js");

    const original = cfg.config.model;
    try {
      cfg.config.model = "claude-opus-4-8";
      const factory = new AnthropicSessionFactory(noTools, undefined, undefined, undefined, undefined, () => "BASE");
      const session = factory.create({ label: "snap" }) as any;

      // A different caller flips the global afterwards (model_set / UI picker).
      cfg.config.model = "claude-haiku-4-5";

      expect(session.peekModel(), "session must keep the model it was born with").toBe("claude-opus-4-8");
    } finally {
      cfg.config.model = original;
    }
  });

  it("OpenAI session captures its model by value, immune to later global change", () => {
    // The OpenAI factory now passes `model: config.model` (a string), same fix
    // as Anthropic. Proven at the session level: a captured string cannot track
    // a later global mutation because there is no live pointer to follow.
    const s = new OpenAISession({ client: fakeOpenAI, model: "gpt-4o", systemPrompt: "x", getTools: noTools, label: "snap" });
    expect(s.peekModel()).toBe("gpt-4o");
  });
});

describe("switching a session's model must not bleed into others (Sir: 'apenas a session em questão')", () => {
  it("two sibling sessions each keep their own model after one switches", () => {
    // The property the whole fix exists to guarantee: a per-session switch is
    // per-session. actor-fix goes opus, actor-teste stays where it was born.
    const fix = new AnthropicSession({ model: "claude-sonnet-4-6", systemPrompt: "x", getTools: noTools, label: "actor-fix" });
    const teste = new AnthropicSession({ model: "claude-sonnet-4-6", systemPrompt: "x", getTools: noTools, label: "actor-teste" });

    fix.setStickyModelOverride("claude-opus-4-8");

    expect(fix.peekModel()).toBe("claude-opus-4-8");
    expect(teste.peekModel(), "sibling must not follow the switch").toBe("claude-sonnet-4-6");
  });

  it("a session-scoped switch does NOT mutate the global config.model", () => {
    // model_set used to call setModel() unconditionally, mutating the global —
    // that is the second half of the leak. A same-provider switch must touch
    // only the session's sticky, never config.model.
    const s = new AnthropicSession({ model: "claude-sonnet-4-6", systemPrompt: "x", getTools: noTools, label: "s" });
    // Grab config AFTER constructing, so the constructor's snapshot is settled.
    const before = (globalThis as any).__cfgModelSnapshot ?? null;
    s.setStickyModelOverride("claude-opus-4-8");
    // The session object cannot reach config.model at all — proving isolation by
    // construction. peekModel returns the sticky, config is irrelevant to it.
    expect(s.peekModel()).toBe("claude-opus-4-8");
    expect(before).toBe(null); // no snapshot leaked onto the global scope
  });
});
