# Compaction

## Intent

Prevent AI sessions from hitting context window limits by summarizing conversation history
when the context grows too large. The summary replaces the full history, preserving key
decisions and progress while dramatically reducing token count.

## Engines

### Engine A — API-native (`compact-2026-01-12` beta)
**Status: intentionally disabled.**

Compacts silently without producing a visible summary or notifying the user. Rejected because
context loss is undetectable — there is no way to audit what was dropped. Engine B is the
only active compaction path.

### Engine B — Manual summarization (active)
Sends the full message history to the session's current model, receives a structured summary,
and replaces the history with two synthetic messages (`[Previous conversation summary]` /
`Understood...`). Produces a visible banner in the chat UI so the user knows compaction
happened.

## Trigger Priority Order

When multiple triggers could fire in the same turn, only one runs — first wins:

1. **Sliding window** (proactive, turn-based) — runs first
2. **Absolute threshold** (80%) — runs if sliding window didn't fire
3. **Abrupt growth** (+15%) — runs if neither of the above fired

## Triggers

### Sliding window (proactive)

Unit of work: **logical turn**. A turn is "one real user prompt + everything the
assistant does in response (the entire tool loop until a non-`tool_use` stop)".
A tool loop with 30 `tool_use` rounds is still **one** turn. Turns are detected
by scanning the history for `user` messages whose first content block is NOT a
`tool_result` (`findUserTurnStarts`).

After `SLIDING_START_TURN` turns (default: 30), fires every `SLIDING_INTERVAL`
turns (default: 10). Compacts the `SLIDING_CHUNK_TURNS` oldest **turns**
(default: 10) into a summary block prepended before the remaining turns.

Unlike full compaction, sliding window is **incremental** — each compaction
replaces the previous summary (and the oldest N turns it covers) with a new,
updated summary. The result is always a single summary block at position [0]
followed by the remaining recent turns. Summaries do not accumulate; each
compaction rolls the window forward.

Skipped if `turnCount < SLIDING_CHUNK_TURNS + 1` (need at least one turn left
after compaction).

**Gating: never mid-tool-loop.** The compactor receives `stop_reason` and
bails out immediately when `stop_reason === "tool_use"`. The current turn is
still being built — compacting now would either split the in-flight turn or
fire the same trigger N times within one user prompt (one per tool round).

**Turn-aligned split.** The slice boundary is
`turnStarts[SLIDING_CHUNK_TURNS]` — by construction the start of a fresh user
prompt. This eliminates the orphan `tool_use` / `tool_result` failure mode at
the boundary, because there is no way to cut a tool pair when you only ever
slice between turns. As a belt-and-braces measure, `sanitizeMessages` is also
called on the final reconstructed history to absorb any pre-existing orphans
inherited from restored or aborted sessions.

**Turn counter is derived, not stored.** `turnCount` is computed from the
message history (length of `findUserTurnStarts()`) rather than from an
in-memory field. This means the schedule survives session restore — a session
loaded from disk picks up exactly where it left off.

### Forced (`/compact` slash command)
User explicitly requests compaction. Bypasses all threshold checks and consecutive-fallback
guards. Always runs if there are messages.

### Automatic — absolute threshold
After every API response, Engine B checks if real input tokens exceeded a configured
percentage of the context window (default: **80%**). If so, compaction runs automatically.

### Automatic — abrupt growth
After every API response, Engine B also checks if real input tokens grew by more than a
configured percentage in a single turn (default: **+15%**). This catches large log dumps,
trace outputs, or tool results that spike the context suddenly, even if the absolute threshold
hasn't been reached yet.

## Design Decisions

### Same model for summarization
Compaction uses `stickyModelOverride ?? getBaseModel()` — the same model the session is
already using. The previous approach used a Haiku utility model, which silently truncated
large contexts (~1M tokens) because Haiku's context window (~200k) is far smaller than
Sonnet/Opus. Using the session model ensures the summarizer can actually process the full
history.

### Consecutive fallback guard
`MAX_CONSECUTIVE_FALLBACKS = 2` — if two consecutive compaction attempts don't reduce the
context below threshold, stop trying and warn the user. Prevents infinite compaction loops.
The abrupt-growth trigger does NOT increment this counter — it is a separate, independent
check.

### Token measurement
`lastRealInputTokens` — the actual billed input token count from the last API response
(input + cache_creation + cache_read). Used as the source of truth for threshold checks.
The `chars/4` heuristic underestimates by 3-4x for sessions with many tool calls.

### Previous tokens tracking
`previousRealInputTokens` — snapshot of `lastRealInputTokens` taken before each API call.
Used to compute the delta for abrupt-growth detection. Reset to 0 after compaction (since
history is replaced, the "previous" baseline is no longer meaningful).

## Invariants

- Engine A is permanently disabled. Do not re-enable without a visible summary mechanism.
- Sliding window NEVER runs while `stop_reason === "tool_use"` — only at logical turn ends. Threshold and growth still run on every API response (they protect against overflow regardless of turn structure).
- After full compaction (`doCompact`), `injectedContextCount` and `previousRealInputTokens` are reset to 0.
- Sliding window does NOT reset `injectedContextCount` or `previousRealInputTokens` — it preserves recent turns.
- The abrupt-growth trigger does not increment `consecutiveFallbacks` — it is a distinct code path.
- Only one compaction trigger fires per turn (priority: sliding > threshold > growth).
- `turnCount` is **derived** from the message history (count of non-`tool_result`-leading user messages), not stored. Survives restore.
- Sliding window slice boundary MUST be a turn boundary (`turnStarts[N]`). This makes splitting a `tool_use` / `tool_result` pair impossible by construction.
