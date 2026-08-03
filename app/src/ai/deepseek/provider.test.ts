// src/ai/deepseek/provider.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { createDeepSeekProvider } from "./provider.js";
import type { ProviderConfig } from "../provider.js";

describe("DeepSeekProvider", () => {
  let config: ProviderConfig;

  beforeEach(() => {
    config = {
      getTools: () => [
        { name: "test_tool", description: "A test tool", input_schema: { type: "object" } },
      ],
      getBasePrompt: () => "You are a helpful assistant.",
      getCoreContext: () => [],
      getPluginInstructions: () => [],
      getPluginContext: () => [],
      getInstructions: () => ({ content: "", filename: "" }),
    };
  });

  it("creates a provider with factory and metrics hud", () => {
    // Set the API key in env (would normally come from settings)
    process.env.DEEPSEEK_API_KEY = "sk-test-key";

    const provider = createDeepSeekProvider(config);

    expect(provider.name).toBe("deepseek");
    expect(provider.factory).toBeDefined();
    expect(provider.metricsPiece).toBeDefined();
  });

  it("throws if apiKey is missing", () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete (global as any).__DEEPSEEK_SETTINGS;

    expect(() => {
      createDeepSeekProvider(config);
    }).toThrow(/DeepSeek provider is not configured/);
  });

  it("factory creates sessions with system prompt", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-key";
    const provider = createDeepSeekProvider(config);

    const session = provider.factory.create({ label: "test" });
    expect(session).toBeDefined();
    expect(session.sessionId).toBeDefined();
  });
});
