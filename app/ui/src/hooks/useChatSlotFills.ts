// app/ui/src/hooks/useChatSlotFills.ts
//
// Chat Slot Fill Registry — GLOBAL, session-agnostic renderers pinned to a
// named ChatSlot. Distinct from useChatAnchors (per-session, ephemeral):
//
//   - Anchor  → one session, comes and goes (e.g. a choice card).
//   - Fill    → ALL sessions, always present (e.g. the voice mic button).
//
// A plugin's renderer registers a fill ONCE when its bundle loads (via
// window.__JARVIS_CHAT_SLOTS.register). Every ChatSlotHost — which is mounted
// in every session — reads the fills for its slot and renders them, injecting
// the per-session ChatSlotContext. Result: the render appears in every chat
// session, present AND future, with no backend involvement.
//
// This is the "listinha do chatrender" (Sir, 2026-07-31): the core exposes the
// registry; the plugin only CONSUMES it. Same shape/discipline as
// window.__JARVIS_CHAT_ANCHORS.

import { useSyncExternalStore } from 'react'
import type { ChatSlot } from './useChatAnchors'

/** A globally-pinned plugin renderer for a chat slot. */
export interface ChatSlotFill {
  /** Stable identity — dedupes re-registration (idempotent on reload). */
  id: string
  /** Which named mount point this fill targets. */
  slot: ChatSlot
  /** Higher = rendered first within the slot. Default 0. */
  priority?: number
  /** The plugin renderer to load: /plugins/<plugin>/renderers/<file>.js */
  renderer: { plugin: string; file: string }
}

type Listener = () => void

class SlotFillStore {
  /** id → fill */
  private byId = new Map<string, ChatSlotFill>()
  private listeners = new Set<Listener>()
  private version = 0
  /** Cached snapshot per slot → stable identity until a mutation bumps version. */
  private cache = new Map<ChatSlot, { version: number; list: ChatSlotFill[] }>()

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Snapshot of fills for one slot, sorted by priority desc. Stable identity
   *  across renders until the registry mutates (required by useSyncExternalStore). */
  listForSlot = (slot: ChatSlot): ChatSlotFill[] => {
    const cached = this.cache.get(slot)
    if (cached && cached.version === this.version) return cached.list
    const list = Array.from(this.byId.values())
      .filter((f) => f.slot === slot)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    this.cache.set(slot, { version: this.version, list })
    return list
  }

  /** Register (or replace) a fill. Idempotent by id — safe to call on every
   *  bundle load without duplicating. */
  register = (fill: ChatSlotFill): void => {
    if (!fill?.id || !fill.slot || !fill.renderer?.plugin || !fill.renderer?.file) {
      // eslint-disable-next-line no-console
      console.error('[chat-slot] register: invalid fill', fill)
      return
    }
    this.byId.set(fill.id, fill)
    this.bump()
  }

  /** Remove a fill by id. No-op if absent. */
  unregister = (id: string): void => {
    if (this.byId.delete(id)) this.bump()
  }

  private bump(): void {
    this.version += 1
    for (const cb of this.listeners) cb()
  }
}

const STORE = new SlotFillStore()

/** Reactive hook: fills for `slot`, sorted by priority desc. */
export function useSlotFills(slot: ChatSlot): ChatSlotFill[] {
  return useSyncExternalStore(
    STORE.subscribe,
    () => STORE.listForSlot(slot),
    () => STORE.listForSlot(slot),
  )
}

/** Public registry — plugin renderers call this to pin a global slot fill.
 *  Exposed on window so plugin bundles (which don't import app/ui) can reach it. */
export const chatSlotFillRegistry = {
  register: (fill: ChatSlotFill) => STORE.register(fill),
  unregister: (id: string) => STORE.unregister(id),
}

// Expose to plugin renderers (same pattern as window.__JARVIS_CHAT_ANCHORS).
;(window as unknown as { __JARVIS_CHAT_SLOTS?: typeof chatSlotFillRegistry }).__JARVIS_CHAT_SLOTS =
  chatSlotFillRegistry
