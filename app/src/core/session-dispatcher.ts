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
import { abortRegistry } from "../capabilities/abort-registry.js";

/** Per-session queue entry */
interface QueuedMessage {
  text: string;
  /** Optional pre-built PromptBlocks — when set, used instead of text in dispatchToSession */
  blocks?: import("../ai/types.js").PromptBlock[];
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
  /** Mid-turn human injection — text appended to the next tool_result user
   * message before the AI continues. Set when the user sends a message while
   * the session is in waiting_tools (between tool rounds). */
  pendingMidTurnInjection?: string;
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

    // IMPORTANT: read state BEFORE sessions.abort() — that call does an
    // internal popState which would change the state we're branching on.
    // If we read after, "waiting_tools" becomes "processing" and Case A
    // never fires, leaving d.running=true and the session as a zombie.
    const sessionState = this.sessions.getState(sessionId);

    this.sessions.abort(sessionId);

    // Two cases:
    //
    // A) State is "waiting_tools" — stream already finished; we're only waiting
    //    for tool results that will never come (abort cancels them). It is safe
    //    to reset running immediately and drain the queue.
    //
    // B) State is "processing" — stream is still iterating inside consumeStream.
    //    Do NOT reset running here; consumeStream will do it once the stream
    //    terminates (the abort signal causes it to receive an "aborted" event or
    //    throw, then fall through to the drain path).
    if (sessionState === "waiting_tools") {
      // Kill any in-flight tool processes (e.g. bash sleep) so the child
      // process doesn't keep running after the user aborts.
      abortRegistry.abortSession(sessionId);
      // sessions.abort() already popped once (waiting_tools → processing).
      // Pop again to return to idle.
      this.sessions.popState(sessionId);
      this.broadcastSessionState(sessionId, "idle");
      d.running = false;
      d.currentTraceId = undefined;
      d.pendingToolCalls = undefined;
      this.broadcastPendingQueue(sessionId);
      void this.drainQueue(sessionId);
    } else {
      // processing — let consumeStream own the drain
      d.currentTraceId = undefined;
      d.pendingToolCalls = undefined;
      this.broadcastPendingQueue(sessionId);
    }

    log.info({ sessionId, sessionState }, "SessionDispatcher: aborted");
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
      // Session is busy — queue the message. It will be drained into the next
      // tool_result user message before continueAndStream (see handleToolResult),
      // so the AI sees it at the earliest possible point without breaking the
      // tool_use/tool_result chain. Messages with replyTo are still routed
      // correctly because the drain loop broadcasts prompt_dispatched per item.
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
        sessionState: this.sessions.getState(sessionId),
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
      .finally(() => {
        // Only drain if the turn fully completed (not waiting for tool results).
        // When stop_reason=tool_use, consumeStream returns early and the session
        // state is "waiting_tools" — draining here would start a new turn before
        // the capability executor finishes. The drain in consumeStream's else-branch
        // (and in handleToolResult's final consumeStream) handles the post-tool drain.
        const state = this.sessions.getState(sessionId);
        if (state !== "waiting_tools") {
          void this.drainQueue(sessionId);
        }
      });
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

      // If item.blocks is set (combined drain), use them directly as separate
      // PromptBlocks. Otherwise fall through buildDispatchText for attribution.
      const rawUserBlocks: import("../ai/types.js").PromptBlock[] = item.blocks
        ? item.blocks
        : (() => {
            const dispatchText = buildDispatchText({
              text: item.text,
              source: item.source,
              replyTo: item.replyTo,
              reminderBlock,
              sourceIsLiveSession: this.sessions.has(item.source),
            });
            return Array.isArray(dispatchText)
              ? dispatchText
              : [{ type: "text" as const, text: dispatchText }];
          })();

      // Timestamp + restart sentinel injections
      const now = new Date();
      const ts = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const timestampBlock = `[now: ${ts}]`;
      const isFirstDispatch = !this.dispatchedSessions.has(sessionId);
      this.dispatchedSessions.add(sessionId);
      const restartBlock = isFirstDispatch
        ? "[SYSTEM: JARVIS started or restarted — this is the first message of this session]"
        : null;

      const userBlocks = rawUserBlocks;
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

    // Mid-turn injection — drain ALL queued messages into the tool_result user
    // message before continueAndStream. This means every message that arrived
    // while the session was executing tools is appended as a text block to the
    // next user message (which already contains tool_result blocks). The
    // Anthropic API accepts mixed content in a user message, so the AI sees
    // the human's queued context in the same turn before its next response.
    //
    // WHY drain the queue here instead of waiting for the turn to complete:
    // the user wants "append queued messages before each new request" — this is
    // exactly the right place: after tool_results are committed, before the AI
    // streams again. The tool_use/tool_result chain is already closed and clean.
    //
    // pendingMidTurnInjection (single string, set when waiting_tools) is merged
    // in first, then the queue is drained in FIFO order.
    const injections: string[] = [];
    if (d.pendingMidTurnInjection) {
      injections.push(d.pendingMidTurnInjection);
      d.pendingMidTurnInjection = undefined;
    }
    while (d.queue.length > 0) {
      const queued = d.queue.shift()!;
      injections.push(queued.text);
      // Acknowledge each dequeued message to the HUD
      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
        target: sessionId,
        event: "prompt_dispatched",
        traceId: queued.traceId,
        items: [{ text: queued.text, source: queued.source }],
      } as any);
    }
    if (injections.length > 0) {
      const combined = injections.join("\n\n");
      (managed.session as any).injectMidTurnContext?.(combined);
      log.info({ traceId, sessionId, count: injections.length, textPreview: preview(combined, 80) },
        "SessionDispatcher: mid-turn queue drain — injected into tool_result message");
      this.broadcastPendingQueue(sessionId);
    }

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
    } finally {
      // Drain the queue whenever this tool-continuation path exits — whether
      // normally (consumeStream completed without tools → else-branch already
      // called drainQueue, so this is a no-op because d.running is false) or
      // via catch (state reset to idle above but d.running was never cleared).
      // The state guard prevents draining while a new tool round is in flight.
      const stateAfter = this.sessions.getState(sessionId);
      if (stateAfter !== "waiting_tools" && stateAfter !== "processing") {
        d.running = false;
        void this.drainQueue(sessionId);
      }
    }
  }

  private async consumeStream(
    sessionId: string,
    stream: AsyncGenerator<AIStreamEvent, void>,
  ): Promise<void> {
    let fullText = "";
    const toolCalls: CapabilityCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    let streamWasAborted = false;
    const d = this.getDispatch(sessionId);
    const traceId = d.currentTraceId;
    const tStream0 = Date.now();
    let firstDeltaAt: number | undefined;
    let deltaCount = 0;

    log.info({ traceId, sessionId }, "SessionDispatcher: consumeStream starting");

    // Inactivity watchdog — if the stream emits no events for WATCHDOG_MS,
    // abort the session to prevent zombie sessions caused by hung API streams.
    // The Anthropic stream may silently stall (no error, no close) if the
    // connection drops after the HTTP response headers are received.
    const WATCHDOG_MS = 30_000; // 30 s — aggressive recovery for hung API streams
    let lastEventAt = Date.now();
    const watchdog = setInterval(() => {
      const idle = Date.now() - lastEventAt;
      if (idle > WATCHDOG_MS) {
        log.warn({ traceId, sessionId, idleMs: idle },
          "SessionDispatcher: stream inactivity watchdog fired — aborting hung stream");
        clearInterval(watchdog);
        this.sessions.abort(sessionId);
      }
    }, 10_000);

    try {
      for await (const event of stream) {
        lastEventAt = Date.now();
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
              streamWasAborted = true;
            }
            break;
        }
      }
    } catch (streamErr: any) {
      clearInterval(watchdog);
      log.error({
        traceId,
        sessionId,
        err: streamErr?.message ?? String(streamErr),
        stack: streamErr?.stack,
      }, "SessionDispatcher: consumeStream threw while iterating");
      throw streamErr;
    }

    clearInterval(watchdog);
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

    // If the stream was aborted, do not enter waiting_tools — any tool_use
    // calls that arrived before the abort signal are stale and will never
    // receive results. Reset to idle immediately to prevent zombie sessions.
    if (streamWasAborted) {
      log.info({ traceId, sessionId, staleToolCalls: toolCalls.length }, "SessionDispatcher: aborted stream — skipping tool dispatch, resetting to idle");
      this.sessions.popState(sessionId);
      this.broadcastSessionState(sessionId, "idle");
      d.running = false;
      d.currentTraceId = undefined;
      d.pendingToolCalls = undefined;
      this.bus.publish({
        channel: "ai.stream",
        source: "session-dispatcher",
        target: sessionId,
        event: "aborted",
        traceId,
      } as any);
      void this.drainQueue(sessionId);
      return;
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

      // Publish turn.summary on system.event so BackgroundReviewPiece
      // (and any other subscriber) can track completed turns per session.
      // Mirrors what TurnTracker did in jarvis.ts before SessionDispatcher
      // became the single ai.request consumer.
      this.bus.publish({
        channel: "system.event",
        source: "session-dispatcher",
        event: "turn.summary",
        data: {
          sessionId,
          traceId,
          outcome: "completed",
          source: "session-dispatcher",
          usage: usage ?? { input_tokens: 0, output_tokens: 0 },
          tools: toolCalls,
          ms: Date.now() - tStream0,
        },
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
      this.broadcastPendingQueue(sessionId);
      return;
    }

    // Segment: a message needs solo dispatch if it has replyTo or comes from
    // a live session (inter-session attribution). Otherwise combine into one call.
    const needsSolo = (m: QueuedMessage): boolean => {
      const internal = m.source === "chat-input" || m.source === "session-dispatcher" || m.source === "cron";
      return !!m.replyTo || (!internal && this.sessions.has(m.source));
    };

    let items: QueuedMessage[];
    let combinedText: string;
    let replyTo: string | undefined;

    if (needsSolo(d.queue[0])) {
      // Solo: dispatch exactly one message, leave the rest for next drain
      const solo = d.queue.shift()!;
      items = [solo];
      combinedText = solo.text;
      replyTo = solo.replyTo;
    } else {
      // Combine: take all leading "plain" messages into one API call
      items = [];
      while (d.queue.length > 0 && !needsSolo(d.queue[0])) {
        items.push(d.queue.shift()!);
      }
      combinedText = items.map(i => i.text).join("\n\n");
      replyTo = undefined;
    }

    d.running = true;
    d.currentTraceId = items[0].traceId;
    (d as any).pendingReplyTo = replyTo;

    // Emit one prompt_dispatched per original message (timeline shows each)
    for (const item of items) {
      this.broadcastPromptDispatched(sessionId, item);
    }
    this.broadcastPendingQueue(sessionId);

    // Build combined item. Multiple queued messages each become a separate
    // PromptBlock — the LLM sees them as distinct inputs in one API call.
    const combinedImages = items.flatMap(i => i.images ?? []);
    const combined: QueuedMessage = {
      text: items[0].text,
      blocks: items.length === 1
        ? undefined
        : items.map(item => ({ type: "text" as const, text: item.text })),
      source: items[0].source,
      replyTo,
      images: combinedImages.length > 0 ? combinedImages : undefined,
      traceId: items[0].traceId,
      systems: items.flatMap(i => i.systems ?? []),
    };

    await this.dispatchToSession(sessionId, combined)
      .finally(() => {
        const state = this.sessions.getState(sessionId);
        if (state !== "waiting_tools") {
          void this.drainQueue(sessionId);
        }
      });
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
