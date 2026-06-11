# Module: AnthropicSession

**File:** `app/src/ai/anthropic/session.ts`  
**Implements:** `AISession`

## Responsibility

Manages a single stateful conversation with the Anthropic API. Handles message history,
streaming, tool calls, model overrides, context injection, and compaction.

## Key Fields

| Field | Type | Description |
|---|---|---|
| `messages` | `MessageParam[]` | Full conversation history sent to the API on every turn |
| `lastRealInputTokens` | `number` | Actual billed input tokens from the last API response (input + cache_creation + cache_read). Source of truth for compaction thresholds. |
| `previousRealInputTokens` | `number` | Snapshot of `lastRealInputTokens` taken before each API call. Used for abrupt-growth detection. Reset to 0 after compaction. |
| `consecutiveFallbacks` | `number` | Counts consecutive auto-compaction attempts that failed to reduce context below threshold. Capped at `MAX_CONSECUTIVE_FALLBACKS`. |
| `betaDisabledUntil` | `number` | Timestamp until which the beta headers (`compact-2026-01-12`, `context-1m`) are suppressed after an API error. |
| `stickyModelOverride` | `string?` | Model override that persists across turns (set via `model_set`). Wins over base model. |
| `nextModelOverride` | `string?` | One-shot model override, consumed on first read within a turn. Wins over sticky. |
| `injectedContextCount` | `number` | Tracks ephemeral injected messages (Mnemosyne memories). Reset after compaction. |

## Key Methods

| Method | Description |
|---|---|
| `send(prompt, images?)` | Main entry point. Streams a full turn including tool loop. |
| `forceCompact()` | Engine B compaction bypassing all threshold checks. Called by `/compact`. |
| `fallbackCompact(lastInputTokens)` | Auto-compaction: checks absolute threshold (80%) and triggers `doCompact`. |
| `doCompact(tokensBefore, reason)` | Core compaction: sanitizes a copy of history, summarizes via session model (with diagnostics + `usage.log` recording, one `max_tokens` retry), writes pre-compact backup, then replaces messages. On ANY failure (empty/short summary, backup write error, API error) history is preserved and `compaction_failed` is emitted. |
| `measureContext()` | Returns estimated token counts for system, tools, messages, and total. |
| `getModel()` | Resolves model priority: nextModelOverride → stickyModelOverride → baseModel. |
| `setMessages(messages)` | Restores history from persistence (session save/restore). |
| `getHistory()` | Returns filtered message history (excludes ephemeral injected messages). |

## Compaction

Three automatic triggers, checked after every API response (priority order — first wins):

1. **Sliding window** — proactive, turn-aware. After `SLIDING_START_TURN` logical
   turns, every `SLIDING_INTERVAL` turns, compacts the oldest
   `SLIDING_CHUNK_TURNS` turns. Gated on `stop_reason !== "tool_use"` — never
   fires mid-tool-loop. Slice boundary is always a fresh user prompt
   (`turnStarts[N]`), so no `tool_use`/`tool_result` pair is ever cut. Turn
   count is **derived from history** (`findUserTurnStarts().length`), not
   stored, so it survives restore.
2. **Absolute threshold** — `lastRealInputTokens ≥ 80% of getMaxContext()` → `fallbackCompact`.
3. **Abrupt growth** — `lastRealInputTokens > previousRealInputTokens * 1.15` AND `previousRealInputTokens > 0` → `doCompact` with reason `"growth"`.

Threshold and growth use `doCompact` (full replacement). Sliding window uses
its own inline path because it's additive (summary prepended, recent turns
preserved). The abrupt-growth path does NOT increment `consecutiveFallbacks`.

The summarizer uses `stickyModelOverride ?? getBaseModel()` — never the utility/Haiku model.
See `docs/features/compaction.md` for full design rationale.

### Turn definition

A **logical turn** is one real user prompt + everything the assistant does in
response (the entire tool loop until a non-`tool_use` stop). An assistant that
runs 30 `tool_use` rounds is still part of ONE turn. Turn starts are user
messages whose first content block is NOT a `tool_result`.

## Model Resolution

```
nextModelOverride (consumed after use)
  → stickyModelOverride (persists until cleared)
    → getBaseModel() (dynamic, reads from config.model)
```

## Invariants

- Messages always alternate user/assistant roles (enforced by `validateAlternation`).
- Engine A (`compact-2026-01-12`) is intentionally disabled — never re-enable without visible summary.
- `previousRealInputTokens` is always 0 after compaction — abrupt-growth check skips when 0.
- `injectedContextCount` is reset to 0 after any compaction.
- Tool calls cleaned up via `cleanupAbortedToolMessages` on abort/close.
- `doCompact` failure paths (empty/short summary, backup write error, API error) NEVER touch `this.messages` — they emit `compaction_failed` (event type outside the public union, forwarded via cast like `compaction_start`).
- The summarizer copy is sanitized (`sanitizeMessages`) and its usage recorded to `usage.log` on every round-trip.
- Full pre-compaction history is archived via `archivePreCompactBackup` (conversation-store, untrimmed, newest 5 per label) before any replacement.
- If `abortController.signal.aborted` is true when `streamFromAPI` is about to push the assistant message, the push is skipped entirely. This prevents an orphan `tool_use` block (no matching `tool_result`) when the API resolves just as the user presses ESC — the race condition that was causing 400 errors on the next turn.
