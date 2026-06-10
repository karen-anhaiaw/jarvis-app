// src/core/settings-merge.test.ts
//
// Regression for F3.13 live-validation finding (2026-06-11): deepMerge is a
// FIELD-EXPLICIT merge — every top-level Settings field must be listed there
// or it is silently DROPPED from load(). The `delegate` field was added to
// the interface but not to deepMerge, so settings.user.json values vanished.
import { describe, it, expect } from "vitest";
import { deepMerge, type Settings } from "./settings.js";

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
});
