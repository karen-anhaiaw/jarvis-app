export type CapabilityHandler = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Where the tool is executed.
 *
 * - `"local"` (default): handler runs in the JARVIS Node process. The standard
 *   client tool_use / tool_result round-trip applies — each call costs one
 *   extra API request.
 *
 * - `"server"`: executed by the Anthropic API internally (server tools such as
 *   web_search, web_fetch, code_execution). No handler is invoked; no
 *   tool_result is sent. The result appears in the same assistant turn as a
 *   `server_tool_use` + `server_tool_result` block pair. One fewer round-trip
 *   per call.
 *
 * Added in @jarvis/core 0.9.0.
 */
export type ToolExecution = "local" | "server";

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
  /**
   * Where the tool is executed. Defaults to `"local"` when omitted so all
   * existing registrations keep working without changes.
   * Added in @jarvis/core 0.9.0.
   */
  execution?: ToolExecution;
  /**
   * Anthropic server tool type identifier (e.g. `"web_search_20250305"`).
   * Required when `execution === "server"`. Ignored for local tools.
   * This value is sent verbatim as `type` in the tools array — Anthropic
   * uses it to route to the correct server-side executor.
   */
  serverToolType?: string;
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
  /**
   * Wall time of THIS call, measured by the registry (added in 0.8.0, F5
   * turn-tracker). Per-call — NOT the Promise.all batch time. Absent when
   * the call never ran (unknown capability fast-fail). Carried on the
   * capability.result bus message; providers build API tool_result blocks
   * field-explicitly, so it never reaches provider payloads.
   */
  durationMs?: number;
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

/**
 * Wire shape for a server tool sent to the Anthropic API.
 * No description, no input_schema — Anthropic knows these internally.
 */
export interface ServerToolWire {
  type: string;   // e.g. "web_search_20250305"
  name: string;
}

/**
 * Wire shape for a local (client) tool sent to the Anthropic API.
 */
export interface LocalToolWire {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolWire = LocalToolWire | ServerToolWire;

export interface CapabilityRegistry {
  register(def: CapabilityDefinition): void;
  getDefinitions(): ToolWire[];
  execute(calls: CapabilityCall[]): Promise<CapabilityResult[]>;
  registerSlashCommand(cmd: SlashCommand): void;
  unregisterSlashCommand(name: string): void;
  getSlashCommands(): Array<{ name: string; description: string; category: string; hint?: string }>;
  readonly names: string[];
  readonly size: number;
}
