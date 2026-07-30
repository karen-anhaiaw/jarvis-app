// src/ai/anthropic/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import type { Piece } from "../../core/piece.js";
import { AnthropicSessionFactory } from "./factory.js";
import { AnthropicMetricsHud } from "./metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["anthropic"] ?? {};
  // Priority: settings.user.json > env vars. No cross-provider fallback.
  // The SDK is instantiated explicitly with these values (session.ts) — we
  // mirror them in process.env so that any other code paths that read env
  // directly stay in sync (e.g. log diagnostics, future SDK call sites).
  if (providerCfg.apiKey) process.env.ANTHROPIC_API_KEY = providerCfg.apiKey;
  if (providerCfg.baseUrl) process.env.ANTHROPIC_BASE_URL = providerCfg.baseUrl;
  // Guard against shell-leaked ANTHROPIC_AUTH_TOKEN — when both API_KEY and
  // AUTH_TOKEN are set, the Anthropic SDK sends "Authorization: Bearer
  // <AUTH_TOKEN>" which proxies (LiteLLM/Bedrock) may prefer over x-api-key,
  // hijacking the credential. Settings.user.json is authoritative; AUTH_TOKEN
  // from shell rc files (e.g. ~/.nurc) gets cleared here.
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const factory = new AnthropicSessionFactory(
    config.getTools,
    config.getCoreContext,
    config.getPluginInstructions,
    config.getPluginContext,
    config.getInstructions,
    config.getBasePrompt,
  );
  const metricsPiece = new AnthropicMetricsHud(factory);

  return {
    name: "anthropic",
    factory,
    metricsPiece,
  };
}
