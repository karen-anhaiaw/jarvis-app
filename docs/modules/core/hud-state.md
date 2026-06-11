# Module: core/hud-state

> `app/src/core/hud-state.ts` — HUD panel state, SSE deltas, HUD-truth (F6).
> Feature doc: `docs/features/hud-truth.md` · BDD: `docs/features/bdd/hud-truth.feature`

## Responsibility

Single point that serializes HUD panel state for the frontend: applies
`hud.update` bus messages to its map, dirty-checks content, and pushes SSE
deltas. Since F6 it also guarantees the HUD cannot silently lie: per-panel
monotonic `rev` (gap detection), `updatedAt` (staleness), reactor pull-direct,
and a reconciliation loop that self-heals lost adds and content drift.

## Fields

| Field | Type | Purpose |
|---|---|---|
| `pieces` | `Map<pieceId, HudPieceData>` | Authoritative panel map (server side) |
| `streamClients` | `Set<ServerResponse>` | Connected SSE clients |
| `contentHash` | `Map<pieceId, string>` | Stable hash of last KNOWN content (dirty check) |
| `revs` | `Map<pieceId, number>` | Per-panel monotonic revision (F6) |
| `changedAt` | `Map<pieceId, number>` | Epoch ms of last real content change (F6) |
| `reactorSource` | `fn?` | Pull-direct reactor truth (JarvisCore) |
| `producers` | `Map<pieceId, () => HudPieceData?>` | Reconciliation snapshot sources |
| `reconcileTimer` | `interval?` | ~10s loop handle |
| `now` | `() => number` | Clock (injectable for tests) |

## Methods

| Method | Purpose |
|---|---|
| `getState()` | Full snapshot for GET /hud — components carry `rev` + `updatedAt` |
| `addStreamClient/removeStreamClient` | SSE pool management |
| `setReactorSource(fn)` | Register reactor truth; panel-copy becomes fallback |
| `registerProducer(pieceId, snapshot)` | Opt-in reconciliation source |
| `reconcile()` | One tick: heal lost adds (warn) + drift; push reactor drift |
| `startReconciliation(ms=10000)` / `stopReconciliation()` | Loop lifecycle (stopped in gracefulShutdown) |

## Invariants (tested in hud-state.test.ts)

1. **`rev` follows content, not clients.** Increments on every real content
   change (and on remove) even with zero SSE clients — the connect snapshot
   is always a consistent gap-detection baseline.
2. **Unchanged updates consume nothing** — stable hash gate before rev/push.
3. **`updatedAt` stamps content changes only** and is excluded from the hash
   (it can never cause a push by itself). `streamingElapsedMs` also excluded.
4. **Remove consumes a rev; re-add continues the sequence** — a client that
   missed the remove detects the gap.
5. **First reactor observation is baseline, not drift** — a healthy first
   reconcile tick pushes zero deltas.
6. **Unknown-pieceId updates warn** (`"update for unknown pieceId"`) — never
   silent. A registered producer heals them on the next tick.
7. **Reconcile preserves layout** — producers own `data`/`status`; position/
   size/visible belong to the user.
8. **Reactor-only deltas carry no `rev`** — clients skip gap logic for them.

## SSE delta shape (consumed by app/ui/src/hooks/useHudStream.ts)

```ts
{ action: "set" | "remove", pieceId, component?, reactor?, rev? }
```

Client behavior: `rev <= lastRev` → drop (idempotent); `rev > lastRev+1` →
single-flight `GET /hud` resync; no rev → apply as-is (compat).

## Related

- `docs/features/hud-truth.md` — design decisions + failure modes
- `app/src/main.ts` — wiring: reactor source, jarvis-core producer, loop start
- `app/src/core/jarvis.ts` — `getReactorState()`, `getHudSnapshot()`
