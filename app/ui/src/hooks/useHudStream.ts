// ui/src/hooks/useHudStream.ts
// Reactive HUD state via SSE. Backend pushes deltas per-piece.
//
// Architecture:
//   - Single SSE connection to /hud-stream shared by all consumers
//   - Internal Map<pieceId, HudComponentState> updated on every delta
//   - useHudState()      → full HudState (reactor + components array) — used by HudRenderer
//   - useHudPiece(id)    → single piece state — used by plugin renderers
//   - useHudReactor()    → reactor state only — used by core node overlay
//
// Plugins access these via window.__JARVIS_HUD_HOOKS (injected in App.tsx)

import { useSyncExternalStore } from 'react'
import type { HudState, HudComponentState, HudReactor } from '../types/hud'

const DEFAULT_REACTOR: HudReactor = { status: 'offline', coreLabel: 'CONNECTING', coreSubLabel: '...' }

interface HudDelta {
  action: 'snapshot' | 'set' | 'remove'
  pieceId?: string
  component?: HudComponentState
  reactor?: HudReactor
  state?: HudState
  /** Per-panel monotonic rev (F6 hud-truth). Absent on reactor-only deltas
   *  and older servers — gap detection is skipped then. */
  rev?: number
}

// ─── Singleton Store ──────────────────────────────────────────────────────────
// One SSE connection, many subscribers. Components subscribe to specific pieces
// and only re-render when their piece changes.

type Listener = () => void

class HudStore {
  private components = new Map<string, HudComponentState>()
  private reactor: HudReactor = DEFAULT_REACTOR
  private listeners = new Set<Listener>()
  private es: EventSource | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** F6.1: grace timer — defers teardown when refCount touches 0 so transient
   *  unsubscribe→resubscribe churn (React re-subscribe on identity change,
   *  StrictMode double-invoke, single-consumer re-renders) never recycles the
   *  EventSource. Recycling per render self-sustains: connect → snapshot →
   *  notify → re-render → re-subscribe → ... (observed live at ~770 cycles/s,
   *  node 53% CPU, 2026-06-11). */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private refCount = 0
  // Snapshot version — bumped on every mutation to trigger useSyncExternalStore
  private version = 0
  // ── F6 hud-truth: per-panel rev tracking ──
  // A delta with rev > lastRev+1 means an SSE delta was LOST on a live
  // connection (failed write, paused client) → full resync from GET /hud.
  // rev <= lastRev → duplicate/stale → ignored (idempotent).
  private lastRevs = new Map<string, number>()
  private resyncing = false

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.refCount++
    // A subscriber arrived within the grace window — keep the live connection.
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
    if (this.refCount === 1) this.connect() // connect() no-ops if es is alive
    return () => {
      this.listeners.delete(listener)
      this.refCount--
      if (this.refCount === 0 && !this.disconnectTimer) {
        // F6.1 hysteresis: only tear down if nobody resubscribes within the
        // grace window. Immediate teardown on 1→0→1 churn was the storm.
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null
          if (this.refCount === 0) this.disconnect()
        }, 250)
      }
    }
  }

  getReactor(): HudReactor { return this.reactor }
  getComponents(): Map<string, HudComponentState> { return this.components }
  getVersion(): number { return this.version }

  getPiece(id: string): HudComponentState | undefined {
    return this.components.get(id)
  }

  private notify() {
    this.version++
    for (const l of this.listeners) l()
  }

  private connect() {
    if (this.es) return
    const es = new EventSource('/hud-stream')
    this.es = es

    es.onmessage = (event) => {
      try {
        const delta: HudDelta = JSON.parse(event.data)
        this.applyDelta(delta)
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => {
      es.close()
      this.es = null
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => this.connect(), 2000)
    }
  }

  private disconnect() {
    if (this.es) { this.es.close(); this.es = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null }
  }

  private applyDelta(delta: HudDelta) {
    switch (delta.action) {
      case 'snapshot': {
        if (delta.state) {
          this.applySnapshot(delta.state)
        }
        break
      }
      case 'set': {
        if (this.revGate(delta)) break
        if (delta.pieceId && delta.component) {
          this.components.set(delta.pieceId, delta.component)
        }
        if (delta.reactor) this.reactor = delta.reactor
        this.notify()
        break
      }
      case 'remove': {
        if (this.revGate(delta)) break
        if (delta.pieceId) {
          this.components.delete(delta.pieceId)
        }
        if (delta.reactor) this.reactor = delta.reactor
        this.notify()
        break
      }
    }
  }

  /** Replace the whole store from a full snapshot (SSE connect or resync). */
  private applySnapshot(state: HudState) {
    this.components = new Map()
    this.lastRevs = new Map()
    for (const comp of state.components) {
      this.components.set(comp.id, comp)
      if (typeof comp.rev === 'number') this.lastRevs.set(comp.id, comp.rev)
    }
    this.reactor = state.reactor
    this.notify()
  }

  /**
   * F6 gap detection. Returns true when the delta must NOT be applied:
   * - duplicate/stale (rev <= lastRev) → ignore
   * - gap (rev > lastRev+1) → a delta was lost → full resync via GET /hud
   * Deltas without rev (reactor-only, older servers) always apply.
   */
  private revGate(delta: HudDelta): boolean {
    if (delta.rev === undefined || !delta.pieceId) return false
    const last = this.lastRevs.get(delta.pieceId)
    if (last !== undefined) {
      if (delta.rev <= last) return true // duplicate/stale — drop
      if (delta.rev > last + 1) {
        this.resync()
        return true // snapshot will carry the truth
      }
    }
    this.lastRevs.set(delta.pieceId, delta.rev)
    return false
  }

  /** Single-flight full resync from GET /hud (the snapshot of truth). */
  private resync() {
    if (this.resyncing) return
    this.resyncing = true
    fetch('/hud')
      .then(r => r.json())
      .then((state: HudState) => this.applySnapshot(state))
      .catch(() => { /* next delta with a gap retries */ })
      .finally(() => { this.resyncing = false })
  }
}

// Single global instance
const store = new HudStore()

// F6.1: STABLE references for useSyncExternalStore. React re-subscribes
// whenever the `subscribe` argument changes identity between renders —
// the previous inline arrows minted a new identity EVERY render, producing
// one unsubscribe+resubscribe (and with a single consumer, one EventSource
// disconnect+connect) per render. NEVER inline these in the hooks.
const subscribeFn = (cb: Listener) => store.subscribe(cb)
const getVersionFn = () => store.getVersion()

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Full HudState — used by HudRenderer / App */
export function useHudState(): HudState {
  useSyncExternalStore(subscribeFn, getVersionFn)
  // Rebuild array only when version changes
  const reactor = store.getReactor()
  const components = [...store.getComponents().values()]
  return { reactor, components }
}

/** Single piece state — used by plugin renderers and built-in renderers */
export function useHudPiece(pieceId: string): HudComponentState | undefined {
  useSyncExternalStore(subscribeFn, getVersionFn)
  return store.getPiece(pieceId)
}

/** Reactor state only — used by core node overlay */
export function useHudReactor(): HudReactor {
  useSyncExternalStore(subscribeFn, getVersionFn)
  return store.getReactor()
}

// Backward compatibility
export { useHudState as useHudStream }
