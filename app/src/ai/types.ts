// src/ai/types.ts

export interface AIStreamEvent {
  type: 'text_delta' | 'tool_use' | 'message_complete' | 'error' | 'compaction' | 'compaction_start' | 'compaction_failed';
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'compaction';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  error?: string;
  /**
   * Emitted at the START of a compaction operation. Only Engine B (fallback /
   * manual `forceCompact`) emits this — Engine A (server-side, API-native) is
   * effectively instantaneous from the client's perspective and only emits the
   * final `compaction` event.
   */
  compactionStart?: {
    engine: 'fallback';
    tokensBefore: number;
    /** Optional reason for why compaction started. */
    reason?: 'forced' | 'threshold' | 'growth' | 'sliding-window';
  };
  /**
   * Emitted when an Engine B compaction attempt FAILS — summarizer error,
   * empty/too-short summary, or pre-compact backup write failure. The session
   * history is guaranteed untouched. Added after the 2026-06-10 incident where
   * an empty summary silently replaced 734k tokens of history; failures must
   * be visible so the UI can resolve the pending banner instead of hanging.
   */
  compactionFailed?: {
    engine: 'fallback';
    /** Human-readable cause — surfaced in the chat failure banner and logs. */
    reason: string;
    tokensBefore: number;
  };
  compaction?: {
    summary: string;
    engine: 'api' | 'fallback' | 'sliding-window';
    tokensBefore: number;
    tokensAfter: number;
  };
}

export type ToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;

export interface CapabilityResult {
  tool_use_id: string;
  content: ToolResultContent;
  is_error?: boolean;
  /**
   * Wall time of THIS call, measured by the registry (F5 turn-tracker).
   * Per-call — NOT the Promise.all batch time. Absent when the call never
   * ran (unknown capability fast-fail). Providers build API tool_result
   * blocks field-explicitly, so this never reaches the provider payload.
   */
  durationMs?: number;
}

export interface CapabilityCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ImageBlock {
  label: string;
  base64: string;
  mediaType: string;
}

/**
 * Callback invoked by AISession before each API call to gather ephemeral
 * context to prepend (as a cache_control:ephemeral block) to the user message.
 * Returns string[] — each string is a context block. Multiple blocks are
 * joined and prepended to the user message content with cache_control:ephemeral.
 * Return [] to contribute nothing for this call.
 */
export type ContextInjectorFn = (sessionId: string) => string[];

/**
 * A single text block for structured prompts (e.g. inter-session messages
 * where the [SYSTEM] context and the actual user text should be separate
 * content blocks rather than one concatenated string).
 */
export interface PromptBlock {
  type: "text";
  text: string;
}

export interface AISession {
  readonly sessionId: string;
  sendAndStream(prompt: string | PromptBlock[], images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void>;
  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void;
  continueAndStream(): AsyncGenerator<AIStreamEvent, void>;
  abort(): void;
  close(): void;
  /** Get raw message history for persistence */
  getMessages(): unknown[];
  /** Restore message history from persistence */
  setMessages(messages: unknown[]): void;
  /** Clean up message history after abort during waiting_tools */
  cleanupAbortedTools?(pendingCalls: CapabilityCall[]): void;
  /** Set a callback to provide ephemeral context injected as messages (not system prompt) */
  setContextInjector?(injector: ContextInjectorFn): void;
  /** Force context compaction (Engine B) regardless of token threshold */
  forceCompact?(): AsyncGenerator<AIStreamEvent, void>;

  // ─── Per-call model routing (optional) ──────────────────────────────────
  // Providers that support per-call model selection implement these.
  // The ModelRouter piece sets the override BEFORE sendAndStream/continueAndStream;
  // the session consumes it on the next API call. Providers without
  // per-call routing simply leave these unimplemented (router becomes no-op).

  /** One-shot model for the next API call. Cleared after consumption. */
  setNextModelOverride?(model: string | undefined): void;
  /** Sticky model for all subsequent calls. `undefined` clears. */
  setStickyModelOverride?(model: string | undefined): void;
  /** Effective model for the next call without consuming any override. */
  peekModel?(): string;

  // ─── Per-session tool filtering (optional) ──────────────────────────────
  // Plugins (e.g. actor-runner) can restrict the visible tool surface by role.
  // Implemented by wrapping `getTools()` — the filter is consulted on every
  // API call, so tools registered later still respect it.

  /** Set a predicate that filters which tools are sent to the model. `undefined` clears. */
  setToolFilter?(filter: ((toolName: string) => boolean) | undefined): void;
}

export interface CreateWithPromptOptions {
  label: string;
  /** Replaces the base system prompt (e.g. custom system prompt instead of jarvis-system.md) */
  basePromptOverride?: string;
  /** Extra context appended inside <system-reminder> after instructions (e.g. role prompt) */
  roleContext?: string;
}

export interface AISessionFactory {
  create(options?: { label?: string; restoreMessages?: unknown[]; restoredSessionId?: string }): AISession;
  createWithPrompt(options: CreateWithPromptOptions & { restoredSessionId?: string }): AISession;
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /**
   * Optional: attach the EventBus so sessions created by the factory can publish
   * provider-specific telemetry (e.g. per-session usage). Providers that do not
   * emit usage events on the bus may leave this unimplemented.
   */
  setBus?(bus: import("../core/bus.js").EventBus): void;
}
