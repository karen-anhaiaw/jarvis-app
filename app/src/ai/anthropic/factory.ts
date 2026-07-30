// src/ai/anthropic/factory.ts
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { loadBasePrompt } from "../system-prompt.js";
import type { AISession, AISessionFactory, CreateWithPromptOptions } from "../types.js";
import type { EventBus } from "../../core/bus.js";
import { AnthropicSession } from "./session.js";
import { config } from "../../config/index.js";
import { DEFAULT_SESSION } from "../../core/constants.js";
import { log } from "../../logger/index.js";

type CapabilityDef =
  | { name: string; description: string; input_schema: Record<string, unknown> }
  | { type: string; name: string };
type CapabilityProvider = () => CapabilityDef[];

export class AnthropicSessionFactory implements AISessionFactory {
  private basePrompt: string;
  private getTools: CapabilityProvider;
  private getCoreContext: () => string[];
  private getPluginInstructions: () => string[];
  private getPluginContext: (sessionId?: string) => string[];
  private getInstructions: () => { content: string; filename: string };
  private bus?: EventBus;
  private sessionCounter = 0;

  constructor(
    getTools: CapabilityProvider,
    getCoreContext?: () => string[],
    getPluginInstructions?: () => string[],
    getPluginContext?: (sessionId?: string) => string[],
    getInstructions?: () => { content: string; filename: string },
    getBasePrompt?: () => string,
  ) {
    // The base prompt comes from the router (ProviderConfig.getBasePrompt) so
    // every provider shares one source. The local read stays as a fallback for
    // direct construction in tests and tooling.
    this.basePrompt = getBasePrompt ? getBasePrompt() : loadBasePrompt();
    this.getTools = getTools;
    this.getCoreContext = getCoreContext ?? (() => []);
    this.getPluginInstructions = getPluginInstructions ?? (() => []);
    this.getPluginContext = getPluginContext ?? (() => []);
    this.getInstructions = getInstructions ?? (() => ({ content: "", filename: "" }));
    log.info({ model: config.model, basePromptLength: this.basePrompt.length }, "AnthropicSessionFactory: initialized");
  }

  /** Attach the EventBus so new sessions can publish per-session usage telemetry. */
  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  /**
   * Build system blocks for sessions created with a custom prompt override
   * (typically plugin-owned sessions). Composition: jarvis.md (CLAUDE.md)
   * instructions + caller-provided basePromptOverride + roleContext.
   * No jarvis-system.md, no core contexts, no plugin instructions (those are JARVIS-specific).
   */
  private buildCustomSystemBlocks(basePromptOverride?: string, roleContext?: string, sessionId?: string): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0: jarvis.md (CLAUDE.md) + caller's basePromptOverride + role
    const parts: string[] = [];

    const { content: instructions, filename: instrFile } = this.getInstructions();
    if (instructions) {
      // data-source identifica o arquivo real (ex: CLAUDE.md) para diagnóstico.
      // Não adicionamos heading — o conteúdo do arquivo já começa com # Title.
      parts.push(`<system-reminder${instrFile ? ` data-source="${instrFile}"` : ""}>\n${instructions}\n</system-reminder>`);
    }

    if (basePromptOverride) {
      parts.push(basePromptOverride);
    }

    if (roleContext) {
      parts.push(roleContext);
    }

    blocks.push({
      type: "text",
      text: parts.join("\n\n---\n\n"),
      cache_control: { type: "ephemeral" },
    });

    // Block 1: plugin dynamic context (per-session — skills etc.)
    const pluginContexts = this.getPluginContext(sessionId).filter(Boolean);
    if (pluginContexts.length > 0) {
      blocks.push({
        type: "text",
        text: pluginContexts.join("\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    return blocks;
  }

  /** Create a session with custom system prompt overrides and prompt caching */
  createWithPrompt(options: CreateWithPromptOptions & { restoredSessionId?: string }): AISession {
    const { label, basePromptOverride, roleContext, restoredSessionId } = options;
    const blockBuilder = () => this.buildCustomSystemBlocks(basePromptOverride, roleContext, label);
    log.debug({ label, hasBaseOverride: !!basePromptOverride, hasRoleContext: !!roleContext, restoredSessionId: !!restoredSessionId }, "AnthropicSessionFactory: creating custom session with cache");
    return new AnthropicSession({
      model: () => config.model,
      systemPrompt: blockBuilder,
      getTools: this.getTools,
      label,
      bus: this.bus,
      restoredSessionId,
      // Effort policy (F3.12): the human-facing default session gets the top
      // tier; background plugin-owned sessions run "high". Policy lives HERE —
      // the provider session must not interpret magic label names.
      highEffort: label === DEFAULT_SESSION,
    });
  }

  getToolDefinitions(): CapabilityDef[] {
    return this.getTools();
  }

  /** Estimate token breakdown (1 token ≈ 4 chars) */
  getTokenBreakdown(): { systemTokens: number; toolsTokens: number } {
    const systemChars = this.buildSystemString().length;
    const toolsChars = JSON.stringify(this.getTools()).length;
    return {
      systemTokens: Math.ceil(systemChars / 4),
      toolsTokens: Math.ceil(toolsChars / 4),
    };
  }

  /** Build system prompt as TextBlockParam[] with cache breakpoints for main sessions */
  buildSystemBlocks(sessionId?: string): TextBlockParam[] {
    const blocks: TextBlockParam[] = [];

    // Block 0 (BP1): base prompt + core contexts + instructions + plugin instructions
    // These rarely change during a session — one stable cache breakpoint.
    const parts: string[] = [this.basePrompt];

    const coreContexts = this.getCoreContext().filter(Boolean);
    if (coreContexts.length > 0) {
      parts.push(coreContexts.join("\n\n---\n\n"));
    }

    const { content: instructions, filename: instrFile } = this.getInstructions();
    if (instructions) {
      parts.push(`<system-reminder${instrFile ? ` data-source="${instrFile}"` : ""}>\n${instructions}\n</system-reminder>`);
    }

    // Plugin instructions (registry + context.md) — static, changes only when plugins are added/removed
    const pluginInstructions = this.getPluginInstructions().filter(Boolean);
    if (pluginInstructions.length > 0) {
      parts.push(pluginInstructions.join("\n\n"));
    }

    blocks.push({
      type: "text",
      text: parts.join("\n\n---\n\n"),
      cache_control: { type: "ephemeral" },
    });

    // Block 1 (BP2): plugin dynamic context — changes every turn (per-session state)
    const pluginContexts = this.getPluginContext(sessionId).filter(Boolean);
    if (pluginContexts.length > 0) {
      blocks.push({
        type: "text",
        text: pluginContexts.join("\n\n"),
        cache_control: { type: "ephemeral" },
      });
    }

    return blocks;
  }

  create(options?: { label?: string; restoreMessages?: unknown[]; restoredSessionId?: string }): AISession {
    const label = options?.label ?? `session-${this.sessionCounter++}`;
    log.debug({ label, contextBlocks: this.getCoreContext().length + this.getPluginContext().length, restoredSessionId: !!options?.restoredSessionId }, "AnthropicSessionFactory: creating session");

    const session = new AnthropicSession({
      model: () => config.model,
      systemPrompt: () => this.buildSystemBlocks(label),
      getTools: this.getTools,
      label,
      bus: this.bus,
      restoredSessionId: options?.restoredSessionId,
      // Effort policy (F3.12): see createWithPrompt — same rule, one place.
      highEffort: label === DEFAULT_SESSION,
    });

    if (options?.restoreMessages && options.restoreMessages.length > 0) {
      session.setMessages(options.restoreMessages);
      log.info({ label, restored: options.restoreMessages.length }, "AnthropicSessionFactory: restored messages into new session");
    }

    return session;
  }

  /** String version for token estimation */
  private buildSystemString(): string {
    const core = this.getCoreContext().filter(Boolean);
    const pluginInstr = this.getPluginInstructions().filter(Boolean);
    const pluginCtx = this.getPluginContext().filter(Boolean);
    const all = [...core, ...pluginInstr, ...pluginCtx];
    if (all.length === 0) return this.basePrompt;
    return this.basePrompt + "\n\n---\n\n" + all.join("\n\n---\n\n");
  }

}
