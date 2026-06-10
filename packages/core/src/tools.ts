export type CapabilityHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface CapabilityDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: CapabilityHandler;
  /** Optional slash-menu grouping (e.g. "filesystem", "hud", "mcp").
   *  Declared by the registrar; when omitted the registry applies structural
   *  fallbacks: `mcp__`-prefixed names → "mcp", else "general".
   *  Added in 0.7.0 — optional, older plugins keep working without it. */
  category?: string;
}

export interface CapabilityCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface CapabilityResult {
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  source: string;
  handler: (args: string) => Promise<SlashCommandResult>;
}

export interface SlashCommandResult {
  /** Text to inject into system prompt (active skill body) */
  inject?: string;
  /** Message to show in chat */
  message?: string;
  /** Dispatch to actor (context: fork) */
  dispatch?: { role: string; task: string };
}

export interface CapabilityRegistry {
  register(def: CapabilityDefinition): void;
  getDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  execute(calls: CapabilityCall[]): Promise<CapabilityResult[]>;
  registerSlashCommand(cmd: SlashCommand): void;
  unregisterSlashCommand(name: string): void;
  getSlashCommands(): Array<{ name: string; description: string; category: string; hint?: string }>;
  readonly names: string[];
  readonly size: number;
}
