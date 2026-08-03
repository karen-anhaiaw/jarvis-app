// src/ai/deepseek/provider.ts
//
// DeepSeek provider — API OpenAI-compatible com cache nativo.
//
// Features:
//   - Prefix cache: automático via DeepSeek API (como OpenAI)
//   - System prompt: composição completa (base + contextos)
//
// Model IDs (2026-07): deepseek-v4-pro, deepseek-v4-flash
// Docs: https://api-docs.deepseek.com
//
// TODO: Adicionar compaction (Engine B) em próxima iteração
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "../openai/factory.js";
import { OpenAIMetricsHud } from "../openai/metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";
import { log } from "../../logger/index.js";

const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["deepseek"] ?? {};
  const baseURL = providerCfg.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL;
  const apiKey = providerCfg.apiKey ?? process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      "DeepSeek provider is not configured: set providers.deepseek.apiKey in " +
      "~/.jarvis/settings.user.json (or export DEEPSEEK_API_KEY). Refusing to " +
      "fall back to OPENAI_API_KEY.",
    );
  }

  log.info({ baseURL }, "DeepSeekProvider: factory created");

  // Reuse OpenAI factory but with DeepSeek endpoint + base prompt
  const factory = new OpenAISessionFactory(
    config.getTools,
    config.getBasePrompt,
    { apiKey, baseURL },
  );
  const metricsPiece = new OpenAIMetricsHud(factory);

  return {
    name: "deepseek",
    factory,
    metricsPiece,
  };
}
