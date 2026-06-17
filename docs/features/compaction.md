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

`measureContext` (F-compact-2.5) counts image blocks at a flat **6,400 chars (≈1.6k
tokens)** regardless of base64 payload size — Anthropic bills images by dimensions, not
bytes, and an 800px-wide JPEG lands around 1.6k tokens. It also recurses into
`tool_result` nested content (string or block array); before this, everything inside a
tool_result contributed **zero** chars, making tool-heavy histories invisible to the
heuristic. The heuristic feeds display/routing only — triggers always use real tokens.

### Summarizer prompt-shape hardening (F-compact-2, incident #2 2026-06-10)

Incident #2: a growth-triggered auto-compact ran on a history whose trailing orphan
`tool_use` had been stripped by `sanitizeMessages`, leaving a user `tool_result` as the
last message. The old code only appended the "Please summarize" instruction after an
assistant message — so the summarizer received a conversation with NO final instruction
and role-played the next turn instead of summarizing (84 chars of fiction containing a
hallucinated user instruction, which post-compact JARVIS believed). Three structural
fixes, applied to BOTH `doCompact` and the sliding-window summarizer:

1. **Instruction always present** — `buildSummarizerMessages` guarantees the summarize
   instruction is the final user content regardless of how the history ends: appended as
   a new user message (after assistant), merged into string content (plain-text user
   tail), or appended as a trailing text block (tool_result tail — keeps the
   no-consecutive-user shape).
2. **Assistant prefill `<summary>`** — the request ends with a prefilled assistant
   message containing `<summary>`. The model can only CONTINUE a summary; starting a
   roleplay turn is structurally impossible. Extraction prepends the prefilled tag
   before matching (`extractSummary`), tolerates re-emitted opening tags, and falls back
   to raw text when the closing tag is missing.
3. **Thinking disabled** — `thinking: { type: "disabled" }` on summarizer calls.
   Prefill is incompatible with extended thinking, and thinking blocks were burning the
   output budget (the max_tokens retry existed for exactly that). The retry is kept as
   defense in depth.

### Previous tokens tracking
`previousRealInputTokens` — snapshot of `lastRealInputTokens` taken before each API call.
Used to compute the delta for abrupt-growth detection. Reset to 0 after compaction (since
history is replaced, the "previous" baseline is no longer meaningful).

## Failure Semantics — history must never be destroyed

> Added after the 2026-06-10 incident: a forced compaction (`POST /chat/compact`) on a
> 734k-token session received an empty summarizer response (`summaryLength: 0`) and
> replaced the entire history with it, unrecoverably. Four compounding gaps: no
> empty-summary guard, the summarizer call skipped `sanitizeMessages` (an earlier
> auto-compact had 400'd on an orphan `tool_use` and was silently swallowed), no
> response diagnostics (the call also bypassed `usage.log`), and no failure event
> (the UI banner hung forever).

`doCompact` either produces a usable summary or changes NOTHING:

1. **Sanitize first** — the message copy sent to the summarizer goes through
   `sanitizeMessages` (it was the only API call site that didn't). The in-memory
   history is not mutated by this pass.
2. **Diagnostics always** — every summarizer round-trip logs `stop_reason`, content
   block types, and summary length, and records token usage to `usage.log`
   (`logUsage`), so failures are diagnosable and billed usage is visible.
3. **Thinking-exhaustion retry** — `stop_reason === "max_tokens"` with zero text
   (adaptive-thinking models can burn the entire budget on thinking blocks) triggers
   exactly ONE retry with a 4x budget clamped to `getMaxOutput(model)`.
4. **Empty/short guard (proportional, F-compact-2.4)** — empty (post-trim) summaries
   are ALWAYS failures. For contexts above `LARGE_CONTEXT_TOKENS` (10k) the minimum
   summary length scales with context size — a large context cannot legitimately
   summarize to a tweet (incident #2: 84 chars passed the old absolute 50-char floor
   for a 416k-token context):
   | tokensBefore | floor |
   |---|---|
   | ≤ 10k | none |
   | 10k–50k | 50 chars |
   | 50k–200k | 300 chars |
   | > 200k | 800 chars |
5. **Pre-compact backup** — the FULL untrimmed history is archived to
   `sessions/archive/<label>_precompact_<timestamp>.json` (`archivePreCompactBackup`,
   newest 5 kept per label) BEFORE replacement. If the backup write fails, compaction
   ABORTS — an oversized context is recoverable, destroyed history is not.
6. **Visible failure** — every failure path yields `compaction_failed`
   (`{ engine, reason, tokensBefore }`). JarvisCore and `main.ts runCompaction`
   forward it to `ai.stream` (cast, like `compaction_start`) + `system.event`;
   ChatPiece flattens it over SSE; ChatPanel replaces the pending ⏳ banner with a
   red "Compaction failed — history preserved" entry.

## Invariants

- Engine A is permanently disabled. Do not re-enable without a visible summary mechanism.
- `doCompact` NEVER replaces history with an empty or unusable summary — failure paths leave `this.messages` untouched and emit `compaction_failed`.
- The pre-compact backup is written BEFORE history replacement; backup failure aborts compaction.
- The summarizer call always goes through `sanitizeMessages` and always records usage + `stop_reason` diagnostics.
- The `max_tokens` empty-text retry runs at most once per compaction attempt.
- The summarize instruction is ALWAYS the final user content of a summarizer request — regardless of whether the sanitized history ends in assistant, plain-text user, or tool_result user.
- Every summarizer request ends with the assistant prefill `<summary>` and carries `thinking: { type: "disabled" }` (prefill and extended thinking are mutually exclusive).
- Summary extraction prepends the prefilled `<summary>` tag before matching; a missing closing tag falls back to the raw response text.
- The short-summary floor is proportional to `tokensBefore` (50 / 300 / 800 chars at 10k / 50k / 200k) — never a single absolute constant.
- Sliding window NEVER runs while `stop_reason === "tool_use"` — only at logical turn ends. Threshold and growth still run on every API response (they protect against overflow regardless of turn structure).
- After full compaction (`doCompact`), `injectedContextCount` and `previousRealInputTokens` are reset to 0.
- Sliding window does NOT reset `injectedContextCount` or `previousRealInputTokens` — it preserves recent turns.
- The abrupt-growth trigger does not increment `consecutiveFallbacks` — it is a distinct code path.
- Only one compaction trigger fires per turn (priority: sliding > threshold > growth).
- `turnCount` is **derived** from the message history (count of non-`tool_result`-leading user messages), not stored. Survives restore.
- Sliding window slice boundary MUST be a turn boundary (`turnStarts[N]`). This makes splitting a `tool_use` / `tool_result` pair impossible by construction.
