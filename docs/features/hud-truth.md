# HUD Truth (Pillar A — Observability)

> Mission jarvis-fix, Phase 6 (F6). The HUD must never silently lie: lost SSE
> deltas are detected and healed, the reactor reads the source of truth
> directly, drifted panels self-correct, and every panel exposes its age.

## Intent

The HUD pipeline is push-only: pieces publish `hud.update` → HudState applies
to its map → SSE delta → frontend HudStore map → renderers. Four failure
modes existed with NO detection (evidence: `hud-state.ts` pre-F6):

1. **Lost delta, live connection** — a failed `client.write` or a paused
   client drops a delta; the frontend keeps rendering stale data forever
   (reconnect heals only on `onerror`).
2. **Copy-of-copy reactor** — `getReactor()` read the jarvis-core PANEL copy
   inside HudState (JarvisCore.globalState → hud.update → pieces map →
   reactor). A lost/missed panel update made the orb lie about engine state.
3. **Dropped update** — `update` for a pieceId HudState doesn't know (lost
   `add`, e.g. HudState constructed after a piece started) was discarded
   SILENTLY. The panel never appears until restart.
4. **No age** — a panel frozen for minutes is indistinguishable from one
   updated a second ago.

## Design decisions

1. **Monotonic `rev` per panel (backend-stamped).** HudState keeps
   `revs: Map<pieceId, number>`; every pushed delta (set AND remove)
   increments and carries `rev`. The full snapshot (GET /hud and the SSE
   `snapshot` event) carries each component's current rev. WHY backend-side:
   the bus has no ordering guarantees across pieces; only the single point
   that serializes deltas (HudState) can stamp a per-panel total order.
2. **Client gap detection → full resync.** The frontend HudStore tracks
   `lastRevs`. On a delta with `rev > lastRev + 1` → a delta was lost →
   fetch `GET /hud` and replace the whole store (components + reactor +
   revs). On `rev <= lastRev` → duplicate/stale → ignore (idempotent).
   WHY full resync instead of per-panel refetch: GET /hud is cheap (one
   in-memory serialization), gaps are rare, and partial healing risks
   cross-panel inconsistency (e.g. missed remove).
   Backward compat: deltas without `rev` apply exactly as before (old
   server / new client and vice versa).
3. **Reactor pull-direct.** `JarvisCore.getReactorState()` (new public
   method) derives the reactor shape STRAIGHT from `globalState` — the
   source of truth. HudState receives `setReactorSource(fn)`; when set,
   `getReactor()` calls it; the panel-copy path remains as fallback
   (compat for tests/headless setups that never wire it). Push triggers
   are unchanged (reactor deltas still ride jarvis-core panel pushes +
   reconciliation ticks).
4. **Reconciliation loop (opt-in producers).** Pieces (or main.ts on their
   behalf) may call `registerProducer(pieceId, snapshot)` where `snapshot()`
   returns the piece's CURRENT desired panel state (`HudPieceData`) or
   undefined to skip. Every ~10s HudState pulls each producer:
   - piece missing from the map (lost add / late HudState) → **re-add** +
     warn log — heals failure mode 3 permanently;
   - piece present but content drifted (stable-hash diff) → merge + push.
   Also re-checks the reactor hash and pushes a reactor delta on drift.
   WHY opt-in: most pieces are pure push and have no independent snapshot;
   forcing a `getSnapshot` on `Piece` would be a breaking interface change.
   Initial producer: jarvis-core (wired in main.ts). Others adopt as needed.
5. **`updatedAt` per panel + staleness is presentation-side.** HudState
   stamps `lastChangedAt` when a panel is added or its stable hash changes
   (NOT on every update call — volatile-field churn must not look like
   freshness). `updatedAt` is excluded from the stable hash (it must never
   cause a push by itself). The frontend shows the age and marks panels
   `stale` (CSS class + tooltip) past a threshold (60s) — presentation
   decides what stale MEANS per panel; the backend only reports the fact.
6. **Silent drops become observable.** The previously-silent
   `update`-for-unknown-pieceId path now logs a warning with the pieceId —
   even before any producer registers, the failure is visible in jarvis.log.

## Flow

```
piece → hud.update ──▶ HudState.apply ──rev++──▶ SSE delta {rev, updatedAt}
                          │                            │
                          │                            ▼
                          │                HudStore: rev gap? ──▶ GET /hud resync
                          │
        reconciliation (10s): producers.getSnapshot() → dirty-check → heal
                          │
JarvisCore.getReactorState() ◀── pull-direct (reactor truth)
```

## Invariants

- `rev` is per-panel monotonic within a HudState lifetime; a remove does NOT
  reset it (re-add continues the sequence — the client may have missed the
  remove and must detect the gap).
- A delta is pushed iff the stable hash changed; `updatedAt` and
  `streamingElapsedMs` never participate in the hash.
- `getReactor()` never throws — a failing reactor source falls back to the
  panel copy.
- Reconciliation never floods: it reuses `pushIfChanged` (dirty-check), so a
  healthy system pushes ZERO deltas per tick.
- Frontend resync is single-flight: overlapping gap detections trigger one
  fetch.

## Files

- `app/src/core/hud-state.ts` — rev, updatedAt, reactor source, producers,
  reconciliation loop, unknown-update warn
- `app/src/core/hud-state.test.ts` — backend scenarios (new)
- `app/src/core/jarvis.ts` — `getReactorState()` public method
- `app/src/main.ts` — wire reactor source + jarvis-core producer + start loop
- `app/ui/src/hooks/useHudStream.ts` — rev tracking, gap detect, resync
- `app/ui/src/types/hud.ts` — `rev?`, `updatedAt?` on HudComponentState
- `app/ui/src/components/HudRenderer.tsx` (or panel chrome) — staleness
  indicator (age tooltip + `stale` class)
- `docs/modules/core/hud-state.md` — module doc (new)

## BDD

See `docs/features/bdd/hud-truth.feature`. Backend scenarios are unit-tested;
frontend gap/resync and staleness rendering are validated live (no UI test
runner exists in this repo — documented limitation).
