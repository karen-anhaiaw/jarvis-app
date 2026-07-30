// src/ai/provider.ts
import type { EventBus } from "../core/bus.js";
import type { AISessionFactory } from "./types.js";
import type { Piece } from "../core/piece.js";
import { log } from "../logger/index.js";
import { getProviderForModel } from "../config/index.js";

export interface Provider {
  readonly name: string;
  readonly factory: AISessionFactory;
  readonly metricsPiece: Piece;
}

type CapabilityDefProvider = () => Array<
  | { name: string; description: string; input_schema: Record<string, unknown> }
  | { type: string; name: string }
>;
type ContextProvider = (sessionId?: string) => string[];
type InstructionsProvider = () => { content: string; filename: string };

export interface ProviderConfig {
  getTools: CapabilityDefProvider;
  /**
   * The JARVIS base system prompt (jarvis-system.md).
   *
   * Lives on the ROUTER contract, not inside each factory. Previously only
   * AnthropicSessionFactory knew how to read it, so the OpenAI and DeepSeek
   * providers silently ran with no system prompt at all — no identity, no
   * Asimov's laws. Putting it here means every provider, present and future,
   * inherits it instead of having to remember.
   */
  getBasePrompt: () => string;
  getCoreContext: ContextProvider;
  getPluginInstructions: ContextProvider;
  getPluginContext: ContextProvider;
  getInstructions: InstructionsProvider;
}

export class ProviderRouter {
  private active: Provider | undefined;
  private bus: EventBus | undefined;
  private providerConfig: ProviderConfig;
  private providerFactories = new Map<string, (config: ProviderConfig) => Provider>();
  /** Cached shadow factories for cross-provider sessions (created on demand, reused). */
  private shadowFactories = new Map<string, AISessionFactory>();

  constructor(providerConfig: ProviderConfig) {
    this.providerConfig = providerConfig;
  }

  registerProviderFactory(name: string, factory: (config: ProviderConfig) => Provider): void {
    this.providerFactories.set(name, factory);
  }

  getActiveProvider(): Provider | undefined {
    return this.active;
  }

  getFactory(): AISessionFactory {
    if (!this.active) throw new Error("No active provider");
    return this.active.factory;
  }

  /**
   * Returns the factory for the provider that owns `model`.
   * Falls back to the active factory if the provider isn't registered
   * or no provider is active yet.
   */
  getFactoryForModel(model: string): AISessionFactory {
    const providerName = getProviderForModel(model);
    const createProvider = this.providerFactories.get(providerName);
    // If the requested provider IS already active, just return it (no new instance)
    if (this.active?.name === providerName) {
      return this.active.factory;
    }
    // Create a lightweight provider instance just for its factory (cached).
    // Note: this doesn't start its metricsPiece — it's factory-only.
    if (createProvider && this.bus) {
      const cached = this.shadowFactories.get(providerName);
      if (cached) return cached;
      const p = createProvider(this.providerConfig);
      p.factory.setBus?.(this.bus);
      this.shadowFactories.set(providerName, p.factory);
      log.info({ model, providerName }, "ProviderRouter: shadow factory created for cross-provider session");
      return p.factory;
    }
    // Fallback: active factory
    log.warn({ model, providerName }, "ProviderRouter: no factory for model, falling back to active");
    return this.getFactory();
  }

  async switchTo(providerName: string, bus: EventBus): Promise<string> {
    this.bus = bus;

    const createProvider = this.providerFactories.get(providerName);
    if (!createProvider) {
      return `Unknown provider: ${providerName}. Available: ${[...this.providerFactories.keys()].join(", ")}`;
    }

    // Stop current provider's metrics HUD
    if (this.active) {
      await this.active.metricsPiece.stop();
      log.info({ from: this.active.name, to: providerName }, "ProviderRouter: switching provider");
    }

    // Create and start new provider
    this.active = createProvider(this.providerConfig);
    // Give the factory the bus so provider sessions can publish telemetry.
    this.active.factory.setBus?.(bus);
    await this.active.metricsPiece.start(bus);
    log.info({ provider: this.active.name }, "ProviderRouter: provider active");

    return `Provider switched to ${providerName}`;
  }

  getProviderNames(): string[] {
    return [...this.providerFactories.keys()];
  }
}
