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
  /**
   * State stack — each push() adds a frame, each pop() removes the top.
   * The current state is the top of the stack (last element).
   * An empty stack means idle.
   *
   * Invariant: only "processing" and "waiting_tools" are pushed.
   * "idle" is never a stack frame — it is derived from an empty stack.
   */
  stateStack: SessionState[];
  createdAt: number;
  pendingToolCalls?: import("../ai/types.js").CapabilityCall[];
}

/** Derived state from the stack top, or "idle" if empty. */
function peekStack(managed: ManagedSession): SessionState {
  return managed.stateStack.length > 0
    ? managed.stateStack[managed.stateStack.length - 1]
    : "idle";
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
   * Global context injector — installed on every session (existing + future).
   * Set once via setGlobalContextInjector(); applied in get() and getWithPrompt().
   * This replaces the per-session onSessionCreated approach: a single fn covers
   * all sessions regardless of when they are created.
   */
  private globalContextInjector?: (sessionId: string) => string[] | Promise<string[]>;

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

  /**
   * Register a global context injector called before every AI request,
   * for every session. Replaces any previously registered injector.
   * Also installs it retroactively on all currently loaded sessions.
   */
  setGlobalContextInjector(fn: (sessionId: string) => string[] | Promise<string[]>): void {
    this.globalContextInjector = fn;
    // Retroactively install on all already-loaded sessions.
    for (const [, managed] of this.sessions) {
      this.applyGlobalInjector(managed.session);
    }
  }

  private applyGlobalInjector(session: unknown): void {
    const setter = (session as { setContextInjector?: (fn: (sessionId: string) => string[] | Promise<string[]>) => void }).setContextInjector;
    log.info({ hasInjector: !!this.globalContextInjector, hasSetter: typeof setter === "function" }, "SessionManager: applyGlobalInjector");
    if (typeof setter !== "function") return;
    if (this.globalContextInjector) setter.call(session, this.globalContextInjector);
  }

  /** Set current provider name (needed for save/restore compatibility checks) */
  setProvider(provider: string): void {
    this.currentProvider = provider;
  }

  /**
   * Wire the ProviderRouter so sessions can be created with the correct
   * factory for their target model (cross-provider plugin-owned sessions).
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
        stateStack: [],
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, managed);
      this.applyGlobalInjector(session);
      log.info({ sessionId, restored: !!restoreMessages }, "SessionManager: created new session");
      this.fireCreated(sessionId, managed);
    }
    return managed;
  }

  /**
   * Fork an existing session into a new ephemeral session.
   *
   * The fork clones the source session's message history so the Anthropic prompt
   * cache can be reused: cache is keyed by model + identical token prefix, NOT by
   * sessionId. A fork with the same history and the same restoredSessionId will hit
   * the cache at ~10% of full-input cost.
   *
   * Cache-preservation invariants (PoC 2026-06-11):
   *   R1: restoredSessionId from source is carried over so metadata.user_id (and
   *       X-Claude-Code-Session-Id) are identical — same cache key prefix.
   *   R2: The globalContextInjector is NOT applied to the fork (applyGlobalInjector
   *       is deliberately skipped). Mnemosyne memories must not bias the classifier.
   *   R3: getPluginContext uses label — fork gets a different label but plugin
   *       contexts are label-agnostic in BP2, so BP1 cache remains unaffected.
   *   R4: highEffort is mirrored from the source via (session as any) cast because
   *       the field is declared `private readonly` — TS enforcement only, JS allows it.
   *
   * The forked session is ephemeral: never persisted, never restored on restart.
   * MUST be closed after use via sessions.close(newId) to avoid ghost sessions.
   *
   * @param sourceId - existing session to clone history from (must exist)
   * @param newId    - identifier for the fork (must not already exist)
   * @returns the new ManagedSession
   * @throws if sourceId is not found or newId already exists
   */
  fork(sourceId: string, newId: string): ManagedSession {
    const source = this.sessions.get(sourceId);
    if (!source) {
      throw new Error(`SessionManager.fork: source session '${sourceId}' not found`);
    }
    if (this.sessions.has(newId)) {
      throw new Error(`SessionManager.fork: target session '${newId}' already exists`);
    }

    const sourceSession = source.session;

    // R1: reuse source's internal sessionId so the Anthropic client sends the
    //     same X-Claude-Code-Session-Id → cache key prefix matches.
    const restoredSessionId: string | undefined =
      (sourceSession as any)._sessionId ?? (sourceSession as any).sessionId ?? undefined;

    // R4: mirror the highEffort flag (private readonly — JS cast is fine)
    const highEffort: boolean = (sourceSession as any).highEffort ?? false;

    // Create the fork via standard get() — this goes through factory.create()
    // which sets highEffort based on label (will be false for any non-"main" newId).
    // We then patch it below (R4).
    // IMPORTANT: get() calls applyGlobalInjector() — we must undo that (R2).
    const managed = this.get(newId);
    const forkedSession = managed.session;

    // Seed with source history
    forkedSession.setMessages?.(sourceSession.getMessages());

    // R1: override internal session ID so cache key matches source
    if (restoredSessionId) {
      (forkedSession as any)._sessionId = restoredSessionId;
    }

    // R4: mirror effort flag (may differ if source is "main" with highEffort=true)
    if (highEffort !== ((forkedSession as any).highEffort ?? false)) {
      (forkedSession as any).highEffort = highEffort;
    }

    // R2: suppress context injector — fork must not be biased by Mnemosyne memories.
    //     Undo the injector that get() just installed via applyGlobalInjector().
    const setter = (forkedSession as {
      setContextInjector?: (fn: (sessionId: string) => string[] | Promise<string[]>) => void;
    }).setContextInjector;
    if (typeof setter === "function") {
      // Replace the global injector with a no-op so no memories are injected into the fork
      setter.call(forkedSession, () => []);
    }

    // Mark ephemeral — fork is never saved to disk, never restored
    this.setEphemeral(newId, true);

    log.info(
      { sourceId, newId, messages: sourceSession.getMessages().length, highEffort, restoredSessionId: !!restoredSessionId },
      "SessionManager: forked session",
    );

    return managed;
  }

  /**
   * Get or create a session with custom prompt options.
   * If the session already exists, returns it (prompt options are ignored — they're set at creation).
   * If new, creates with createWithPrompt and optionally restores saved conversation.
   *
   * Pass `model` to use the correct provider factory for cross-provider
   * plugin-owned sessions (e.g. a plugin requesting preferred_model: "gpt-4o"
   * while the active provider is Anthropic).
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

    // Resolve the factory for the target model (cross-provider plugin sessions)
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
      stateStack: [],
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, managed);
    this.applyGlobalInjector(session);
    log.info({ sessionId, model: options.model, hasRestore: !!(saved && saved.messages.length > 0) }, "SessionManager: created session with custom prompt");
    this.fireCreated(sessionId, managed);
    return managed;
  }

  /**
   * Push a new state frame onto the session's stack.
   * Called at the start of each operation (API call, tool execution).
   * JarvisCore calls this; never call setState() for new code.
   */
  pushState(sessionId: string, state: Exclude<SessionState, "idle">): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    const prev = peekStack(managed);
    managed.stateStack.push(state);
    log.info({ sessionId, pushed: state, stack: managed.stateStack, from: prev }, "SessionManager: state pushed");
  }

  /**
   * Pop the top state frame from the session's stack.
   * Called when an operation completes (API response, tool result, abort).
   * Returns the new top state ("idle" if stack is now empty).
   */
  popState(sessionId: string): SessionState {
    const managed = this.sessions.get(sessionId);
    if (!managed) return "idle";
    const popped = managed.stateStack.pop();
    const next = peekStack(managed);
    log.info({ sessionId, popped, stack: managed.stateStack, next }, "SessionManager: state popped");
    // Save on return to idle — turn is complete
    if (next === "idle" && !this.ephemeralSessions.has(sessionId)) {
      this.save(sessionId);
    }
    return next;
  }

  /**
   * Abort the current operation: signal the AI provider to stop streaming,
   * then pop the top frame. Does NOT clear the full stack — only the current
   * operation is cancelled. The stack returns to whatever was below it.
   */
  abort(sessionId: string): SessionState {
    const managed = this.sessions.get(sessionId);
    if (!managed) return "idle";
    managed.session.abort();
    managed.pendingToolCalls = undefined;
    const next = this.popState(sessionId);
    log.info({ sessionId, next }, "SessionManager: aborted, popped state");
    return next;
  }

  getState(sessionId: string): SessionState {
    const managed = this.sessions.get(sessionId);
    if (!managed) return "idle";
    return peekStack(managed);
  }

  /**
   * @deprecated Use pushState/popState instead.
   * Kept for backward compatibility with old callers during migration.
   * Sets state directly by manipulating the stack to match the desired state.
   */
  setState(sessionId: string, state: SessionState): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    const prev = peekStack(managed);
    if (state === "idle") {
      // Clear the entire stack — caller wants a hard reset to idle
      if (managed.stateStack.length > 0) {
        managed.stateStack.length = 0;
        log.info({ sessionId, from: prev }, "SessionManager: setState(idle) — stack cleared");
        if (!this.ephemeralSessions.has(sessionId)) this.save(sessionId);
      }
    } else {
      // Replace top frame if already in a non-idle state, otherwise push
      if (managed.stateStack.length > 0) {
        managed.stateStack[managed.stateStack.length - 1] = state;
      } else {
        managed.stateStack.push(state);
      }
      if (prev !== state) {
        log.info({ sessionId, from: prev, to: state }, "SessionManager: setState (legacy)");
      }
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

  /** List saved session labels from disk (e.g. ["main", "bg-alice", "bg-bob"]) */
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
