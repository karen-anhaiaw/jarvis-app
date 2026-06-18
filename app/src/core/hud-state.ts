// src/core/hud-state.ts
/**
 * @module core/hud-state
 * @see docs/features/hud-truth.md
 * @see docs/features/bdd/hud-truth.feature
 * @see docs/modules/core/hud-state.md
 *
 * Manages HUD panel state. Provides:
 * 1. getState() — full snapshot for initial load (GET /hud) — carries per-panel
 *    `rev` + `updatedAt` so clients can resync and display age.
 * 2. SSE stream — pushes deltas only when piece content actually changed
 *    (stable-hash dirty check). Every pushed delta carries a per-panel
 *    monotonic `rev` (gap detection) — see HUD-truth design (F6).
 * 3. Reactor pull-direct — when a reactor source is registered (JarvisCore),
 *    the orb state is read from the source of truth, not the panel copy.
 * 4. Reconciliation — registered producers are polled (~10s) and drift/lost
 *    panels self-heal.
 *
 * INVARIANTS (tested in hud-state.test.ts):
 * - `rev` follows CONTENT changes (and removes), independent of connected
 *   clients — the snapshot on connect is always a consistent baseline.
 * - `updatedAt` stamps content changes only; it is EXCLUDED from the stable
 *   hash so it can never cause a push by itself.
 * - Unknown-pieceId updates are logged (warn), never silently dropped.
 */
import type { ServerResponse } from "node:http";
import type { EventBus } from "./bus.js";
import type { HudPieceData } from "./piece.js";
import type { HudUpdateMessage } from "./types.js";
import { load as loadSettings } from "./settings.js";
import { log } from "../logger/index.js";

/** Serialized piece for the frontend */
interface HudComponent {
  id: string;
  name: string;
  status: string;
  visible: boolean;
  ephemeral: boolean;
  hudConfig: { type: string; draggable: boolean; resizable: boolean };
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
  renderer?: { plugin: string; file: string };
  /** Per-panel monotonic revision — gap detection (F6). */
  rev: number;
  /** Epoch ms of the last REAL content change (F6 staleness). */
  updatedAt: number;
}

interface HudReactorState { status: string; coreLabel: string; coreSubLabel: string }

/** SSE delta event sent to frontend */
interface HudDelta {
  action: "set" | "remove";
  pieceId: string;
  component?: HudComponent;
  reactor?: HudReactorState;
  /** Mirrors component.rev (set) or the remove's consumed rev. Reactor-only
   *  deltas omit it — clients must skip gap detection for those. */
  rev?: number;
}

/** Producer snapshot callback — returns the piece's CURRENT desired panel
 *  state, or undefined to skip this tick. See feature doc, decision #4. */
export type HudProducerSnapshot = () => HudPieceData | undefined;

export class HudState {
  private pieces = new Map<string, HudPieceData>();
  private streamClients = new Set<ServerResponse>();

  // Stable content hash per piece — updated on EVERY content change
  // (regardless of connected clients); doubles as the SSE dirty check.
  private contentHash = new Map<string, string>();
  private lastReactorHash = "";

  // ─── F6 state ─────────────────────────────────────────────────────────
  private revs = new Map<string, number>();
  private changedAt = new Map<string, number>();
  private reactorSource?: () => HudReactorState | undefined;
  private producers = new Map<string, HudProducerSnapshot>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(bus: EventBus, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;

    bus.subscribe<HudUpdateMessage>("hud.update", (msg) => {
      switch (msg.action) {
        case "add": {
          this.applyAdd(msg.piece!);
          break;
        }
        case "update": {
          const existing = this.pieces.get(msg.pieceId);
          if (!existing) {
            if (msg.piece) {
              // Plugin sent "update" but we have no record (e.g. addedToHud flag
              // was not reset on stop(), so it published "update" instead of "add"
              // after a disable→enable cycle). Treat as "add" when msg.piece is
              // present — self-healing without requiring a restart.
              log.warn({ pieceId: msg.pieceId, source: msg.source }, "HudState: update for unknown pieceId with piece payload — treating as add");
              this.applyAdd(msg.piece);
            } else {
              // Previously a SILENT drop (failure mode 3, hud-truth.md).
              // The warn makes the loss observable; a registered producer
              // heals it on the next reconciliation tick.
              log.warn({ pieceId: msg.pieceId, source: msg.source }, "HudState: update for unknown pieceId — dropped (lost add?)");
            }
            break;
          }
          existing.data = { ...existing.data, ...msg.data };
          if (msg.status) existing.status = msg.status;
          if (msg.visible !== undefined) existing.visible = msg.visible;
          if (msg.layout) {
            existing.position = { x: msg.layout.x, y: msg.layout.y };
            existing.size = { width: msg.layout.width, height: msg.layout.height };
          }
          log.trace({ pieceId: msg.pieceId }, "HudState: updated");
          this.applyContentChange(msg.pieceId);
          break;
        }
        case "remove": {
          if (!this.pieces.delete(msg.pieceId)) break; // unknown — nothing to do
          this.contentHash.delete(msg.pieceId);
          this.changedAt.delete(msg.pieceId);
          log.debug({ pieceId: msg.pieceId }, "HudState: removed");

          // Remove consumes a rev too: a client that misses the remove sees
          // a gap on the panel's next appearance and resyncs (BDD: re-add
          // continues the sequence).
          const rev = (this.revs.get(msg.pieceId) ?? 0) + 1;
          this.revs.set(msg.pieceId, rev);

          this.pushDelta({
            action: "remove",
            pieceId: msg.pieceId,
            rev,
            ...(msg.pieceId === "jarvis-core" ? { reactor: this.getReactor() } : {}),
          });
          break;
        }
      }
    });
  }

  // ─── Full snapshot (used by GET /hud for initial load) ───────────────────

  getState(): Record<string, unknown> {
    const components = [...this.pieces.values()].map(p => this.serializePiece(p));
    return { reactor: this.getReactor(), components };
  }

  // ─── SSE stream (used by GET /hud-stream) ───────────────────────────────

  addStreamClient(res: ServerResponse): void {
    this.streamClients.add(res);
    // trace level — these events fire on every HUD repaint and would
    // flood the log file. Promote to debug only when actively diagnosing
    // SSE client churn.
    log.trace({ clients: this.streamClients.size }, "HudState: SSE client connected");
  }

  removeStreamClient(res: ServerResponse): void {
    this.streamClients.delete(res);
    log.trace({ clients: this.streamClients.size }, "HudState: SSE client disconnected");
  }

  // ─── F6: reactor pull-direct ──────────────────────────────────────────

  /**
   * Register the reactor source of truth (JarvisCore.getReactorState).
   * When set, getReactor() reads it directly — the jarvis-core PANEL copy
   * (which arrives via hud.update and can lag/drop) becomes a fallback only.
   */
  setReactorSource(fn: () => HudReactorState | undefined): void {
    this.reactorSource = fn;
  }

  // ─── F6: reconciliation ───────────────────────────────────────────────

  /** Register a producer whose snapshot() is pulled on every reconcile tick. */
  registerProducer(pieceId: string, snapshot: HudProducerSnapshot): void {
    this.producers.set(pieceId, snapshot);
    log.debug({ pieceId }, "HudState: producer registered");
  }

  /**
   * One reconciliation tick (public for tests; the loop calls it).
   * - lost add  → re-add from the producer snapshot (warn — should not happen)
   * - drift     → overwrite data/status from the snapshot; layout (position/
   *               size/visible) is preserved — it belongs to the user, not
   *               the producer.
   * - reactor   → push a reactor-only delta when its hash drifted.
   * Reuses the stable-hash dirty check, so a healthy tick pushes nothing.
   */
  reconcile(): void {
    for (const [pieceId, snapshot] of this.producers) {
      let snap: HudPieceData | undefined;
      try {
        snap = snapshot();
      } catch (err) {
        log.error({ err, pieceId }, "HudState: producer snapshot threw");
        continue;
      }
      if (!snap) continue;

      const existing = this.pieces.get(pieceId);
      if (!existing) {
        log.warn({ pieceId }, "HudState: reconcile — piece missing, re-adding from producer snapshot");
        this.applyAdd(snap);
        continue;
      }

      existing.data = snap.data;
      existing.status = snap.status;
      this.applyContentChange(pieceId);
    }

    // Reactor drift (pull-direct source may move without a panel push).
    // First observation is a BASELINE, not drift — settle silently so a
    // healthy first tick pushes nothing (BDD: zero deltas on healthy tick).
    const reactor = this.getReactor();
    const reactorHash = JSON.stringify(reactor);
    if (reactorHash !== this.lastReactorHash) {
      const isBaseline = this.lastReactorHash === "";
      this.lastReactorHash = reactorHash;
      if (!isBaseline) {
        // Reactor-only delta: no component, no rev (clients skip gap logic).
        this.pushDelta({ action: "set", pieceId: "jarvis-core", reactor });
      }
    }
  }

  /** Start the periodic reconciliation loop (default 10s). Idempotent. */
  startReconciliation(intervalMs = 10_000): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile(), intervalMs);
    this.reconcileTimer.unref?.();
    log.info({ intervalMs }, "HudState: reconciliation loop started");
  }

  stopReconciliation(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
      log.info("HudState: reconciliation loop stopped");
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /** Shared by the bus `add` handler and reconcile's re-add path so saved
   *  layout handling stays identical in both. */
  private applyAdd(piece: HudPieceData): void {
    // Override with saved layout from settings (skip ephemeral panels)
    if (!piece.ephemeral) {
      const saved = loadSettings().pieces?.[piece.pieceId]?.config?.layout as any;
      if (saved) {
        piece.position = { x: saved.x, y: saved.y };
        piece.size = { width: saved.width, height: saved.height };
      }
    }
    this.pieces.set(piece.pieceId, piece);
    log.debug({ pieceId: piece.pieceId, type: piece.type, ephemeral: !!piece.ephemeral }, "HudState: added");
    this.applyContentChange(piece.pieceId);
  }

  private serializePiece(p: HudPieceData): HudComponent {
    return {
      id: p.pieceId,
      name: p.name,
      status: p.status,
      visible: p.visible !== false,
      ephemeral: p.ephemeral ?? false,
      hudConfig: { type: p.type, draggable: true, resizable: true },
      position: p.position ?? { x: 0, y: 0 },
      size: p.size ?? { width: 200, height: 100 },
      data: p.data,
      renderer: p.renderer,
      rev: this.revs.get(p.pieceId) ?? 0,
      updatedAt: this.changedAt.get(p.pieceId) ?? this.now(),
    };
  }

  /**
   * Reactor state for the orb. Pull-direct from the registered source
   * (JarvisCore — the truth) when available; panel-copy fallback otherwise.
   * Never throws: a failing source falls back to the copy.
   */
  private getReactor(): HudReactorState {
    if (this.reactorSource) {
      try {
        const fromSource = this.reactorSource();
        if (fromSource) return fromSource;
      } catch (err) {
        log.error({ err }, "HudState: reactor source threw — falling back to panel copy");
      }
    }
    const core = this.pieces.get("jarvis-core");
    return core
      ? { status: core.data.status as string ?? "online", coreLabel: core.data.coreLabel as string ?? "ONLINE", coreSubLabel: "" }
      : { status: "offline", coreLabel: "OFFLINE", coreSubLabel: "" };
  }

  /**
   * Content-change pipeline for add/update/reconcile:
   * stable hash → unchanged? done : (rev++, stamp updatedAt, push if clients).
   *
   * WHY rev/updatedAt advance even with zero clients: the snapshot a client
   * receives on connect must be a consistent baseline — revs that only move
   * while someone watches would make gaps undetectable across reconnects.
   */
  private applyContentChange(pieceId: string): void {
    const piece = this.pieces.get(pieceId);
    if (!piece) return;

    const hash = this.stableHash(piece);
    if (this.contentHash.get(pieceId) === hash) return; // no content change

    this.contentHash.set(pieceId, hash);
    this.revs.set(pieceId, (this.revs.get(pieceId) ?? 0) + 1);
    this.changedAt.set(pieceId, this.now());

    if (this.streamClients.size === 0) return;

    const component = this.serializePiece(piece);
    const delta: HudDelta = { action: "set", pieceId, component, rev: component.rev };

    // Reactor rides jarvis-core pushes when its own hash moved.
    if (pieceId === "jarvis-core") {
      const reactor = this.getReactor();
      const reactorHash = JSON.stringify(reactor);
      if (reactorHash !== this.lastReactorHash) {
        this.lastReactorHash = reactorHash;
        delta.reactor = reactor;
      }
    }

    this.pushDelta(delta);
  }

  /**
   * Hash piece content excluding volatile/cosmetic fields.
   * Excluded: streamingElapsedMs (frontend computes locally), and — by
   * construction — rev/updatedAt, which live OUTSIDE HudPieceData and are
   * only attached at serialization time. The hash source is the raw piece,
   * so freshness metadata can never trigger a push.
   */
  private stableHash(piece: HudPieceData): string {
    const stableData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(piece.data)) {
      if (k === "streamingElapsedMs") continue;
      stableData[k] = v;
    }
    return JSON.stringify({
      name: piece.name,
      status: piece.status,
      visible: piece.visible !== false,
      position: piece.position,
      size: piece.size,
      renderer: piece.renderer,
      data: stableData,
    });
  }

  private pushDelta(delta: HudDelta): void {
    if (this.streamClients.size === 0) return;
    const msg = `data: ${JSON.stringify(delta)}\n\n`;
    for (const client of this.streamClients) {
      try { client.write(msg); } catch {}
    }
  }
}
