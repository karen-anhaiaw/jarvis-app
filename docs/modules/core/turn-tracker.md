# Module: core/turn-tracker

> `app/src/core/turn-tracker.ts` — per-turn lifecycle aggregation (F5, Pillar B).
> Feature doc: `docs/features/turn-tracker.md` · BDD: `docs/features/bdd/turn-tracker.feature`

## Responsibility

Aggregate everything that happens inside ONE conversation turn (= one traceId)
into a single `TurnSummary`, published as `system.event: turn.summary` when the
turn closes. JarvisCore calls the tracker's methods directly at its hook
sites; the tracker is a publisher, never a bus subscriber (see feature doc,
design decision #1).

## Fields

| Field | Type | Purpose |
|---|---|---|
| `open` | `Map<sessionId, OpenTurn>` | At most ONE open turn per session |
| `buffer` | `TurnSummary[]` | Closed summaries, ring buffer (newest last internally) |
| `publishFn` | `(msg) => void`? | Bus publish; optional (tests, headless aggregation) |
| `now` | `() => number` | Clock; injectable for tests |
| `capacity` | `number` | Ring buffer size (default 50) |

## Methods

| Method | Called from (jarvis.ts site) | Effect |
|---|---|---|
| `begin(sessionId, traceId, source)` | `handlePrompt` idle path; `drainQueue` | Opens turn. Force-closes a leaked open turn as `error:"superseded"` |
| `textDelta(sessionId, traceId, chars)` | `consumeStream` `text_delta` | First call stamps TTFT; accumulates `textChars` |
| `roundTrip(sessionId, traceId, usage?, stopReason?, model?)` | `consumeStream` `message_complete` | `roundTrips++`, usage accumulates, last stopReason/model win |
| `toolsDispatched(sessionId, traceId, calls)` | `consumeStream` tool branch (post stale-guard) | Registers pending tools (no duration) |
| `toolsCompleted(sessionId, traceId, results)` | `handleToolResult` after `addToolResults` | Stamps `durationMs`/`isError` per toolUseId |
| `complete(sessionId, traceId)` | `consumeStream` text-only branch | Closes as `completed`, publishes summary |
| `abort(sessionId, traceId?)` | `abortSession` (traceId omitted) | Closes open turn as `aborted` |
| `error(sessionId, traceId, message)` | `dispatchToSession` catch; `handleToolResult` catch | Closes as `error` |
| `openTraceId(sessionId)` | introspection | TraceId of the open turn |
| `recent(n?)` | turn-inspector, jarvis_eval | Newest-first closed summaries |
| `toolLatencyPercentiles()` | turn-inspector | Nearest-rank p50/p95 + count over buffered tool durations |

## Invariants

1. **One summary per traceId, ever.** Close is idempotent; unknown/stale
   traceIds no-op (`match()` guard).
2. **Stale accumulation is ignored** — events whose traceId doesn't match the
   session's open turn are dropped silently (post-abort stragglers).
3. **Never throws into JarvisCore** — `begin` and `close` are try/caught;
   a failing publish is logged and swallowed.
4. **Usage numbers are always 0-defaulted** — never NaN/undefined.
5. **Tool `durationMs` absent ≠ 0** — absent means the result never arrived.
6. **costUsd undefined for unknown model families** (see `ai/pricing.ts`) —
   consumers render "—", never fabricate.

## Bus

Publishes `system.event` `{ event: "turn.summary", data: TurnSummary, traceId }`
(source `jarvis-core`). Public API since @jarvis/core 0.8.0.

## Dependencies

- `./types.js` → `TurnSummary`, `TurnToolStat` (re-exported from @jarvis/core)
- `../ai/pricing.js` → `estimateCostUsd` (family-based, returns undefined for unknown)
- `../logger/index.js` → structured close/error logging
