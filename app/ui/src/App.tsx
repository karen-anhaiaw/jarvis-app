// ui/src/App.tsx
import { useEffect, useRef } from 'react'
import { HudRenderer } from './components/HudRenderer'
import { DetachedPanelRenderer } from './components/DetachedPanelRenderer'
import { useHudState, useHudPiece, useHudReactor } from './hooks/useHudStream'
import { useAnchors } from './hooks/useChatAnchors'
// Side-effect: importing useChatSlotFills registers window.__JARVIS_CHAT_SLOTS
import { chatSlotFillRegistry } from './hooks/useChatSlotFills'

// Expose HUD hooks globally so plugin renderers can access them
// without importing from the main bundle (they run in isolated esbuild scope)
;(window as any).__JARVIS_HUD_HOOKS = { useHudState, useHudPiece, useHudReactor, useAnchors }
// Side-effect: importing useChatAnchors registers window.__JARVIS_CHAT_ANCHORS
// Reference the registry so the import is not tree-shaken (keeps the global).
void chatSlotFillRegistry

// Inject theme CSS vars into a <style> tag, hot-reloading on change
function useTheme() {
  const styleRef = useRef<HTMLStyleElement | null>(null)

  useEffect(() => {
    const el = document.createElement('style')
    el.id = 'jarvis-theme'
    document.head.appendChild(el)
    styleRef.current = el

    const apply = async () => {
      try {
        const res = await fetch('/theme/active')
        if (!res.ok) return
        const { vars } = await res.json()
        if (!vars || Object.keys(vars).length === 0) {
          el.textContent = ''
          return
        }
        const css = `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`
        el.textContent = css
      } catch {
        // server not ready yet
      }
    }

    apply()
    const interval = setInterval(apply, 3000)
    return () => { clearInterval(interval); el.remove() }
  }, [])
}

/** Check if this window should render a single detached panel */
function getDetachedPanelId(): string | null {
  const params = new URLSearchParams(window.location.search)
  return params.get('panel')
}

export function App() {
  const state = useHudState()
  useTheme()

  const detachedPanelId = getDetachedPanelId()



  if (detachedPanelId) {
    return <DetachedPanelRenderer state={state} panelId={detachedPanelId} />
  }

  return <HudRenderer state={state} />
}
