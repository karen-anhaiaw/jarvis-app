import { Rnd } from 'react-rnd'
import { useRef, useEffect, useCallback, useState, type ReactNode } from 'react'

// ── Z-index ───────────────────────────────────────────────────────────────
// On click: find the max z among all panels, set this one to max + 1.
// Menu/overlays live at 9998/9999 — panels stay below that.
const PANEL_Z_CAP = 9000

function getMaxPanelZ(): number {
  let max = 10
  // .draggablePanel is the inner div inside the Rnd wrapper.
  // bringToFront calls getSelfElement() which returns the Rnd wrapper itself,
  // and sets zIndex on it. So we must read from el.parentElement (= Rnd wrapper).
  // Cap reads at PANEL_Z_CAP so stale runaway values don't accumulate.
  document.querySelectorAll<HTMLElement>('.draggablePanel').forEach(el => {
    const z = Math.min(parseInt(el.parentElement?.style.zIndex ?? '0', 10), PANEL_Z_CAP)
    if (z > max) max = z
  })
  return max
}

// Imperative registry — lets context menu focus a panel by pieceId
const panelFocusRegistry = new Map<string, () => void>()
export function registerPanelFocus(pieceId: string, fn: () => void) {
  panelFocusRegistry.set(pieceId, fn)
}
export function unregisterPanelFocus(pieceId: string) {
  panelFocusRegistry.delete(pieceId)
}
export function focusPanel(pieceId: string) {
  panelFocusRegistry.get(pieceId)?.()
}

type Props = {
  id: string
  pieceId: string
  defaultX: number
  defaultY: number
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  minHeight?: number
  children: ReactNode
  borderColor?: string
  onClose?: () => void
  onDetach?: (pieceId: string) => void
  autoGrowBottom?: boolean
  persistLayout?: boolean
  /** Epoch ms of the panel's last REAL content change (F6 hud-truth).
   *  When older than STALE_AFTER_MS the header shows a staleness badge. */
  updatedAt?: number
}

// ── Staleness badge (F6 hud-truth) ───────────────────────────────────────
// Presentation-side staleness: the backend only reports updatedAt (fact);
// the UI decides what "stale" means. 60s default — most live panels push
// well under that. Re-renders on a 10s tick, only while mounted.
const STALE_AFTER_MS = 60_000

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function StaleBadge({ updatedAt }: { updatedAt: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])
  const age = now - updatedAt
  if (age < STALE_AFTER_MS) return null
  return (
    <span
      className="panelStaleBadge"
      title={`No content change for ${fmtAge(age)} (last update ${new Date(updatedAt).toLocaleTimeString()})`}
      style={{ color: 'var(--color-muted)', fontSize: '8px', opacity: 0.7 }}
    >
      ◌ {fmtAge(age)}
    </span>
  )
}

function saveLayout(pieceId: string, x: number, y: number, width: number, height: number) {
  fetch('/hud/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pieceId, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }),
  }).catch(() => {})
}

export function DraggablePanel({
  id,
  pieceId,
  defaultX,
  defaultY,
  defaultWidth,
  defaultHeight,
  minWidth = 100,
  minHeight = 60,
  children,
  borderColor,
  onClose,
  onDetach,
  autoGrowBottom = false,
  persistLayout = true,
  updatedAt,
}: Props) {
  const rndRef = useRef<Rnd>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const lastAutoH = useRef(0)

  const bringToFront = useCallback(() => {
    const el = rndRef.current?.getSelfElement()
    if (!el) return
    const next = Math.min(getMaxPanelZ() + 1, PANEL_Z_CAP)
    el.style.zIndex = String(next)
  }, [])

  // Native listener on the Rnd wrapper — fires for any click anywhere,
  // regardless of react-rnd's cancel/handle logic.
  useEffect(() => {
    const el = rndRef.current?.getSelfElement()
    if (!el) return
    el.addEventListener('mousedown', bringToFront)
    return () => el.removeEventListener('mousedown', bringToFront)
  }, [bringToFront])

  // Register for imperative focus from context menu
  useEffect(() => {
    registerPanelFocus(pieceId, bringToFront)
    return () => unregisterPanelFocus(pieceId)
  }, [pieceId, bringToFront])

  // Bring to front on mount — new panels appear above all existing ones.
  useEffect(() => {
    bringToFront()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const syncHeight = useCallback(() => {
    if (!autoGrowBottom || !rndRef.current || !innerRef.current) return
    const inner = innerRef.current
    const needed = inner.scrollHeight + 2
    if (needed === lastAutoH.current) return
    lastAutoH.current = needed
    const rnd = rndRef.current
    const selfEl = (rnd as any).getSelfElement() as HTMLElement | null
    if (!selfEl) return
    const curY = parseInt(selfEl.style.top || '0') || defaultY
    const curH = selfEl.offsetHeight
    const bottom = curY + curH
    const newH = Math.max(needed, minHeight)
    const newY = bottom - newH
    rnd.updatePosition({ x: parseInt(selfEl.style.left || '0') || defaultX, y: Math.max(0, newY) })
    rnd.updateSize({ width: selfEl.offsetWidth || defaultWidth, height: newH })
  }, [autoGrowBottom, defaultX, defaultY, defaultWidth, minHeight])

  useEffect(() => {
    if (!autoGrowBottom || !innerRef.current) return
    const observer = new ResizeObserver(() => syncHeight())
    observer.observe(innerRef.current)
    return () => observer.disconnect()
  }, [autoGrowBottom, syncHeight])

  useEffect(() => {
    if (!rndRef.current) return
    rndRef.current.updatePosition({ x: defaultX, y: defaultY })
    rndRef.current.updateSize({ width: defaultWidth, height: defaultHeight })
  }, [defaultX, defaultY, defaultWidth, defaultHeight])

  return (
    <Rnd
      ref={rndRef}
      default={{ x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="parent"
      style={borderColor ? { borderColor } : undefined}
      dragHandleClassName="drag-handle"
      enableUserSelectHack={false}
      cancel=".panelContent"
      enableResizing={{
        top: false, right: true, bottom: true, left: false,
        topRight: false, bottomRight: true, bottomLeft: false, topLeft: false,
      }}
      resizeHandleStyles={{
        bottomRight: { width: '10px', height: '10px', bottom: '2px', right: '2px', cursor: 'se-resize' },
      }}
      onDragStop={(_e, d) => {
        if (!persistLayout) return
        const el = rndRef.current?.getSelfElement()
        saveLayout(pieceId, d.x, d.y, el?.offsetWidth ?? defaultWidth, el?.offsetHeight ?? defaultHeight)
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        if (!persistLayout) return
        saveLayout(pieceId, pos.x, pos.y, parseInt(ref.style.width), parseInt(ref.style.height))
      }}
    >
      <div ref={innerRef} className="draggablePanel" style={{ width: '100%', height: '100%' }}>
        <div className="drag-handle panelHeader"
          style={borderColor ? { borderBottomColor: borderColor } : undefined}>
          <span>{id}</span>
          <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {updatedAt !== undefined && <StaleBadge updatedAt={updatedAt} />}
            {onDetach && (
              <span
                onClick={(e) => { e.stopPropagation(); onDetach(pieceId) }}
                title="Detach to separate window"
                style={{ cursor: 'pointer', color: 'var(--color-muted)', fontSize: '9px', lineHeight: 1 }}
              >⧉</span>
            )}
            <span className="panelHeaderIcon">⠿</span>
            {onClose && (
              <span
                onClick={(e) => { e.stopPropagation(); onClose() }}
                style={{ cursor: 'pointer', color: 'var(--color-muted)', fontSize: '9px', lineHeight: 1 }}
              >✕</span>
            )}
          </span>
        </div>
        <div className="panelContent">
          {children}
        </div>
      </div>
    </Rnd>
  )
}
