// src/ai/openai/provider.ts
import type { Provider, ProviderConfig } from "../provider.js";
import { OpenAISessionFactory } from "./factory.js";
import { OpenAIMetricsHud } from "./metrics-hud.js";
import { load as loadSettings } from "../../core/settings.js";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const providerCfg = loadSettings().providers?.["openai"] ?? {};
  // Priority: settings.user.json > env vars. No cross-provider fallback.
  const baseURL = providerCfg.baseUrl ?? process.env.OPENAI_BASE_URL;
  const apiKey = providerCfg.apiKey ?? process.env.OPENAI_API_KEY;

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
    name: "openai",
    factory,
    metricsPiece,
  };
}
