# Module: JarvisCore (`src/core/jarvis.ts`)

## Responsibility

`JarvisCore` is the **central orchestration engine** of JARVIS. It is the only component that:

1. Receives prompts from the EventBus (`ai.request`) for **any** session
2. Dispatches them to AI provider sessions via `SessionManager`
3. Drives the full streaming loop token-by-token
4. Detects tool calls, emits them as `capability.request`, and waits for results
5. Resumes generation after tools execute
6. Manages the per-session prompt queue
7. Tracks global and per-session state for HUD display

It implements the `Piece` interface and is wired in `main.ts` after all other pieces start.

---

## State Machine

### Global State

```
loading ──ready()──→ online
online  ──[any session processing]──→ processing
online  ──[any session waiting_tools]──→ waiting_tools
```

Global state is **derived** from all per-session states, never set directly. See `deriveGlobalState()`.

### Per-Session State

```
                          ┌────────────────────────────────┐
                          │                                ▼
idle ──handlePrompt()──→ processing ──tool calls──→ waiting_tools
 ▲                            │                          │
 │                      text only / error          capability.result
 └──────────────────── idle ◄─────────────────────────────┘
                             │
                      abortSession()
                             │
                          idle (queue preserved)
```

### State Transition Table

| From | Trigger | To | Side Effects |
|---|---|---|---|
| `loading` | `ready()` | `online` | Sends startup greeting + prompt |
| `idle` | `ai.request` | `processing` | Emits `prompt_dispatched`, calls `dispatchToSession` |
| `processing` | Stream yields text only | `idle` | Publishes `ai.stream/complete`, drains queue |
| `processing` | Stream yields tool calls | `waiting_tools` | Publishes `capability.request` |
| `processing` | Provider error | `idle` | Publishes `ai.stream/error` |
| `waiting_tools` | `capability.result` | `processing` | Adds tool results, calls `continueAndStream` |
| `waiting_tools` | `abortSession` | `idle` | Cleans tool history, publishes `aborted`, drains queue |
| `processing` | `abortSession` | `idle` | Publishes `aborted`, drains queue |
| any non-idle | `ai.request` | unchanged | Queues the message in `pendingPrompts` |

---

## Key Design Invariants

### 1. New prompts NEVER abort in-flight work

If a session is busy and a new `ai.request` arrives, the message is queued — never dropped, never interrupting the current turn. Only explicit user action (`abortSession`) interrupts processing.

### 2. Queue survives abort

`abortSession` cancels the current turn but deliberately preserves `pendingPrompts`. Comment in source:
> "The user aborted the current request, not the queued ones. `drainQueue()` will pick them up now that the session is idle again."

### 3. Idle sessions are not stored in sessionStates

When a session becomes idle, its key is **deleted** from `sessionStates` (not set to "idle"). This means `sessionStates.size` accurately reflects the count of active sessions. An empty map means everything is idle.

### 4. Global state is always derived, never independently set

`deriveGlobalState()` is called after every `setSessionState()`. Priority: `waiting_tools > processing > online`. This prevents global/per-session state from diverging.

### 5. Trace ID is per-turn, not per-session

`currentTrace[sessionId]` is set at `handlePrompt` dispatch and deleted at turn completion (or abort). All bus events in a turn (stream deltas, capability requests, tool results) share the same trace ID for log correlation.

### 6. Every turn produces exactly one TurnSummary

The `turns` field (TurnTracker, F5) is called directly at the turn hook sites
— begin on `currentTrace.set` (handlePrompt/drainQueue), accumulation inside
`consumeStream`/`handleToolResult`, close on turn-complete/abort/error. It
publishes `system.event: turn.summary` once per traceId. Direct calls (not bus
subscription) so the stale-turn guards apply — see
`docs/features/turn-tracker.md` design decision #1.

### 7. JarvisCore handles ANY session ID

The `ai.request` subscriber fires for any `msg.target`. Session existence and creation are delegated to `SessionManager.get()`, which creates sessions lazily. There is no `ownedPatterns` filter anymore. `isSessionOwned()` always returns `true` and `registerSessionPattern()` is a no-op kept for backward compat.

---

## Bus Channels

### Subscribed

| Channel | Condition | Handler |
|---|---|---|
| `ai.request` | `msg.target` is set | `handlePrompt()` |
| `capability.result` | `msg.target` is set | `handleToolResult()` |

### Published

| Channel | Event | When |
|---|---|---|
| `hud.update` | `add` | `start()` — registers HUD overlay |
| `hud.update` | `remove` | `stop()` — deregisters HUD overlay |
| `hud.update` | `update` | Any state change |
| `ai.stream` | `delta` | Each text token from provider |
| `ai.stream` | `complete` | Text-only turn finishes |
| `ai.stream` | `error` | Provider error or stream error |
| `ai.stream` | `tool_start` | Before dispatching capability.request |
| `ai.stream` | `tool_done` | After receiving capability.result |
| `ai.stream` | `tool_cancelled` | On abort while waiting_tools |
| `ai.stream` | `aborted` | After abortSession completes |
| `ai.stream` | `compaction_start` | Compaction begins (Engine B, cast) |
| `ai.stream` | `compaction` | Compaction complete (cast) |
| `ai.stream` | `prompt_dispatched` | Prompt sent to AI — for HUD timeline (cast) |
| `ai.stream` | `pending_queue` | Queue snapshot for HUD queue list (cast) |
| `ai.stream` | `complete` (startup) | `ready()` — zero-cost greeting, no tokens |
| `capability.request` | — | Tool calls detected in stream |
| `system.event` | `api.usage` | After each completed turn |
| `system.event` | `compaction` | After compaction |
| `system.event` | `compaction_failed` | Engine B compaction failed (history preserved) |
| `system.event` | `turn.summary` | Turn closes (via TurnTracker — see `docs/modules/core/turn-tracker.md`) |
| `ai.request` | — | `replyTo` routing after turn completion |
| `ai.request` | — | Startup prompt injection on `ready()` |

> **Note:** `prompt_dispatched`, `pending_queue`, `compaction_start` are published via `as any` cast and are **intentionally NOT in the public `AIStreamMessage` union**. This prevents breaking plugins when these internal events evolve.

---

## Method Reference

### `ready(): void`

Called by the Piece orchestrator after ALL pieces have started. Transitions `globalState` from `"loading"` to `"online"` and calls `sendStartupPrompt()`.

---

### `getReactorState()` / `getHudSnapshot()` (F6 hud-truth)

`getReactorState()` derives the HUD orb state DIRECTLY from `globalState` — HudState pulls it via `setReactorSource` instead of trusting its panel copy. `getHudSnapshot()` returns the current desired jarvis-core panel (mirrors the start() `add`) — registered as the first reconciliation producer in main.ts. See `docs/modules/core/hud-state.md`.

---

### `abortSession(sessionId: string): void`

Aborts the current turn for a session. Called by `POST /chat/abort` (user pressing ESC).

**Critical detail:** If the session was in `waiting_tools`, calls `session.cleanupAbortedTools(pendingToolCalls)` **before** aborting. This removes the orphaned `tool_use`/`tool_result` blocks from message history. Without this, the next turn would see an inconsistent message array and the AI provider would return a validation error.

---

### `private sendStartupPrompt(): void`

Runs on `ready()`. Always emits a zero-cost `"Back online, Sir."` greeting via `ai.stream/complete` (no LLM call, no tokens). If a startup prompt file exists at `~/.jarvis/startup-prompt.txt`, reads it, wraps it in a `<note-to-self>` block to prevent the model from treating previous action lists as new commands, and publishes it as `ai.request` to `main`.

**Why the `<note-to-self>` wrapper:** Without it, a restart note containing "Próximas ações: restart JARVIS" caused an infinite restart loop — the model treated the past session's todo list as new instructions.

---

### `private handlePrompt(msg: AIRequestMessage): Promise<void>`

Primary handler for `ai.request`. Implements the queuing logic:

- If session busy → queue in `pendingPrompts`, broadcast queue snapshot, return.
- If session idle → register `replyTo`, set trace, emit `prompt_dispatched`, call `dispatchToSession`.

---

### `private dispatchToSession(sessionId, text, images?): Promise<void>`

Sends text to the AI provider and drives the stream. Transitions session to `"processing"`. Wraps the `consumeStream` call in try/catch — any provider error resets state to idle and publishes an error event.

---

### `private handleToolResult(msg: CapabilityResultMessage): Promise<void>`

Resumes the AI stream after tool execution. Guards against late-arriving results (session not in `waiting_tools` → discard with warning). Calls `session.addToolResults()` then `session.continueAndStream()`.

---

### `private consumeStream(sessionId, stream): Promise<void>`

The core streaming loop. Iterates `AsyncGenerator<AIStreamEvent>`:

| Event | Action |
|---|---|
| `text_delta` | Append to `fullText`, publish `ai.stream/delta` |
| `tool_use` | Accumulate in `toolCalls` array |
| `message_complete` | Capture `usage` |
| `compaction_start` | Forward to bus (cast) |
| `compaction` | Forward to `ai.stream` and `system.event` |
| `error` (non-abort) | Publish `ai.stream/error` |

After stream exhausts:
- **If tool calls:** Store in `pendingToolCalls`, transition to `waiting_tools`, publish `capability.request`.
- **If text only:** Transition to `idle`, publish `ai.stream/complete`, route `replyTo` if set, call `drainQueue`.

---

### `private drainQueue(sessionId: string): void`

Combines all queued messages into one API call (N-to-1), but expands them back to N individual timeline entries via `broadcastPromptDispatched`. Called after a text-only turn completes and after `abortSession`.

**Queue clear timing:** Queue is cleared (`queue.length = 0`) before `broadcastPromptDispatched`. The subsequent `broadcastPendingQueue` sends an empty snapshot (clearing the UI queue list) AFTER `broadcastPromptDispatched` (so the entries transition from queue to timeline, not disappear).

---

### `private deriveGlobalState(): void`

Recomputes `globalState` from `sessionStates`. Priority: `waiting_tools > processing > online`. Also calls `graphRegistry.update()` to keep the internal graph in sync.

---

## Helper Functions (module-level)

### `summarizeToolArgs(input): string`

Strips `__sessionId` from tool input, formats remaining args for HUD display. Single-arg tools show only the value; multi-arg tools show `key=value` pairs. Objects are `JSON.stringify`-ed.

### `shortenToolName(name): string`

Strips MCP namespace prefix: `mcp__knowledge-semantic__knowledge_search` → `knowledge_search`.

---

## Fields

| Field | Type | Purpose |
|---|---|---|
| `bus` | `EventBus` | Set in `start()`. Sole communication channel. |
| `sessions` | `SessionManager` | AI provider session lifecycle. Injected via `setSessions()`. |
| `totalRequests` | `number` | Monotonic counter of completed turns. HUD display. |
| `lastResponseMs` | `number` | Wall-clock duration of last completed turn. HUD display. |
| `globalState` | enum | Derived aggregate state across all sessions. |
| `sessionStates` | `Map<sessionId, state>` | Per-session active states. Idle sessions NOT stored. |
| `pendingPrompts` | `Map<sessionId, msg[]>` | Queue of pending prompts per session. |
| `pendingReplyTo` | `Map<sessionId, callerSessionId>` | Request-reply routing state. |
| `currentTrace` | `Map<sessionId, traceId>` | Per-turn trace ID for log correlation. |
| `turns` | `TurnTracker` | Per-turn aggregation → `system.event: turn.summary` (F5). Public via `turnTracker` getter. |
| `jarvisMdPath` | `string` | Path to `~/.jarvis/jarvis.md`. |

---

## Related

- `docs/features/chat.md` — End-to-end chat feature
- `docs/features/bdd/chat.feature` — BDD scenarios
- `docs/modules/core/session-manager.md` — Session lifecycle
- `docs/modules/core/conversation-store.md` — Startup prompt persistence
- `src/core/jarvis.ts` — Source file
- `src/input/chat-piece.ts` — HTTP/SSE bridge
