// src/ai/anthropic/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import type { Piece } from "../../core/piece.js";
import { AnthropicSessionFactory } from "./factory.js";
import { AnthropicMetricsHud } from "./metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["anthropic"] ?? {};
  // Priority: settings.user.json > env vars. No cross-provider fallback.
  // SDK reads from env automatically — set only if settings override present.
  if (providerCfg.apiKey) process.env.ANTHROPIC_API_KEY = providerCfg.apiKey;
  if (providerCfg.baseUrl) process.env.ANTHROPIC_BASE_URL = providerCfg.baseUrl;

  const factory = new AnthropicSessionFactory(
    config.getTools,
    config.getCoreContext,
    config.getPluginInstructions,
    config.getPluginContext,
    config.getInstructions,
  );
  const metricsPiece = new AnthropicMetricsHud(factory);

  return {
    name: "anthropic",
    factory,
    metricsPiece,
  };
}
