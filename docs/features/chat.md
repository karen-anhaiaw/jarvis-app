# Feature: Chat

## Overview

The Chat feature is the primary human-AI interface in JARVIS. It provides a real-time, streaming conversation panel rendered in the Electron HUD. Every keystroke, response token, tool execution, and queue state change flows through this feature.

Two modules implement it end-to-end:

- **`src/input/chat-piece.ts`** — HTTP/SSE bridge. Receives user input, routes it onto the EventBus, and streams all AI events back to connected browser clients.
- **`src/core/jarvis.ts`** — Orchestration engine. Receives prompts from the bus, dispatches them to AI provider sessions, drives the streaming loop, handles tool calls, and manages the prompt queue.

---

## Architecture

```
Browser (HUD)
    │
    ├── POST /chat/send          → ChatPiece.handleSend()
    │                                → bus: ai.request (target: sessionId)
    │                                    → JarvisCore.handlePrompt()
    │                                        → SessionManager.get(sessionId)
    │                                        → AI Provider (sendAndStream)
    │                                        → consumeStream() [token loop]
    │                                            → bus: ai.stream/delta
    │                                            → bus: ai.stream/complete
    │                                            → bus: capability.request [if tools]
    │                                    ← bus: capability.result
    │                                        → AI Provider (continueAndStream)
    │
    └── GET /chat-stream         → ChatPiece SSE pool
                                      ← bus: ai.stream/* → SSE frame → browser
```

---

## User Input Flow

1. User types in the HUD chat input and presses Enter.
2. Browser sends `POST /chat/send` with `{ sessionId, prompt, images? }`.
3. `ChatPiece.handleSend()` validates the request and publishes `ai.request` onto the bus with `source: "chat-input"`, `target: sessionId`.
4. **`JarvisCore`** receives the event via its `ai.request` subscription.
5. If the session is **idle**: dispatches immediately to the AI provider.
6. If the session is **busy** (processing or waiting for tools): message is added to `pendingPrompts[sessionId]` — never dropped, never causes an abort.

### Slash Commands

If the prompt starts with `/`, `handleSend` intercepts it before publishing to the bus:

1. Matches against registered slash commands via `CapabilityRegistry.getSlashCommand(name)`.
2. If found: broadcasts `type:"user"` SSE immediately, calls `handler(args, { sessionId })`, returns 200.
3. Handler result `{ message?, inject? }`: message is broadcast as `type:"done"`.
4. If no slash command matches: falls through to normal `ai.request` publishing.

---

## Streaming Response Flow

Each token streamed from the AI provider produces an `ai.stream/delta` bus event, which `ChatPiece` converts to an SSE frame delivered to all browser clients in the session pool.

### SSE Event Types

| SSE `type` | Source bus event | Description |
|---|---|---|
| `delta` | `ai.stream/delta` | Streaming text chunk |
| `done` | `ai.stream/complete` | Full turn complete with full text |
| `error` | `ai.stream/error` | Error banner |
| `tool_start` | `ai.stream/tool_start` | Tool execution started |
| `tool_done` | `ai.stream/tool_done` | Tool execution completed |
| `tool_cancelled` | `ai.stream/tool_cancelled` | Tool aborted (user pressed ESC) |
| `aborted` | `ai.stream/aborted` | Turn aborted |
| `user` | `ai.stream/prompt_dispatched` | User entry in timeline |
| `pending_queue` | `ai.stream/pending_queue` | Queue snapshot for UI |
| `compaction` | `ai.stream/compaction` | Context compaction completed |
| `compaction_start` | `ai.stream/compaction_start` | Context compaction starting |
| `timeline_entry` | `chat.timeline` | Plugin custom timeline entry |

### Why `type:"user"` is NOT emitted on `POST /chat/send`

Timeline entries reflect **what was sent to the AI**, not **what arrived at the HTTP endpoint**. A message may sit in the queue for seconds before being dispatched. The `type:"user"` SSE fires when the message actually goes to the provider (via `ai.stream/prompt_dispatched`), not when the HTTP request lands.

---

## Message Queue

When a session is busy, incoming messages are queued rather than dropped or interrupting the current turn.

### Queue Lifecycle

```
ai.request arrives → session busy?
    YES → pendingPrompts[sessionId].push(msg)
          broadcast pending_queue snapshot to UI
    NO  → dispatch immediately

Turn completes →
    drainQueue(sessionId)
        → snapshot all queued items
        → combine texts (N messages → 1 API call, saves tokens)
        → broadcastPromptDispatched (N items → N UI entries)
        → broadcastPendingQueue (empty → UI clears queue list)
        → dispatchToSession (merged text)
```

### N-to-1 Combining

Multiple queued messages are combined into a single API call (joined with `\n\n`) to reduce token usage. The HUD timeline still shows one entry per original message because `broadcastPromptDispatched` receives the original `items` array.

---

## Abort (ESC Key)

When the user presses ESC:

1. Browser sends `POST /chat/abort` with `{ sessionId }`.
2. `JarvisCore.abortSession(sessionId)` is called.
3. In-flight AI stream is cancelled via `SessionManager.abort()`.
4. **Pending queue is preserved** — abort cancels the current turn, not queued work.
5. Queued messages are immediately drained (`drainQueue` is called after abort).
6. If the session was in `waiting_tools`: tool history is cleaned up (orphaned tool blocks removed from message history) and `tool_cancelled` events are published.
7. `ai.stream/aborted` is published for the session.

### Race Condition: ESC during `processing` while API is resolving

A subtle race exists when the user presses ESC while the AI provider is about to return a `tool_use` response:

- `abortSession` fires `AbortController.abort()` and transitions state to `idle`.
- Concurrently, `streamFromAPI` already has the final API response in memory (`await finalMessage()` resolved just before the signal arrived).
- Without a guard, `streamFromAPI` would push `assistant[tool_use]` to message history — but `consumeStream` would detect the stale trace ID and return without registering `pendingToolCalls` or calling `addToolResults`. Result: orphan `tool_use` in history → 400 on the next turn.

**Fix (implemented in `session.ts`):** before pushing the assistant message, check `abortController.signal.aborted`. If true, skip the push entirely and log. This closes the race at the source rather than requiring downstream cleanup.

### Queue Preservation on Abort

A key invariant: the pending queue survives an abort. The UI shows the queue during the pre-drain moment, then messages transition to the chat as user entries when the drain fires.

---

## Session Multiplexing

Each session has its own SSE connection pool (`streamClients[sessionId]`). This enables:

- Multiple sessions open simultaneously (main + actor panels).
- Multiple browser tabs watching the same session.
- Correct routing of events to the right panel.

Sessions are not restricted by prefix — `main`, `actor-*`, `grpc-*`, or any custom ID all work identically.

---

## History Rehydration

On browser connect or reconnect, the frontend calls `GET /chat/history?sessionId=X`:

1. `ChatPiece.handleHistory()` retrieves raw messages from `SessionManager`.
2. `parseMessagesToHistory()` converts Anthropic-format message arrays into structured timeline entries.
3. `jarvis_ask_choice` tool calls are parsed into `kind:"choice"` entries; their answers are extracted from subsequent `[choice]` user messages.
4. For `sessionId === "main"`: a pending greeting (set during `consumeStartupPrompt`) is appended once if present.

Messages delivered only via SSE (not persisted in session history) are **not** visible on reconnect — they are gone. This is a known limitation of the SSE-only delivery path.

---

## Choice System

`jarvis_ask_choice` tool calls produce interactive choice cards in the HUD. The parsing is handled by `parseMessagesToHistory()`.

### Parsing Flow

```
assistant turn: tool_use jarvis_ask_choice { question, options, ... }
    → creates kind:"choice" entry
    → pushed to pendingQueue (FIFO)

user turn: "[choice] <question> → <answer>"
    → consumeChoiceAnswer() called
    → matches against pendingQueue by question text
    → fills entry.answers
    → user message is suppressed from timeline (not shown as user entry)
```

### FIFO Invariant

Multiple simultaneous pending choices are tracked in order. FIFO matching ensures earlier choices are answered before later ones. Without FIFO, a later choice would overwrite an earlier pending entry, causing its answer to never be consumed.

### Other (Free-Text) Answers

When a user provides a free-text "Other" answer, `OTHER_VALUE = "__other__"` is stored as the option value alongside the free text. `allow_other` defaults to `true` — it is opt-out, not opt-in.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Queue survives abort | Abort = "cancel current request", not "cancel all work" |
| Abort guard before assistant message push | Closes race between ESC and `finalMessage()` resolving — prevents orphan `tool_use` when API returns `stop_reason:"tool_use"` milliseconds after abort is signalled |
| N queued messages → 1 API call | Token efficiency; display still shows N entries via `prompt_dispatched` items |
| `type:"user"` fires at dispatch, not at HTTP receive | Timeline must reflect "what was sent to the AI", not "what arrived at the boundary" |
| `prompt_dispatched` not in public `AIStreamMessage` union | Keeps plugin API surface stable; internal detail that may change |
| `pending_queue` not in public union | Same rationale |
| `allow_other` defaults to `true` | Inclusive UX default; explicit `false` required to disable |
| FIFO choice queue | Prevents later choices overwriting earlier unanswered ones |
| `ChatPiece` is session-agnostic | Routes events for any `sessionId` — no hardcoded `"main"` dependency |

---

## Related

- `docs/modules/core/jarvis-core.md` — JarvisCore state machine detail
- `docs/modules/core/session-manager.md` — Session lifecycle
- `docs/features/bdd/chat.feature` — BDD scenarios
- `src/input/chat-piece.ts`
- `src/core/jarvis.ts`
