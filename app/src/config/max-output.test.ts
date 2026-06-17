import { describe, it, expect } from "vitest";
import { getMaxOutput } from "./index.js";

/**
 * Regression test for the tool_use truncation bug.
 *
 * Bug: `max_tokens: 8192` in AnthropicSession limited how large a tool_use
 * input JSON could be. When an actor tried write_file with content >~8KB or
 * bash with a large command, the model truncated the JSON mid-stream, the
 * SDK returned `input: {}` or partial args, and capabilities failed with
 * `command is required` / `content is required`.
 *
 * Fix: use model-aware getMaxOutput() so Opus gets 128k, Sonnet/Haiku 64k.
 *
 * These tests pin the values. If Anthropic releases new models with different
 * caps, update getMaxOutput and this test together.
 */
describe("getMaxOutput", () => {
  it("returns 128k for Fable/Mythos models", () => {
    expect(getMaxOutput("claude-fable-5")).toBe(128_000);
    expect(getMaxOutput("claude-mythos-5")).toBe(128_000);
  });

  it("returns 128k for Opus models", () => {
    expect(getMaxOutput("claude-opus-4-7")).toBe(128_000);
    expect(getMaxOutput("claude-opus-4-6")).toBe(128_000);
    expect(getMaxOutput("opus")).toBe(128_000);
  });

  it("returns 64k for Sonnet models", () => {
    expect(getMaxOutput("claude-sonnet-4-6")).toBe(64_000);
    expect(getMaxOutput("claude-sonnet-3-5")).toBe(64_000);
  });

  it("returns 64k for Haiku models", () => {
    expect(getMaxOutput("claude-haiku-4-5")).toBe(64_000);
  });

  it("falls back to safe 16k for unknown models", () => {
    expect(getMaxOutput("gpt-4o")).toBe(16_000);
    expect(getMaxOutput("some-random-model")).toBe(16_000);
    expect(getMaxOutput("")).toBe(16_000);
  });

  it("always returns at least 16k (never the old 8192 bug value)", () => {
    const models = [
      "claude-fable-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "gpt-4o",
      "unknown-model",
      "",
    ];
    for (const m of models) {
      expect(getMaxOutput(m)).toBeGreaterThanOrEqual(16_000);
    }
  });

  it("returns value high enough to fit a ~20KB tool_use input JSON", () => {
    // A large write_file call has roughly: 20KB content + JSON overhead ≈ 25KB
    // At ~4 chars/token that's ~6250 tokens just for the tool_use input.
    // Plus preamble text and JSON structure = comfortably under 16k.
    // The old 8192 cap was too tight; all current caps must be > 16k.
    const minRequired = 16_000;
    for (const m of ["claude-fable-5", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(getMaxOutput(m)).toBeGreaterThan(minRequired);
    }
  });
});
