# Module: pieces/turn-inspector

> `app/src/pieces/turn-inspector.ts` — Turn Inspector HUD panel (F5, Pillar B).
> Feature doc: `docs/features/turn-tracker.md` · Renderer: `app/ui/src/components/renderers/TurnInspectorRenderer.tsx`

## Responsibility

HUD panel with the timeline of recent turns + derived metrics. Pure consumer
of the public `system.event: turn.summary` contract (@jarvis/core 0.8.0) —
deliberately NOT coupled to the TurnTracker instance inside JarvisCore, so the
core product dogfoods the same event surface plugins use.

## Fields

| Field | Type | Purpose |
|---|---|---|
| `turns` | `TurnSummary[]` | Own ring buffer (50), newest FIRST |
| `added` | `boolean` | hud.update add-vs-update flow flag (HUD convention) |

## Behavior

- `start(bus)` — subscribes `system.event`; on `turn.summary` unshifts into
  buffer (cap 50) and republishes the panel. Publishes initial `add`.
- `stop()` — publishes `remove`.
- `aggregates()` — derived metrics over the buffer:
  `count/completed/aborted/errors`, `avgTtftMs`, `toolP50Ms`/`toolP95Ms`
  (nearest-rank via `nearestRankPercentile` from core/turn-tracker),
  `toolCount`, `totalCostUsd`/`avgCostUsd` (micro-dollar rounded; undefined
  when no turn had a known-family cost).

## Panel data contract (consumed by TurnInspectorRenderer)

```ts
{ turns: TurnSummary[],            // newest first, up to 50
  aggregates: { count, completed, aborted, errors,
                avgTtftMs?, toolP50Ms?, toolP95Ms?, toolCount,
                totalCostUsd?, avgCostUsd? } }
```

Renderer registered in `app/ui/src/components/renderers/index.ts` under the
pieceId `turn-inspector`. Shows the 8 newest turns (dot = outcome) + the
aggregate rows; per-turn tooltip carries source/traceId/roundTrips/ttft.

## Invariants

- Buffer is the piece's OWN copy — restart resets it (in-memory by design).
- Unknown-cost turns (costUsd undefined) are excluded from cost aggregates,
  never counted as 0 (would skew the average down).
- Panel layout (x 1680, y 130, 240×220) persists via normal HUD settings
  (not ephemeral).
