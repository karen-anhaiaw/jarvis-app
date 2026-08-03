// app/ui/src/components/panels/PluginAnchorRenderer.tsx
//
// Dynamic loader + renderer for plugin-provided chat anchor renderers.
//
// Extracted from ChatAnchorSlot so BOTH the anchor slot (composer-above) and
// the generic ChatSlotHost can reuse the exact same loader — zero duplication.
//
// FRONTIER NOTE: this is UI-INTERNAL (React lives in app/ui). It is NOT part
// of @jarvis/core. The core only defines the CONTRACT (`ChatAnchor`,
// `ChatSlot`, `renderer: {plugin,file}`); this file is the concrete impl that
// loads and mounts a plugin's renderer bundle at runtime. A plugin never sees
// this module — it only publishes a ChatAnchor and ships its renderer file.
//
// The renderer bundle is served at /plugins/<plugin>/renderers/<file>.js — the
// same loader path used for HUD pieces. React is shared via window.__JARVIS_REACT
// (injected by the server's esbuild banner), so plugin renderers do NOT bundle
// their own React.

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { ChatAnchor, ChatSlot } from '../../hooks/useChatAnchors'

// Session context the HOST injects into every plugin renderer mounted in a
// chat slot. The host owns the session it belongs to and PUSHES this down —
// the plugin renderer never looks it up. A plugin reads what it needs
// (e.g. the mic button reads sessionId to route its transcript) and ignores
// the rest. Keep in sync with the ChatSlotContext consumed by plugin renderers.
export interface ChatSlotContext {
  /** Which chat session this render is serving. */
  sessionId: string
  /** Which named mount point the render was placed in. */
  slot: ChatSlot
  /** Base URL for remote sessions (e.g. manned-journey). Empty/undefined ⇒
   *  same-origin. A renderer that talks to a backend should prefix with this. */
  baseUrl?: string
}

// ── Plugin renderer cache (one Module per plugin/file pair) ─────────────────

type PluginModule = { default?: ComponentType<any> } & Record<string, any>
const pluginCache = new Map<string, Promise<PluginModule>>()

export function loadPluginRenderer(plugin: string, file: string): Promise<PluginModule> {
  const key = `${plugin}::${file}`
  let p = pluginCache.get(key)
  if (!p) {
    const url = `/plugins/${encodeURIComponent(plugin)}/renderers/${encodeURIComponent(file)}.js`
    p = import(/* @vite-ignore */ url).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[anchor] failed to load plugin renderer', { plugin, file, err })
      pluginCache.delete(key)
      throw err
    })
    pluginCache.set(key, p)
  }
  return p
}

const anchorPendingStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '11px',
  color: '#888',
  fontStyle: 'italic',
}

const anchorErrorStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: '11px',
  color: '#ff6b6b',
  background: '#2a1620',
  borderLeft: '3px solid #ff6b6b',
  borderRadius: '4px',
}

export function PluginAnchorRenderer({
  anchor,
  ctx,
}: {
  anchor: ChatAnchor
  /** Session context injected by the host. Optional so existing callers
   *  (composer-above choice cards) keep working without change. */
  ctx?: ChatSlotContext
}) {
  const [Comp, setComp] = useState<ComponentType<any> | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!anchor.renderer) return
    let cancelled = false
    loadPluginRenderer(anchor.renderer.plugin, anchor.renderer.file)
      .then((mod) => {
        if (cancelled) return
        const comp = mod.default ?? null
        if (!comp) setErr('plugin renderer has no default export')
        else setComp(() => comp)
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [anchor.renderer?.plugin, anchor.renderer?.file])

  if (err) {
    return (
      <div style={anchorErrorStyle}>
        anchor renderer error ({anchor.renderer?.plugin}/{anchor.renderer?.file}): {err}
      </div>
    )
  }
  if (!Comp) {
    return <div style={anchorPendingStyle}>loading anchor renderer…</div>
  }
  return <Comp anchor={anchor} payload={anchor.payload} ctx={ctx} />
}

export { anchorErrorStyle, anchorPendingStyle }
