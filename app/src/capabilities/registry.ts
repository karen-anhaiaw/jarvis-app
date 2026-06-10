// src/capabilities/registry.ts
import type { CapabilityCall, CapabilityResult } from "../ai/types.js";
import { log } from "../logger/index.js";

/** Called by the executor while a tool is running to push partial stdout. */
export type ProgressCallback = (chunk: string) => void;

export type CapabilityHandler = (input: Record<string, unknown>, onProgress?: ProgressCallback) => Promise<unknown>;

export interface CapabilityDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: CapabilityHandler;
  /** If true, the handler accepts a progress callback and will stream partial output. */
  supportsProgress?: boolean;
  /** Slash-menu grouping, declared by the tool's OWNER at registration time
   *  (F3.15). Replaces the old hardcoded per-tool string lists in
   *  getSlashCommands — the registry must not know tool names. When omitted,
   *  structural fallbacks apply: names with the `mcp__` prefix → "mcp",
   *  everything else → "general". */
  category?: string;
}

export type CapabilityExecutionListener = (toolName: string, isError: boolean, timeMs: number) => void;

/**
 * Context provided to a slash command handler at invocation time.
 * Plumbed through from whoever dispatches the command (e.g. ChatPiece)
 * so handlers can act on the session that typed the slash, instead of
 * hardcoding "main".
 */
export interface SlashCommandContext {
  /** Session that issued the command ("main", "actor-alice", etc). */
  sessionId?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  source: string;
  handler: (args: string, ctx?: SlashCommandContext) => Promise<SlashCommandResult>;
}

export interface SlashCommandResult {
  inject?: string;
  message?: string;
  dispatch?: { role: string; task: string };
}

export class CapabilityRegistry {
  private tools = new Map<string, CapabilityDefinition>();
  private slashCommands = new Map<string, SlashCommand>();
  private listeners: CapabilityExecutionListener[] = [];

  onExecution(listener: CapabilityExecutionListener): void {
    this.listeners.push(listener);
  }

  register(def: CapabilityDefinition): void {
    this.tools.set(def.name, def);
    log.info({ name: def.name }, "CapabilityRegistry: registered");
  }

  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return [...this.tools.values()].map(({ name, description, input_schema }) => ({
      name, description, input_schema,
    }));
  }

  async execute(
    calls: CapabilityCall[],
    onProgress?: (toolId: string, toolName: string, chunk: string) => void,
  ): Promise<CapabilityResult[]> {
    return Promise.all(
      calls.map(async (tc) => {
        const def = this.tools.get(tc.name);
        if (!def) {
          return { tool_use_id: tc.id, content: JSON.stringify({ error: `Unknown capability: ${tc.name}` }), is_error: true };
        }
        const t0 = Date.now();
        try {
          log.info({ tool: tc.name, input: tc.input }, "CapabilityRegistry: executing");
          const progressCb: ProgressCallback | undefined = (onProgress && def.supportsProgress)
            ? (chunk) => onProgress(tc.id, tc.name, chunk)
            : undefined;
          const result = await def.handler(tc.input, progressCb);
          // If handler returns an array of content blocks (image/text), pass as-is
          if (Array.isArray(result) && result.length > 0 && result[0]?.type && ["image", "text", "document"].includes(result[0].type)) {
            log.info({ tool: tc.name, contentBlocks: result.length, types: result.map((b: any) => b.type) }, "CapabilityRegistry: result (content blocks)");
            for (const l of this.listeners) l(tc.name, false, Date.now() - t0);
            return { tool_use_id: tc.id, content: result };
          }
          const content = JSON.stringify(result);
          log.info({ tool: tc.name, resultLength: content.length, preview: content.slice(0, 200) }, "CapabilityRegistry: result (text)");
          for (const l of this.listeners) l(tc.name, false, Date.now() - t0);
          return { tool_use_id: tc.id, content };
        } catch (err) {
          log.error({ tool: tc.name, input: tc.input, err }, "CapabilityRegistry: handler error");
          for (const l of this.listeners) l(tc.name, true, Date.now() - t0);
          return { tool_use_id: tc.id, content: JSON.stringify({ error: String(err) }), is_error: true };
        }
      })
    );
  }

  registerSlashCommand(cmd: SlashCommand): void {
    this.slashCommands.set(cmd.name, cmd);
    log.info({ name: cmd.name, source: cmd.source }, "CapabilityRegistry: slash command registered");
  }

  unregisterSlashCommand(name: string): void {
    if (this.slashCommands.delete(name)) {
      log.info({ name }, "CapabilityRegistry: slash command unregistered");
    }
  }

  getSlashCommand(name: string): SlashCommand | undefined {
    return this.slashCommands.get(name);
  }

  /** Get slash-command metadata for the UI (name, description, category, hint) */
  getSlashCommands(): Array<{ name: string; description: string; category: string; hint?: string }> {
    // Plugin-registered slash commands (skills, etc.)
    const pluginCommands = [...this.slashCommands.values()].map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      category: cmd.source,
      hint: cmd.hint,
    }));

    // Capability-derived commands. Category is DECLARATIVE (F3.15): each
    // tool's owner sets `category` at registration — the registry must not
    // maintain per-tool name lists. Only two STRUCTURAL fallbacks remain:
    //   - the `mcp__` name prefix (MCP tool convention) → "mcp", so dynamic
    //     registrars that skip the field still group correctly;
    //   - everything else → "general".
    const capCommands = [...this.tools.values()].map(({ name, description, category }) => ({
      name,
      description,
      category: category ?? (name.startsWith("mcp__") ? "mcp" : "general"),
    }));

    return [...pluginCommands, ...capCommands];
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }
}
