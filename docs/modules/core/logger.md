# Logger — `app/src/logger/`

## Files

| File | Responsibility |
|---|---|
| `buffer.ts` | PURE layer: `LogEntry` type, in-memory ring buffer (500 entries), listeners, `wrapWithBuffer()` proxy factory. No import side effects — unit-testable with a stub pino. |
| `index.ts` | Wiring: file rotation (keep 3), pino transport (NDJSON file + optional pretty console), exports the proxied `log`. Re-exports the buffer API for backward compat. |
| `trace.ts` | `newTraceId()` (8-hex) + `preview()` helpers. |

## LogEntry

```ts
{ seq, timestamp, level, msg, ctx? }
```

`ctx` = child-logger bindings merged with the call's object argument
(call-site wins). Absent for plain string calls with no bindings. Added in F4
— previously the object was dropped, leaving the HUD/`/logs` SSE blind to
sessionId/traceId/err.

## Invariants

1. **Every level call lands in the ring buffer** — including calls on
   `log.child(...)` descendants (proxy wraps `child()` recursively, bindings
   accumulate). Regression guarded by `buffer.test.ts`; breaking this makes
   plugin logs invisible in the HUD while still present in the file.
2. **File output is NDJSON** (`pino/file` target) — tooling parses with `jq`,
   never regex on pretty text. Console pretty exists only when `LOG_LEVEL`
   is set.
3. `buffer.ts` must stay side-effect-free at import time (tests rely on it);
   rotation/transport effects live exclusively in `index.ts`.
4. Rotation: on boot `jarvis.log` → `jarvis-<ts>.log`, keep `MAX_LOG_FILES=3`.

## Consumers

- `server.ts` — `GET /logs` SSE streams `LogEntry` JSON (now with `ctx`).
- HUD log panel — via the SSE above.
- `usage-log.ts` is INDEPENDENT (own JSONL at `~/.jarvis/logs/usage.log`).

## Tests / BDD

- `app/src/logger/buffer.test.ts`
- `docs/features/bdd/observability-tracing.feature` (items 16/16b/19)
