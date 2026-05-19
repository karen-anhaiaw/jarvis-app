// src/core/session-manager.ts
import type { AISession, AISessionFactory, CreateWithPromptOptions } from "../ai/types.js";
import type { EventBus } from "./bus.js";
import type { ProviderRouter } from "../ai/provider.js";
import { log } from "../logger/index.js";
import {
  saveConversation,
  loadConversation,
  clearConversation,
  listSavedSessions,
} from "./conversation-store.js";
import { config } from "../config/index.js";

type SessionState = "idle" | "processing" | "waiting_tools";

interface ManagedSession {
  session: AISession;
  state: SessionState;
  createdAt: number;
  pendingToolCalls?: import("../ai/types.js").CapabilityCall[];
}

/**
 * Tracks how a session was created so getWithPrompt can restore properly.
 */
interface SessionCreationOptions {
  promptOptions?: CreateWithPromptOptions;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private factory: AISessionFactory;
  private providerRouter?: ProviderRouter;
  private currentProvider: string = "anthropic";
  private autoSaveTimer?: ReturnType<typeof setInterval>;
  private ephemeralSessions = new Set<string>();
  private bus?: EventBus;
  private static AUTO_SAVE_INTERVAL_MS = 30_000; // save every 30s

  /**
   * Tracks creation options per session so we can restore with the right prompt.
   * Only set for sessions created via getWithPrompt.
   */
  private creationOptions = new Map<string, SessionCreationOptions>();

  constructor(factory: AISessionFactory) {
    this.factory = factory;
  }

  /**
   * Attach the EventBus so the manager can publish lifecycle events
   * (session.closed) that downstream pieces rely on for eviction.
   * Call once during app bootstrap — all subsequent close() calls will emit.
   */
  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  /** Set current provider name (needed for save/restore compatibility checks) */
  setProvider(provider: string): void {
    this.currentProvider = provider;
  }

  /**
   * Wire the ProviderRouter so sessions can be created with the correct
   * factory for their target model (cross-provider actors).
   */
  setProviderRouter(router: ProviderRouter): void {
    this.providerRouter = router;
  }

  /**
   * Resolve the factory to use for a given model.
   * If a ProviderRouter is wired and the model belongs to a different provider,
   * returns that provider's factory instead of the active one.
   */
  private factoryFor(model?: string): AISessionFactory {
    if (model && this.providerRouter) {
      return this.providerRouter.getFactoryForModel(model);
    }
    return this.factory;
  }

  /** Start auto-saving conversation state periodically */
  startAutoSave(): void {
    if (this.autoSaveTimer) return;
    this.autoSaveTimer = setInterval(() => this.saveAll(), SessionManager.AUTO_SAVE_INTERVAL_MS);
    log.info({ intervalMs: SessionManager.AUTO_SAVE_INTERVAL_MS }, "SessionManager: auto-save started");
  }

  /** Stop auto-save timer */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  /** Check if a session exists (without creating it) */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Read-only lookup. Returns undefined if the session doesn't exist.
   * Use when you want to inspect/mutate an existing session WITHOUT
   * triggering creation (which `get()` does as a side effect).
   * Required by the ModelRouter — routing must never spawn a session.
   */
  peek(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List session IDs of all currently-managed sessions.
   * Used for retroactive operations (e.g. installing a new context injector
   * on sessions that already exist).
   *
   * @since 0.4.0
   */
  listActive(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Listeners fired when a session is created (by `get()` or `getWithPrompt()`).
   * Used by the ModelRouter to apply sticky model overrides on the FIRST turn —
   * the router's bus subscriber runs before the session exists, so peek()
   * returns undefined on turn 1; this hook lets the router catch up immediately
   * after creation, before sendAndStream() reads getModel().
   */
  private createListeners: Array<(sessionId: string, managed: ManagedSession) => void> = [];

  onSessionCreated(listener: (sessionId: string, managed: ManagedSession) => void): void {
    this.createListeners.push(listener);
  }

  private fireCreated(sessionId: string, managed: ManagedSession): void {
    for (const l of this.createListeners) {
      try { l(sessionId, managed); }
      catch (err) { log.warn({ sessionId, err }, "SessionManager: onSessionCreated listener threw"); }
    }
  }

  /**
   * Get or create a session.
   * Auto-creates with factory.create() and restores saved conversation.
   * For sessions with custom prompts, prefer getWithPrompt().
   */
  get(sessionId: string): ManagedSession {
    let managed = this.sessions.get(sessionId);
    if (!managed) {
      // Try to load saved conversation for restore
      const saved = loadConversation(sessionId, this.currentProvider);
      const restoreMessages = saved && saved.messages.length > 0 ? saved.messages : undefined;
      // Stable instanceId so X-Claude-Code-Session-Id stays consistent across restarts.
      // Passed to the factory so the Anthropic client is built with the correct
      // session header from the start (no post-construction mutation needed).
      const restoredSessionId = saved?.instanceId ?? (saved as any)?.apiSessionId; // migrate old field

      // If session has saved creation options, restore with custom prompt
      const opts = this.creationOptions.get(sessionId);
      let session: AISession;
      if (opts?.promptOptions) {
        session = this.factory.createWithPrompt({ ...opts.promptOptions, restoredSessionId });
      } else {
        // Factory handles restore — each provider knows its own message format
        session = this.factory.create({ label: sessionId, restoreMessages, restoredSessionId });
      }

      if (restoreMessages && !opts?.promptOptions) {
        log.info(
          { sessionId, restored: saved!.messageCount, savedAt: saved!.savedAt },
          "SessionManager: conversation restored via factory",
        );
      }

      managed = {
        session,
        state: "idle",
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, managed);
      log.info({ sessionId, restored: !!restoreMessages }, "SessionManager: created new session");
      this.fireCreated(sessionId, managed);
    }
    return managed;
  }

  /**
   * Get or create a session with custom prompt options.
   * If the session already exists, returns it (prompt options are ignored — they're set at creation).
   * If new, creates with createWithPrompt and optionally restores saved conversation.
   *
   * Pass `model` to use the correct provider factory for cross-provider actors
   * (e.g. an actor with preferred_model: "gpt-4o" when the active provider is Anthropic).
   */
  getWithPrompt(sessionId: string, options: CreateWithPromptOptions & { model?: string }): ManagedSession {
    let managed = this.sessions.get(sessionId);
    if (managed) return managed;

    // Store creation options for future restore
    this.creationOptions.set(sessionId, { promptOptions: options });

    // Try to restore saved conversation FIRST so we can pass the stable instanceId
    // into the factory and have the Anthropic client built with the right header.
    const saved = loadConversation(sessionId, this.currentProvider);
    const restoredSessionId = saved?.instanceId ?? (saved as any)?.apiSessionId; // migrate old field

    // Resolve the factory for the target model (cross-provider actor support)
    const factory = this.factoryFor(options.model);
    const session = factory.createWithPrompt({ ...options, restoredSessionId });

    if (saved && saved.messages.length > 0) {
      session.setMessages?.(saved.messages);
      log.info(
        { sessionId, restored: saved.messageCount, savedAt: saved.savedAt },
        "SessionManager: custom session conversation restored",
      );
    }

    managed = {
      session,
      state: "idle",
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, managed);
    log.info({ sessionId, model: options.model, hasRestore: !!(saved && saved.messages.length > 0) }, "SessionManager: created session with custom prompt");
    this.fireCreated(sessionId, managed);
    return managed;
  }

  setState(sessionId: string, state: SessionState): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      const prev = managed.state;
      managed.state = state;
      // info-level so state transitions are visible without enabling debug.
      // No-op transitions (idle→idle, processing→processing) are filtered to
      // avoid noise from defensive callers.
      if (prev !== state) {
        log.info({ sessionId, from: prev, to: state }, "SessionManager: state changed");
      } else {
        log.trace({ sessionId, state }, "SessionManager: state set (no change)");
      }

      // Save after each complete turn (when going back to idle) — skip ephemeral sessions
      if (state === "idle" && !this.ephemeralSessions.has(sessionId)) {
        this.save(sessionId);
      }
    }
  }

  getState(sessionId: string): SessionState {
    return this.sessions.get(sessionId)?.state ?? "idle";
  }

  abort(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.session.abort();
      managed.pendingToolCalls = undefined;
      managed.state = "idle";
      log.info({ sessionId }, "SessionManager: aborted");
    }
  }

  /** Mark a session as ephemeral (never saved to disk) or persistent. */
  setEphemeral(sessionId: string, ephemeral: boolean): void {
    if (ephemeral) {
      this.ephemeralSessions.add(sessionId);
      log.info({ sessionId }, "SessionManager: marked ephemeral");
    } else {
      this.ephemeralSessions.delete(sessionId);
      log.info({ sessionId }, "SessionManager: marked persistent");
    }
  }

  /** Check if a session is ephemeral. */
  isEphemeral(sessionId: string): boolean {
    return this.ephemeralSessions.has(sessionId);
  }

  /** Save a single session's conversation to disk (skips ephemeral sessions) */
  save(sessionId: string): void {
    if (this.ephemeralSessions.has(sessionId)) return;
    const managed = this.sessions.get(sessionId);
    if (managed) {
      saveConversation(
        sessionId,
        managed.session.getMessages(),
        this.currentProvider,
        config.model,
        (managed.session as any).sessionId,
      );
    }
  }

  /** Save all active sessions to disk */
  saveAll(): void {
    for (const [id] of this.sessions) {
      this.save(id);
    }
  }

  close(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      // Save before closing (save() already skips ephemeral)
      this.save(sessionId);
      managed.session.close();
      this.sessions.delete(sessionId);
      this.creationOptions.delete(sessionId);
      this.ephemeralSessions.delete(sessionId);
      log.info({ sessionId }, "SessionManager: closed");
      this.emitClosed(sessionId);
    }
  }

  /** Clear saved conversation for a session (e.g. on explicit /clear command) */
  clearSaved(sessionId: string): void {
    clearConversation(sessionId);
  }

  updateFactory(factory: AISessionFactory): void {
    this.factory = factory;
    this.closeAll();
    log.info("SessionManager: factory updated, sessions cleared");
  }

  closeAll(): void {
    // Save all before closing
    this.saveAll();
    const closedIds: string[] = [];
    for (const [id] of this.sessions) {
      const managed = this.sessions.get(id);
      if (managed) {
        managed.session.close();
        this.sessions.delete(id);
        closedIds.push(id);
      }
    }
    this.creationOptions.clear();
    this.ephemeralSessions.clear();
    for (const id of closedIds) this.emitClosed(id);
  }

  /** Publish session.closed on the bus so downstream pieces can evict per-session state. */
  private emitClosed(sessionId: string): void {
    if (!this.bus) return;
    this.bus.publish({
      channel: "system.event",
      source: "session-manager",
      event: "session.closed",
      data: { sessionId },
    });
  }

  /** List saved session labels from disk (e.g. ["main", "actor-alice", "actor-bob"]) */
  listSaved(prefix?: string): string[] {
    const all = listSavedSessions();
    return prefix ? all.filter(id => id.startsWith(prefix)) : all;
  }

  /** Archive a session: save to archive dir, then delete the live session file */
  archiveSaved(sessionId: string): void {
    // clearConversation already deletes the file — we just need to archive first
    // Re-use the conversation-store archive logic
    const saved = loadConversation(sessionId, this.currentProvider);
    if (saved) {
      // Import archive helper
      const { archiveConversation } = require("./conversation-store.js");
      if (typeof archiveConversation === "function") {
        archiveConversation(sessionId);
      } else {
        // Fallback: just delete
        clearConversation(sessionId);
      }
    }
    log.info({ sessionId }, "SessionManager: archived");
  }

  get size(): number {
    return this.sessions.size;
  }
}
