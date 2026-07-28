// src/ai/deepseek/provider.ts
//
// DeepSeek provider — direct API (api.deepseek.com), not via gateway.
//
// DeepSeek exposes an OpenAI-compatible /chat/completions endpoint, so we reuse
// OpenAISessionFactory and OpenAIMetricsHud wholesale. Only the credentials and
// baseURL differ. The metrics piece keeps the shared "token-counter" id so the
// ModelPicker / TokenCounterRenderer keep working unchanged.
//
// Model IDs (2026-07): deepseek-v4-pro, deepseek-v4-flash — both 1M context,
// 384K max output. NOTE: deepseek-chat and deepseek-reasoner were retired on
// 2026-07-24 and now return 404. Do not reintroduce them.
//
// Docs: https://api-docs.deepseek.com
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "../openai/factory.js";
import { OpenAIMetricsHud } from "../openai/metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";

/** Official DeepSeek API root. The `/v1` suffix also works and is unrelated to model version. */
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["deepseek"] ?? {};
  // Priority: settings.user.json > env vars > official default. No cross-provider fallback.
  const baseURL = providerCfg.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL;
  const apiKey = providerCfg.apiKey ?? process.env.DEEPSEEK_API_KEY;

  // Fail loudly instead of silently leaking another provider's credential.
  // OpenAISessionFactory falls back to process.env.OPENAI_API_KEY when apiKey is
  // undefined — harmless for OpenAI, but here it would ship the OpenAI/gateway
  // key to api.deepseek.com. Provider factories run lazily on switchTo(), so
  // throwing here cannot break boot; it only blocks an unconfigured switch.
  if (!apiKey) {
    throw new Error(
      "DeepSeek provider is not configured: set providers.deepseek.apiKey in " +
      "~/.jarvis/settings.user.json (or export DEEPSEEK_API_KEY). Refusing to " +
      "fall back to OPENAI_API_KEY.",
    );
  }

  const factory = new OpenAISessionFactory(
    config.getTools,
    () => {
      const core = config.getCoreContext().filter(Boolean);
      const pluginInstr = config.getPluginInstructions().filter(Boolean);
      const pluginCtx = config.getPluginContext().filter(Boolean);
      const { content: instructions, filename: instrFile } = config.getInstructions();
      const parts = [core.join("\n\n---\n\n"), pluginInstr.join("\n\n"), pluginCtx.join("\n\n")];
      if (instructions) parts.push(`# ${instrFile || "instructions"}\n\n${instructions}`);
      return parts.filter(Boolean).join("\n\n---\n\n");
    },
    { apiKey, baseURL },
  );
  const metricsPiece = new OpenAIMetricsHud(factory);

  return {
    name: "deepseek",
    factory,
    metricsPiece,
  };
}
