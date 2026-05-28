// DetachedPanelRenderer.tsx
// Renders a single panel in a detached BrowserWindow.
// The ?panel=<id> query param tells us which panel to render.
// Frameless window with custom title bar for drag + reattach.

import { lazy, Suspense, useCallback } from 'react'
import type { HudState, HudComponentState } from '../types/hud'
import { renderers } from './renderers/index'
import { ChatPanelHudAdapter } from './panels/ChatPanelHudAdapter'

const pluginRendererCache: Record<string, React.LazyExoticComponent<React.ComponentType<{ state: any }>>> = {}

function getPluginRenderer(plugin: string, file: string) {
  const key = `${plugin}/${file}`
  if (!pluginRendererCache[key]) {
    const bust = Date.now()
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

function renderPanel(comp: HudComponentState) {
  // Root chat docked panel — sessionId and assistantLabel come from piece
  // data (published by ChatPiece), so no hardcoding here.
  if (comp.id === 'chat-output' || comp.id === 'chat-input') {
    return <ChatPanelHudAdapter state={comp} />
  }

  // Built-in renderer
  const BuiltinRenderer = renderers[comp.id]
  if (BuiltinRenderer) {
    return <BuiltinRenderer state={comp} />
  }

  // Core renderer — piece declares { plugin: null, file: 'ChatPanel' | ... }
  if (comp.renderer && comp.renderer.plugin === null) {
    const registry = (window as any).__JARVIS_COMPONENTS ?? {}
    // Prefer the HUD adapter when available, else fall back to the raw component.
    const CoreRenderer = registry[`${comp.renderer.file}HudAdapter`] ?? registry[comp.renderer.file]
    if (CoreRenderer) return <CoreRenderer state={comp} />
    return <GenericRenderer state={comp} />
  }

  // Plugin renderer
  if (comp.renderer) {
    const PluginRenderer = getPluginRenderer(comp.renderer.plugin, comp.renderer.file)
    return (
      <Suspense fallback={<GenericRenderer state={comp} />}>
        <PluginRenderer state={comp} />
      </Suspense>
    )
  }

  // Generic
  return <GenericRenderer state={comp} />
}

export function DetachedPanelRenderer({ state, panelId }: { state: HudState; panelId: string }) {
  const comp = state.components.find(c => c.id === panelId)

  // Special case: chat can be either chat-output or chat-input
  const chatComp = state.components.find(c => c.id === 'chat-output') || state.components.find(c => c.id === 'chat-input')
  const isChat = panelId === 'chat-output' || panelId === 'chat-input' || panelId === 'chat'
  const activeComp = isChat ? (chatComp ? { ...chatComp, id: 'chat-output' } : null) : comp
  const title = isChat ? 'CHAT' : (comp?.name?.toUpperCase() ?? panelId.toUpperCase())

  const reattach = useCallback(() => {
    fetch('/hud/reattach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId }),
    }).catch(() => {})
    // Window will be closed by Electron main process
  }, [panelId])

  if (!activeComp) {
    return (
      <div className="detachedPanel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#567' }}>
        Panel "{panelId}" not found
      </div>
    )
  }

  return (
    <div className="detachedPanel">
      {/* Custom title bar — draggable region */}
      <div className="detachedTitleBar">
        <span className="detachedTitleText">{title}</span>
        <span className="detachedTitleActions">
          <span
            onClick={reattach}
            title="Reattach to main window"
            className="detachedTitleBtn"
          >↩</span>
        </span>
      </div>
      {/* Panel content */}
      <div className="detachedContent">
        {renderPanel(activeComp)}
      </div>
    </div>
  )
}
