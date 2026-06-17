// src/pieces/model-router.ts
//
// ModelRouter v2 — sticky per session + utility isolation + auto-degrade.
//
// Design (derived from observing Claude Code's traffic):
//   - Each model has its OWN cache pool. Switching invalidates 100% of the
//     cache in the previous model. Penalty observed: ~$3.32 for a single
//     Sonnet→Opus switch on a 192k token context.
//   - Therefore: sticky-by-default. Don't switch unless user explicitly asks
//     OR the math obviously favors switching.
//
// Decision priority (top wins):
//   1. data.utility=true (caller-declared)  → utility model (Haiku), sticky untouched.
//   2. Prefix [opus]/[sonnet]/[haiku]        → updates sticky from now on,
//                                              emits banner with reconstruction cost.
//   3. Auto-degrade (large context, opt-in)  → updates sticky, emits banner.
//   4. Sticky model                          → no change, no banner, no cost.
//
// State:
//   Map<sessionId, SessionRoute> — independent sticky per session (main, actor-*, grpc-*).
//   Persisted via conversation-store hooks (saveRouteState/loadRouteState).
//
// Bus events emitted:
//   - system.event "router.decision" — every routed call
//   - system.event "router.switch"   — only on actual model change with cost estimate
//   - chat.anchor "set"              — banner UI in the chat panel

import type { Piece } from "../core/piece.js";
import type { EventBus } from "../core/bus.js";
import type { AIRequestMessage } from "../core/types.js";
import type { SessionManager } from "../core/session-manager.js";
import type { ChatPiece } from "../input/chat-piece.js";
import { log } from "../logger/index.js";
import { load as loadSettings } from "../core/settings.js";
import { loadRouteState, saveRouteState } from "../core/conversation-store.js";
import { getProviderForModel, getCurrentProvider } from "../config/index.js";

// Anthropic public list price per 1M tokens.
// Used ONLY for cost estimates in banners — actual billing is whatever
// LiteLLM/Anthropic charges. Ratios are correct for relative comparison.
const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-fable-5":              { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 1.00 },
  "claude-opus-4-8":             { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  "claude-opus-4-7":             { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-6":             { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-opus-4-5":             { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-sonnet-4-6":           { input:  3.00, output: 15.00, cacheWrite:  3.75, cacheRead: 0.30 },
  "claude-sonnet-4-5":           { input:  3.00, output: 15.00, cacheWrite:  3.75, cacheRead: 0.30 },
  "claude-sonnet-4-5-20250929":  { input:  3.00, output: 15.00, cacheWrite:  3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":            { input:  1.00, output:  5.00, cacheWrite:  1.25, cacheRead: 0.10 },
  "claude-haiku-4-5-20251001":   { input:  1.00, output:  5.00, cacheWrite:  1.25, cacheRead: 0.10 },
};

function priceOf(model: string) {
  return PRICING[model] ?? PRICING["claude-opus-4-8"]; // worst-case fallback
}

interface RoutingConfig {
  enabled: boolean;
  default: string;
  heavy: string;
  light: string;
  utility: string;
  aliases: Record<string, string>;
  auto: {
    degradeOnLargeContext: {
      enabled: boolean;
      threshold: number;
      from: string;
      to: string;
    };
  };
}

// Tier structure (2026-06, post Fable 5 launch):
//   heavy   = claude-fable-5   — Mythos-class, max capability, $10/$50 per MTok
//   default = claude-opus-4-8  — complex reasoning, agentic coding, $5/$25 per MTok
//   light   = claude-sonnet-4-6 — speed + intelligence balance, $3/$15 per MTok
//   utility = claude-haiku-4-5  — fastest, cheapest, for subtasks, $1/$5 per MTok
const DEFAULTS: RoutingConfig = {
  enabled: true,
  default: "claude-opus-4-8",
  heavy:   "claude-fable-5",
  light:   "claude-sonnet-4-6",
  utility: "claude-haiku-4-5",
  aliases: {
    fable:  "claude-fable-5",
    opus:   "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku:  "claude-haiku-4-5",
  },
  auto: {
    degradeOnLargeContext: {
      enabled: true,
      threshold: 150_000,
      from: "claude-opus-4-8",
      to:   "claude-sonnet-4-6",
    },
  },
};

function loadRoutingConfig(): RoutingConfig {
  const raw = loadSettings() as any;
  const r = raw?.models?.routing ?? {};
  // config.model (top-level "model" in settings) is the user's preferred model.
  // Use it as the default for routing unless routing.default is explicitly set.
  const configModel = raw?.model ?? null;
  return {
    enabled: r.enabled !== false,
    default: r.default ?? configModel ?? DEFAULTS.default,
    heavy:   r.heavy   ?? DEFAULTS.heavy,
    light:   r.light   ?? DEFAULTS.light,
    utility: r.utility ?? DEFAULTS.utility,
    aliases: { ...DEFAULTS.aliases, ...(r.aliases ?? {}) },
    auto: {
      degradeOnLargeContext: {
        enabled:   r.auto?.degradeOnLargeContext?.enabled !== false,
        threshold: r.auto?.degradeOnLargeContext?.threshold ?? DEFAULTS.auto.degradeOnLargeContext.threshold,
        from:      r.auto?.degradeOnLargeContext?.from ?? DEFAULTS.auto.degradeOnLargeContext.from,
        to:        r.auto?.degradeOnLargeContext?.to ?? DEFAULTS.auto.degradeOnLargeContext.to,
      },
    },
  };
}

/** Per-session routing state. Persists across restarts via conversation-store. */
export interface SessionRoute {
  sticky: string;
  switchCount: number;
  lastSwitchAt?: number;
  lastReason?: string;
  /** True when the user explicitly chose this model (prefix or slash command).
   *  Auto-degrade is suppressed while this flag is set. */
  userForced?: boolean;
}

interface Decision {
  model: string;
  cleanText: string;
  reason: string;
  /** Whether this decision changed the session's sticky model. */
  stickyChanged: boolean;
  /** When sticky changed, estimated USD cost of cache reconstruction. */
  switchCostUsd?: number;
  ctxTokens?: number;
}

/** Strip [tag] prefix from start. Case-insensitive. */
function parsePrefix(text: string): { tag?: string; rest: string } {
  const m = text.match(/^\s*\[([a-z][a-z0-9_-]{0,32})\]\s*/i);
  if (!m) return { rest: text };
  return { tag: m[1].toLowerCase(), rest: text.slice(m[0].length) };
}

export class ModelRouterPiece implements Piece {
  readonly id = "model-router";
  readonly name = "ModelRouter";

  private bus!: EventBus;
  private sessions: SessionManager;
  private chatPiece?: ChatPiece;
  /** sessionId → route. In memory. Loaded lazily on first touch (per session). */
  private routes = new Map<string, SessionRoute>();
  /** Sessions whose route has been hydrated from disk. Avoids repeated loads. */
  private hydrated = new Set<string>();

  /** Marker key on AIRequestMessage.data after we've routed it. Prevents loops. */
  private static ROUTED_FLAG = "__model_routed__";

  /**
   * @param sessions  passive lookup of sessions for ctx estimation + override apply
   * @param chatPiece optional — used to surface switch banners in the timeline.
   *                  If absent, banners are logged only.
   */
  constructor(sessions: SessionManager, chatPiece?: ChatPiece) {
    this.sessions = sessions;
    this.chatPiece = chatPiece;
  }

  /**
   * Pending overrides for sessions that don't exist yet at routing time.
   * Drained by the SessionManager.onSessionCreated hook the moment a new
   * session lands. Required because the bus subscriber for ai.request runs
   * BEFORE JarvisCore creates the session — peek() returns undefined on the
   * first turn of every session.
   */
  private pendingOverrides = new Map<string, string>();

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    bus.subscribe<AIRequestMessage>("ai.request", (msg) => this.onRequest(msg));

    // Session lifecycle eviction (F3.14): sticky routes and pending overrides
    // for closed sessions leaked forever (review 2026-06-10). Dropping them
    // also prevents persisting dead routes to disk on stop().
    bus.subscribe("system.event", (msg: any) => {
      if (msg.event !== "session.closed") return;
      const sessionId = msg.data?.sessionId as string | undefined;
      if (!sessionId) return;
      this.routes.delete(sessionId);
      this.pendingOverrides.delete(sessionId);
    });

    // Hook: when a brand-new session is created by SessionManager, apply any
    // override we computed earlier but couldn't dispatch (sticky from disk,
    // prefix from the very first message, etc).
    if ((this.sessions as any).onSessionCreated) {
      (this.sessions as any).onSessionCreated((sessionId: string, managed: any) => {
        const pending = this.pendingOverrides.get(sessionId);
        if (!pending) return;
        this.pendingOverrides.delete(sessionId);
        const session = managed?.session;
        // Use sticky here too — see comment in onRequest for rationale.
        if (session?.setStickyModelOverride) {
          session.setStickyModelOverride(pending);
          log.info(
            { sessionId, model: pending },
            "ModelRouter: pending sticky override applied on session creation",
          );
        } else {
          log.warn(
            { sessionId, model: pending },
            "ModelRouter: pending override discarded — session has no setStickyModelOverride",
          );
        }
      });
    }

    log.info("ModelRouter v2: started (sticky + utility + auto-degrade)");
  }

  async stop(): Promise<void> {
    // Persist all touched routes before shutting down.
    for (const [sessionId, route] of this.routes) {
      try {
        saveRouteState(sessionId, route);
      } catch (err) {
        log.warn({ sessionId, err }, "ModelRouter: failed to save route on stop");
      }
    }
    log.info("ModelRouter v2: stopped");
  }

  /** Public: get current route for a session (read-only). For HUD/inspect. */
  getRoute(sessionId: string): SessionRoute | undefined {
    return this.routes.get(sessionId);
  }

  /** Public: get all known routes. */
  getAllRoutes(): Record<string, SessionRoute> {
    return Object.fromEntries(this.routes);
  }

  /**
   * Public: change the sticky model for a session WITHOUT going through the bus.
   * Used by the /model slash command.
   * Emits the same banner + system event as a prefix-driven change.
   * Returns the route after the change (for the slash command to surface).
   */
  setStickyModel(sessionId: string, model: string, reason = "slash-command"): SessionRoute {
    const route = this.ensureRoute(sessionId, loadRoutingConfig());
    if (route.sticky === model) {
      return route;
    }
    const ctxTokens = this.estimateCtxTokens(sessionId);
    const cost = ctxTokens * priceOf(model).cacheWrite / 1_000_000;
    const prev = route.sticky;
    route.sticky = model;
    route.userForced = true; // slash command = explicit user choice
    route.switchCount++;
    route.lastSwitchAt = Date.now();
    route.lastReason = reason;
    saveRouteState(sessionId, route);

    this.emitSwitch(sessionId, prev, model, ctxTokens, cost, reason);
    this.emitBanner(sessionId, prev, model, ctxTokens, cost, reason);
    return route;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /** Hydrate route state for a session from disk on first access. */
  private ensureRoute(sessionId: string, cfg: RoutingConfig): SessionRoute {
    if (!this.hydrated.has(sessionId)) {
      this.hydrated.add(sessionId);
      const persisted = loadRouteState(sessionId);
      if (persisted) {
        this.routes.set(sessionId, persisted);
      }
    }
    let r = this.routes.get(sessionId);
    if (!r) {
      // If the session already exists with a sticky model override (set by a piece
      // before the first ai.request, e.g. slack-hook pinning Haiku), seed the
      // route from that override instead of cfg.default so we don't stomp it.
      const existingSticky = (this.sessions.peek(sessionId) as any)?.session?.stickyModelOverride;
      r = { sticky: existingSticky ?? cfg.default, switchCount: 0 };
      this.routes.set(sessionId, r);
    }
    return r;
  }

  /**
   * Estimate context tokens for cost calculation.
   * Uses session.measureContext() if available (Anthropic), else falls back
   * to a rough char/4 heuristic. Synchronous — no count_tokens API call here.
   */
  private estimateCtxTokens(sessionId: string): number {
    const managed = this.sessions.peek(sessionId);
    const session = managed?.session as any;
    if (session?.measureContext) {
      try {
        const ctx = session.measureContext();
        return ctx.totalTokensEst ?? 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  /**
   * Main entry. For every ai.request:
   *   - decide model (utility / prefix / auto-degrade / sticky)
   *   - apply override on session
   *   - clean message text if prefix was stripped
   *   - emit decision/switch events + banner if applicable
   */
  private onRequest(msg: AIRequestMessage): void {
    const cfg = loadRoutingConfig();
    if (!cfg.enabled) return;

    if (msg.data && (msg.data as any)[ModelRouterPiece.ROUTED_FLAG]) return;

    const target = msg.target;
    if (!target) return;

    const decision = this.decide(target, msg, cfg);

    // Apply override on the target session — or queue it if the session
    // doesn't exist yet (first turn). The onSessionCreated hook will drain.
    //
    // We use STICKY (not next-only) override here because the actor-runner
    // plugin and other consumers may bypass the bus on continuation turns
    // (calling session.sendAndStream() / session.continueAndStream() directly).
    // A "next-only" override would be consumed by turn 1 and lost on turn 2.
    // Sticky persists until the next routing decision changes it — which is
    // the semantics we actually want: keep the model decision until the user
    // (or auto-degrade) explicitly switches.
    const managed = this.sessions.peek(target);
    const session = managed?.session as any;
    if (session?.setStickyModelOverride) {
      session.setStickyModelOverride(decision.model);
      log.info(
        { target, model: decision.model, reason: decision.reason },
        "ModelRouter: sticky override applied",
      );
    } else if (!managed) {
      // Session doesn't exist yet — defer to onSessionCreated hook.
      this.pendingOverrides.set(target, decision.model);
      log.info(
        { target, model: decision.model, reason: decision.reason },
        "ModelRouter: override queued (session not yet created)",
      );
    } else {
      log.debug(
        { target, hasSession: !!session, hasOverride: !!session?.setStickyModelOverride },
        "ModelRouter: session has no sticky override support, skipping",
      );
    }

    // Emit telemetry.
    this.bus.publish({
      channel: "system.event",
      source: this.id,
      event: "router.decision",
      data: {
        sessionId: target,
        model: decision.model,
        reason: decision.reason,
        stickyChanged: decision.stickyChanged,
        ctxTokens: decision.ctxTokens,
      },
    });

    // Strip prefix from text if needed.
    if (decision.cleanText !== msg.text) {
      msg.text = decision.cleanText;
      (msg as any).data = { ...(msg.data ?? {}), [ModelRouterPiece.ROUTED_FLAG]: true };
    }
  }

  /**
   * Pure routing decision. Side effects (sticky update, save) happen here too,
   * but emission of bus events is done in onRequest after we have the result.
   */
  private decide(sessionId: string, msg: AIRequestMessage, cfg: RoutingConfig): Decision {
    const route = this.ensureRoute(sessionId, cfg);

    // ── 1. Utility flag ─────────────────────────────────────────────────
    if (msg.data?.utility === true) {
      return {
        model: cfg.utility,
        cleanText: msg.text ?? "",
        reason: "utility:flag",
        stickyChanged: false,
      };
    }

    const text = msg.text ?? "";

    // ── 2. Explicit prefix [opus]/[sonnet]/[haiku] ──────────────────────
    const { tag, rest } = parsePrefix(text);
    if (tag && cfg.aliases[tag]) {
      const newModel = cfg.aliases[tag];
      if (newModel === route.sticky) {
        // Same model — no switch, just a redundant prefix. Strip + log.
        return {
          model: newModel,
          cleanText: rest,
          reason: `prefix:${tag} (no-change)`,
          stickyChanged: false,
        };
      }
      // Real switch — user explicitly chose this model.
      const ctxTokens = this.estimateCtxTokens(sessionId);
      const cost = ctxTokens * priceOf(newModel).cacheWrite / 1_000_000;
      const prev = route.sticky;
      route.sticky = newModel;
      route.userForced = true;
      route.switchCount++;
      route.lastSwitchAt = Date.now();
      route.lastReason = `prefix:${tag}`;
      saveRouteState(sessionId, route);

      this.emitSwitch(sessionId, prev, newModel, ctxTokens, cost, `prefix:${tag}`);
      this.emitBanner(sessionId, prev, newModel, ctxTokens, cost, `prefix:${tag}`);

      return {
        model: newModel,
        cleanText: rest,
        reason: `prefix:${tag}`,
        stickyChanged: true,
        switchCostUsd: cost,
        ctxTokens,
      };
    }

    // Unknown prefix [foo] — pass through unchanged, log warning.
    if (tag) {
      log.debug({ tag, sessionId }, "ModelRouter: unknown prefix, ignored");
    }

    // ── 3. Auto-degrade on large context ────────────────────────────────
    // Skip if the user explicitly forced a model — respect their choice.
    if (cfg.auto.degradeOnLargeContext.enabled && route.sticky === cfg.auto.degradeOnLargeContext.from && !route.userForced) {
      const ctxTokens = this.estimateCtxTokens(sessionId);
      if (ctxTokens > cfg.auto.degradeOnLargeContext.threshold) {
        const newModel = cfg.auto.degradeOnLargeContext.to;
        const cost = ctxTokens * priceOf(newModel).cacheWrite / 1_000_000;
        const prev = route.sticky;
        route.sticky = newModel;
        route.switchCount++;
        route.lastSwitchAt = Date.now();
        route.lastReason = "auto-degrade:large-ctx";
        saveRouteState(sessionId, route);

        this.emitSwitch(sessionId, prev, newModel, ctxTokens, cost, "auto-degrade:large-ctx");
        this.emitBanner(sessionId, prev, newModel, ctxTokens, cost, "auto-degrade:large-ctx");

        return {
          model: newModel,
          cleanText: text,
          reason: "auto-degrade:large-ctx",
          stickyChanged: true,
          switchCostUsd: cost,
          ctxTokens,
        };
      }
    }

    // ── 4. Sticky (default path, ~95% of calls) ─────────────────────────
    return {
      model: route.sticky,
      cleanText: text,
      reason: "sticky",
      stickyChanged: false,
    };
  }

  private emitSwitch(
    sessionId: string,
    fromModel: string,
    toModel: string,
    ctxTokens: number,
    costUsd: number,
    reason: string,
  ): void {
    this.bus.publish({
      channel: "system.event",
      source: this.id,
      event: "router.switch",
      data: { sessionId, fromModel, toModel, ctxTokens, costUsd, reason },
    });
    log.info(
      { sessionId, fromModel, toModel, ctxTokens, costUsd: costUsd.toFixed(4), reason },
      "ModelRouter: model switched",
    );
  }

  private emitBanner(
    sessionId: string,
    fromModel: string,
    toModel: string,
    ctxTokens: number,
    costUsd: number,
    reason: string,
  ): void {
    const reasonLabel = reason.startsWith("auto-degrade")
      ? "Auto-degrade (large context)"
      : reason.startsWith("prefix:")
        ? `Explicit ${reason}`
        : reason;

    // Compose banner. Surfaced as a `system` timeline entry via ChatPiece —
    // it appears inline above the next assistant message and is non-blocking.
    const line1 = `⚠️ Model switch — ${shortName(fromModel)} → ${shortName(toModel)} (${reasonLabel})`;
    const line2 = ctxTokens > 0
      ? `   ↳ context ${(ctxTokens / 1000).toFixed(1)}k tokens · reconstruction ~$${costUsd.toFixed(2)}`
      : "";
    const text = line2 ? `${line1}\n${line2}` : line1;

    if (this.chatPiece?.broadcastEvent) {
      this.chatPiece.broadcastEvent(sessionId, {
        type: "system",
        text,
        session: sessionId,
      });
    }
  }
}

function shortName(model: string): string {
  if (model.includes("fable"))  return "Fable";
  if (model.includes("mythos")) return "Mythos";
  if (model.includes("opus"))   return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku"))  return "Haiku";
  return model;
}
