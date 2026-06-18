// app/src/core/session-dispatcher.ts
//
// WHY: JarvisCore and actor-runner both subscribe to ai.request and call
// sendAndStream independently — causing duplicate API calls on the same
// session. SessionDispatcher is the SINGLE ai.request consumer for ALL
// sessions (main, actor-*, grpc-*, etc.). JarvisCore and actor-runner become
// lifecycle orchestrators only (session creation, HUD, abort).
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./session-manager.js";
import type { AIRequestMessage, CapabilityResultMessage } from "./types.js";
import type { AIStreamEvent, CapabilityCall } from "../ai/types.js";
import { log } from "../logger/index.js";
import { newTraceId, preview } from "../logger/trace.js";
import { config } from "../config/index.js";
import { buildDispatchText } from "./jarvis.js";

/** Per-session queue entry */
interface QueuedMessage {
  text: string;
  source: string;
  replyTo?: string;
  images?: AIRequestMessage["images"];
  traceId: string;
  systems?: string[];
}

/** Per-session dispatcher runtime state */
interface SessionDispatch {
  queue: QueuedMessage[];
  running: boolean;
  currentTraceId?: string;
  pendingToolCalls?: CapabilityCall[];
}

/** Shorten tool name for display (strips bash→bash, edit_file→edit_file, etc.) */
function shortenToolName(name: string): string {
  return name.replace(/^jarvis_/, "").replace(/_/g, " ");
}

export class SessionDispatcher {
  private state = new Map<string, SessionDispatch>();
  private bus!: EventBus;
  readonly sessions: SessionManager;
  /** Sessions that have been dispatched at least once this process lifetime */
  private dispatchedSessions = new Set<string>();

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  start(bus: EventBus): void {
    this.bus = bus;

    // Single subscriber for ALL ai.request messages
    bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      // Internal pre-fetch signal — must never be routed to the LLM
      if ((msg as any).data?._preFetch) return;
      if (!msg.target) return; // targetless — JarvisCore already logs a warning for these
      // Actor dispatch messages carry data.role — they are lifecycle signals
      // handled by actor-runner (which creates the session and re-publishes
      // without data.role). We must not process the original here or the
      // SessionDispatcher would run sendAndStream twice per dispatch.
      if ((msg as any).data?.role) return;
      this.handleRequest(msg);
    });

    // Single subscriber for ALL capability.result messages
    bus.subscribe<CapabilityResultMessage>("capability.result", (msg) => {
      if (msg.target) this.handleToolResult(msg);
    });

    // Evict state when session closes
    bus.subscribe<any>("system.event", (msg) => {
      if (msg.event === "session.closed" && msg.data?.sessionId) {
        this.evict(msg.data.sessionId as string);
      }
    });

    log.info("SessionDispatcher: started");
  }

  /** Get or create per-session dispatch state */
  getDispatch(sessionId: string): SessionDispatch {
    let d = this.state.get(sessionId);
    if (!d) {
      d = { queue: [], running: false };
      this.state.set(sessionId, d);
    }
    return d;
  }

  /** Called when a session is closed — evict dispatch state to avoid leaks */
  evict(sessionId: string): void {
    this.state.delete(sessionId);
    log.debug({ sessionId }, "SessionDispatcher: evicted");
  }

  /** Abort current operation for a session */
  abort(sessionId: string): void {
    const d = this.state.get(sessionId);
    if (!d) return;
    this.sessions.abort(sessionId);
    d.running = false;
    d.currentTraceId = undefined;
    d.pendingToolCalls = undefined;
    // Preserve queue — user aborted THIS turn, not future queued ones
    this.broadcastPendingQueue(sessionId);
    log.info({ sessionId }, "SessionDispatcher: aborted");
  }

  get size(): number {
    return this.state.size;
  }

  // ─── Private: request routing ─────────────────────────────────────────

  private handleRequest(msg: AIRequestMessage): void {
    const sessionId = msg.target!;
    const text = msg.text ?? "";
    const traceId = msg.traceId ?? newTraceId();

    const d = this.getDispatch(sessionId);

    log.info({
      traceId,
      sessionId,
      source: msg.source,
      running: d.running,
      promptLength: text.length,
      promptPreview: preview(text, 120),
      images: msg.images?.length ?? 0,
      replyTo: msg.replyTo,
    }, "SessionDispatcher: handleRequest");

    if (d.running) {
      d.queue.push({
        text,
        source: msg.source ?? "unknown",
        replyTo: msg.replyTo,
        images: msg.images,
        traceId,
        systems: (msg as any).systems,
      });
      log.info({
        traceId,
        sessionId,
        queueSize: d.queue.length,
      }, "SessionDispatcher: queued prompt (session busy)");
      this.broadcastPendingQueue(sessionId);
      return;
    }

    d.running = true;
    d.currentTraceId = traceId;

    const item: QueuedMessage = {
      text,
      source: msg.source ?? "unknown",
      replyTo: msg.replyTo,
      images: msg.images,
      traceId,
      systems: (msg as any).systems,
    };

    this.broadcastPromptDispatched(sessionId, item);
    this.dispatchToSession(sessionId, item)
      .finally(() => this.drainQueue(sessionId));
  }

  private async dispatchToSession(sessionId: string, item: QueuedMessage): Promise<void> {
    const traceId = item.traceId;

    this.sessions.pushState(sessionId, "processing");
    this.broadcastSessionState(sessionId, "processing");

    try {
      const managed = this.sessions.get(sessionId);
      if (!managed?.session) {
        throw new Error(`SessionDispatcher: no managed session for '${sessionId}'`);
      }

      const systems = Array.isArray(item.systems) ? item.systems : [];
      const reminderBlock = systems.length > 0
        ? systems.map(s => `<system-reminder>\n${s}\n</system-reminder>`).join("\n\n") + "\n\n"
        : "";

      const dispatchText = buildDispatchText({
        text: item.text,
        source: item.source,
        replyTo: item.replyTo,
        reminderBlock,
        sourceIsLiveSession: this.sessions.has(item.source),
      });

      // Timestamp + restart sentinel injections
      const now = new Date();
      const ts = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const timestampBlock = `[now: ${ts}]`;
      const isFirstDispatch = !this.dispatchedSessions.has(sessionId);
      this.dispatchedSessions.add(sessionId);
      const restartBlock = isFirstDispatch
        ? "[SYSTEM: JARVIS started or restarted — this is the first message of this session]"
        : null;

      const userBlocks: import("../ai/types.js").PromptBlock[] = Array.isArray(dispatchText)
        ? dispatchText
        : [{ type: "text" as const, text: dispatchText }];
      const injections: import("../ai/types.js").PromptBlock[] = [
        { type: "text" as const, text: timestampBlock },
        ...(restartBlock ? [{ type: "text" as const, text: restartBlock }] : []),
      ];
      const enrichedText = [...injections, ...userBlocks];

      const images = item.images?.map(i => ({ label: i.label, base64: i.base64, mediaType: i.mediaType }));

      log.info({
        traceId,
        sessionId,
        promptLength: item.text.length,
        promptPreview: preview(item.text, 120),
        promptBlocks: enrichedText.length,
        images: images?.length ?? 0,
        messageCountBefore: (managed.session as any)?.messages?.length,
      }, "SessionDispatcher: *** API CALL START ***");

      (managed.session as { setTurnTraceId?: (id?: string) => void }).setTurnTraceId?.(traceId);
      const stream = managed.session.sendAndStream(enrichedText, images);
      await this.consumeStream(sessionId, stream);
    } catch (err: any) {
      this.sessions.popState(sessionId);
      this.broadcastSessionState(sessionId, "idle");
      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
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
      }, "SessionDispatcher: dispatchToSession failed");
      // Reset running on error so the queue can drain on next turn
      const dErr = this.getDispatch(sessionId);
      dErr.running = false;
      dErr.currentTraceId = undefined;
      void this.drainQueue(sessionId);
      return;
    }

    const d = this.getDispatch(sessionId);
    d.currentTraceId = undefined;
    log.info({ traceId, sessionId }, "SessionDispatcher: dispatchToSession ← done");
  }

  private async handleToolResult(msg: CapabilityResultMessage): Promise<void> {
    const sessionId = msg.target!;
    const results = msg.results;
    const d = this.getDispatch(sessionId);
    const traceId = msg.traceId ?? d.currentTraceId;
    const sessionState = this.sessions.getState(sessionId);

    log.info({
      traceId,
      sessionId,
      sessionState,
      resultCount: results?.length ?? 0,
    }, "SessionDispatcher: handleToolResult (entry)");

    if (sessionState !== "waiting_tools") {
      log.warn({ traceId, sessionId, state: sessionState }, "SessionDispatcher: tool result but not waiting — discarding");
      return;
    }

    const pendingCalls = d.pendingToolCalls;
    if (!pendingCalls) {
      log.error({ traceId, sessionId }, "SessionDispatcher: no pending tool calls — abort");
      return;
    }

    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    managed.session.addToolResults(pendingCalls, results);
    d.pendingToolCalls = undefined;

    for (const tc of pendingCalls) {
      const result = results.find(r => r.tool_use_id === tc.id);
      const rawOutput = result
        ? typeof result.content === "string" ? result.content : JSON.stringify(result.content)
        : "";
      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
        target: sessionId,
        event: "tool_done",
        toolName: shortenToolName(tc.name),
        toolId: tc.id,
        toolOutput: rawOutput,
        traceId,
      } as any);
    }

    log.info({
      traceId,
      sessionId,
      tools: pendingCalls.map(tc => tc.name),
    }, "SessionDispatcher: *** TOOL RESULTS RECEIVED ***");

    this.sessions.popState(sessionId);
    this.sessions.pushState(sessionId, "processing");
    this.broadcastSessionState(sessionId, "processing");

    try {
      (managed.session as { setTurnTraceId?: (id?: string) => void }).setTurnTraceId?.(traceId);
      const stream = managed.session.continueAndStream();
      await this.consumeStream(sessionId, stream);
    } catch (err: any) {
      this.sessions.popState(sessionId);
      this.broadcastSessionState(sessionId, "idle");
      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
        target: sessionId,
        event: "error",
        error: String(err),
        traceId,
      } as any);
      log.error({
        traceId,
        sessionId,
        err: err?.message ?? String(err),
      }, "SessionDispatcher: tool continuation failed");
    }
  }

  private async consumeStream(
    sessionId: string,
    stream: AsyncGenerator<AIStreamEvent, void>,
  ): Promise<void> {
    let fullText = "";
    const toolCalls: CapabilityCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    const d = this.getDispatch(sessionId);
    const traceId = d.currentTraceId;
    const tStream0 = Date.now();
    let firstDeltaAt: number | undefined;
    let deltaCount = 0;

    log.info({ traceId, sessionId }, "SessionDispatcher: consumeStream starting");

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            fullText += event.text ?? "";
            deltaCount++;
            if (firstDeltaAt === undefined) {
              firstDeltaAt = Date.now();
              log.info({ traceId, sessionId, ttftMs: firstDeltaAt - tStream0 }, "SessionDispatcher: first delta received");
            }
            this.bus.publish({
              channel: "ai.stream",
              source: "session-dispatcher",
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
              }, "SessionDispatcher: stream produced tool_use");
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
            }, "SessionDispatcher: stream message_complete");
            break;
          case "compaction_start":
            if (event.compactionStart) {
              this.bus.publish({
                channel: "ai.stream",
                source: "session-dispatcher",
                target: sessionId,
                event: "compaction_start",
                compactionStart: event.compactionStart,
                traceId,
              } as any);
            }
            break;
          case "compaction_failed":
            if (event.compactionFailed) {
              this.bus.publish({
                channel: "ai.stream",
                source: "session-dispatcher",
                target: sessionId,
                event: "compaction_failed",
                compactionFailed: event.compactionFailed,
                traceId,
              } as any);
            }
            break;
          case "compaction":
            if (event.compaction) {
              this.bus.publish({
                channel: "ai.stream",
                source: "session-dispatcher",
                target: sessionId,
                event: "compaction",
                compaction: event.compaction,
                traceId,
              } as any);
              this.bus.publish({
                channel: "system.event",
                source: "session-dispatcher",
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
            }
            break;
          case "error":
            if (event.error !== "aborted") {
              log.error({ traceId, sessionId, error: event.error }, "SessionDispatcher: stream error event");
              this.bus.publish({
                channel: "ai.stream",
                source: "session-dispatcher",
                target: sessionId,
                event: "error",
                error: event.error,
                traceId,
              } as any);
            } else {
              log.info({ traceId, sessionId }, "SessionDispatcher: stream aborted (user)");
            }
            break;
        }
      }
    } catch (streamErr: any) {
      log.error({
        traceId,
        sessionId,
        err: streamErr?.message ?? String(streamErr),
        stack: streamErr?.stack,
      }, "SessionDispatcher: consumeStream threw while iterating");
      throw streamErr;
    }

    log.info({
      traceId,
      sessionId,
      ms: Date.now() - tStream0,
      deltaCount,
      textLength: fullText.length,
      toolCalls: toolCalls.length,
    }, "SessionDispatcher: consumeStream finished iterating");

    if (usage) {
      this.bus.publish({
        channel: "system.event",
        source: "session-dispatcher",
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
      d.pendingToolCalls = toolCalls;

      this.sessions.popState(sessionId);
      this.sessions.pushState(sessionId, "waiting_tools");
      this.broadcastSessionState(sessionId, "waiting_tools");

      log.info({
        traceId,
        sessionId,
        toolCount: toolCalls.length,
        toolNames: toolCalls.map(tc => tc.name),
        ms: Date.now() - tStream0,
      }, "SessionDispatcher: *** API RESPONSE — TOOL USE ***");

      for (const tc of toolCalls) {
        this.bus.publish({
          channel: "ai.stream",
          source: "session-dispatcher",
          target: sessionId,
          event: "tool_start",
          toolName: shortenToolName(tc.name),
          toolId: tc.id,
          toolArgs: JSON.stringify(tc.input ?? {}),
          traceId,
        } as any);
      }

      this.bus.publish({
        channel: "capability.request",
        source: "session-dispatcher",
        target: sessionId,
        calls: toolCalls,
        traceId,
      } as any);
    } else {
      log.info({
        traceId,
        sessionId,
        finalTextLength: fullText.length,
        finalTextPreview: preview(fullText, 120),
        deltaCount,
        ms: Date.now() - tStream0,
      }, "SessionDispatcher: *** API RESPONSE COMPLETE ***");

      this.sessions.popState(sessionId);
      this.broadcastSessionState(sessionId, "idle");

      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
        target: sessionId,
        event: "complete",
        text: fullText,
        usage: usage ?? { input_tokens: 0, output_tokens: 0 },
        traceId,
      } as any);

      // Route response back to calling session if replyTo set
      const replyTo = d.queue.length === 0 ? undefined : undefined; // replyTo tracked in QueuedMessage
      // Actually: replyTo is stored on the item that was dispatched. We need to track it.
      // For now it's on currentItem — we store it on d temporarily via a dedicated field.
      const pendingReplyTo = (d as any).pendingReplyTo as string | undefined;
      if (pendingReplyTo && fullText) {
        (d as any).pendingReplyTo = undefined;
        log.info({ traceId, sessionId, replyTo: pendingReplyTo }, "SessionDispatcher: routing response to replyTo");
        this.bus.publish({
          channel: "ai.request",
          source: "session-dispatcher",
          target: pendingReplyTo,
          text: `[${sessionId}] ${fullText}`,
          traceId,
        } as any);
      }

      d.running = false;
      // Drain any queued messages now that the turn is complete.
      // Must be called here (not only in handleRequest's .finally) because
      // tool-loop continuations go through handleToolResult → consumeStream
      // directly, bypassing the .finally chain in handleRequest.
      void this.drainQueue(sessionId);
    }
  }

  private async drainQueue(sessionId: string): Promise<void> {
    const d = this.getDispatch(sessionId);
    if (d.queue.length === 0) {
      d.running = false;
      this.broadcastPendingQueue(sessionId); // empty array → clears UI
      return;
    }

    const next = d.queue.shift()!;
    d.running = true;
    d.currentTraceId = next.traceId;
    (d as any).pendingReplyTo = next.replyTo;

    this.broadcastPromptDispatched(sessionId, next);
    this.broadcastPendingQueue(sessionId);
    await this.dispatchToSession(sessionId, next)
      .finally(() => this.drainQueue(sessionId));
  }

  // ─── Private: broadcasts ──────────────────────────────────────────────

  private broadcastPromptDispatched(sessionId: string, item: QueuedMessage): void {
    this.bus.publish({
      channel: "ai.stream",
      source: "session-dispatcher",
      target: sessionId,
      event: "prompt_dispatched",
      traceId: item.traceId,
      items: [{ text: item.text, source: item.source, images: item.images }],
    } as any);
  }

  private broadcastPendingQueue(sessionId: string): void {
    const d = this.getDispatch(sessionId);
    this.bus.publish({
      channel: "ai.stream",
      source: "session-dispatcher",
      target: sessionId,
      event: "pending_queue",
      items: d.queue.map(q => ({
        text: (q.text ?? "").slice(0, 280),
        source: q.source,
        hasImages: !!q.images?.length,
      })),
    } as any);
  }

  private broadcastSessionState(sessionId: string, state: string): void {
    this.bus.publish({
      channel: "ai.stream",
      source: "session-dispatcher",
      target: sessionId,
      event: "session_state",
      state,
    } as any);
  }
}
