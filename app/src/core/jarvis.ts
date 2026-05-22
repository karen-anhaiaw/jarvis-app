// src/core/jarvis.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./session-manager.js";
import { consumeStartupPrompt } from "./conversation-store.js";
import type {
  AIRequestMessage,
  AIStreamMessage,
  CapabilityRequestMessage,
  CapabilityResultMessage,
  SystemEventMessage,
  HudUpdateMessage,
} from "./types.js";
import type { AIStreamEvent, CapabilityCall } from "../ai/types.js";
import type { Piece } from "./piece.js";
import { log } from "../logger/index.js";
import { newTraceId, preview } from "../logger/trace.js";
import { config } from "../config/index.js";
import { graphRegistry } from "./graph-registry.js";

function summarizeToolArgs(input: Record<string, unknown>): string {
  const { __sessionId: _, ...args } = input;
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const val = typeof v === "string" ? v
        : typeof v === "number" || typeof v === "boolean" ? String(v)
        : JSON.stringify(v);
      // For single-arg tools, just show the value
      if (entries.length === 1) return val;
      // For multi-arg, show key=value
      return `${k}=${val}`;
    })
    .join(" ");
}

function shortenToolName(name: string): string {
  // mcp__knowledge-semantic__knowledge_search → knowledge_search
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1];
  }
  return name;
}

export class JarvisCore implements Piece {
  readonly id = "jarvis-core";
  readonly name = "Jarvis Core";

  private bus!: EventBus;
  private sessions: SessionManager;
  private totalRequests = 0;
  private lastResponseMs = 0;
  private globalState: "loading" | "online" | "processing" | "waiting_tools" = "loading";
  private sessionStates = new Map<string, "idle" | "processing" | "waiting_tools">();
  private pendingPrompts = new Map<string, AIRequestMessage[]>();
  private pendingReplyTo = new Map<string, string>(); // sessionId → replyTo (caller session)
  /** sessionId → current traceId. Set when a prompt is dispatched, used by
   *  follow-up publishes (ai.stream, capability.request, capability.result
   *  continuation) so the whole turn shares one id in the logs. */
  private currentTrace = new Map<string, string>();

  private getTrace(sessionId: string): string | undefined {
    return this.currentTrace.get(sessionId);
  }
  private jarvisMdPath = join(homedir(), ".jarvis", "jarvis.md");

  /** Session ownership: JarvisCore only processes sessions it owns.
   *  Default: "main" and "grpc-*". Plugins can register additional patterns. */
  private ownedPatterns: Array<string | RegExp> = ["main", /^grpc-/];

  /** Check if a session ID belongs to this core instance */
  private isOwnedSession(sessionId: string): boolean {
    return this.ownedPatterns.some(p =>
      typeof p === "string" ? p === sessionId : p.test(sessionId)
    );
  }

  /**
   * Public matcher for other pieces (notably ChatPiece) to ask whether a
   * sessionId is processed by this core. Used to decide whether to mirror
   * user-typed input as type:"user" SSE immediately, or wait for the
   * core's prompt_dispatched event. Plugin-owned sessions (e.g. actor-*)
   * never get prompt_dispatched, so the asker must mirror locally.
   */
  isSessionOwned(sessionId: string): boolean {
    return this.isOwnedSession(sessionId);
  }

  /** Register an additional session pattern that JarvisCore should manage.
   *  Accepts exact string or RegExp. */
  registerSessionPattern(pattern: string | RegExp): void {
    this.ownedPatterns.push(pattern);
    log.info({ pattern: String(pattern) }, "JarvisCore: registered session pattern");
  }

  systemContext(): string {
    // jarvis.md is now injected as the first message, not system prompt
    return "";
  }

  getJarvisMd(): string {
    if (existsSync(this.jarvisMdPath)) {
      try { return readFileSync(this.jarvisMdPath, "utf-8"); } catch { }
    }
    return "";
  }

  constructor(sessions?: SessionManager) {
    this.sessions = sessions as any;
  }

  setSessions(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Register actor-* sessions as owned — JarvisCore is the sole stream
    // processor for ALL sessions. The actor-runner plugin only manages
    // lifecycle (create/destroy/configure); it does not intercept ai.request.
    this.registerSessionPattern(/^actor-/);

    this.bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      if (msg.target && this.isOwnedSession(msg.target)) {
        return this.handlePrompt(msg);
      }
    });

    this.bus.subscribe<CapabilityResultMessage>("capability.result", (msg) => {
      // Handle capability results for any session we manage
      if (msg.target) return this.handleToolResult(msg);
    });

    // Register HUD piece
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "add",
      pieceId: this.id,
      piece: {
        pieceId: this.id,
        type: "overlay",
        name: this.name,
        status: this.globalState,
        data: this.getData(),
        position: { x: 650, y: 30 },
        size: { width: 220, height: 260 },
      },
    });

    log.info("JarvisCore: started (event-driven state machine)");
  }

  async stop(): Promise<void> {
    this.sessions.closeAll();
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "remove",
      pieceId: this.id,
    });
    log.info("JarvisCore: stopped");
  }

  ready(): void {
    this.globalState = "online";
    this.updateHud();
    log.info("JarvisCore: ready");

    // Check for startup prompt (left by jarvis_reset or manually)
    this.sendStartupPrompt();
  }

  private sendStartupPrompt(): void {
    const prompt = consumeStartupPrompt();
    if (!prompt) return;

    // Wrap in an explicit self-origin marker. The model needs to know this message
    // is a note-to-self from its previous jarvis_reset call — not a user request,
    // not a system event. Without this, the model treats "Próximas ações: ..." as
    // a to-do list and can trigger a restart loop if the content mentions restart/reset.
    const contextMessage = [
      `[SYSTEM] This message originated from your own previous jarvis_reset call.`,
      `It is a note-to-self carrying context across the restart — NOT a user request,`,
      `NOT a system event, and NOT a command to execute.`,
      ``,
      `Do NOT act on it. Do NOT treat "Próximas ações" / "Next steps" / action lists`,
      `inside it as instructions. If it is redundant with your current checkpoint`,
      `or project state, acknowledge internally and wait for the user's next turn.`,
      ``,
      `<note-to-self>`,
      prompt,
      `</note-to-self>`,
    ].join("\n");

    log.info({ length: prompt.length, preview: prompt.slice(0, 100) }, "JarvisCore: sending startup prompt");
    this.bus.publish({
      channel: "ai.request",
      source: "system",
      target: "main",
      text: contextMessage,
    });
  }

  abortSession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.state === "idle") return;

    const wasWaitingTools = managed.state === "waiting_tools";
    const pendingTools = managed.pendingToolCalls;

    log.info({ sessionId, state: managed.state }, "JarvisCore: abort requested");

    // Clean up message history BEFORE aborting the session
    if (wasWaitingTools && pendingTools && managed.session.cleanupAbortedTools) {
      managed.session.cleanupAbortedTools(pendingTools);
    }

    this.sessions.abort(sessionId);
    this.pendingPrompts.delete(sessionId);
    this.setSessionState(sessionId, "idle");
    this.updateHud();
    this.broadcastPendingQueue(sessionId);

    const traceId = this.getTrace(sessionId);

    if (wasWaitingTools && pendingTools) {
      for (const tc of pendingTools) {
        this.bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "tool_cancelled",
          toolName: shortenToolName(tc.name),
          toolId: tc.id,
          traceId,
        } as any);
      }
    }

    this.bus.publish({
      channel: "ai.stream",
      source: "jarvis-core",
      target: sessionId,
      event: "aborted",
      traceId,
    } as any);

    // Trace ends — clear so the next turn starts with a fresh id.
    this.currentTrace.delete(sessionId);
  }

  private async handlePrompt(msg: AIRequestMessage): Promise<void> {
    const sessionId = msg.target!;
    const text = msg.text ?? "";
    const traceId = msg.traceId ?? newTraceId();

    const managed = this.sessions.get(sessionId);

    log.info({
      traceId,
      sessionId,
      source: msg.source,
      managedState: managed.state,
      promptLength: text.length,
      promptPreview: preview(text, 120),
      images: msg.images?.length ?? 0,
      replyTo: msg.replyTo,
    }, "JarvisCore: handlePrompt");

    if (managed.state !== "idle") {
      // Queue the message — it will be drained after the current operation finishes.
      // Never abort a running operation just because a new message arrived.
      // Only explicit user abort (ESC / abort button) should interrupt processing.
      if (!this.pendingPrompts.has(sessionId)) {
        this.pendingPrompts.set(sessionId, []);
      }
      this.pendingPrompts.get(sessionId)!.push(msg);
      log.info({
        traceId,
        sessionId,
        state: managed.state,
        queueSize: this.pendingPrompts.get(sessionId)!.length,
      }, "JarvisCore: queued prompt (session busy)");
      this.broadcastPendingQueue(sessionId);
      return;
    }

    // Track replyTo so we can route the response back to the caller
    if (msg.replyTo) {
      this.pendingReplyTo.set(sessionId, msg.replyTo);
    } else {
      this.pendingReplyTo.delete(sessionId);
    }

    this.currentTrace.set(sessionId, traceId);

    // When a message arrives from another session (not the human chat input)
    // and carries a replyTo, deliver it as TWO separate content blocks:
    //   [0] [SYSTEM] preamble — origin + reply routing instruction
    //   [1] the actual message text
    // This keeps context and content structurally distinct in the message history.
    // Inter-session: message from another session (not user input, not jarvis-core
    // routing its own result back) AND has a replyTo target.
    // Excludes jarvis-core as source to avoid injecting preamble on task dispatches
    // (actor_dispatch flows through JarvisCore with source="jarvis-core", replyTo="main").
    const isInterSession = msg.source !== "chat-input"
      && msg.source !== "jarvis-core"
      && !!msg.replyTo;
    const dispatchText: string | import("../ai/types.js").PromptBlock[] = isInterSession
      ? [
          {
            type: "text" as const,
            text: [
              `[SYSTEM] This message was sent by session "${msg.source}" (not the user).`,
              `It expects your response to be delivered via bus_publish to session "${msg.replyTo}".`,
              `Do NOT address the user directly. Publish your answer using:`,
              `  bus_publish({ channel: "ai.request", target: "${msg.replyTo}", text: "<your answer>" })`,
            ].join("\n"),
          },
          {
            type: "text" as const,
            text: msg.text ?? "",
          },
        ]
      : text;

    // Session is idle — this prompt is about to be sent to the API.
    // Emit prompt_dispatched so the timeline renders it as a user entry
    // NOW (not when the request first arrived). Single message → single event.
    this.broadcastPromptDispatched(sessionId, [{
      text,
      source: msg.source,
      images: msg.images,
    }]);

    await this.dispatchToSession(sessionId, dispatchText, msg.images);
  }

  /**
   * Send a prompt to the AI session and consume its stream. Extracted from
   * handlePrompt so drainQueue can reuse it without re-running the queue
   * branch and without re-emitting prompt_dispatched (drain emits its own,
   * one event per original queued message).
   */
  private async dispatchToSession(
    sessionId: string,
    text: string | import("../ai/types.js").PromptBlock[],
    msgImages?: AIRequestMessage["images"],
  ): Promise<void> {
    const managed = this.sessions.get(sessionId);
    const traceId = this.getTrace(sessionId);
    this.sessions.setState(sessionId, "processing");
    this.setSessionState(sessionId, "processing");
    this.updateHud();
    const t0 = Date.now();
    const textForLog = Array.isArray(text)
      ? text.map(b => b.text).join(" ")
      : text;
    log.info({
      traceId,
      sessionId,
      promptLength: textForLog.length,
      promptPreview: preview(textForLog, 120),
      promptBlocks: Array.isArray(text) ? text.length : 1,
      images: msgImages?.length ?? 0,
      messageCountBefore: (managed.session as any)?.messages?.length,
    }, "JarvisCore: dispatchToSession → calling provider");

    try {
      const images = msgImages?.map(i => ({ label: i.label, base64: i.base64, mediaType: i.mediaType }));
      const stream = managed.session.sendAndStream(text, images);
      await this.consumeStream(sessionId, stream);
    } catch (err: any) {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "error",
        error: String(err),
        traceId,
      } as any);
      log.error({
        traceId,
        sessionId,
        err: err?.message ?? String(err),
        stack: err?.stack,
      }, "JarvisCore: dispatchToSession failed (throw bubbled out of sendAndStream)");
    }

    this.lastResponseMs = Date.now() - t0;
    this.totalRequests++;
    log.info({
      traceId,
      sessionId,
      ms: this.lastResponseMs,
      totalRequests: this.totalRequests,
    }, "JarvisCore: dispatchToSession ← done");
    // Derive correct state from all sessions instead of blindly setting "online"
    this.deriveGlobalState();
    this.updateHud();
  }

  private async handleToolResult(msg: CapabilityResultMessage): Promise<void> {
    const sessionId = msg.target!;
    const results = msg.results;
    const managed = this.sessions.get(sessionId);
    // Trace flows from msg if present; else fall back to the session's
    // current trace (set when handlePrompt dispatched).
    const traceId = msg.traceId ?? this.getTrace(sessionId);

    log.info({
      traceId,
      sessionId,
      sessionState: managed.state,
      resultCount: results?.length ?? 0,
      results: results?.map(r => ({
        id: r.tool_use_id,
        isError: r.is_error,
        contentLen: typeof r.content === "string" ? r.content.length : JSON.stringify(r.content ?? "").length,
      })),
    }, "JarvisCore: handleToolResult (entry)");

    if (managed.state !== "waiting_tools") {
      log.warn({ traceId, sessionId, state: managed.state }, "JarvisCore: tool result but not waiting — discarding");
      return;
    }

    const pendingCalls = managed.pendingToolCalls;
    if (!pendingCalls) {
      log.error({ traceId, sessionId }, "JarvisCore: no pending tool calls — abort");
      return;
    }

    managed.session.addToolResults(pendingCalls, results);

    // Notify chat of tool completion with output preview
    for (const tc of pendingCalls) {
      const result = results.find(r => r.tool_use_id === tc.id);
      const rawOutput = result
        ? typeof result.content === "string" ? result.content : JSON.stringify(result.content)
        : "";
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "tool_done",
        toolName: shortenToolName(tc.name),
        toolId: tc.id,
        toolOutput: rawOutput,
        traceId,
      } as any);
    }

    managed.pendingToolCalls = undefined;
    this.sessions.setState(sessionId, "processing");
    this.setSessionState(sessionId, "processing");
    this.updateHud();

    log.info({
      traceId,
      sessionId,
      pendingCallCount: pendingCalls.length,
      messageCountBefore: (managed.session as any)?.messages?.length,
    }, "JarvisCore: continuing stream after tool results");

    try {
      const stream = managed.session.continueAndStream();
      await this.consumeStream(sessionId, stream);
    } catch (err: any) {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "error",
        error: String(err),
        traceId,
      } as any);
      log.error({
        traceId,
        sessionId,
        err: err?.message ?? String(err),
        stack: err?.stack,
      }, "JarvisCore: tool continuation failed");
    }
  }

  private async consumeStream(
    sessionId: string,
    stream: AsyncGenerator<AIStreamEvent, void>,
  ): Promise<void> {
    let fullText = "";
    const toolCalls: CapabilityCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    const traceId = this.getTrace(sessionId);
    const tStream0 = Date.now();
    let firstDeltaAt: number | undefined;
    let deltaCount = 0;

    log.info({ traceId, sessionId }, "JarvisCore: consumeStream starting");

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            fullText += event.text ?? "";
            deltaCount++;
            if (firstDeltaAt === undefined) {
              firstDeltaAt = Date.now();
              log.info({ traceId, sessionId, ttftMs: firstDeltaAt - tStream0 }, "JarvisCore: first delta received");
            }
            this.bus.publish({
              channel: "ai.stream",
              source: "jarvis-core",
              target: sessionId,
              event: "delta",
              text: event.text ?? "",
              traceId,
            } as any);
            break;
          case "tool_use":
            if (event.toolUse) {
              toolCalls.push(event.toolUse);
              log.info({
                traceId,
                sessionId,
                toolName: event.toolUse.name,
                toolId: event.toolUse.id,
                inputKeys: Object.keys(event.toolUse.input ?? {}),
              }, "JarvisCore: stream produced tool_use");
            }
            break;
          case "message_complete":
            usage = event.usage;
            log.info({
              traceId,
              sessionId,
              stopReason: (event as any).stopReason,
              deltaCount,
              textLength: fullText.length,
              toolCalls: toolCalls.length,
              usage,
            }, "JarvisCore: stream message_complete");
            break;
          case "compaction_start":
            if (event.compactionStart) {
              // Forward to ai.stream so the chat UI can render a "compacting…" banner.
              // Event name `compaction_start` is intentionally NOT in the public
              // AIStreamMessage union (kept stable for plugins) — published via cast.
              this.bus.publish({
                channel: "ai.stream",
                source: "jarvis-core",
                target: sessionId,
                event: "compaction_start",
                compactionStart: event.compactionStart,
                traceId,
              } as any);

              log.info({
                traceId,
                sessionId,
                engine: event.compactionStart.engine,
                tokensBefore: event.compactionStart.tokensBefore,
                reason: event.compactionStart.reason,
              }, "JarvisCore: compaction started");
            }
            break;
          case "compaction":
            if (event.compaction) {
              this.bus.publish({
                channel: "ai.stream",
                source: "jarvis-core",
                target: sessionId,
                event: "compaction",
                compaction: event.compaction,
                traceId,
              } as any);

              this.bus.publish({
                channel: "system.event",
                source: "jarvis-core",
                event: "compaction",
                data: {
                  sessionId,
                  engine: event.compaction.engine,
                  tokensBefore: event.compaction.tokensBefore,
                  tokensAfter: event.compaction.tokensAfter,
                  summaryLength: event.compaction.summary.length,
                },
                traceId,
              } as any);

              log.info({
                traceId,
                sessionId,
                engine: event.compaction.engine,
                tokensBefore: event.compaction.tokensBefore,
                tokensAfter: event.compaction.tokensAfter,
              }, "JarvisCore: context compacted");
            }
            break;
          case "error":
            if (event.error !== "aborted") {
              log.error({ traceId, sessionId, error: event.error }, "JarvisCore: stream error event");
              // Publish to bus so the chat SSE delivers a visible error banner.
              // Previously this was silently dropped — the user saw nothing.
              this.bus.publish({
                channel: "ai.stream",
                source: "jarvis-core",
                target: sessionId,
                event: "error",
                error: event.error,
                traceId,
              } as any);
            } else {
              log.info({ traceId, sessionId }, "JarvisCore: stream aborted (user)");
            }
            break;
        }
      }
    } catch (streamErr: any) {
      // Generator threw outside our switch — make sure it's visible.
      log.error({
        traceId,
        sessionId,
        err: streamErr?.message ?? String(streamErr),
        stack: streamErr?.stack,
      }, "JarvisCore: consumeStream threw while iterating");
      throw streamErr;
    }

    log.info({
      traceId,
      sessionId,
      ms: Date.now() - tStream0,
      deltaCount,
      textLength: fullText.length,
      toolCalls: toolCalls.length,
    }, "JarvisCore: consumeStream finished iterating");

    if (usage) {
      this.bus.publish({
        channel: "system.event",
        source: "jarvis-core",
        event: "api.usage",
        data: {
          sessionId,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_creation_input_tokens: (usage as any).cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: (usage as any).cache_read_input_tokens ?? 0,
          model: config.model,
        },
        traceId,
      } as any);
    }

    if (toolCalls.length > 0) {
      const managed = this.sessions.get(sessionId);
      managed.pendingToolCalls = toolCalls;
      this.sessions.setState(sessionId, "waiting_tools");
      this.setSessionState(sessionId, "waiting_tools");
      this.updateHud();

      log.info({
        traceId,
        sessionId,
        toolCallCount: toolCalls.length,
        toolNames: toolCalls.map(tc => tc.name),
      }, "JarvisCore: dispatching capability.request");

      // Notify chat of tool execution start
      for (const tc of toolCalls) {
        this.bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "tool_start",
          toolName: shortenToolName(tc.name),
          toolId: tc.id,
          toolArgs: summarizeToolArgs(tc.input),
          traceId,
        } as any);
      }

      this.bus.publish({
        channel: "capability.request",
        source: "jarvis-core",
        target: sessionId,
        calls: toolCalls,
        traceId,
      } as any);
    } else {
      this.sessions.setState(sessionId, "idle");
      this.setSessionState(sessionId, "idle");
      this.updateHud();
      log.info({
        traceId,
        sessionId,
        finalTextLength: fullText.length,
        finalTextPreview: preview(fullText, 200),
      }, "JarvisCore: turn complete (no tool calls)");

      this.bus.publish({
        channel: "ai.stream",
        source: "jarvis-core",
        target: sessionId,
        event: "complete",
        text: fullText,
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
        traceId,
      } as any);

      // Trace ends here for this turn — clear so a new turn starts fresh.
      this.currentTrace.delete(sessionId);

      // Route response back to the calling session if replyTo is set
      const replyTo = this.pendingReplyTo.get(sessionId);
      if (replyTo && fullText) {
        this.pendingReplyTo.delete(sessionId);
        log.info({ traceId, sessionId, replyTo, textLength: fullText.length }, "JarvisCore: routing response to replyTo");
        this.bus.publish({
          channel: "ai.request",
          source: "jarvis-core",
          target: replyTo,
          text: `[${sessionId}] ${fullText}`,
          traceId,
        } as Parameters<EventBus["publish"]>[0]);
      }

      // Drain queued prompts for this session
      this.drainQueue(sessionId);
    }
  }

  private drainQueue(sessionId: string): void {
    const queue = this.pendingPrompts.get(sessionId);
    if (!queue || queue.length === 0) return;

    // Snapshot the original queued messages BEFORE combining, so the
    // timeline can render one user entry per original message (preserving
    // each message's source/label). The backend still combines them into
    // a single API call to save tokens.
    const items = queue.map(m => ({
      text: m.text ?? "",
      source: m.source,
      images: (m as any).images,
    }));
    const combined = items.map(i => i.text).join("\n\n");
    const allImages = items.flatMap(i => i.images ?? []);
    queue.length = 0;
    this.broadcastPendingQueue(sessionId);

    // Drain starts a fresh turn — generate a new traceId so logs separate
    // the previous turn's tail from this combined dispatch.
    const traceId = newTraceId();
    this.currentTrace.set(sessionId, traceId);

    log.info({
      traceId,
      sessionId,
      items: items.length,
      combinedLength: combined.length,
      images: allImages.length,
    }, "JarvisCore: draining queued prompts");

    // Emit one prompt_dispatched per original queued message — the timeline
    // renders each as its own user entry with its own source label.
    this.broadcastPromptDispatched(sessionId, items);

    // Send the combined prompt to the AI. We bypass handlePrompt because
    // (a) the queue branch would re-queue (session is still flipping out
    // of processing), and (b) prompt_dispatched was already emitted above
    // for the original items.
    void this.dispatchToSession(sessionId, combined, allImages.length > 0 ? allImages : undefined);
  }

  /**
   * Announce that one or more prompts are about to be sent to the AI for
   * this session. Frontend renders one user entry per item, using each
   * preserved source so labels (chat, actor-*, grpc, etc.) stay accurate.
   *
   * Emitted from two places:
   *  - handlePrompt() when the session was idle: a single item.
   *  - drainQueue() when previously-queued messages are about to ship: one
   *    item per originally-queued message (NOT one item for the combined
   *    text — preserving source-per-message is the whole point).
   *
   * The event name `prompt_dispatched` is intentionally NOT in the public
   * AIStreamMessage event union; we publish via cast and ChatPiece reads
   * via cast, keeping the public type surface stable for plugins.
   */
  private broadcastPromptDispatched(
    sessionId: string,
    items: Array<{ text: string; source?: string; images?: AIRequestMessage["images"] }>,
  ): void {
    if (items.length === 0) return;
    this.bus.publish({
      channel: "ai.stream",
      source: "jarvis-core",
      target: sessionId,
      event: "prompt_dispatched",
      items: items.map(i => ({
        text: i.text,
        source: i.source,
        images: i.images,
      })),
    } as any);
  }

  /**
   * Broadcast the current pending queue snapshot for a session over the SSE
   * channel. Frontend uses this to render the "queued messages" list under
   * the JARVIS thinking indicator.
   */
  private broadcastPendingQueue(sessionId: string): void {
    const queue = this.pendingPrompts.get(sessionId) ?? [];
    const items = queue.map(msg => ({
      text: (msg.text ?? "").slice(0, 280),
      source: msg.source,
      hasImages: Array.isArray((msg as any).images) && (msg as any).images.length > 0,
    }));
    this.bus.publish({
      channel: "ai.stream",
      source: "jarvis-core",
      target: sessionId,
      event: "pending_queue",
      items,
    } as any);
  }

  /** Derive global state from all tracked per-session states */
  private deriveGlobalState(): void {
    const prev = this.globalState;
    if (this.sessionStates.size === 0) {
      this.globalState = "online";
    } else {
      const states = [...this.sessionStates.values()];
      if (states.includes("waiting_tools")) {
        this.globalState = "waiting_tools";
      } else if (states.includes("processing")) {
        this.globalState = "processing";
      } else {
        this.globalState = "online";
      }
    }
    // Keep graphRegistry in sync so the core-node tree reflects live state
    if (this.globalState !== prev) {
      graphRegistry.update("jarvis-core", { status: this.globalState });
    }
  }

  private setSessionState(sessionId: string, state: "idle" | "processing" | "waiting_tools"): void {
    if (state === "idle") {
      this.sessionStates.delete(sessionId);
    } else {
      this.sessionStates.set(sessionId, state);
    }
    this.deriveGlobalState();
  }

  getData(): Record<string, unknown> {
    return {
      status: this.globalState,
      coreLabel: this.globalState.toUpperCase().replace("_", " "),
      totalRequests: this.totalRequests,
      lastResponseMs: this.lastResponseMs,
      activeSessions: this.sessions.size,
    };
  }

  private updateHud(): void {
    if (!this.bus) return;
    this.bus.publish({
      channel: "hud.update",
      source: this.id,
      action: "update",
      pieceId: this.id,
      data: this.getData(),
      status: this.globalState,
    });
  }
}
