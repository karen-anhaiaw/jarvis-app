import { useRef, useEffect, useState } from 'react'
import type { HudComponentState } from '../../types/hud'

const MODEL_NOTES: Record<string, string> = {
  'claude-opus-4-7':   'Max',
  'claude-opus-4-6':   'Max',
  'claude-sonnet-4-6': 'High',
  'claude-haiku-4-5':  'Fast',
  'gpt-4o':            'OpenAI',
  'gpt-4o-mini':       'Fast',
  'gpt-4.1':           'OpenAI',
  'o3':                'Reason',
  'o4-mini':           'Fast',
}

interface RequestSnapshot {
  seq: number
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreation: number
}

export function TokenCounterRenderer({ state }: { state: HudComponentState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const data = state.data as any

  const sessionInputTokensRaw = data?.sessionInputTokens ?? data?.inputTokens ?? 0
  const sessionOutputTokens = data?.sessionOutputTokens ?? data?.outputTokens ?? 0
  const sessionCacheRead = data?.cacheRead ?? 0
  const sessionCacheCreation = data?.cacheCreation ?? 0
  const sessionInputTotal = sessionInputTokensRaw + sessionCacheRead + sessionCacheCreation
  const contextTokens = data?.contextTokens ?? 0
  const cachePct = data?.cachePct ?? 0
  const contextPct = data?.contextPct ?? 0
  const maxContext = data?.maxContext ?? 200000
  const model = data?.model ?? 'unknown'
  const requestCount = data?.requestCount ?? 0
  const systemTokens = data?.systemTokens ?? 0
  const toolsTokens = data?.toolsTokens ?? 0
  const messagesTokens = data?.messagesTokens ?? 0
  const streaming = data?.streaming ?? false
  const streamingVerb = data?.streamingVerb ?? ''
  const streamingStartMs = data?.streamingStartMs ?? 0
  const streamingOutputChars = data?.streamingOutputChars ?? 0
  const requestHistory: RequestSnapshot[] = data?.requestHistory ?? []
  const scope: string = data?.scope ?? 'ALL'
  const availableScopes: string[] = data?.availableScopes ?? []

  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)

  const setScope = async (next: string) => {
    setScopeMenuOpen(false)
    if (next === scope) return
    try {
      await fetch('/providers/anthropic/scope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: next }),
      })
    } catch { /* backend will ignore invalid scopes, silent is fine */ }
  }

  // Close menu when clicking outside
  useEffect(() => {
    if (!scopeMenuOpen) return
    const onDocClick = () => setScopeMenuOpen(false)
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [scopeMenuOpen])

  // Compute elapsed locally via requestAnimationFrame — no backend pushes needed
  const [elapsedMs, setElapsedMs] = useState(0)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (!streaming || !streamingStartMs) {
      setElapsedMs(0)
      return
    }
    const tick = () => {
      setElapsedMs(Date.now() - streamingStartMs)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [streaming, streamingStartMs])

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const w = c.width, h = c.height
    const cx = w / 2, cy = 90
    ctx.clearRect(0, 0, w, h)

    const outerR = 70
    const midR = 55
    const innerR = 42

    const fmt = (n: number) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
    const fmtUsd = (n: number) => n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3)

    // Anthropic pricing per token (claude-opus-4)
    const PRICE_INPUT = 15 / 1_000_000       // $15/MTok
    const PRICE_OUTPUT = 75 / 1_000_000      // $75/MTok
    const PRICE_CACHE_READ = 1.5 / 1_000_000 // $1.50/MTok
    const PRICE_CACHE_WRITE = 18.75 / 1_000_000 // $18.75/MTok

    const reqCost = (r: RequestSnapshot) =>
      r.inputTokens * PRICE_INPUT +
      r.outputTokens * PRICE_OUTPUT +
      r.cacheRead * PRICE_CACHE_READ +
      r.cacheCreation * PRICE_CACHE_WRITE

    // ─── Outer ring: context breakdown (system / tools / messages) ───
    const total = systemTokens + toolsTokens + messagesTokens
    const segments = [
      { label: 'SYSTEM', value: systemTokens, color: '#a6f' },
      { label: 'TOOLS', value: toolsTokens, color: '#4a8' },
      { label: 'MESSAGES', value: messagesTokens, color: '#4af' },
    ]

    // Background
    ctx.beginPath()
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.2)'
    ctx.lineWidth = 10
    ctx.stroke()

    // Segments — proportional to total context used (contextPct), split by relative weight
    const usedSweep = contextPct * Math.PI * 2
    let angle = -Math.PI / 2
    if (total > 0) {
      segments.forEach(seg => {
        const sweep = (seg.value / total) * usedSweep
        if (sweep > 0.01) {
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, angle, angle + sweep)
          ctx.strokeStyle = seg.color
          ctx.lineWidth = 10
          ctx.lineCap = 'butt'
          ctx.stroke()

          // Glow
          ctx.shadowColor = seg.color
          ctx.shadowBlur = 4
          ctx.beginPath()
          ctx.arc(cx, cy, outerR, angle, angle + sweep)
          ctx.strokeStyle = seg.color
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.shadowBlur = 0
        }
        angle += sweep
      })
    }

    // Ticks
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2 - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * (outerR + 6), cy + Math.sin(a) * (outerR + 6))
      ctx.lineTo(cx + Math.cos(a) * (outerR + 9), cy + Math.sin(a) * (outerR + 9))
      ctx.strokeStyle = 'rgba(68,170,255,0.1)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // ─── Middle ring: cache ratio ───
    ctx.beginPath()
    ctx.arc(cx, cy, midR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.15)'
    ctx.lineWidth = 4
    ctx.stroke()
    if (cachePct > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, midR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(cachePct, 1))
      ctx.strokeStyle = '#4a8'
      ctx.lineWidth = 4
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    // ─── Inner ring: output ───
    const outputPct = maxContext > 0 ? sessionOutputTokens / (maxContext / 10) : 0
    ctx.beginPath()
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(42,58,74,0.15)'
    ctx.lineWidth = 3
    ctx.stroke()
    if (outputPct > 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, innerR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(outputPct, 1))
      ctx.strokeStyle = '#fa4'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    // ─── Center text ───
    const ctxColor = contextPct > 0.8 ? '#f44' : contextPct > 0.5 ? '#fa4' : '#fff'
    ctx.fillStyle = ctxColor
    ctx.font = '500 16px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.fillText(`${fmt(contextTokens)} / ${fmt(maxContext)}`, cx, cy - 4)
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '500 10px "Orbitron", monospace'
    ctx.fillText(`CONTEXT ${(contextPct * 100).toFixed(1)}%`, cx, cy + 10)

    // ─── Legend below ring ───
    const ly = cy + outerR + 16
    const legendItems = [
      ...segments,
      { label: 'CACHE', value: 0, color: '#4a8' },
      { label: 'OUTPUT', value: 0, color: '#fa4' },
    ]
    const spacing = w / legendItems.length
    legendItems.forEach((item, i) => {
      const lx = spacing * i + spacing / 2
      ctx.fillStyle = item.color
      ctx.fillRect(lx - 12, ly, 6, 6)
      ctx.fillStyle = '#7a8a9a'
      ctx.font = '9px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'
      ctx.fillText(item.label, lx - 4, ly + 5)
    })

    // ─── Stats row (session accumulated totals) ───
    const sy = ly + 16
    ctx.fillStyle = '#4a5a6a'
    ctx.font = '9px "Orbitron", monospace'
    ctx.textAlign = 'center'
    ctx.fillText('SESSION', cx, sy)
    ctx.fillStyle = '#5a6a7a'
    ctx.font = '10px "JetBrains Mono", monospace'
    ctx.fillText(`IN ${fmt(sessionInputTotal)}  OUT ${fmt(sessionOutputTokens)}  REQ ${requestCount}`, cx, sy + 12)

    // ─── Model + effort (always visible) ───
    const modelNote = MODEL_NOTES[model]
    ctx.font = '10px "Orbitron", monospace'
    if (modelNote) {
      const modelText = model
      const noteText = ` · ${modelNote}`
      const modelW = ctx.measureText(modelText).width
      const noteW = ctx.measureText(noteText).width
      const totalW = modelW + noteW
      const startX = cx - totalW / 2
      ctx.textAlign = 'left'
      ctx.fillStyle = '#4af'
      ctx.fillText(modelText, startX, sy + 26)
      ctx.fillStyle = '#6a8a5a'
      ctx.fillText(noteText, startX + modelW, sy + 26)
      ctx.textAlign = 'center'
    } else {
      ctx.fillStyle = '#4af'
      ctx.fillText(model, cx, sy + 26)
    }

    // ─── Streaming status (only when streaming, line below model) ───
    if (streaming) {
      const elapsedSec = Math.floor(elapsedMs / 1000)
      const estOutputTokens = Math.round(streamingOutputChars / 4) // rough char→token estimate
      const statusText = `${streamingVerb}… ${elapsedSec}s · ↑ ${fmt(estOutputTokens)} tok`
      const pulseAlpha = 0.6 + 0.4 * Math.sin(Date.now() / 400)
      ctx.globalAlpha = pulseAlpha
      ctx.fillStyle = '#f1fa8c'
      ctx.font = '500 10px "JetBrains Mono", monospace'
      ctx.fillText(statusText, cx, sy + 40)
      ctx.globalAlpha = 1
    }

    // ─── Request History Sparkline (stacked bars) ───
    if (requestHistory.length > 0) {
      const sparkTopY = sy + 56
      const chartPadL = 12
      const labelAreaR = 44
      const chartX0 = chartPadL
      const chartW = w - chartPadL - labelAreaR

      // Separator line
      ctx.strokeStyle = 'rgba(68,170,255,0.15)'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(12, sparkTopY)
      ctx.lineTo(w - 12, sparkTopY)
      ctx.stroke()

      // Section label
      ctx.fillStyle = '#6a7a8a'
      ctx.font = '9px "Orbitron", monospace'
      ctx.textAlign = 'center'
      ctx.fillText('REQUEST HISTORY', cx, sparkTopY + 14)

      // Limit to last 25 requests for display
      const displayHistory = requestHistory.slice(-25)

      // Compute costs
      const allCosts = requestHistory.map(r => reqCost(r))
      const sessionTotal = allCosts.reduce((a, b) => a + b, 0)
      const costs = allCosts.slice(-25)
      const lastReq = displayHistory[displayHistory.length - 1]
      const lastCostVal = costs[costs.length - 1]

      // Last request info line — cost + token count
      const lastReqTotalTok = (lastReq.inputTokens ?? 0) + (lastReq.outputTokens ?? 0) + (lastReq.cacheRead ?? 0) + (lastReq.cacheCreation ?? 0)
      const sessionTotalTok = requestHistory.reduce((s, r) => s + (r.inputTokens ?? 0) + (r.outputTokens ?? 0) + (r.cacheRead ?? 0) + (r.cacheCreation ?? 0), 0)
      ctx.fillStyle = '#8af'
      ctx.font = '9px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillText(`REQ #${lastReq.seq}  ·  ${fmtUsd(lastCostVal)} / ${fmt(lastReqTotalTok)}  ·  SESSION ${fmtUsd(sessionTotal)} / ${fmt(sessionTotalTok)}`, cx, sparkTopY + 28)

      const barsY = sparkTopY + 38
      const barsH = 70

      // Find max cost for scaling
      const maxCost = Math.max(...costs, 0.001)

      const barCount = displayHistory.length
      const gap = 2
      const barW = Math.max(4, Math.min(14, (chartW - (barCount - 1) * gap) / barCount))
      const totalBarsW = barCount * barW + (barCount - 1) * gap
      const barsX0 = chartX0 + (chartW - totalBarsW) / 2

      // Scale gridlines with USD labels on the right
      ctx.strokeStyle = 'rgba(68,170,255,0.1)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2, 3])
      for (let pct = 0.25; pct <= 1; pct += 0.25) {
        const gy = barsY + barsH - barsH * pct
        ctx.beginPath()
        ctx.moveTo(barsX0, gy)
        ctx.lineTo(barsX0 + totalBarsW, gy)
        ctx.stroke()
        // USD label on right side
        ctx.fillStyle = '#7a8a9a'
        ctx.font = '9px "JetBrains Mono", monospace'
        ctx.textAlign = 'left'
        ctx.fillText(fmtUsd(maxCost * pct), barsX0 + totalBarsW + 4, gy + 3)
      }
      ctx.setLineDash([])
      ctx.textAlign = 'center'

      // Cost breakdown colors
      const costColors = {
        input:      '#4488ff',  // blue — input cost
        output:     '#ffaa44',  // orange — output cost
        cacheRead:  '#44aa88',  // green — cache read cost (cheap)
        cacheWrite: '#6644cc',  // purple — cache write cost
      }

      displayHistory.forEach((req, i) => {
        const x = barsX0 + i * (barW + gap)
        const cost = costs[i]
        const barTotalH = (cost / maxCost) * barsH

        // Cost breakdown per segment
        const inputC = req.inputTokens * PRICE_INPUT
        const outputC = req.outputTokens * PRICE_OUTPUT
        const cacheReadC = req.cacheRead * PRICE_CACHE_READ
        const cacheWriteC = req.cacheCreation * PRICE_CACHE_WRITE

        const segs = [
          { value: cacheReadC, color: costColors.cacheRead },
          { value: cacheWriteC, color: costColors.cacheWrite },
          { value: inputC, color: costColors.input },
          { value: outputC, color: costColors.output },
        ]

        let segY = barsY + barsH
        segs.forEach(seg => {
          if (seg.value <= 0 || cost <= 0) return
          const segH = Math.max(0.5, (seg.value / cost) * barTotalH)
          segY -= segH
          ctx.fillStyle = seg.color
          ctx.fillRect(x, segY, barW, segH)
        })

        // Highlight current (last) request
        if (i === barCount - 1) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5
          ctx.strokeRect(x - 0.5, barsY + barsH - barTotalH - 0.5, barW + 1, barTotalH + 1)
        }
      })

      // Baseline
      ctx.strokeStyle = 'rgba(68,170,255,0.25)'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(barsX0, barsY + barsH)
      ctx.lineTo(barsX0 + totalBarsW, barsY + barsH)
      ctx.stroke()

      // Legend
      const sly = barsY + barsH + 10
      const slegend = [
        { label: 'IN', color: costColors.input },
        { label: 'OUT', color: costColors.output },
        { label: 'CACHE', color: costColors.cacheRead },
        { label: 'WRITE', color: costColors.cacheWrite },
      ]
      const legendW = w - 24
      const slSpacing = legendW / slegend.length
      slegend.forEach((item, i) => {
        const slx = 12 + slSpacing * i + slSpacing / 2 - 20
        ctx.fillStyle = item.color
        ctx.fillRect(slx, sly, 7, 7)
        ctx.fillStyle = '#7a8a9a'
        ctx.font = '9px "JetBrains Mono", monospace'
        ctx.textAlign = 'left'
        ctx.fillText(item.label, slx + 10, sly + 7)
      })
    }

  }, [sessionInputTotal, sessionOutputTokens, contextTokens, cachePct, contextPct, maxContext, model, requestCount, systemTokens, toolsTokens, messagesTokens, streaming, streamingVerb, elapsedMs, streamingOutputChars, requestHistory])

  // Pretty label for the scope pill
  const scopeLabel = scope === 'ALL' ? 'ALL' : scope

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {/* Scope pill — overlay on top, absolute so it doesn't shift canvas layout */}
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); setScopeMenuOpen(v => !v) }}
          title="Switch session scope"
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            padding: '2px 10px',
            borderRadius: 10,
            border: '1px solid rgba(68,170,255,0.4)',
            background: 'rgba(15,20,32,0.85)',
            color: '#4af',
            fontSize: 9,
            fontFamily: 'JetBrains Mono, monospace',
            whiteSpace: 'nowrap',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'none',
          }}
        >
          {scopeMenuOpen ? '▾' : '▸'} {scopeLabel}
        </span>
        {scopeMenuOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              pointerEvents: 'auto',
              marginTop: 4,
              minWidth: 160,
              maxHeight: 220,
              overflowY: 'auto',
              background: 'rgba(15,20,32,0.95)',
              border: '1px solid rgba(68,170,255,0.4)',
              borderRadius: 6,
              padding: 4,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}
          >
            <ScopeOption value="ALL" label="ALL — all sessions" active={scope === 'ALL'} onPick={setScope} />
            {availableScopes.length > 0 && (
              <div style={{ height: 1, background: 'rgba(68,170,255,0.2)', margin: '4px 0' }} />
            )}
            {availableScopes.map((sid) => (
              <ScopeOption key={sid} value={sid} label={sid} active={scope === sid} onPick={setScope} />
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <canvas ref={canvasRef} width={300} height={396} />
      </div>
    </div>
  )
}

// Single-row entry in the scope dropdown.
function ScopeOption({ value, label, active, onPick }: { value: string; label: string; active: boolean; onPick: (s: string) => void }) {
  return (
    <div
      onClick={() => onPick(value)}
      style={{
        padding: '4px 8px',
        cursor: 'pointer',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        color: active ? '#4af' : '#cfd6e2',
        background: active ? 'rgba(68,170,255,0.12)' : 'transparent',
        borderRadius: 3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'rgba(68,170,255,0.06)' }}
      onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      {active ? '● ' : '○ '}{label}
    </div>
  )
}
