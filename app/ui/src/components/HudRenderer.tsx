import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import type { HudState } from '../types/hud'
import { DraggablePanel, focusPanel } from './DraggablePanel'
import { renderers } from './renderers/index'
import { CoreNodeOverlay } from './CoreNodeOverlay'
import { ChatPanel } from './panels/ChatPanel'
import { ChatPanelHudAdapter } from './panels/ChatPanelHudAdapter'

// Core renderer registry — resolved when a HUD piece declares
// `renderer: { plugin: null, file: '<name>' }`. Plugins (including
// jarvis-plugin-actors) use this to mount the unified ChatPanel for any
// session by passing `data.sessionId` in the HUD payload.
const CORE_RENDERERS: Record<string, React.ComponentType<{ state: any }>> = {
  ChatPanel: ChatPanelHudAdapter,
}

// ErrorBoundary — catches runtime errors in plugin renderers so they don't
// take down the entire HUD. Only the broken panel shows an error message.
class PluginErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '12px', color: '#f44', fontFamily: 'monospace', fontSize: '11px' }}>
          <div style={{ fontWeight: 600, marginBottom: '6px' }}>⚠ Renderer crashed</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#f88', opacity: 0.8 }}>
            {this.state.error?.message ?? 'Unknown error'}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// Cache for lazily loaded plugin renderers
const pluginRendererCache: Record<string, React.LazyExoticComponent<React.ComponentType<{ state: any }>>> = {}

function getPluginRenderer(plugin: string, file: string) {
  const key = `${plugin}/${file}`
  if (!pluginRendererCache[key]) {
    // Each new cache entry gets a unique bust so re-imports after panel
    // close/reopen always fetch a fresh bundle from the server.
    // Using a per-entry counter (not Date.now at module load) means
    // every new lazy() call gets a unique URL defeating the ES module cache.
    const bust = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    pluginRendererCache[key] = lazy(() =>
      import(/* @vite-ignore */ `/plugins/${plugin}/renderers/${file}.js?v=${bust}`)
    )
  }
  return pluginRendererCache[key]
}

function GenericRenderer({ state }: { state: any }) {
  return (
    <div style={{ padding: '8px', fontSize: '10px', color: '#8af', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '4px', opacity: 0.7 }}>STATUS: {state.status}</div>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#6af' }}>
        {JSON.stringify(state.data, null, 2)}
      </pre>
    </div>
  )
}

// Human-friendly labels for reactor status — shown below the JARVIS title
const STATUS_LABELS: Record<string, string> = {
  online:        'ONLINE',
  processing:    'THINKING…',
  waiting_tools: 'WORKING…',
  loading:       'LOADING…',
  offline:       'OFFLINE',
}

// ─── Context Menu ──────────────────────────────────────────────────────────

interface CtxMenuState { x: number; y: number }

// ── Z-index tiers ──────────────────────────────────────────────────────────
// Panels: unlimited (react-rnd managed, brought to front on click)
// Menu backdrop: 9999999999998  Menu / submenu: 9999999999999
// ───────────────────────────────────────────────────────────────────────────

function HudContextMenu({
  menu,
  onClose,
  allComponents,
  chatPanels,
  hiddenPanels,
  onTogglePanel,
}: {
  menu: CtxMenuState
  onClose: () => void
  allComponents: HudState['components']
  chatPanels: Array<{ id: string; name: string }>
  hiddenPanels: Set<string>
  onTogglePanel: (id: string, visible: boolean) => void
}) {
  const [chatSubOpen, setChatSubOpen] = React.useState(false)
  const chatRowRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [subLeft, setSubLeft] = React.useState(0)
  const [subTop, setSubTop]   = React.useState(0)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Recompute submenu position whenever it opens (after paint)
  React.useEffect(() => {
    if (!chatSubOpen) return
    const id = requestAnimationFrame(() => {
      const mr = menuRef.current?.getBoundingClientRect()
      const rr = chatRowRef.current?.getBoundingClientRect()
      if (mr && rr) { setSubLeft(mr.right + 4); setSubTop(rr.top) }
    })
    return () => cancelAnimationFrame(id)
  }, [chatSubOpen])

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '4px 12px', cursor: 'pointer' }
  const hl = (e: React.MouseEvent, on: boolean) => { (e.currentTarget as HTMLElement).style.background = on ? 'rgba(68,170,255,0.10)' : 'transparent' }
  const dot = (color: string) => <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, marginRight: 8, flexShrink: 0 }} />
  const menuBox: React.CSSProperties = { position: 'fixed', zIndex: 9999999999999, background: '#0d1117', border: '1px solid #2a3040', borderRadius: 6, minWidth: 200, boxShadow: '0 8px 32px rgba(0,0,0,0.7)', fontFamily: 'var(--font-mono)', fontSize: 11, color: '#cfd8e8', overflow: 'hidden' }

  // All non-chat panels — flat list, sorted by name
  const panels = allComponents
    .filter(c => c.id !== 'chat-output' && c.id !== 'chat-input' && c.renderer?.file !== 'ChatPanel')
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999999999998 }} />

      {/* main menu */}
      <div ref={menuRef} style={{ ...menuBox, left: menu.x, top: menu.y }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '6px 12px 5px', fontSize: 9, letterSpacing: '1.5px', color: '#4a5a6a', borderBottom: '1px solid #1a2030', fontFamily: 'var(--font-display)', textTransform: 'uppercase' }}>
          HUDs
        </div>

        {/* Chats → submenu trigger */}
        <div
          ref={chatRowRef}
          style={{ ...row, background: chatSubOpen ? 'rgba(68,170,255,0.10)' : 'transparent' }}
          onClick={() => setChatSubOpen(o => !o)}
          onMouseEnter={e => { if (!chatSubOpen) hl(e, true) }}
          onMouseLeave={e => { if (!chatSubOpen) hl(e, false) }}
        >
          {dot(chatPanels.length > 0 ? '#50fa7b' : '#444')}
          <span style={{ flex: 1 }}>Chats</span>
          <span style={{ color: '#4a6a8a', fontSize: 9, marginLeft: 8 }}>▶</span>
        </div>

        {/* all other panels — flat */}
        {panels.map(c => {
          const visible = !hiddenPanels.has(c.id) && c.visible !== false
          const color = !visible ? '#444' : c.status === 'running' ? '#50fa7b' : c.status === 'error' ? '#ff5555' : '#4af'
          return (
            <div key={c.id} style={{ ...row, opacity: visible ? 1 : 0.45 }}
              onClick={() => { onTogglePanel(c.id, visible); onClose() }}
              onMouseEnter={e => hl(e, true)} onMouseLeave={e => hl(e, false)}
            >
              {dot(color)}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.id}</span>
              <span style={{ color: '#3a4a5a', fontSize: 9, marginLeft: 8 }}>{visible ? 'hide' : 'show'}</span>
            </div>
          )
        })}
      </div>

      {/* chat submenu */}
      {chatSubOpen && (
        <div style={{ ...menuBox, left: subLeft, top: subTop }} onClick={e => e.stopPropagation()}>
          {chatPanels.length === 0
            ? <div style={{ padding: '8px 12px', color: '#4a5a6a', fontSize: 10 }}>No chats open</div>
            : chatPanels.map(cp => (
              <div key={cp.id} style={row}
                onMouseEnter={e => hl(e, true)} onMouseLeave={e => hl(e, false)}
                onClick={() => { focusPanel(cp.id); onClose() }}
              >
                {dot('#50fa7b')}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cp.name}</span>
              </div>
            ))
          }
        </div>
      )}
    </>
  )
}

// ───────────────────────────────────────────────────────────────────────────

export function HudRenderer({ state }: { state: HudState }) {
  const coreComp = state.components.find(c => c.id === 'jarvis-core')
  const coreNodeComp = state.components.find(c => c.id === 'hud-core-node')
  const chatOutputComp = state.components.find(c => c.id === 'chat-output')
  const chatInputComp = state.components.find(c => c.id === 'chat-input')
  const otherComps = state.components.filter(c => c.id !== 'jarvis-core' && c.id !== 'chat-output' && c.id !== 'chat-input' && c.id !== 'hud-core-node' && c.visible !== false)

  const [hiddenPanels, setHiddenPanels] = useState<Set<string>>(new Set())
  const [detachedPanels, setDetachedPanels] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)



  // Load persisted detached state on mount
  useEffect(() => {
    fetch('/hud/detached').then(r => r.json()).then((panels: Array<{ panelId: string }>) => {
      if (panels.length > 0) {
        setDetachedPanels(new Set(panels.map(p => p.panelId)))
      }
    }).catch(() => {})
  }, [])

  const hidePanel = useCallback((pieceId: string) => {
    const comp = state.components.find(c => c.id === pieceId)
    if (comp?.ephemeral) {
      // Ephemeral panels: remove from HUD state entirely via /hud/remove.
      // No hiddenPanels tracking needed — the piece's next "add" creates a
      // fresh entry and the panel reappears automatically.
      fetch('/hud/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId }),
      }).catch(() => {})
    } else {
      // Persistent panels: hide locally + persist to settings
      setHiddenPanels(prev => new Set([...prev, pieceId]))
      fetch('/hud/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId }),
      }).catch(() => {})
    }
  }, [state.components])

  const openContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // Clamp so the menu never spawns below / right of the viewport
    const MENU_W = 220
    const MENU_H = 400 // conservative upper bound
    const x = Math.min(e.clientX, window.innerWidth  - MENU_W - 8)
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8)
    setCtxMenu({ x, y })
  }, [])

  const togglePanel = useCallback((id: string, currentlyVisible: boolean) => {
    if (currentlyVisible) {
      setHiddenPanels(prev => new Set([...prev, id]))
      fetch('/hud/hide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId: id }),
      }).catch(() => {})
    } else {
      setHiddenPanels(prev => { const next = new Set(prev); next.delete(id); return next })
      fetch('/hud/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pieceId: id }),
      }).catch(() => {})
    }
  }, [])

  const detachPanel = useCallback((pieceId: string) => {
    const comp = state.components.find(c => c.id === pieceId)
    // Optimistically hide, but revert if request fails
    setDetachedPanels(prev => new Set([...prev, pieceId]))
    fetch('/hud/detach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        panelId: pieceId,
        title: comp?.name?.toUpperCase() ?? pieceId,
        width: comp?.size.width ?? 500,
        height: comp?.size.height ?? 400,
      }),
    }).then(r => {
      if (!r.ok) throw new Error('detach failed')
    }).catch(() => {
      // Revert — re-show the panel
      setDetachedPanels(prev => {
        const next = new Set(prev)
        next.delete(pieceId)
        return next
      })
    })
  }, [state.components])

  // Listen for reattach events from Electron main process
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.panelId) {
        setDetachedPanels(prev => {
          const next = new Set(prev)
          next.delete(detail.panelId)
          return next
        })
      }
    }
    window.addEventListener('panel-reattach', handler)
    return () => window.removeEventListener('panel-reattach', handler)
  }, [])

  const statusColor = state.reactor.status === 'online' ? '#4af'
    : state.reactor.status === 'processing' ? '#fa4'
    : state.reactor.status === 'waiting_tools' ? '#a6f'
    : state.reactor.status === 'loading' ? '#a6f'
    : '#f44'

  // Build chat panel list: main + all actor/session chats.
  // Use the full components array (not otherComps) so hidden chats still appear
  // in the menu and can be focused/revealed.
  const chatPanels = [
    ...(chatOutputComp ? [{ id: 'chat-output', name: 'main' }] : []),
    ...state.components
      .filter(c =>
        c.id !== 'chat-output' &&
        c.id !== 'chat-input' &&
        c.id !== 'hud-core-node' &&
        c.renderer?.file === 'ChatPanel'
      )
      .map(c => ({ id: c.id, name: c.name || c.id })),
  ]

  return (
    <div className="hudRoot" onContextMenu={openContextMenu}>
      {ctxMenu && (
        <HudContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          allComponents={state.components.filter(c => c.id !== 'hud-core-node')}
          chatPanels={chatPanels}
          hiddenPanels={hiddenPanels}
          onTogglePanel={togglePanel}
        />
      )}
      <div className="hudDragBar">
        <div className="hudDragBarHandle" />
      </div>

      <div className="hudContent">
        {coreComp && (
          <div className="hudOrbContainer">
            {/* Graph overlay — nebula swarm for all nodes including root */}
            <CoreNodeOverlay coreNodeState={coreNodeComp} reactorStatus={state.reactor.status} />
            {/* JARVIS label floats at center */}
            <div className="coreNodeLabel" style={{ color: statusColor }}>
              <div style={{ fontSize: '14px', letterSpacing: '6px' }}>J A R V I S</div>
              <div style={{ fontSize: '8px', letterSpacing: '2px', marginTop: '4px', opacity: 0.7 }}>
                {STATUS_LABELS[state.reactor.status] ?? state.reactor.status.toUpperCase().replace('_', ' ')}
              </div>
            </div>
          </div>
        )}

        {/* Chat — unified ChatPanel for main session */}
        {(chatOutputComp || chatInputComp) && !detachedPanels.has('chat-output') && (
          <DraggablePanel
            key="chat-docked"
            id="CHAT"
            pieceId="chat-output"
            onDetach={detachPanel}
            defaultX={chatOutputComp?.position.x ?? 10}
            defaultY={chatOutputComp?.position.y ?? 400}
            defaultWidth={chatOutputComp?.size.width ?? 1660}
            defaultHeight={(chatOutputComp?.size.height ?? 280) + (chatInputComp?.size.height ?? 44)}
            minWidth={300}
            minHeight={120}
          >
            {/* App-level responsibility: the root chat is sessionId "main".
                This is the ONLY place in the app that hardcodes it. */}
            <ChatPanel sessionId="main" assistantLabel="JARVIS" />
          </DraggablePanel>
        )}

        {/* Regular panels (including plugin panels like actor-pool) */}
        {otherComps.filter(c => !hiddenPanels.has(c.id) && !detachedPanels.has(c.id)).map(comp => {
          // 1. Try built-in renderer
          const BuiltinRenderer = renderers[comp.id]

          if (BuiltinRenderer) {
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
                updatedAt={comp.updatedAt}
              >
                <BuiltinRenderer state={comp} />
              </DraggablePanel>
            )
          }

          // 2. Core renderer — piece declares { plugin: null, file: 'ChatPanel' }
          if (comp.renderer && comp.renderer.plugin === null) {
            const CoreRenderer = CORE_RENDERERS[comp.renderer.file]
            if (CoreRenderer) {
              return (
                <DraggablePanel
                  key={comp.id}
                  id={comp.name.toUpperCase()}
                  pieceId={comp.id}
                  defaultX={comp.position.x}
                  defaultY={comp.position.y}
                  defaultWidth={comp.size.width}
                  defaultHeight={comp.size.height}
                  minWidth={100}
                  minHeight={60}
                  onClose={() => hidePanel(comp.id)}
                  onDetach={detachPanel}
                  persistLayout={!comp.ephemeral}
                  updatedAt={comp.updatedAt}
                >
                  <PluginErrorBoundary fallback={<GenericRenderer state={comp} />}>
                    <CoreRenderer state={comp} />
                  </PluginErrorBoundary>
                </DraggablePanel>
              )
            }
          }

          // 3. Plugin renderer (lazy loaded)
          if (comp.renderer) {
            const PluginRenderer = getPluginRenderer(comp.renderer.plugin, comp.renderer.file)
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
                updatedAt={comp.updatedAt}
              >
                <PluginErrorBoundary fallback={<GenericRenderer state={comp} />}>
                <Suspense fallback={<GenericRenderer state={comp} />}>
                  <PluginRenderer state={comp} />
                </Suspense>
              </PluginErrorBoundary>
              </DraggablePanel>
            )
          }

          // 3. Generic fallback for pieces with data but no renderer
          if (comp.data && Object.keys(comp.data).length > 0) {
            return (
              <DraggablePanel
                key={comp.id}
                id={comp.name.toUpperCase()}
                pieceId={comp.id}
                defaultX={comp.position.x}
                defaultY={comp.position.y}
                defaultWidth={comp.size.width}
                defaultHeight={comp.size.height}
                minWidth={100}
                minHeight={60}
                onClose={() => hidePanel(comp.id)}
                onDetach={detachPanel}
                persistLayout={!comp.ephemeral}
                updatedAt={comp.updatedAt}
              >
                <GenericRenderer state={comp} />
              </DraggablePanel>
            )
          }

          return null
        })}

      </div>
    </div>
  )
}
