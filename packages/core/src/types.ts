// Channel-based message system for JARVIS EventBus

import type { CapabilityCall, CapabilityResult } from "./tools.js";
import type { HudPieceData } from "./piece.js";

export type Channel = "ai.request" | "ai.stream" | "capability.request" | "capability.result" | "hud.update" | "system.event" | "chat.anchor" | "chat.timeline";

export interface BusMessage {
  id: string;
  timestamp: number;
  source: string;
  target?: string;
  channel: Channel;
  /**
   * Trace ID — propagates across an end-to-end conversation turn so logs
   * for chat→bus→core→provider→stream→SSE can be correlated by a single id.
   * Set by the originating publisher (e.g. ChatPiece for user input,
   * JarvisCore for follow-up streams). Optional for backward compatibility:
   * messages without traceId still work, just without correlation.
   */
  traceId?: string;
}

// Image attachment for multi-modal messages
export interface ImageAttachment {
  /** Sequential label: "Image #1", "Image #2", etc. */
  label: string;
  /** Base64-encoded image data (no data: prefix) */
  base64: string;
  /** MIME type: image/png, image/jpeg, image/gif, image/webp */
  mediaType: string;
}

// ai.request — someone wants an AI session to process a prompt
export interface AIRequestMessage extends BusMessage {
  channel: "ai.request";
  text: string;
  images?: ImageAttachment[];
  replyTo?: string;
  /**
   * Optional per-turn system reminders.
   *
   * Each entry is wrapped in `<system-reminder>...</system-reminder>` and
   * prepended to `text` BEFORE the prompt is sent to the API. The chat
   * timeline shows only `text` (clean), but the API sees reminders + text.
   *
   * Use case: turn-scoped instructions from plugins (e.g. STT forces
   * `voice_say`, never-forget injects persistent reminders, future tools
   * may add task-list context) without polluting the visible conversation.
   *
   * Persistence: the composed prompt (reminders + text) is persisted in the
   * AI session message history, so the LLM continues to see the reminders
   * in subsequent turns via prompt caching. The user-visible chat timeline
   * keeps showing only `text`.
   *
   * Multiple sources: if multiple publishers ever need to inject reminders
   * for the same turn, concatenate the arrays in order — entries are emitted
   * sequentially in the final prompt.
   *
   * Compatibility: optional field added in @jarvis/core 0.5.0. Plugins built
   * against older core versions still work — they simply omit `systems` and
   * the prompt is sent verbatim.
   */
  systems?: string[];
  /**
   * Optional payload for dispatch metadata.
   *
   * Conventional keys (consumed by core pieces):
   *   - `utility: true` — this is a utility call (summary, classification,
   *     title generation, etc). The ModelRouter routes it to the configured
   *     utility model (Haiku by default) WITHOUT touching the session's
   *     sticky model. Use for isolated, one-shot calls that don't share
   *     cache with the main loop.
   *   - `actorRole`, `actorContext` — actor-runner plugin metadata.
   *   - any other plugin-specific key.
   */
  data?: Record<string, unknown> & { utility?: boolean };
}

// ai.stream — tokens coming from any AI session
export interface AIStreamMessage extends BusMessage {
  channel: "ai.stream";
  event: "delta" | "complete" | "error" | "tool_start" | "tool_done" | "tool_cancelled" | "aborted" | "compaction";
  text?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
  toolName?: string;
  toolId?: string;
  toolMs?: number;
  toolArgs?: string;
  toolOutput?: string;
  compaction?: {
    summary: string;
    engine: 'api' | 'fallback';
    tokensBefore: number;
    tokensAfter: number;
  };
}

// capability.request — AI session wants to execute capabilities
export interface CapabilityRequestMessage extends BusMessage {
  channel: "capability.request";
  calls: CapabilityCall[];
}

// capability.result — capability execution results
export interface CapabilityResultMessage extends BusMessage {
  channel: "capability.result";
  results: CapabilityResult[];
}

// hud.update — panel lifecycle
export interface HudUpdateMessage extends BusMessage {
  channel: "hud.update";
  action: "add" | "update" | "remove";
  pieceId: string;
  piece?: HudPieceData;
  data?: Record<string, unknown>;
  status?: string;
  visible?: boolean;
  layout?: { x: number; y: number; width: number; height: number };
}

// system.event — everything else (health, MCP, api usage, etc.)
export interface SystemEventMessage extends BusMessage {
  channel: "system.event";
  event: string;
  data: Record<string, unknown>;
}

// ─── Turn summaries (Pillar B — F5) ─────────────────────────────────────
// Published by jarvis-core as `system.event` with `event: "turn.summary"`
// and `data` shaped as TurnSummary. One summary per conversation turn
// (one traceId): prompt dispatch → session idle, spanning 1..N API
// round-trips. Public API from 0.8.0 — plugins may subscribe and consume.
// See docs/features/turn-tracker.md for the full design.

/** Per-tool execution stat inside a TurnSummary. */
export interface TurnToolStat {
  /** Shortened tool name (same form the chat timeline shows). */
  name: string;
  /** Provider tool_use id — joins ai.stream tool_start/tool_done events. */
  toolUseId: string;
  /**
   * Registry-measured wall time of THIS call (not the batch).
   * Absent — not 0 — when the result never arrived (e.g. abort mid-tools).
   */
  durationMs?: number;
  isError: boolean;
}

/**
 * One conversation turn, aggregated. Emitted exactly once per traceId on
 * `system.event: turn.summary` when the turn closes (completed, aborted
 * or error). All usage numbers default to 0 — never NaN/undefined.
 */
export interface TurnSummary {
  traceId: string;
  sessionId: string;
  /** ai.request source: "chat-input", "cron", an actor session id, "drain:combined", … */
  source: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /**
   * First text delta − startedAt (user-perceived latency). Absent when the
   * turn streamed no text. Only the FIRST delta of the turn sets it.
   */
  ttftMs?: number;
  /** API calls in this turn (≥1 unless the turn errored before dispatch). */
  roundTrips: number;
  /** Model observed on the last round-trip. */
  model?: string;
  /** stop_reason of the round-trip that ended the turn. */
  stopReason?: string;
  outcome: "completed" | "aborted" | "error";
  /** Present when outcome === "error". */
  error?: string;
  /** Total streamed text length (chars). */
  textChars: number;
  tools: TurnToolStat[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** input + cacheRead + cacheWrite (everything billed on the input side). */
    totalInput: number;
    /** totalInput + output. */
    total: number;
  };
  /**
   * Server-side estimate by model-family pricing. Undefined for unknown
   * families — consumers must render "—", never fabricate a number.
   */
  costUsd?: number;
}

// chat.anchor — pieces declare/remove/clear UI anchors that float above the
// chat composer (per-session). Generic mechanism: any piece can publish.
// The frontend AnchorRegistry consumes via SSE forwarding in ChatPiece.
export interface ChatAnchor {
  /** Unique within (sessionId, source). */
  id: string;
  /** Session scope — anchors NEVER cross sessions. Required. */
  sessionId: string;
  /** Owner identifier (piece id, plugin name, etc.) for diagnostics. */
  source: string;
  /** Higher = rendered higher in the stack. Default 0. */
  priority?: number;
  /** Discriminator interpreted by the front renderer registry.
   *  Built-in: "choice". Plugins can register their own kinds. */
  rendererKind: string;
  /** Arbitrary data the renderer consumes. */
  payload: unknown;
  /** Optional plugin renderer (loaded via /plugins/<plugin>/renderers/<file>.js)
   *  if the kind is not built-in. */
  renderer?: { plugin: string; file: string };
  /** Auto-remove after this many ms (clock starts at set time). */
  ttlMs?: number;
  /** Wallclock ms; set automatically by the registry if missing. */
  createdAt?: number;
}

export interface ChatAnchorMessage extends BusMessage {
  channel: "chat.anchor";
  /** Always carries sessionId for routing — even on remove/clear. */
  sessionId: string;
  action: "set" | "remove" | "clear";
  /** Required when action === "set". */
  anchor?: ChatAnchor;
  /** Required when action === "remove". */
  anchorId?: string;
}

/**
 * A single notification entry for the chat timeline.
 *
 * `text` is always shown as a plain-text fallback.
 * `rendererKind` + `renderer` follow the same contract as ChatAnchor:
 *   built-in kinds are handled natively; custom kinds load the plugin
 *   renderer from /plugins/<plugin>/renderers/<file>.js.
 * `payload` carries structured data for the renderer — never UI instructions.
 */
export interface ChatTimelineEntry {
  /** Session scope — entries never cross sessions. */
  sessionId: string;
  /** Owner for diagnostics (piece id, plugin name, etc). */
  source: string;
  /** Plain-text fallback — always shown when no renderer is present. */
  text: string;
  /**
   * Semantic discriminator for renderer dispatch.
   * The core stays agnostic — it bridges the entry verbatim.
   * Unknown kinds fall back to `text`.
   */
  rendererKind?: string;
  /**
   * Optional external renderer loaded from the plugin's renderers/ dir.
   * When present and the bundle loads successfully, replaces the fallback.
   */
  renderer?: { plugin: string; file: string };
  /** Structured data passed verbatim to the renderer component. */
  payload?: unknown;
}

export interface ChatTimelineMessage extends BusMessage {
  channel: "chat.timeline";
  entry: ChatTimelineEntry;
}

export type AnyBusMessage = AIRequestMessage | AIStreamMessage | CapabilityRequestMessage | CapabilityResultMessage | HudUpdateMessage | SystemEventMessage | ChatAnchorMessage | ChatTimelineMessage;

// Distributive Omit — preserves union discrimination when omitting keys
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

// Type for bus.publish() — auto-filled fields (id, timestamp) omitted, union preserved
export type PublishMessage = DistributiveOmit<AnyBusMessage, "id" | "timestamp">;

// Handler type
export type MessageHandler<T extends BusMessage = BusMessage> = (msg: T) => void | Promise<void>;
