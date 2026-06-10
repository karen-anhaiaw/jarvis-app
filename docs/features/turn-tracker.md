# Turn Tracker (Pillar B — Observability)

> Mission jarvis-fix, Phase 5 (F5). Per-turn lifecycle aggregation: one structured
> `TurnSummary` per conversation turn, published as `system.event: turn.summary`,
> rendered by the Turn Inspector HUD panel, feeding derived metrics
> (TTFT, tool latency p50/p95, cost/turn).

## Intent

JARVIS already logs richly (F4 tracing: one `traceId` spans a full turn), but
nothing AGGREGATES a turn. Questions like "how slow was that turn, which tool
dominated, what did it cost?" require manual jq over jarvis.log + usage.log.
The TurnTracker answers them structurally: every turn produces exactly one
summary object with timing, tools, tokens, and cost.

## Definitions

**Turn** — everything between a prompt dispatch and the session returning to
idle, under ONE `traceId`. A turn spans 1..N API round-trips (text-only
response = 1; each tool loop adds a round-trip). Turn boundaries in
`JarvisCore`:

| Boundary | Site | Tracker call |
|---|---|---|
| start | `handlePrompt` idle path (after `currentTrace.set`) | `begin(sessionId, traceId, source)` |
| start | `drainQueue` (fresh traceId per drain; solo or combined) | `begin(sessionId, traceId, source)` |
| end (completed) | `consumeStream` text-only branch (turn complete) | `complete(sessionId, traceId, stopReason)` |
| end (aborted) | `abortSession` | `abort(sessionId, traceId)` |
| end (error) | `dispatchToSession` catch / `handleToolResult` catch | `error(sessionId, traceId, message)` |

In-flight accumulation:

| Event | Site | Tracker call |
|---|---|---|
| first text delta | `consumeStream` `text_delta` (first only) | `firstDelta(sessionId, traceId)` |
| API round-trip done | `consumeStream` `message_complete` | `roundTrip(sessionId, traceId, usage, stopReason, model)` |
| tools dispatched | `consumeStream` tool branch | `toolsDispatched(sessionId, traceId, calls)` |
| tools finished | `handleToolResult` (before continuation) | `toolsCompleted(sessionId, traceId, results)` |

## Design decisions

1. **In-process, not a bus subscriber.** JarvisCore calls tracker methods
   directly at the exact sites where it already owns the data. Rationale:
   the stale-turn guards (`currentTrace` mismatch after abort) live in
   JarvisCore; a bus-subscribing tracker would race them and double-count
   aborted turns. Direct calls inherit the guards for free.
2. **One summary per traceId, ever.** The tracker keeps one open turn per
   session keyed by traceId. Closing is idempotent: `complete`/`abort`/`error`
   on an unknown or already-closed trace is a silent no-op. This absorbs
   stale completions after abort (consumeStream returns early on trace
   mismatch — and even if it didn't, the tracker would refuse).
3. **TTFT is turn-level, user-perceived.** `ttftMs = firstDelta − startedAt`,
   measured from turn begin (dispatch), not from the round-trip start, and
   only the FIRST delta of the FIRST round-trip sets it. Per-round TTFT
   already exists in logs (F4) — the summary captures what the user felt.
4. **Per-tool durations come from the registry, carried by
   `CapabilityResult.durationMs`** (new optional field, app-internal type).
   The registry already times each call individually (`Date.now() − t0`
   per call inside `execute`); batch timing at the jarvis-core level would
   assign the whole `Promise.all` wall time to every tool. The field is
   additive; Anthropic/OpenAI sessions build API `tool_result` blocks
   field-explicitly (`tool_use_id`/`content`/`is_error`), so `durationMs`
   never leaks into provider payloads.
5. **Usage accumulates across round-trips.** Each `message_complete` adds
   `input/output/cache_creation/cache_read`. `stopReason` and `model` are
   captured per round; the summary carries the LAST round's stopReason
   (the one that ended the turn) and the model observed.
6. **Cost is a server-side estimate by model family** (`app/src/ai/pricing.ts`).
   Family matching (opus/sonnet/haiku) on the model id; cache-write = 1.25×
   input rate, cache-read = 0.1× input rate (Anthropic convention). Unknown
   families (e.g. internal models) → `costUsd: undefined` — honest "—" in the
   HUD instead of a fabricated number. The UI TokenCounter's flat-opus
   assumption is a known pre-existing inaccuracy, NOT replicated here.
7. **`turn.summary` rides `system.event`** — no new bus channel. The payload
   type `TurnSummary` is exported from `@jarvis/core` (MINOR bump): plugins
   may consume the event; the shape is public API from 2.1.0 on.
8. **Turn Inspector is a separate piece** (`app/src/pieces/turn-inspector.ts`),
   not part of JarvisCore: subscribes to `system.event`, keeps a ring buffer
   (default 50), publishes a HUD panel with the timeline + derived metrics
   (avg/max TTFT, tool latency p50/p95, avg cost/turn, error rate). Keeps
   core lean and follows the piece-composition rule.
9. **Derived metrics live in the Turn Inspector panel**, not in the provider
   metrics HUD. The Anthropic metrics panel is provider-scoped; turn metrics
   are provider-agnostic. The plan's "feed metrics-hud" is satisfied by the
   inspector exposing the same aggregates in its panel data (any consumer
   can read them from the bus snapshot).

## TurnSummary shape (public, @jarvis/core 2.1.0)

```ts
interface TurnToolStat {
  name: string;          // shortened tool name (as shown in chat)
  toolUseId: string;
  durationMs?: number;   // registry-measured; absent if result never arrived
  isError: boolean;
}

interface TurnSummary {
  traceId: string;
  sessionId: string;
  source: string;            // ai.request source (chat-input, cron, actor id, "drain:combined", …)
  startedAt: number;         // epoch ms
  endedAt: number;
  durationMs: number;        // endedAt − startedAt
  ttftMs?: number;           // first text delta − startedAt (absent if no text)
  roundTrips: number;        // API calls in this turn (≥1)
  model?: string;            // model observed on the last round-trip
  stopReason?: string;       // last round's stop reason
  outcome: "completed" | "aborted" | "error";
  error?: string;            // present when outcome === "error"
  textChars: number;         // total streamed text length
  tools: TurnToolStat[];
  usage: {
    input: number; output: number;
    cacheRead: number; cacheWrite: number;
    totalInput: number;      // input + cacheRead + cacheWrite
    total: number;           // totalInput + output
  };
  costUsd?: number;          // estimate; undefined for unknown model families
}
```

## Flow

```
handlePrompt/drainQueue ──begin──▶ TurnTracker (open turn per session)
consumeStream: text_delta ──firstDelta──▶ ttft
consumeStream: message_complete ──roundTrip──▶ usage+= , stopReason, model
consumeStream: tool branch ──toolsDispatched──▶ tools[] (pending)
handleToolResult ──toolsCompleted──▶ tools[].durationMs/isError
consumeStream: turn complete ──complete──▶ close → publish system.event turn.summary + log
abortSession ──abort──▶ close (outcome=aborted) → publish + log
dispatch/continuation catch ──error──▶ close (outcome=error) → publish + log
                                          │
                                          ▼
                       turn-inspector piece (ring buffer 50)
                       └─▶ hud.update panel: timeline + TTFT/p50/p95/cost-per-turn
```

## Invariants

- Exactly one `turn.summary` per traceId; closing twice is a no-op.
- Tracker never throws into JarvisCore paths (all methods catch internally).
- `usage` fields are always numbers (0 default) — consumers never see NaN.
- `durationMs` on tools is absent (not 0) when the tool never returned
  (abort mid-tools).
- The tracker holds at most ONE open turn per session (a new `begin` for a
  session force-closes a leaked previous turn as `outcome:"error"`,
  `error:"superseded"` — defensive; should not happen given core guards).

## Files

- `app/src/core/turn-tracker.ts` — tracker (new)
- `app/src/core/turn-tracker.test.ts` — unit tests vs BDD (new)
- `app/src/core/jarvis.ts` — hook calls (begin/firstDelta/roundTrip/tools*/complete/abort/error)
- `app/src/ai/types.ts` — `CapabilityResult.durationMs?`
- `app/src/capabilities/registry.ts` — fill `durationMs` per call
- `app/src/ai/pricing.ts` — family pricing + `estimateCostUsd` (new)
- `app/src/pieces/turn-inspector.ts` — HUD piece (new)
- `app/ui/src/components/renderers/TurnInspectorRenderer.tsx` — panel renderer (new)
- `packages/core/src/types.ts` — `TurnSummary`, `TurnToolStat` (MINOR 2.1.0)

## BDD

See `docs/features/bdd/turn-tracker.feature` — source of truth for tests.
