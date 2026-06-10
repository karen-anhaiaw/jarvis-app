# Observability — End-to-End Tracing (Pillar C)

Mission jarvis-fix, Phase F4. Builds on ef362f8 (BusMessage.traceId, @jarvis/core
0.6.0, structured logs in jarvis.ts/bus.ts/executor/chat-piece).

## Intent

One conversation turn must be reconstructable from logs alone: filter by
`traceId` and see chat → bus → core → tool handlers → provider API → stream,
including logs emitted INSIDE tool handlers (loader/MCP) and provider sessions.
Logs must be machine-parseable (NDJSON) and the HUD ring buffer must carry the
structured context, not just the message string.

## Design

### 1. Structured ring buffer (`LogEntry.ctx`)

`LogEntry` gains `ctx?: Record<string, unknown>` — the merged object argument
of the pino call (plus child bindings). Previously the proxy extracted only the
`msg` string and DROPPED the object, making the HUD log panel and `/logs` SSE
blind to sessionId/traceId/err fields.

### 2. Proxied `child()` — ring buffer integrity

**Bug fixed:** the log Proxy intercepted only level methods; `log.child()`
returned a RAW pino child, so every child-logger call (plugins via
`ctx.log`, F4 per-turn children) bypassed `pushEntry` — invisible to the HUD
and `/logs` SSE (file was unaffected). The proxy now wraps `child()`
recursively: children push to the same ring buffer with their bindings merged
into `ctx`.

### 3. NDJSON file + pretty console (item 19)

File target switches from `pino-pretty` to raw `pino/file` → `jarvis.log` is
NDJSON (one JSON object per line; `jq`-friendly; multi-line ctx blocks gone).
Console (when `LOG_LEVEL` set) stays pretty/colorized. No code parses the old
pretty format (verified: server.ts streams the ring buffer, death-watch only
writes). Functional greps keep working — `msg` content still matches.

### 4. traceId at the edges (item 17)

| Edge | Mechanism |
|---|---|
| Tool handlers (loader, MCP) | CapabilityExecutor injects `__traceId` into tool input (same pattern as `__sessionId`/`__toolUseId`); handlers include it in their log calls and strip it before passing args to external processes/MCP servers |
| Cron | `executeJob` generates `newTraceId()` per fire; carried on the fire log AND the published `ai.request`/delegate result so downstream inherits the SAME id |
| Provider sessions (Anthropic, OpenAI) | Duck-typed optional `setTurnTraceId(id)` on the concrete session classes, called by JarvisCore before `sendAndStream`/`continueAndStream`. Session includes it in key logs (entry, API call, complete, error). Deliberately NOT added to the `AISession` interface in @jarvis/core — app-internal concern; promote only if plugins need it |
| SessionManager | NO signature changes — state transitions are already logged by JarvisCore's per-turn child (item 18) with traceId. Changing `setState(...)` would ripple the public SessionManager interface for marginal gain |

### 5. Per-turn child logger in JarvisCore (item 18)

`handlePrompt`/`dispatchToSession`/`consumeStream` derive
`turnLog = log.child({ traceId, sessionId })` once per turn and use it for all
turn-scoped logs — removes ~15 hand-threaded `traceId` fields and guarantees
no turn log is missing correlation. Depends on (2).

## Invariants

1. The bus keeps auto-filling `traceId` when absent — explicit ids only ADD
   linkage, never required.
2. `__traceId` (like `__sessionId`/`__toolUseId`) must be stripped before
   forwarding input to MCP servers / external processes.
3. Child loggers MUST land in the ring buffer — UI truth depends on it.
4. File log format is NDJSON from F4 on; tooling parses with `jq`, not regex
   on pretty output.

## BDD

`docs/features/bdd/observability-tracing.feature`
