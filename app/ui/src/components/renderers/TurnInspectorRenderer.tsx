import type { HudComponentState } from '../../types/hud'
import { Panel, Row, Dot, Label, RightValue } from './PanelLayout'

/**
 * Turn Inspector — timeline of recent turns + derived metrics.
 * Data contract: pieces/turn-inspector.ts → { turns: TurnSummary[], aggregates }.
 * Shows the newest N turns (buffer holds 50; panel height limits visible rows).
 */

interface TurnRow {
  traceId: string
  sessionId: string
  source: string
  durationMs: number
  ttftMs?: number
  roundTrips: number
  outcome: 'completed' | 'aborted' | 'error'
  tools: Array<{ name: string; durationMs?: number; isError: boolean }>
  usage: { total: number }
  costUsd?: number
}

const VISIBLE_TURNS = 8

function fmtMs(ms?: number): string {
  if (typeof ms !== 'number') return '—'
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function fmtCost(usd?: number): string {
  if (typeof usd !== 'number') return '—'
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const OUTCOME_STATUS: Record<TurnRow['outcome'], 'connected' | 'pending' | 'error'> = {
  completed: 'connected',
  aborted: 'pending',
  error: 'error',
}

export function TurnInspectorRenderer({ state }: { state: HudComponentState }) {
  const d = state.data
  const turns = (d.turns as TurnRow[] | undefined) ?? []
  const agg = (d.aggregates as Record<string, number | undefined>) ?? {}

  return (
    <Panel>
      {turns.length === 0 && (
        <Row>
          <Label>no turns yet</Label>
        </Row>
      )}
      {turns.slice(0, VISIBLE_TURNS).map(t => (
        <Row key={t.traceId}>
          <Dot status={OUTCOME_STATUS[t.outcome] ?? 'pending'} />
          {/* native tooltip carries the details Label can't fit */}
          <span title={`${t.source} · trace ${t.traceId} · ${t.roundTrips}rt · ttft ${fmtMs(t.ttftMs)}`}>
            <Label>{t.sessionId}</Label>
          </span>
          <RightValue>
            {fmtMs(t.durationMs)} · {t.tools.length}🔧 · {fmtTokens(t.usage?.total ?? 0)} · {fmtCost(t.costUsd)}
          </RightValue>
        </Row>
      ))}
      <Row>
        <Label>ttft avg</Label>
        <RightValue>{fmtMs(agg.avgTtftMs)}</RightValue>
      </Row>
      <Row>
        <Label>tool p50/p95</Label>
        <RightValue>{fmtMs(agg.toolP50Ms)} / {fmtMs(agg.toolP95Ms)}</RightValue>
      </Row>
      <Row>
        <Label>turns</Label>
        <RightValue>
          {Number(agg.count ?? 0)} · ✓{Number(agg.completed ?? 0)} ⊘{Number(agg.aborted ?? 0)} ✗{Number(agg.errors ?? 0)}
        </RightValue>
      </Row>
      <Row>
        <Label>cost</Label>
        <RightValue>{fmtCost(agg.totalCostUsd)} total · {fmtCost(agg.avgCostUsd)}/turn</RightValue>
      </Row>
    </Panel>
  )
}
