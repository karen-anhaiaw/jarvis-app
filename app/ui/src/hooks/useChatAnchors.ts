// app/ui/src/hooks/useChatAnchors.ts
//
// Chat Anchor Registry — generic, session-scoped UI anchors that float above
// the chat composer. Any piece (core or plugin) can register an anchor to
// pin a UI element until explicitly removed.
//
// Architecture:
//   - Singleton store keyed by sessionId → Map<anchorId, ChatAnchor>
//   - Backend pieces publish via the `chat.anchor` bus channel; ChatPiece
//     forwards to /chat-stream as SSE events; ChatPanel consumes and calls
//     applySSEEvent().
//   - Plugin RENDERERS may also call window.__JARVIS_CHAT_ANCHORS directly
//     (synchronous local mutation). Only use this if you genuinely need
//     UI-only anchors with no backend involvement.
//   - useAnchors(sessionId) → ChatAnchor[] sorted by priority desc.
//
// Session scope is strict: anchors NEVER leak between sessions. Listing on
// session A returns only anchors with sessionId === A.
//
// TTL: anchors with `ttlMs` are auto-removed after expiry (handled by a single
// shared timer per anchor, cleared if the anchor is replaced or removed).

import { useSyncExternalStore } from 'react'

// Mirror of @jarvis/core ChatSlot — keep in sync with packages/core/src/types.ts.
// Named mount points the chat UI exposes for anchors. The core names them;
// ChatPanel owns where each renders; plugins target a slot by name.
export type ChatSlot =
  | 'composer-above'
  | 'composer-actions'
  | 'header-actions'
  | 'message-footer'

// Mirror of @jarvis/core ChatAnchor — duplicated here because the UI bundle
// does not depend on @jarvis/core. Keep these in sync.
export interface ChatAnchor {
  id: string
  sessionId: string
  source: string
  /** Named mount point. Omitted ⇒ treated as 'composer-above' (historical
   *  anchor position — choice cards). Keep in sync with core ChatAnchor.slot. */
  slot?: ChatSlot
  priority?: number
  rendererKind: string
  payload: unknown
  renderer?: { plugin: string; file: string }
  ttlMs?: number
  createdAt?: number
}

type Listener = () => void

class AnchorStore {
  /** sessionId → (anchorId → anchor) */
  private bySession = new Map<string, Map<string, ChatAnchor>>()
  /** anchor key (`${sessionId}::${id}`) → ttl timer */
  private ttlTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private listeners = new Set<Listener>()
  /** Bumped on every mutation. Snapshot identity for useSyncExternalStore. */
  private version = 0
  /** Cached snapshot per sessionId → kept stable until that session changes. */
  private cache = new Map<string, { version: number; list: ChatAnchor[] }>()

  // ── External Store contract ────────────────────────────────────────────

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Snapshot for a given sessionId. Stable identity until that session changes. */
  getSnapshot = (sessionId: string): ChatAnchor[] => {
    const cached = this.cache.get(sessionId)
    if (cached && cached.version === this.version) return cached.list
    const map = this.bySession.get(sessionId)
    const list: ChatAnchor[] = map ? Array.from(map.values()) : []
    list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    this.cache.set(sessionId, { version: this.version, list })
    return list
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  set(anchor: ChatAnchor): void {
    if (!anchor || !anchor.sessionId || !anchor.id) {
      // eslint-disable-next-line no-console
      console.warn('[anchors] set: missing sessionId/id', anchor)
      return
    }
    const stamped: ChatAnchor = { ...anchor, createdAt: anchor.createdAt ?? Date.now() }
    let map = this.bySession.get(stamped.sessionId)
    if (!map) {
      map = new Map()
      this.bySession.set(stamped.sessionId, map)
    }
    map.set(stamped.id, stamped)
    this.scheduleTtl(stamped)
    this.bump()
  }

  remove(sessionId: string, id: string): void {
    if (!sessionId || !id) return
    const map = this.bySession.get(sessionId)
    if (!map) return
    if (!map.delete(id)) return
    this.clearTtl(sessionId, id)
    if (map.size === 0) this.bySession.delete(sessionId)
    this.bump()
  }

  clear(sessionId: string): void {
    if (!sessionId) return
    const map = this.bySession.get(sessionId)
    if (!map) return
    for (const id of map.keys()) this.clearTtl(sessionId, id)
    this.bySession.delete(sessionId)
    this.bump()
  }

  /** Diagnostics — dump all anchors. Do not use in production rendering. */
  dump(): Record<string, ChatAnchor[]> {
    const out: Record<string, ChatAnchor[]> = {}
    for (const [sid, map] of this.bySession.entries()) {
      out[sid] = Array.from(map.values())
    }
    return out
  }

  // ── SSE bridge ─────────────────────────────────────────────────────────

  /** Apply an `anchor.*` SSE event from /chat-stream. Returns true if applied. */
  applySSEEvent(evt: { type: string; sessionId?: string; anchor?: ChatAnchor; anchorId?: string }): boolean {
    if (!evt || typeof evt.type !== 'string') return false
    if (evt.type === 'anchor.set' && evt.anchor) {
      this.set(evt.anchor)
      return true
    }
    if (evt.type === 'anchor.remove' && evt.sessionId && evt.anchorId) {
      this.remove(evt.sessionId, evt.anchorId)
      return true
    }
    if (evt.type === 'anchor.clear' && evt.sessionId) {
      this.clear(evt.sessionId)
      return true
    }
    return false
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private bump(): void {
    this.version += 1
    for (const cb of this.listeners) cb()
  }

  private scheduleTtl(anchor: ChatAnchor): void {
    const key = `${anchor.sessionId}::${anchor.id}`
    this.clearTtl(anchor.sessionId, anchor.id) // replace existing
    if (!anchor.ttlMs || anchor.ttlMs <= 0) return
    const timer = setTimeout(() => {
      // double-check identity in case the anchor was replaced before fire
      const map = this.bySession.get(anchor.sessionId)
      const current = map?.get(anchor.id)
      if (current && current.createdAt === anchor.createdAt) {
        this.remove(anchor.sessionId, anchor.id)
      }
    }, anchor.ttlMs)
    this.ttlTimers.set(key, timer)
  }

  private clearTtl(sessionId: string, id: string): void {
    const key = `${sessionId}::${id}`
    const t = this.ttlTimers.get(key)
    if (t) {
      clearTimeout(t)
      this.ttlTimers.delete(key)
    }
  }
}

const STORE = new AnchorStore()

// ── Public API ──────────────────────────────────────────────────────────────

/** React hook — anchors for the given session, sorted by priority desc.
 *  Returns a stable array reference until that session's anchors change. */
export function useAnchors(sessionId: string): ChatAnchor[] {
  return useSyncExternalStore(
    STORE.subscribe,
    () => STORE.getSnapshot(sessionId),
    () => STORE.getSnapshot(sessionId),
  )
}

/** Imperative API — use from non-React code or plugin renderers. */
export const chatAnchorRegistry = {
  set: (anchor: ChatAnchor) => STORE.set(anchor),
  remove: (sessionId: string, id: string) => STORE.remove(sessionId, id),
  clear: (sessionId: string) => STORE.clear(sessionId),
  applySSEEvent: (evt: any) => STORE.applySSEEvent(evt),
  dump: () => STORE.dump(),
}

// Expose to window for plugin renderers (loaded as IIFE via /plugins/<p>/renderers/<file>.js)
if (typeof window !== 'undefined') {
  ;(window as any).__JARVIS_CHAT_ANCHORS = chatAnchorRegistry
}
