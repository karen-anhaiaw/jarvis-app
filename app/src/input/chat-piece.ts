// src/input/chat-piece.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventBus } from "../core/bus.js";
import type { Piece } from "../core/piece.js";
import type { AIRequestMessage, AIStreamMessage, HudUpdateMessage, ChatAnchorMessage, ChatTimelineMessage } from "../core/types.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { SessionManager } from "../core/session-manager.js";
import { log } from "../logger/index.js";
import { DEFAULT_SESSION } from "../core/constants.js";
import { newTraceId, preview } from "../logger/trace.js";
import { consumePendingGreeting, loadConversation } from "../core/conversation-store.js";
import { config, getProviderForModel } from "../config/index.js";

/**
 * ChatPiece — session-agnostic chat bridge.
 *
 * The core chat piece does NOT know about "main" or any plugin-owned session
 * id pattern. It receives a sessionId as an opaque string on every request and
 * routes SSE clients, history lookups and ai.request publishes to/for that
 * exact session id.
 *
 * SSE multiplexing: one pool of clients per sessionId. An ai.stream event only
 * reaches the pool whose sessionId matches msg.target.
 *
 * Required payload on every HTTP endpoint:
 *  - POST /chat/send         → body { sessionId, prompt, images? }
 *  - GET  /chat-stream       → query ?sessionId=X
 *  - GET  /chat/history      → query ?sessionId=X
 *  - POST /chat/abort        → body { sessionId }
 *  - POST /chat/clear-session→ body { sessionId }
 *  - POST /chat/compact      → body { sessionId }
 *
 * Missing or empty sessionId → HTTP 400.
 */
export class ChatPiece implements Piece {
  readonly id = "chat";
  readonly name = "Chat";

  private bus!: EventBus;
  private registry?: CapabilityRegistry;
  private sessions?: SessionManager;

  /** SSE clients keyed by sessionId. Events only reach matching pools. */
  private streamClients = new Map<string, Set<ServerResponse>>();

  setRegistry(registry: CapabilityRegistry): void {
    this.registry = registry;
  }

  setSessions(sessions: SessionManager): void {
    this.sessions = sessions;
  }

  /**
   * @deprecated No-op since the session-agnostic refactor.
   * ChatPiece is now plugin-agnostic and does NOT mirror type:"user" —
   * the session owner emits `prompt_dispatched`. Kept for backward
   * compatibility with main.ts wiring; can be removed in a major bump.
   */
  setOwnedSessionMatcher(_matcher: (sid: string) => boolean): void {
    // intentionally empty
  }

  systemContext(): string {
    return `## Chat Piece
The user interacts via a chat panel in the HUD (Electron window). Text input at the bottom, messages displayed above.
Your text responses are shown in the chat panel. Additional I/O available via plugins.`;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    // Route ai.stream events to the SSE pool of their target sessionId
    this.bus.subscribe<AIStreamMessage>("ai.stream", (msg) => {
      if (!msg.target) return;
      const source = (msg.source === "jarvis-core" || msg.source === "session-dispatcher") ? "jarvis" : msg.source;
      switch (msg.event) {
        case "delta":
          this.broadcast(msg.target, { type: "delta", text: msg.text, source, session: msg.target });
          break;
        case "complete":
          this.broadcast(msg.target, { type: "done", fullText: msg.text ?? "", source, session: msg.target });
          break;
        case "error":
          this.broadcast(msg.target, { type: "error", error: msg.error, source, session: msg.target });
          break;
        case "tool_start":
          this.broadcast(msg.target, { type: "tool_start", name: msg.toolName, id: msg.toolId, args: msg.toolArgs, source, session: msg.target });
          break;
        case "tool_done":
          this.broadcast(msg.target, { type: "tool_done", name: msg.toolName, id: msg.toolId, ms: msg.toolMs, output: msg.toolOutput, source, session: msg.target });
          break;
        case "tool_progress" as any:
          this.broadcast(msg.target, { type: "tool_progress", id: (msg as any).toolId, chunk: (msg as any).chunk, source, session: msg.target });
          break;
        case "tool_cancelled":
          this.broadcast(msg.target, { type: "tool_cancelled", name: msg.toolName, id: msg.toolId, source, session: msg.target });
          break;
        case "aborted":
          log.info({ sessionId: msg.target }, "ChatPiece: SSE → aborted");
          this.broadcast(msg.target, { type: "aborted", source, session: msg.target });
          break;
        // Authoritative session state from the backend stack push/pop.
        // Forwarded verbatim so the frontend can use it as ground truth.
        case "session_state" as any:
          log.info({ sessionId: msg.target, state: (msg as any).state }, "ChatPiece: SSE → session_state");
          this.broadcast(msg.target, { type: "session_state", state: (msg as any).state, session: msg.target });
          break;
        case "compaction":
          this.broadcast(msg.target, {
            type: "compaction",
            engine: (msg as any).compaction?.engine,
            tokensBefore: (msg as any).compaction?.tokensBefore,
            tokensAfter: (msg as any).compaction?.tokensAfter,
            summary: (msg as any).compaction?.summary,
            source,
            session: msg.target,
          });
          break;
        // compaction_start is published by JarvisCore (and main.ts force-compact
        // handlers) when Engine B (fallback / forced) starts the summary call.
        // Engine A (server-side) is instantaneous and does not emit start.
        // Not in the public AIStreamMessage event union — read via cast.
        case "compaction_start" as any:
          this.broadcast(msg.target, {
            type: "compaction_start",
            engine: (msg as any).compactionStart?.engine,
            tokensBefore: (msg as any).compactionStart?.tokensBefore,
            reason: (msg as any).compactionStart?.reason,
            source,
            session: msg.target,
          });
          break;
        // compaction_failed is published by JarvisCore / main.ts runCompaction
        // when Engine B fails (summarizer error, empty summary, backup write
        // failure). History is preserved — the UI replaces the pending banner
        // with a failure entry. Not in the public AIStreamMessage union — cast.
        case "compaction_failed" as any:
          this.broadcast(msg.target, {
            type: "compaction_failed",
            engine: (msg as any).compactionFailed?.engine,
            tokensBefore: (msg as any).compactionFailed?.tokensBefore,
            reason: (msg as any).compactionFailed?.reason,
            source,
            session: msg.target,
          });
          break;
        // pending_queue is published by JarvisCore.broadcastPendingQueue.
        // Not declared in AIStreamMessage.event union (intentionally — kept
        // out of the public type surface to avoid forcing plugin updates),
        // so we read it via cast.
        case "pending_queue" as any:
          this.broadcast(msg.target, {
            type: "pending_queue",
            items: (msg as any).items ?? [],
            source,
            session: msg.target,
          });
          break;
        // prompt_dispatched is published by JarvisCore.broadcastPromptDispatched
        // when prompts are about to be sent to the AI. One event may carry
        // multiple items (e.g. a queue drain combines N original messages
        // into one API call but emits one item per original message). We
        // expand into one `type:"user"` SSE per item so the timeline renders
        // them as distinct user entries with their original sources.
        // Not in the AIStreamMessage union — read via cast.
        case "prompt_dispatched" as any: {
          const items = (msg as any).items as Array<{
            text?: string;
            source?: string;
            images?: any[];
          }> | undefined;
          if (!items) break;
          for (const item of items) {
            // Map the item's source the same way the legacy mirror did.
            let itemSource = item.source ?? source;
            if (itemSource === "chat-input") itemSource = "chat";
            else if (itemSource === "grpc") itemSource = "grpc";
            this.broadcast(msg.target, {
              type: "user",
              text: item.text ?? "",
              images: item.images,
              source: itemSource,
              session: msg.target,
            });
          }
          break;
        }
      }
    });

    // system.event "router.switch" → SSE model_changed for ModelPicker.
    // Emitted by ModelRouter whenever the effective model changes for a session.
    // Allows ModelPicker to go event-driven instead of polling /chat/session-info.
    this.bus.subscribe("system.event", (msg: any) => {
      if (msg.event !== "router.switch") return;
      const { sessionId, toModel, effort } = msg.data ?? {};
      if (!sessionId || !toModel) return;
      // Mission Gearbox: effort rides alongside the model on this event so the
      // picker's trigger/active-row updates instantly without a session-info
      // round-trip — same immediacy the model itself already had.
      this.broadcast(sessionId, { type: "model_changed", model: toModel, effort: effort ?? null, session: sessionId });
    });

    // chat.timeline → typed SSE bridge for per-session timeline entries.
    // Any piece or plugin publishes a ChatTimelineMessage; the chat-piece
    // bridges it to the client as type:"timeline_entry" with the entry
    // payload. The client owns all rendering — core has zero plugin knowledge.
    this.bus.subscribe<ChatTimelineMessage>("chat.timeline", (msg) => {
      if (!msg.entry?.sessionId) return;
      this.broadcast(msg.entry.sessionId, {
        type: "timeline_entry",
        entry: msg.entry,
        session: msg.entry.sessionId,
      });
    });

    // chat.anchor → forward to the SSE pool of the matching sessionId.
    // Generic mechanism: any piece (core or plugin) can pin a UI anchor
    // above the chat composer for a specific session.
    this.bus.subscribe<ChatAnchorMessage>("chat.anchor", (msg) => {
      const sessionId = msg.sessionId;
      if (!sessionId) return;
      switch (msg.action) {
        case "set":
          if (!msg.anchor) return;
          // Stamp createdAt server-side if missing — guarantees TTL expiry
          // in the client uses a coherent reference timestamp.
          this.broadcast(sessionId, {
            type: "anchor.set",
            sessionId,
            anchor: { ...msg.anchor, createdAt: msg.anchor.createdAt ?? Date.now() },
          });
          break;
        case "remove":
          if (!msg.anchorId) return;
          this.broadcast(sessionId, {
            type: "anchor.remove",
            sessionId,
            anchorId: msg.anchorId,
          });
          break;
        case "clear":
          this.broadcast(sessionId, { type: "anchor.clear", sessionId });
          break;
      }
    });

    // NOTE: We deliberately do NOT mirror ai.request here as type:"user".
    // The timeline must reflect "what was sent to the API", not "what
    // arrived in the bus". The session owner (JarvisCore for main/grpc-*,
    // or any plugin owning custom sessionIds) is responsible
    // for emitting `prompt_dispatched` (handled above) at the moment a
    // prompt is actually sent to the model — which is also the moment we
    // want the user entry to appear in the timeline. Until then, a queued
    // prompt shows only as a card in the pending_queue list.

    // Register HUD panels for the root chat (main session lives in App.tsx).
    // data carries sessionId + assistantLabel so ChatPanelHudAdapter (and
    // DetachedPanelRenderer) can render without hardcoding session identity.
    this.bus.publish({
      channel: "hud.update", source: this.id, action: "add", pieceId: "chat-output",
      piece: { pieceId: "chat-output", type: "panel", name: "Chat", status: "running",
        data: { sessionId: DEFAULT_SESSION, assistantLabel: "JARVIS" },
        position: { x: 10, y: 480 }, size: { width: 1660, height: 280 } },
    });

    this.bus.publish({
      channel: "hud.update", source: this.id, action: "add", pieceId: "chat-input",
      piece: { pieceId: "chat-input", type: "panel", name: "Input", status: "running",
        data: { sessionId: DEFAULT_SESSION, assistantLabel: "JARVIS" },
        position: { x: 10, y: 768 }, size: { width: 1660, height: 44 } },
    });

    log.info("ChatPiece: started");
  }

  async stop(): Promise<void> {
    for (const clients of this.streamClients.values()) {
      for (const res of clients) { try { res.end(); } catch {} }
    }
    this.streamClients.clear();

    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-output",
    });
    this.bus.publish({
      channel: "hud.update", source: this.id, action: "remove", pieceId: "chat-input",
    });
    log.info("ChatPiece: stopped");
  }

  // ────────────── Helpers ──────────────

  private parseQuerySessionId(req: IncomingMessage): string | null {
    const url = req.url ?? "";
    const idx = url.indexOf("?");
    if (idx < 0) return null;
    const params = new URLSearchParams(url.slice(idx + 1));
    const v = params.get("sessionId");
    return v && v.trim() ? v.trim() : null;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private send400(res: ServerResponse, error: string): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  }

  // ────────────── HTTP handlers ──────────────

  /** POST /chat/send — body { sessionId, prompt, images? } */
  async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string;
    try { body = await this.readBody(req); } catch (e) { return this.send400(res, String(e)); }

    let parsed: any;
    try { parsed = JSON.parse(body); } catch (e) { return this.send400(res, `Invalid JSON: ${e}`); }

    const sessionId: string | undefined = parsed.sessionId;
    if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
      return this.send400(res, "sessionId is required");
    }
    const sid = sessionId.trim();
    const prompt: string = parsed.prompt ?? "";
    const images = parsed.images;
    // One traceId per HTTP /chat/send call. Propagates from here all the
    // way down through ai.request → ai.stream → capability.* events.
    const traceId = newTraceId();

    log.info({
      traceId,
      sessionId: sid,
      promptLength: typeof prompt === "string" ? prompt.length : -1,
      promptPreview: typeof prompt === "string" ? preview(prompt, 200) : "<non-string>",
      images: Array.isArray(images) ? images.length : 0,
      imageBytesTotal: Array.isArray(images) ? images.reduce((acc: number, i: any) => acc + (i?.base64?.length ?? 0), 0) : 0,
    }, "ChatPiece: handleSend (entry)");

    // Intercept slash commands (only have semantics for the calling session)
    if (this.registry && typeof prompt === "string" && prompt.startsWith("/")) {
      const match = prompt.match(/^\/(\S+)\s*(.*)?$/);
      if (match) {
        const [, cmdName, cmdArgs] = match;
        const slashCmd = this.registry.getSlashCommand(cmdName);
        if (slashCmd) {
          this.broadcast(sid, { type: "user", text: prompt, source: "chat", session: sid });
          slashCmd.handler(cmdArgs?.trim() ?? "", { sessionId: sid }).then((result) => {
            if (result.message) this.broadcast(sid, { type: "done", fullText: result.message, source: "system", session: sid });
            if (result.inject) log.info({ cmd: cmdName, injectLength: result.inject.length }, "ChatPiece: slash command injected content");
            // Slash commands never reach JarvisCore, so no session_state:idle is
            // ever emitted for them. The UI sets isThinking=true on the 'user'
            // event and ONLY session_state clears it (done doesn't, by design) —
            // without this, the chat shows "thinking..." forever after any slash.
            this.broadcast(sid, { type: "session_state", state: "idle", session: sid });
          }).catch((err) => {
            this.broadcast(sid, { type: "error", error: `Slash command error: ${err}`, source: "system", session: sid });
            this.broadcast(sid, { type: "session_state", state: "idle", session: sid });
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
    }

    // ChatPiece is plugin-agnostic. It does NOT mirror type:"user" itself.
    // The session OWNER (JarvisCore for main/grpc-*, or any plugin that
    // owns custom session prefixes) is responsible for emitting
    // `prompt_dispatched` (timeline) when the prompt actually goes to the
    // API and `pending_queue` (queue cards) while it waits. Frontend just
    // renders whatever SSE delivers.
    log.info({ traceId, sessionId: sid }, "ChatPiece: publishing ai.request");
    this.bus.publish({
      channel: "ai.request",
      source: "chat-input",
      target: sid,
      text: prompt,
      images,
      traceId,
    } as any);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, traceId }));
  }

  /** GET /chat-stream?sessionId=X — SSE pool scoped to sessionId. */
  handleStream(req: IncomingMessage, res: ServerResponse): void {
    const sid = this.parseQuerySessionId(req);
    if (!sid) { this.send400(res, "sessionId query param is required"); return; }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

    if (!this.streamClients.has(sid)) this.streamClients.set(sid, new Set());
    const pool = this.streamClients.get(sid)!;
    pool.add(res);

    // Heartbeat — SSE comment every 15s to prevent the socket from being
    // silently closed by Chromium/OS when no events flow for a long period.
    // Without this, an idle session drops the connection and the front
    // loses all events (messages, thinking state, tool calls) until reload.
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      pool.delete(res);
      if (pool.size === 0) this.streamClients.delete(sid);
    });
  }

  /** GET /chat/session-info?sessionId=X — model and provider for the session. */
  handleSessionInfo(req: IncomingMessage, res: ServerResponse): void {
    const sid = this.parseQuerySessionId(req);
    if (!sid) { this.send400(res, "sessionId query param is required"); return; }
    try {
      // peek() — NEVER get(): get() materializes a ghost session (main's full
      // system prompt, wrong role) for unknown ids, and the ModelPicker polls
      // this endpoint every 5s for every open panel. Same guard rationale as
      // handleHistory's has() check below.
      const managed = this.sessions?.peek(sid);
      const session = managed?.session as any;
      // Effective model = peekModel() (next ?? sticky ?? base). For sessions
      // not yet materialized, report the provider default — what a brand-new
      // session would use — so the HUD shows the truthful upcoming model
      // instead of a placeholder.
      const model = session?.peekModel?.() ?? session?.stickyModelOverride ?? config.model ?? null;
      const provider = session?.constructor?.name?.replace("Session", "").toLowerCase() ?? null;
      // Mission Gearbox: current effort (from sticky params), so the HUD picker
      // can mark the active {model, effort} row without a separate round-trip.
      const effort = (session?.peekParams?.() ?? {}).effort ?? null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model, provider, effort }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: null, provider: null }));
    }
  }

  /** GET /chat/history?sessionId=X — parsed session messages. */
  handleHistory(req: IncomingMessage, res: ServerResponse): void {
    const sid = this.parseQuerySessionId(req);
    if (!sid) { this.send400(res, "sessionId query param is required"); return; }

    try {
      if (!this.sessions) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      if (!this.sessions.has(sid)) {
        // Session not yet materialized — try to hydrate from disk so the chat
        // panel can show history on first open without triggering a full session
        // creation (which would load the system prompt, start pieces, etc.).
        log.info({ sid }, "ChatPiece.handleHistory: session not in memory, trying disk");
        const provider = getProviderForModel(config.model);
        const saved = loadConversation(sid, provider);
        if (!saved || saved.messages.length === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[]");
          return;
        }
        const entries = parseMessagesToHistory(saved.messages as any[], sid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(entries));
        return;
      }
      const managed = this.sessions.get(sid);
      const rawMessages = managed.session.getMessages() as any[];
      const entries = parseMessagesToHistory(rawMessages, sid);
      // Append startup greeting if one is pending (set by consumeStartupPrompt on boot).
      // Consumed once so subsequent history requests don't repeat it.
      const greeting = sid === DEFAULT_SESSION ? consumePendingGreeting() : null;
      if (greeting) {
        entries.push({ kind: "message", role: "assistant", text: greeting, source: "jarvis" });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
  }

  /** Broadcast a system/UI event to a specific session's SSE pool.
   *  Note: this is used by main.ts (e.g. session_cleared). Plugins/components
   *  should publish on ai.stream/ai.request; those route automatically. */
  broadcastEvent(sessionId: string, data: Record<string, unknown>): void {
    if (!sessionId) return;
    this.broadcast(sessionId, data);
  }

  private broadcast(sessionId: string, data: Record<string, unknown>): void {
    const pool = this.streamClients.get(sessionId);
    if (!pool || pool.size === 0) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of pool) {
      try { client.write(msg); } catch {}
    }
  }
}

/** Parse raw session messages into chat timeline entries. Pure helper.
 *
 * Special handling for jarvis_ask_choice:
 *   - tool_use(jarvis_ask_choice, input) → entry kind:'choice' with questions[]
 *     Input shapes supported:
 *       (a) { question, options, multi?, allow_other? } → 1 question
 *       (b) { questions: [{ question, options, multi?, allow_other? }, ...] }
 *   - If the NEXT user message matches "[choice] ..." the answer(s) are
 *     consumed and the choice entry is marked answered.
 *       Single-question response:  "[choice] <q> → <labels>"
 *       Multi-question response:   "[choice]\n<q1> → <a1>\n<q2> → <a2>\n..."
 */
export function parseMessagesToHistory(rawMessages: any[], sessionId?: string): any[] {
  // Infer a stable source label for user messages based on the session.
  // The Anthropic message format has no sender metadata — we derive it from
  // the session ID so actor chats show the correct sender (e.g. "main") instead
  // of the generic "chat" / "YOU" label.
  //
  // Rules:
  //   main / undefined → "chat"  (renders as YOU — the human user)
  //   actor-<name>     → "main"  (messages to actors come from orchestrator)
  //   grpc-*           → "grpc"
  //   anything else    → "chat"  (safe fallback)
  const inferredUserSource = (() => {
    if (!sessionId || sessionId === "main") return "chat";
    if (sessionId.startsWith("actor-")) return "main";
    if (sessionId.startsWith("grpc-")) return "grpc";
    return "chat";
  })();
  const entries: any[] = [];

  interface PendingChoiceQuestion {
    question: string;
    options: Array<{ value: string; label: string }>;
  }
  interface PendingChoice {
    entryIdx: number;
    questions: PendingChoiceQuestion[];
  }
  // FIFO queue: multiple choices can be awaiting answers out-of-order.
  // Without this, a later tool_use overwrites an earlier pending choice and
  // its answer is never consumed.
  const pendingQueue: PendingChoice[] = [];

  const OTHER_VALUE = "__other__";

  /** Map an answer string back to option values for ONE question.
   *  Greedy longest-label-first matching so labels containing ", " (e.g.
   *  "C) Card único, 1 submit final") aren't split incorrectly.
   *  Anything that doesn't match a known label falls through as a single
   *  "Other" free-text chunk.
   */
  const mapAnswerToValues = (
    answerStr: string,
    q: PendingChoiceQuestion,
  ): { values: string[]; otherText?: string; dismissed?: boolean } => {
    // Sentinel for the "Dismiss" button. The frontend serializes the dismiss
    // action as `[choice] <q> → (dismissed)`. Surface it explicitly so the UI
    // can render a "dismissed" pill instead of treating it as free-text Other.
    if (answerStr.trim() === "(dismissed)") {
      return { values: [], dismissed: true };
    }

    const labels = q.options.map(o => o.label).sort((a, b) => b.length - a.length);
    const values: string[] = [];
    let otherText: string | undefined;

    let rest = answerStr.trim();
    while (rest.length > 0) {
      let matched = false;
      for (const lbl of labels) {
        // Match label at start, followed by end-of-string OR ", " delimiter.
        if (rest === lbl) {
          const opt = q.options.find(o => o.label === lbl);
          if (opt) values.push(opt.value);
          rest = "";
          matched = true;
          break;
        }
        if (rest.startsWith(lbl + ", ")) {
          const opt = q.options.find(o => o.label === lbl);
          if (opt) values.push(opt.value);
          rest = rest.slice(lbl.length + 2);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // No known label at this position → treat the remaining string as free-text "Other".
        values.push(OTHER_VALUE);
        otherText = rest;
        rest = "";
      }
    }
    return { values, otherText };
  };

  const consumeChoiceAnswer = (text: string): boolean => {
    if (pendingQueue.length === 0) return false;
    if (!text.startsWith("[choice]")) return false;

    const trimmed = text.replace(/^\[choice\]\s*/, "");

    // Bare-dismiss form: "[choice] (dismissed)" with no question segment.
    // Pair with the OLDEST pending choice (FIFO) and mark every question as
    // dismissed — covers the edge case where the frontend couldn't extract
    // the first question label.
    if (trimmed === "(dismissed)") {
      const target = pendingQueue.shift();
      if (!target) return false;
      const entry = entries[target.entryIdx];
      if (!entry || entry.kind !== "choice") return true; // consumed silently
      entry.answers = target.questions.map(() => ({ values: [], dismissed: true }));
      return true;
    }

    const hasNewlines = /\n/.test(trimmed);

    // Extract the first question text from the answer to find which pending choice it targets.
    // - Multi-line: each line is "<q> → <a>". Use the FIRST line's question to match.
    // - Single-line: "<q> → <a>".
    const firstQMatch = hasNewlines
      ? trimmed.split(/\n+/, 1)[0]?.match(/^(.+?)\s+→\s+(.+)$/s)
      : trimmed.match(/^(.+?)\s+→\s+(.+)$/s);
    if (!firstQMatch) return false;
    const firstQ = firstQMatch[1].trim();

    // Find the pending choice whose first question matches firstQ.
    const targetIdx = pendingQueue.findIndex(p => p.questions[0]?.question === firstQ);
    if (targetIdx === -1) return false;
    const target = pendingQueue[targetIdx];

    const entry = entries[target.entryIdx];
    if (!entry || entry.kind !== "choice") return false;

    if (hasNewlines || target.questions.length > 1) {
      // Multi-question answer
      const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const answersByQ: Record<string, { values: string[]; otherText?: string }> = {};
      for (const line of lines) {
        const m = line.match(/^(.+?)\s+→\s+(.+)$/s);
        if (!m) continue;
        const q = m[1].trim();
        const ansStr = m[2].trim();
        const pending = target.questions.find(pq => pq.question === q);
        if (!pending) continue;
        answersByQ[q] = mapAnswerToValues(ansStr, pending);
      }
      if (Object.keys(answersByQ).length === 0) return false;
      entry.answers = target.questions.map(pq => answersByQ[pq.question] ?? { values: [] });
      pendingQueue.splice(targetIdx, 1);
      return true;
    }

    // Single-question: entire text is "<q> → <labels>"
    const ansStr = firstQMatch[2].trim();
    const pending = target.questions[0];
    entry.answers = [mapAnswerToValues(ansStr, pending)];
    pendingQueue.splice(targetIdx, 1);
    return true;
  };

  for (const msg of rawMessages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content) && msg.content.every((b: any) => b.type === "tool_result")) continue;

      // Join multiple text blocks with \n\n so each PromptBlock appears as a
      // distinct paragraph instead of being concatenated on one line.
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n\n");
      }

      if (!text.trim()) continue;
      // If this user message is a choice answer, consume it silently.
      if (consumeChoiceAnswer(text.trim())) continue;
      entries.push({ kind: "message", role: "user", text, source: inferredUserSource });
    } else if (msg.role === "assistant") {
      let text = "";
      const toolUses: any[] = [];
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") text += block.text;
          if (block.type === "tool_use") toolUses.push(block);
        }
      }
      if (text) entries.push({ kind: "message", role: "assistant", text, source: "jarvis" });
      for (const tu of toolUses) {
        if (tu.name === "jarvis_ask_choice" && tu.input && typeof tu.input === "object") {
          const input = tu.input as any;

          // Normalize to questions[]
          const parseOne = (raw: any): { question: string; options: any[]; multi: boolean; allow_other: boolean } | null => {
            if (!raw || typeof raw !== "object") return null;
            const question = String(raw.question ?? "").trim();
            if (!question) return null;
            const options = Array.isArray(raw.options)
              ? raw.options
                  .filter((o: any) => o && typeof o.value === "string" && typeof o.label === "string")
                  .map((o: any) => ({ value: String(o.value), label: String(o.label), description: o.description }))
              : [];
            if (options.length === 0) return null;
            return {
              question,
              options,
              multi: raw.multi === true,
              allow_other: raw.allow_other !== false,
            };
          };

          let questions: Array<{ question: string; options: any[]; multi: boolean; allow_other: boolean }> = [];
          if (Array.isArray(input.questions)) {
            questions = input.questions.map(parseOne).filter((q: any) => q !== null);
          } else {
            const single = parseOne(input);
            if (single) questions = [single];
          }
          if (questions.length === 0) continue;

          const choiceEntry: any = {
            kind: "choice",
            choice_id: tu.id ?? `choice-${entries.length}`,
            questions,
          };
          entries.push(choiceEntry);
          pendingQueue.push({
            entryIdx: entries.length - 1,
            questions: questions.map(q => ({ question: q.question, options: q.options })),
          });
          continue;
        }
        entries.push({
          kind: "capability",
          name: tu.name,
          id: tu.id,
          args: typeof tu.input === "object" ? JSON.stringify(tu.input) : String(tu.input ?? ""),
          status: "done",
        });
      }
    }
  }

  return entries;
}
