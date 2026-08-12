// src/core/settings-merge.test.ts
//
// Regression for F3.13 live-validation finding (2026-06-11): deepMerge is a
// FIELD-EXPLICIT merge — every top-level Settings field must be listed there
// or it is silently DROPPED from load(). The `delegate` field was added to
// the interface but not to deepMerge, so settings.user.json values vanished.
import { describe, it, expect } from "vitest";
import { deepMerge, getRetrySettings, type Settings } from "./settings.js";

const base = (extra: Partial<Settings> = {}): Settings => ({ pieces: {}, ...extra });

describe("settings deepMerge — top-level field passthrough", () => {
  it("preserves delegate declared only in the user file (F3.13 regression)", () => {
    const merged = deepMerge(base(), base({ delegate: { defaultRole: "nu-discovery-agent" } }));
    expect(merged.delegate).toEqual({ defaultRole: "nu-discovery-agent" });
  });

  it("falls back to the default file's delegate when user omits it", () => {
    const merged = deepMerge(base({ delegate: { defaultRole: "generic" } }), base());
    expect(merged.delegate).toEqual({ defaultRole: "generic" });
  });

  it("user delegate wins over default", () => {
    const merged = deepMerge(
      base({ delegate: { defaultRole: "generic" } }),
      base({ delegate: { defaultRole: "nu-discovery-agent" } }),
    );
    expect(merged.delegate).toEqual({ defaultRole: "nu-discovery-agent" });
  });

  it("delegate absent everywhere → undefined (no crash)", () => {
    const merged = deepMerge(base(), base());
    expect(merged.delegate).toBeUndefined();
  });

  // retry field — same passthrough contract as delegate/compaction.
  it("preserves retry declared only in the user file", () => {
    const merged = deepMerge(base(), base({ retry: { enabled: true, maxRetries: 3, rateLimitWaitMs: 5000, backoffBaseMs: 1000, respectRetryAfter: false } }));
    expect(merged.retry).toEqual({ enabled: true, maxRetries: 3, rateLimitWaitMs: 5000, backoffBaseMs: 1000, respectRetryAfter: false });
  });

  it("user retry overrides merge onto defaults (partial override fills gaps)", () => {
    // Only rateLimitWaitMs provided in user layer — the rest come from DEFAULT_RETRY.
    const merged = deepMerge(base(), base({ retry: { rateLimitWaitMs: 30000 } as any }));
    expect(merged.retry?.rateLimitWaitMs).toBe(30000);
    expect(merged.retry?.maxRetries).toBe(5); // default
    expect(merged.retry?.enabled).toBe(true); // default
  });

  it("retry absent everywhere → undefined at merge, defaults applied by getRetrySettings", () => {
    const merged = deepMerge(base(), base());
    expect(merged.retry).toBeUndefined();
    const eff = getRetrySettings(merged);
    expect(eff).toEqual({ enabled: true, maxRetries: 5, rateLimitWaitMs: 15000, backoffBaseMs: 2000, respectRetryAfter: true });
  });
});
