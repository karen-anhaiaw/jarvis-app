# abort-registry

> `app/src/capabilities/abort-registry.ts` · singleton `abortRegistry` · since 0.4 (mission jarvis-fix)

## Responsibility

Single source of per-tool AbortControllers, keyed `(sessionId, toolUseId)`. Replaces the duplicated per-session single-controller Maps that lived in `capabilities/loader.ts` and `mcp/manager.ts`.

## Why it exists (decision record)

`CapabilityRegistry.execute()` runs tool calls in **parallel** (`Promise.all`). The old per-session design meant a turn with 2+ tools overwrote the controller on each `set(sessionId, ctrl)` — ESC aborted only the LAST tool; earlier ones kept running as orphans (bash side effects landing after user abort). Review 2026-06-10, finding B1+D2.

## API

| Method | Behavior |
|---|---|
| `register(sessionId, toolUseId)` | Creates + tracks a controller, returns its `AbortSignal`. `toolUseId` undefined → unique synthetic key (`anon-N`), never collides |
| `release(sessionId, toolUseId)` | Stops tracking (does NOT abort). Call in handler `finally`. Undefined toolUseId → no-op |
| `abortSession(sessionId)` | Aborts ALL in-flight tools of the session, clears entries, returns count. Safe no-op when empty |
| `activeCount(sessionId?)` | Tracked tool count (per session or total) |
| `wire(bus)` | Subscribes `ai.stream` event `aborted` → `abortSession(target)`. Idempotent. Called ONCE in `main.ts` |

## Invariants

1. One controller per `(sessionId, toolUseId)` — parallel tools never share.
2. `wire()` subscribes at most once regardless of call count.
3. `release()` never aborts; `abortSession()` always clears the session bucket.
4. Consumers: `capabilities/loader.ts` (exec tools), `mcp/manager.ts` (MCP calls). Both read `__sessionId`/`__toolUseId` injected by `capabilities/executor.ts` (`handleRequest`).

## Bus channels

- Subscribes: `ai.stream` (event `aborted` only) — via `wire(bus)`.
- Publishes: none.

## Tests

`app/src/capabilities/abort-registry.test.ts` — mirrors `docs/features/bdd/abort-registry.feature` 1:1 (11 scenarios).
