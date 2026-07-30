// src/ai/openai/session.ts
import OpenAI from "openai";
import type { AISession, AIStreamEvent, CapabilityCall, CapabilityResult, ImageBlock } from "../types.js";
import type { EventBus } from "../../core/bus.js";
import { cleanupAbortedToolMessages } from "./cleanup-aborted-tools.js";
import { log } from "../../logger/index.js";

type CapabilityDef =
  | { name: string; description: string; input_schema: Record<string, unknown> }
  | { type: string; name: string };
type Message = OpenAI.Chat.ChatCompletionMessageParam;

/** OpenAI's Chat Completions API rejects requests whose `tools` array has
 *  more than 128 entries ("Invalid 'tools': array too long"). JARVIS often
 *  exposes far more (core + plugin + every connected MCP tool), so the list
 *  is trimmed to this cap before each call. See toOpenAITools(). */
const OPENAI_MAX_TOOLS = 128;

/** Usage in the Anthropic-shaped form the HUD and telemetry expect. */
export interface NormalizedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Converts OpenAI usage into the Anthropic-shaped form used across JARVIS.
 *
 * WHY THIS EXISTS
 *   message_complete used to report cache_creation_input_tokens: 0 and
 *   cache_read_input_tokens: 0 as HARDCODED literals. OpenAI returns the real
 *   figure in usage.prompt_tokens_details.cached_tokens, which was never read,
 *   so the HUD showed zero cache even on a perfect hit — making a working cache
 *   indistinguishable from a broken one.
 *
 * SEMANTICS — the two APIs disagree, and getting this wrong doubles the bill
 * on screen:
 *   OpenAI    prompt_tokens INCLUDES the cached tokens.
 *   Anthropic input_tokens  EXCLUDES them (cache reads are counted separately).
 * The HUD speaks Anthropic's shape, so the cached portion is subtracted here.
 *
 * cache_creation stays 0 on purpose: OpenAI has no explicit cache-write step
 * and does not bill one — caching is automatic and keyed on prompt prefix.
 */
export function mapOpenAIUsage(u: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}): NormalizedUsage {
  const cached = Math.max(0, u.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: Math.max(0, u.prompt_tokens - cached),
    output_tokens: u.completion_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

const STREAMING_VERBS = [
  "Analyzing", "Bloviating", "Cogitating", "Deliberating", "Elaborating",
  "Formulating", "Generating", "Hypothesizing", "Inferring", "Juggling",
  "Kernelizing", "Lucubrating", "Musing", "Noodling", "Orchestrating",
  "Pontificating", "Quantifying", "Reasoning", "Synthesizing", "Transmuting",
];

export class OpenAISession implements AISession {
  readonly sessionId: string;
  private client: OpenAI;
  private getModel: () => string;
  private getSystemPrompt: () => string;
  private getTools: () => CapabilityDef[];
  private messages: Message[] = [];
  private label: string;
  /** Trace id of the CURRENT turn — set by JarvisCore (duck-typed, F4.17).
   *  Mirrors AnthropicSession; log-correlation only, not on AISession. */
  private turnTraceId?: string;
  private abortController?: AbortController;

  // ── Model routing (ModelRouter support) ──────────────────────────────
  private nextModelOverride?: string;
  private stickyModelOverride?: string;

  // ── Tool filtering (plugin-session support) ───────────────────────────
  private toolFilter?: (toolName: string) => boolean;

  // ── Context injector (Mnemosyne support) ─────────────────────────────
  private contextInjector?: (sessionId: string) => string[];

  /** Assistant text produced in the SAME turn as tool calls. OpenAI allows
   *  an assistant message to carry BOTH content and tool_calls — the old
   *  code discarded this text (B2), losing the model's pre-tool reasoning
   *  from history. Captured by streamFromAPI, consumed exactly once by
   *  addToolResults. (mission jarvis-fix F2.1) */
  private pendingAssistantText = "";

  // ── Bus (telemetry) ───────────────────────────────────────────────────
  private bus?: EventBus;

  constructor(opts: {
    client: OpenAI;
    model: string | (() => string);
    systemPrompt: string | (() => string);
    getTools: () => CapabilityDef[];
    label: string;
    bus?: EventBus;
  }) {
    this.sessionId = crypto.randomUUID();
    this.client = opts.client;
    const model = opts.model;
    this.getModel = typeof model === "function" ? model : () => model;
    const sp = opts.systemPrompt;
    this.getSystemPrompt = typeof sp === "function" ? sp : () => sp;
    this.getTools = opts.getTools;
    this.label = opts.label;
    this.bus = opts.bus;
    log.info({ label: this.label, sessionId: this.sessionId }, "OpenAISession: created");
  }

  /** Set the trace id for the upcoming turn (F4.17). Called by JarvisCore via
   *  duck-typing; pass undefined to clear. Used purely for log correlation. */
  setTurnTraceId(traceId: string | undefined): void {
    this.turnTraceId = traceId;
  }

  // ── Model routing ─────────────────────────────────────────────────────

  setNextModelOverride(model: string | undefined): void {
    this.nextModelOverride = model;
  }

  setStickyModelOverride(model: string | undefined): void {
    this.stickyModelOverride = model;
  }

  peekModel(): string {
    return this.nextModelOverride ?? this.stickyModelOverride ?? this.getModel();
  }

  // ── Tool filtering ────────────────────────────────────────────────────

  setToolFilter(filter: ((toolName: string) => boolean) | undefined): void {
    this.toolFilter = filter;
  }

  // ── Context injector ──────────────────────────────────────────────────

  setContextInjector(injector: (sessionId: string) => string[]): void {
    this.contextInjector = injector;
  }

  // ── Cleanup aborted tools ─────────────────────────────────────────────

  cleanupAbortedTools(pendingCalls: CapabilityCall[]): void {
    // Additive cleanup ported from the tested Anthropic module — the old
    // destructive loop popped trailing role:"tool" messages unconditionally,
    // orphaning valid assistant tool_calls (API 400). See
    // openai/cleanup-aborted-tools.ts for the decision record. (F2.4)
    this.messages = cleanupAbortedToolMessages(this.messages, pendingCalls);
    // The aborted turn's pre-tool text is represented by the synthetic
    // pair — drop any pending text so it doesn't leak into the next turn.
    this.pendingAssistantText = "";
    log.info({ label: this.label, cleaned: pendingCalls.length }, "OpenAISession: aborted tools cleaned up");
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
      log.info({ label: this.label }, "OpenAISession: aborted");
    }
  }

  async *sendAndStream(prompt: string | import("../types.js").PromptBlock[], images?: ImageBlock[]): AsyncGenerator<AIStreamEvent, void> {
    // Context injections prepend to the REAL user message of this turn —
    // parity with the Anthropic session. The old code fabricated a fake
    // user "<context>" + assistant "Understood." pair on EVERY injected
    // turn: permanent history pollution and growing token cost (B3/F2.2).
    let injectionPrefix = "";
    if (this.contextInjector) {
      const injections = this.contextInjector(this.label);
      if (injections.length > 0) {
        injectionPrefix = `<context>\n${injections.join("\n\n")}\n</context>\n\n`;
      }
    }

    // Normalize prompt to text — OpenAI doesn't need granular block separation
    const promptText = injectionPrefix + (Array.isArray(prompt)
      ? prompt.map(b => b.text).join("\n")
      : prompt);


    if (images && images.length > 0) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const img of images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        });
        content.push({ type: "text", text: `[${img.label}]` });
      }
      content.push({ type: "text", text: promptText });
      this.messages.push({ role: "user", content });
    } else {
      this.messages.push({ role: "user", content: promptText });
    }
    yield* this.streamFromAPI();
  }

  addToolResults(toolCalls: CapabilityCall[], results: CapabilityResult[]): void {
    // Add assistant message with tool calls — INCLUDING the text the model
    // produced before calling tools (captured by streamFromAPI). OpenAI
    // supports content + tool_calls on the same assistant message; dropping
    // the text lost the model's reasoning from history (B2/F2.1).
    this.messages.push({
      role: "assistant",
      content: this.pendingAssistantText || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });
    this.pendingAssistantText = ""; // consumed — exactly once
    // Add tool results
    for (const r of results) {
      this.messages.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      });
    }
  }

  async *continueAndStream(): AsyncGenerator<AIStreamEvent, void> {
    yield* this.streamFromAPI();
  }

  close(): void {
    log.info({ label: this.label, messageCount: this.messages.length }, "OpenAISession: closed");
    this.messages = [];
  }

  getMessages(): unknown[] {
    return this.messages;
  }

  setMessages(messages: unknown[]): void {
    this.messages = messages as Message[];
    log.info({ label: this.label, restored: messages.length }, "OpenAISession: messages restored");
  }

  private getEffectiveModel(): string {
    const model = this.nextModelOverride ?? this.stickyModelOverride ?? this.getModel();
    // Consume next override after first use
    if (this.nextModelOverride) {
      this.nextModelOverride = undefined;
    }
    return model;
  }

  private toOpenAITools(): OpenAI.Chat.ChatCompletionTool[] {
    const tools = this.getTools();
    const filtered = this.toolFilter ? tools.filter(t => this.toolFilter!(t.name)) : tools;
    // OpenAI does not support Anthropic server tools — skip them (no `description` field).
    const mapped = filtered
      .filter((t): t is { name: string; description: string; input_schema: Record<string, unknown> } => "description" in t)
      .map(t => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));

    // OpenAI hard-caps the `tools` array at 128 entries; JARVIS routinely
    // exposes many more (core + plugin + every connected MCP tool). Sending
    // >128 makes the API reject the whole request ("array too long"), so we
    // trim here. Priority: keep ALL non-MCP tools (core capabilities, slash,
    // plugin tools) first — those are the JARVIS essentials — then fill the
    // remaining slots with MCP tools (name-prefixed `mcp__`). This keeps the
    // model functional on OpenAI even when dozens of MCP servers are connected.
    if (mapped.length <= OPENAI_MAX_TOOLS) return mapped;

    const isMcp = (name: string) => name.startsWith("mcp__");
    const core = mapped.filter(t => !isMcp(t.function.name));
    const mcp = mapped.filter(t => isMcp(t.function.name));
    const kept = [...core, ...mcp].slice(0, OPENAI_MAX_TOOLS);
    const dropped = mapped.length - kept.length;
    log.warn(
      { label: this.label, total: mapped.length, kept: kept.length, dropped, coreKept: Math.min(core.length, OPENAI_MAX_TOOLS) },
      "OpenAISession: tool list exceeds OpenAI's 128 limit — trimmed (MCP tools dropped first)",
    );
    return kept;
  }

  private async *streamFromAPI(): AsyncGenerator<AIStreamEvent, void> {
    const t0 = Date.now();
    this.abortController = new AbortController();

    const systemPrompt = this.getSystemPrompt();
    const tools = this.toOpenAITools();
    const model = this.getEffectiveModel();

    // Pick a streaming verb for this request
    const streamingVerb = STREAMING_VERBS[Math.floor(Math.random() * STREAMING_VERBS.length)];

    log.info({ label: this.label, traceId: this.turnTraceId, model, messageCount: this.messages.length, toolCount: tools.length }, "OpenAISession: calling API");

    // Announce streaming start (verb + model for the metrics HUD).
    // Internal event — intentionally NOT in the public AIStreamMessage
    // union (published via cast, same pattern as prompt_dispatched).
    // The old shape used `type: "delta"` with no `event` field — outside
    // the channel contract: it fell through every consumer switch and
    // logged as INFO noise on the bus (B4/F2.3).
    this.bus?.publish({
      channel: "ai.stream",
      source: this.label,
      target: this.label,
      event: "streaming_started",
      data: { streamingVerb, model },
    } as any);

    try {
      const allMessages: Message[] = [
        { role: "system", content: systemPrompt },
        ...this.messages,
      ];

      const stream = await this.client.chat.completions.create({
        model,
        messages: allMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: this.abortController.signal });

      const toolCalls: CapabilityCall[] = [];
      let fullText = "";
      let usage: NormalizedUsage | undefined;

      // Track tool call assembly (streamed in pieces)
      const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          fullText += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        // Tool calls come in deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!pendingToolCalls.has(tc.index)) {
              pendingToolCalls.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            }
            const pending = pendingToolCalls.get(tc.index)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.args += tc.function.arguments;
          }
        }

        // Usage in the final chunk
        if (chunk.usage) {
          usage = mapOpenAIUsage(chunk.usage);
        }
      }

      this.abortController = undefined;

      // Assemble completed tool calls
      for (const [, pending] of pendingToolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(pending.args); } catch {}
        const tc: CapabilityCall = { id: pending.id, name: pending.name, input };
        toolCalls.push(tc);
        yield { type: "tool_use", toolUse: tc };
      }

      // Persist assistant text. With tool calls, the text is NOT pushed yet —
      // addToolResults builds the combined assistant message (content +
      // tool_calls) so the pre-tool reasoning survives in history (F2.1).
      if (toolCalls.length > 0) {
        this.pendingAssistantText = fullText;
      } else if (fullText) {
        this.messages.push({ role: "assistant", content: fullText });
        this.pendingAssistantText = "";
      }

      // Emit usage telemetry to bus
      if (usage && this.bus) {
        this.bus.publish({
          channel: "system.event",
          source: this.label,
          event: "api.openai.usage",
          data: {
            sessionId: this.label,
            model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            durationMs: Date.now() - t0,
          },
        } as any);
      }

      yield {
        type: "message_complete",
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage,
      };

      log.info({
        label: this.label,
        ms: Date.now() - t0,
        toolCalls: toolCalls.length,
        textLength: fullText.length,
        usage,
      }, "OpenAISession: API call complete");

    } catch (err) {
      this.abortController = undefined;
      if ((err as any)?.name === "AbortError") {
        log.info({ label: this.label }, "OpenAISession: stream aborted");
        yield { type: "error", error: "aborted" };
        return;
      }
      log.error({ label: this.label, traceId: this.turnTraceId, err }, "OpenAISession: API error");
      yield { type: "error", error: String(err) };
    }
  }
}
