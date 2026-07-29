// src/main.ts
// Credentials come from exactly two places:
//   1. settings.user.json → providers.<name>.{apiKey,baseUrl}  (canonical)
//   2. shell env vars     → ANTHROPIC_API_KEY / OPENAI_API_KEY  (fallback)
// The provider modules apply (1) on top of (2) at boot; no dotenv loader.
import { EventBus } from "./core/bus.js";
import { SessionManager } from "./core/session-manager.js";
import { JarvisCore } from "./core/jarvis.js";
import { SessionDispatcher } from "./core/session-dispatcher.js";
import { HudState } from "./core/hud-state.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { CapabilityExecutor } from "./capabilities/executor.js";
import { CapabilityLoaderPiece } from "./capabilities/loader.js";
import { McpManager } from "./mcp/manager.js";
import { ChatPiece } from "./input/chat-piece.js";
import { GrpcPiece } from "./input/grpc-piece.js";
import { HttpServer } from "./server.js";
import { PieceManager } from "./core/piece-manager.js";
import { PluginManager } from "./core/plugin-manager.js";
import { CronPiece } from "./core/cron-piece.js";
import type { Piece } from "./core/piece.js";
import { log } from "./logger/index.js";
import { clearAllConversations } from "./core/conversation-store.js";
import { launchHud } from "./transport/hud/electron.js";
import { config, setModel, getValidModels, getCurrentProvider, getProviderForModel } from "./config/index.js";
import { ProviderRouter } from "./ai/provider.js";
import { createAnthropicProvider } from "./ai/anthropic/provider.js";
import { createOpenAIProvider } from "./ai/openai/provider.js";
import { createDeepSeekProvider } from "./ai/deepseek/provider.js";
import { AnthropicSessionFactory } from "./ai/anthropic/factory.js";
import { abortRegistry } from "./capabilities/abort-registry.js";
import { bootstrap } from "./core/bootstrap.js";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { registerSessionInspectorTools } from "./ai/anthropic/session-inspector.js";
import { HudCoreNodePiece } from "./core/hud-core-node.js";
import { DiffViewerPiece } from "./pieces/diff-viewer.js";
import { ChoicePromptPiece } from "./pieces/choice-prompt.js";
import { ModelRouterPiece } from "./pieces/model-router.js";
import { TurnInspectorPiece } from "./pieces/turn-inspector.js";
import { DelegateTaskPiece } from "./pieces/delegate-task.js";
import { load as loadSettingsForSlash } from "./core/settings.js";
import { ensureUiBuildIntegrity } from "./server.js";
import { installDeathWatch } from "./core/death-watch.js";
import type { IncomingMessage } from "node:http";

/** Read the full request body and JSON-parse it. Rejects on malformed JSON. */
function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Install death-watch as the very first thing — before any other module work
// so we catch bootstrap failures (UI build errors, missing config, plugin load
// crashes). Snapshot/graceful-shutdown are wired later once runtime refs exist
// (see installDeathWatch() at the bottom of main()).
installDeathWatch();

async function main() {
  // ─── Bootstrap ~/.jarvis from shipped source ─────────────────────────────
  // Runs on every boot (idempotent). Populates settings.json, jarvis-system.md,
  // mcp.json template, settings.user.json template, and core directories.
  // Uses node:fs only — no shell, no process.env.HOME, no process.cwd().
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // sourceRoot is the app/ directory (two levels up from src/core/)
  const sourceRoot = pathJoin(__dirname, "..", "..");
  const jarvisHome = process.env.JARVIS_HOME ?? pathJoin(homedir(), ".jarvis");
  await bootstrap({ jarvisHome, sourceRoot });

  // Verify UI build integrity before anything else — if assets are stale, rebuild
  ensureUiBuildIntegrity();

  const bus = new EventBus();
  // Shared per-tool abort registry — single ai.stream "aborted" subscription
  // for ALL tool executors (filesystem capabilities, MCP calls). Keyed by
  // (sessionId, toolUseId) so ESC aborts every parallel tool of the session.
  abortRegistry.wire(bus);
  const capabilityRegistry = new CapabilityRegistry();

  const chatPiece = new ChatPiece();
  chatPiece.setRegistry(capabilityRegistry);
  // sessions wired later after SessionManager is created
  const jarvisCore = new JarvisCore();

  // SessionManager is created here (with null factory placeholder; factory is
  // wired after provider activation below) so the ModelRouter piece — which
  // needs a passive reference to look up sessions — can sit at the head of
  // the pieces array and subscribe to ai.request BEFORE JarvisCore.
  const sessionsForRouter = new SessionManager(null as any);
  sessionsForRouter.setBus(bus);

  // Keep a typed handle on the router so /model and other internals can
  // mutate sticky state without going through the bus.
  const modelRouter = new ModelRouterPiece(sessionsForRouter, chatPiece);

  const pieces: Piece[] = [
    // ModelRouter MUST come first: bus delivers handlers in subscription
    // order, so this piece routes (sets per-call model override on the
    // session) BEFORE JarvisCore reads getModel() in its own handler.
    modelRouter,
    jarvisCore,
    new CapabilityExecutor(capabilityRegistry),
    new CapabilityLoaderPiece(capabilityRegistry),
    new McpManager(capabilityRegistry),
    new GrpcPiece(capabilityRegistry),
    new TurnInspectorPiece(),
    chatPiece,
  ];

  // Provider router — manages active AI provider + metrics HUD
  // Find the plugin manager piece lazily (it's in the pieces array)
  const getPluginManager = () => pieces.find(p => p.id === "plugin-manager") as any;
  const providerRouter = new ProviderRouter({
    getTools: () => capabilityRegistry.getDefinitions(),
    getCoreContext: () => pieces.filter(p => p.id !== "plugin-manager" && p.systemContext).map(p => p.systemContext!()),
    getPluginInstructions: () => {
      const pm = getPluginManager();
      return pm?.systemContext ? [pm.systemContext()] : [];
    },
    getPluginContext: (sessionId?: string) => {
      const pm = getPluginManager();
      return pm?.pluginPieceContext ? [pm.pluginPieceContext(sessionId)] : [];
    },
    getInstructions: () => jarvisCore.getJarvisMd(),  // returns { content, filename }
  });
  providerRouter.registerProviderFactory("anthropic", createAnthropicProvider);
  providerRouter.registerProviderFactory("openai", createOpenAIProvider);
  providerRouter.registerProviderFactory("deepseek", createDeepSeekProvider);

  // SessionManager — factory set after provider activation.
  // We reuse `sessionsForRouter` created earlier (router holds a passive ref).
  const sessions = sessionsForRouter;
  jarvisCore.setSessions(sessions);
  chatPiece.setSessions(sessions);

  // SessionDispatcher — instantiated here but started AFTER pieceManager.startAll()
  // so that plugins (e.g. actor-runner) subscribe to ai.request BEFORE the dispatcher.
  // Bus delivers to subscribers in registration order — actor-runner must run first
  // to create the session before the dispatcher calls sendAndStream.
  const dispatcher = new SessionDispatcher(sessions);
  jarvisCore.setDispatcher(dispatcher);

  // Tell ChatPiece which sessions JarvisCore owns. For owned sessions
  // (main, grpc-*, etc.), JarvisCore emits prompt_dispatched and ChatPiece
  // stays out of the timeline-mirroring business. For non-owned sessions
  // (plugin-owned sessionIds, e.g. a session-orchestrator plugin),
  // ChatPiece must mirror user-typed input as type:"user" SSE immediately
  // so the panel renders it.
  chatPiece.setOwnedSessionMatcher((sid) => jarvisCore.isSessionOwned(sid));

  // clear_session — clears only the calling session (memory + disk), archives first
  capabilityRegistry.register({
    name: "clear_session",
    category: "system",
    description: "Archive and clear saved conversation history. Sessions are rolled to sessions/archive/ with timestamps before clearing. Next restart will start fresh with no memory of previous messages.",
    input_schema: { type: "object", properties: {} },
    handler: async (input) => {
      const sessionId = String(input.__sessionId ?? "main");
      log.info({ sessionId }, "clear_session: clearing");
      jarvisCore.abortSession(sessionId);
      sessions.archiveSaved(sessionId);
      sessions.close(sessionId);
      chatPiece.broadcastEvent(sessionId, { type: "session_cleared", session: sessionId });
      return { ok: true, message: `Session '${sessionId}' archived and cleared. Next message will start fresh.` };
    },
  });

  // Model management tools — now provider-aware
  capabilityRegistry.register({
    name: "model_set",
    category: "model",
    description: `Switch the AI model. Examples: claude-sonnet-4-6, claude-opus-4-8, claude-opus-4-7, gpt-4o, gpt-4o-mini, o3. Anthropic models use Claude, others use OpenAI-compatible API.`,
    input_schema: {
      type: "object",
      properties: { model: { type: "string", description: "Model ID to switch to" } },
      required: ["model"],
    },
    handler: async (input) => {
      const result = setModel(input.model as string);
      if (result.providerChanged) {
        await providerRouter.switchTo(result.provider, bus);
        sessions.updateFactory(providerRouter.getFactory());
        sessions.setProvider(result.provider);
        jarvisCore.abortSession("main");
      }
      return result.message;
    },
  });
  capabilityRegistry.register({
    name: "model_get",
    category: "model",
    description: "Get the current AI model and provider being used.",
    input_schema: { type: "object", properties: {} },
    handler: async () => ({
      model: config.model,
      provider: getCurrentProvider(),
      available: getValidModels(),
    }),
  });

  // Runtime eval — full access to JARVIS internals
  capabilityRegistry.register({
    name: "jarvis_eval",
    description: "Execute JavaScript code inside the running JARVIS process. Has access to: bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece, and all runtime objects. Use for introspection, debugging, testing, or calling any internal function. Returns the expression result (or last statement). Async code supported.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to execute in the JARVIS runtime context" },
      },
      required: ["code"],
    },
    handler: async (input) => {
      const code = input.code as string;
      const context = { bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece, log, setModel, getCurrentProvider, getValidModels };
      try {
        const keys = Object.keys(context);
        const values = Object.values(context);
        const asyncFn = new Function(...keys, `return (async () => { ${code} })()`);
        const result = await asyncFn(...values);
        return { result: result !== undefined ? String(result) : "undefined" };
      } catch (err: any) {
        return { error: err.message, stack: err.stack };
      }
    },
  });

  /**
   * Drives a session's forceCompact() stream to completion, forwarding
   * compaction events to the bus (chat banner + metrics) and saving the
   * compacted session. Shared by the /compact slash command and the HTTP
   * compact endpoint — previously two verbatim copies of this loop (review
   * finding D1, mission jarvis-fix F2.5). Caller-specific guards (session
   * exists, provider support, idle check) and result delivery (return
   * message vs broadcastEvent) stay at the call sites.
   */
  const runCompaction = async (sessionId: string): Promise<void> => {
    const managed = sessions.get(sessionId);
    const stream = managed.session.forceCompact!();
    for await (const event of stream) {
      if (event.type === "compaction_start" && event.compactionStart) {
        bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "compaction_start",
          compactionStart: event.compactionStart,
        } as any);
      } else if (event.type === "compaction" && event.compaction) {
        // ai.stream → chat timeline banner; system.event → metrics HUD
        bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "compaction",
          compaction: event.compaction,
        } as any);
        bus.publish({
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
        });
      } else if (event.type === "compaction_failed" && event.compactionFailed) {
        // Forced compaction failed — history preserved (doCompact failure
        // semantics). Forward to ai.stream so the chat banner resolves, and
        // to system.event for metrics/forensics. This path matters: the
        // 2026-06-10 incident came through THIS loop (POST /chat/compact).
        bus.publish({
          channel: "ai.stream",
          source: "jarvis-core",
          target: sessionId,
          event: "compaction_failed",
          compactionFailed: event.compactionFailed,
        } as any);
        bus.publish({
          channel: "system.event",
          source: "jarvis-core",
          event: "compaction_failed",
          data: {
            sessionId,
            engine: event.compactionFailed.engine,
            tokensBefore: event.compactionFailed.tokensBefore,
            reason: event.compactionFailed.reason,
          },
        });
      }
    }
    // Persist the compacted history (skips ephemeral sessions)
    sessions.save(sessionId);
  };

  // /compact slash command — force context compaction (Engine B) on the CALLING session.
  // Handler receives ctx.sessionId from ChatPiece, so it acts on whichever session
  // typed the slash (main or any plugin-owned sessionId) instead of hardcoding "main".
  capabilityRegistry.registerSlashCommand({
    name: "compact",
    description: "Force context compaction — summarizes conversation to free tokens",
    hint: "Compacts the current session context (Engine B)",
    source: "system",
    handler: async (_args, ctx) => {
      const sessionId = ctx?.sessionId ?? "main";

      if (!sessions.has(sessionId)) {
        return { message: `⚠️ Session not found: ${sessionId}` };
      }

      const managed = sessions.get(sessionId);
      if (!managed.session.forceCompact) {
        return { message: "⚠️ Current provider does not support forced compaction." };
      }
      if (sessions.getState(sessionId) !== "idle") {
        return { message: "⚠️ Session is busy — wait for it to finish before compacting." };
      }

      chatPiece.broadcastEvent(sessionId, { type: "system", text: "⏳ Compacting context…", session: sessionId });

      await runCompaction(sessionId);

      return { message: `✅ Context compacted successfully (${sessionId}).` };
    },
  });

  // /model — change sticky model for the calling session WITHOUT sending a prompt.
  //   /model               → show current sticky + cost projection
  //   /model opus          → switch to Opus, banner with reconstruction cost
  //   /model claude-haiku-4-5  → switch to a specific model id
  capabilityRegistry.registerSlashCommand({
    name: "model",
    description: "Show or change the sticky model for the current session",
    hint: "/model [opus|sonnet|haiku|<model-id>]",
    source: "system",
    handler: async (args, ctx) => {
      const sessionId = ctx?.sessionId ?? "main";
      const arg = (args ?? "").trim();
      const route = modelRouter.getRoute(sessionId);

      if (!arg) {
        const sticky = route?.sticky ?? "(default)";
        const switches = route?.switchCount ?? 0;
        return {
          message: `🔧 Sticky model for ${sessionId}: \`${sticky}\` (${switches} switches this session)\nUsage: /model opus|sonnet|haiku|<model-id>`,
        };
      }

      // Resolve alias or accept full model id
      const cfg = (loadSettingsForSlash() as any)?.models?.routing ?? {};
      const aliases = { opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5", ...(cfg.aliases ?? {}) };
      const target = aliases[arg.toLowerCase()] ?? arg;

      // Same-provider switches are SESSION-SCOPED: only the sticky route for
      // this session changes — config.model / settings.model stay untouched so
      // other sessions and the new-session default keep their own models.
      // Cross-provider needs the global switch (factory swap is process-wide).
      // Bug fixed 2026-06-10: setModel() ran unconditionally here, so every
      // /model (incl. the UI picker) leaked the choice globally — new sessions
      // and unpinned factory sessions silently inherited it.
      const targetProvider = getProviderForModel(target);
      if (targetProvider !== getCurrentProvider()) {
        const switchResult = setModel(target);
        await providerRouter.switchTo(switchResult.provider, bus);
        sessions.updateFactory(providerRouter.getFactory());
        sessions.setProvider(switchResult.provider);
        jarvisCore.abortSession(sessionId);
      }

      const newRoute = modelRouter.setStickyModel(sessionId, target, "slash:/model");
      return {
        message: `🔧 Sticky model for ${sessionId}: \`${newRoute.sticky}\` (was \`${route?.sticky ?? "(default)"}\`)`,
      };
    },
  });

  // Core Node graph visualization
  pieces.push(new HudCoreNodePiece());

  // Diff Viewer — file visualization, diff, and comparison in HUD
  pieces.push(new DiffViewerPiece(capabilityRegistry));

  // Choice Prompt — inline chat choice cards (radio / checkbox / other)
  pieces.push(new ChoicePromptPiece(capabilityRegistry, chatPiece));

  // Cron scheduler
  const cronPiece = new CronPiece(capabilityRegistry);
  pieces.push(cronPiece);

  // Delegate-read-task — ephemeral worker for cheap exploration.
  // Uses the active provider's factory and the global capability registry.
  const delegateTaskPiece = new DelegateTaskPiece({
    getFactory: () => providerRouter.getFactory(),
    getFactoryForModel: (model) => providerRouter.getFactoryForModel(model),
    registry: capabilityRegistry,
    sessions,
  });
  pieces.push(delegateTaskPiece);

  // Wire delegate into cron so cron jobs can run in delegate mode directly.
  cronPiece.setDelegatePiece(delegateTaskPiece);
  // Fire-time target validation (phantom prevention G2): cron checks the
  // SessionManager before publishing into a persisted target.
  cronPiece.setSessionResolver(sessions);

  // Plugin manager
  const pluginManager = new PluginManager(capabilityRegistry);
  pieces.push(pluginManager);

  const hudState = new HudState(bus);

  // ─── HUD truth (F6) ───
  // Reactor pull-direct: the orb reads JarvisCore.globalState — the source
  // of truth — instead of HudState's panel copy (which can lag/drop).
  hudState.setReactorSource(() => jarvisCore.getReactorState());
  // Reconciliation: jarvis-core registers as the first producer; lost adds
  // and content drift self-heal every ~10s. Other pieces opt in as needed.
  hudState.registerProducer("jarvis-core", () => jarvisCore.getHudSnapshot());
  hudState.startReconciliation();

  // Activate initial provider AFTER HudState exists (so metrics HUD registers)
  await providerRouter.switchTo(getCurrentProvider(), bus);
  sessions.updateFactory(providerRouter.getFactory());
  sessions.setProvider(getCurrentProvider());
  sessions.setProviderRouter(providerRouter);
  sessions.startAutoSave();
  pluginManager.setFactory(providerRouter.getFactory());
  pluginManager.setSessionManager(sessions);

  // Register session inspector tools (Anthropic-only — exposes session, history, system prompt, tools)
  const activeFactory = providerRouter.getFactory();
  if (activeFactory instanceof AnthropicSessionFactory) {
    registerSessionInspectorTools(capabilityRegistry, sessions, activeFactory);
  }

  const pieceManager = new PieceManager(pieces, bus, capabilityRegistry);
  pluginManager.setPieceManager(pieceManager);

  const server = new HttpServer(
    50052,
    chatPiece,
    () => hudState.getState(),
    (sessionId: string) => jarvisCore.abortSession(sessionId),
    () => capabilityRegistry.getSlashCommands(),
  );
  server.setHudStreamHandler((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    // Send full snapshot first so client has complete state
    res.write(`data: ${JSON.stringify({ action: "snapshot", state: hudState.getState() })}\n\n`);
    hudState.addStreamClient(res);
    _req.on("close", () => hudState.removeStreamClient(res));
  });
  server.setOnHudRemove((pieceId: string) => {
    bus.publish({ channel: "hud.update", source: "server", action: "remove", pieceId });
  });
  server.setOnHudShow((pieceId: string) => {
    bus.publish({ channel: "hud.update", source: "server", action: "update", pieceId, data: {}, visible: true } as any);
  });
  server.setOnHudHide((pieceId: string) => {
    bus.publish({ channel: "hud.update", source: "server", action: "update", pieceId, data: {}, visible: false } as any);
  });
  server.setOnClearSession((sessionId: string) => {
    log.info({ sessionId }, "ClearSession: clearing conversation for session");
    jarvisCore.abortSession(sessionId);
    sessions.close(sessionId);
    sessions.clearSaved(sessionId);
    // Tell only the SSE pool of this session to clear its timeline
    chatPiece.broadcastEvent(sessionId, { type: "session_cleared", session: sessionId });
  });
  server.setOnCompact(async (sessionId: string) => {
    if (!sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const managed = sessions.get(sessionId);
    if (!managed.session.forceCompact) {
      throw new Error("Current provider does not support forced compaction.");
    }

    chatPiece.broadcastEvent(sessionId, { type: "system", text: "⏳ Compacting context…", session: sessionId });

    await runCompaction(sessionId);

    chatPiece.broadcastEvent(sessionId, { type: "system", text: "✅ Context compacted.", session: sessionId });
  });
  pluginManager.setHttpServer(server);
  pluginManager.setChatPiece(chatPiece);

  // ─── Provider-scoped HUD scope routes ───
  // POST /providers/anthropic/scope { scope: "ALL" | "<sessionId>" }
  //   → switches which session the Anthropic Usage HUD renders.
  // GET  /providers/anthropic/scope
  //   → returns current scope + available sessionIds (for UI dropdown).
  server.registerRoute("POST", "/providers/anthropic/scope", async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const scope = typeof body?.scope === "string" ? body.scope : null;
      if (!scope) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing 'scope' string in body" }));
        return;
      }
      const active = providerRouter.getActiveProvider();
      const hud = active?.metricsPiece as { setScope?: (s: string) => void; getScope?: () => string; getAvailableScopes?: () => string[] } | undefined;
      if (!hud?.setScope) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Active provider metrics HUD does not support scope switching" }));
        return;
      }
      hud.setScope(scope);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, scope: hud.getScope?.(), available: hud.getAvailableScopes?.() ?? [] }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
    }
  });

  server.registerRoute("GET", "/providers/anthropic/scope", async (_req, res) => {
    const active = providerRouter.getActiveProvider();
    const hud = active?.metricsPiece as { getScope?: () => string; getAvailableScopes?: () => string[] } | undefined;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      provider: active?.name ?? null,
      scope: hud?.getScope?.() ?? null,
      available: hud?.getAvailableScopes?.() ?? [],
    }));
  });

  await pieceManager.startAll();

  // Start dispatcher AFTER all pieces/plugins have subscribed — ensures actor-runner
  // (and any other session-provisioning plugin) registers its ai.request subscriber
  // first, so sessions are created before the dispatcher processes the same message.
  dispatcher.start(bus);

  console.log("JARVIS starting...");
  console.log(`HUD  ${server.url}\n`);
  // Skip Electron HUD when running in headless/test mode (e.g. setup.sh validation)
  if (process.env.JARVIS_NO_HUD !== "1") {
    launchHud(server.url);
  }
  jarvisCore.ready();
  console.log("JARVIS online\n");

  // Flush any piece/plugin startup failures to the main session now that the AI is online.
  pluginManager.notifyLoadFailures();
  pieceManager.notifyStartupFailures();
  // ─── Graceful shutdown — shared by SIGINT, SIGTERM, SIGHUP ─────────
  // Pulled into a named function so death-watch can reuse it for SIGTERM/SIGHUP.
  let shuttingDown = false;
  const gracefulShutdown = async (reason: string) => {
    if (shuttingDown) return; // idempotent — multiple signals during shutdown
    shuttingDown = true;
    log.info({ reason }, "Shutting down...");
    try {
      hudState.stopReconciliation();
      sessions.stopAutoSave();
      // Stop pieces FIRST — pieces that own ephemeral sessions (e.g. session-orchestrator
      // plugin) get a chance to clean them up before we persist.
      await pieceManager.stopAll();
      // Now save remaining sessions (ephemeral ones already cleaned by their owner)
      sessions.saveAll();
      const activeProvider = providerRouter.getActiveProvider();
      if (activeProvider) await activeProvider.metricsPiece.stop();
      server.stop();
    } catch (err) {
      log.error({ err, reason }, "error during graceful shutdown");
    }
  };

  // Now that runtime refs exist, re-install death-watch with the rich snapshot
  // + graceful-shutdown wiring. installDeathWatch is idempotent for the handlers
  // it already attached at module load — this call only enriches the closure
  // for memory pressure + signals.
  installDeathWatch({
    snapshot: () => {
      try {
        const ids = sessions.listActive();
        return {
          model: config.model,
          provider: getCurrentProvider(),
          sessionCount: ids.length,
          sessions: ids.map((id) => {
            const managed: any = sessions.peek(id);
            return {
              id,
              state: sessions.getState(id),
              ephemeral: sessions.isEphemeral(id),
              messages: managed?.session?.messageCount?.() ?? managed?.messages?.length ?? undefined,
            };
          }),
          activePieces: pieces.map((p) => p.id),
        };
      } catch (err: any) {
        return { snapshotError: String(err?.message ?? err) };
      }
    },
    onGracefulShutdown: gracefulShutdown,
    onMemoryCritical: ({ rssMb }) => {
      // Surface to HUD via the bus so the user sees a warning before macOS kills us.
      try {
        bus.publish({
          channel: "system.event",
          source: "death-watch",
          event: "memory-critical",
          data: { rssMb: Math.round(rssMb) },
        } as any);
      } catch { /* best effort */ }
    },
  });

  process.on("SIGINT", async () => {
    await gracefulShutdown("SIGINT");
    process.exit(0);
  });
}

main().catch((err) => { log.fatal({ err }, "Startup failed"); process.exit(1); });
