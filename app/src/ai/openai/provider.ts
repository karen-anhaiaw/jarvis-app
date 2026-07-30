// src/ai/openai/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "./factory.js";
import { OpenAIMetricsHud } from "./metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";
import { composeSystemPrompt } from "../system-prompt.js";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["openai"] ?? {};
  // Priority: settings.user.json > env vars. No cross-provider fallback.
  const baseURL = providerCfg.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = providerCfg.apiKey ?? process.env.OPENAI_API_KEY;

  // composeSystemPrompt is shared with the DeepSeek provider (which used to
  // carry a verbatim copy of this lambda) and includes the base prompt, which
  // the old inline version omitted entirely. It also orders sections stable →
  // volatile so OpenAI's automatic prefix cache can actually engage.
  const factory = new OpenAISessionFactory(
    config.getTools,
    () => composeSystemPrompt(config),
    { apiKey, baseURL },
  );
  const metricsPiece = new OpenAIMetricsHud(factory);

  return {
    name: "openai",
    factory,
    metricsPiece,
  };
}
