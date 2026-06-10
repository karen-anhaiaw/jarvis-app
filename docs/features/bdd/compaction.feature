Feature: Session Compaction

  Background:
    Given an AnthropicSession with label "test-session"
    And the session model is "claude-sonnet-4-6"
    And compaction is enabled in settings

  # ── Forced compaction ──────────────────────────────────────────────────────

  Scenario: Force compact with messages
    Given the session has 50 messages
    When forceCompact() is called
    Then a compaction_start event is emitted with engine "fallback" and reason "forced"
    And the summarizer is called with the session's current model (not utility/haiku)
    And a compaction event is emitted with tokensBefore > 0
    And the session messages are replaced with 2 synthetic messages
    And injectedContextCount is reset to 0
    And previousRealInputTokens is reset to 0

  Scenario: Force compact with no messages is a no-op
    Given the session has 0 messages
    When forceCompact() is called
    Then no events are emitted
    And the session messages remain empty

  # ── Absolute threshold ─────────────────────────────────────────────────────

  Scenario: Auto-compact triggers at 80% context window
    Given the context window is 1,000,000 tokens
    And the last real input tokens is 800,000 (80%)
    When an API response completes
    Then fallbackCompact is triggered
    And a compaction_start event is emitted with reason "threshold"
    And consecutiveFallbacks is incremented

  Scenario: Auto-compact does not trigger below 80% threshold
    Given the context window is 1,000,000 tokens
    And the last real input tokens is 799,999 (79.9%)
    When an API response completes
    Then fallbackCompact is NOT triggered
    And consecutiveFallbacks is reset to 0

  Scenario: Max consecutive fallbacks blocks further compaction
    Given consecutiveFallbacks is 2 (at MAX_CONSECUTIVE_FALLBACKS)
    And last real input tokens exceeds 80% threshold
    When an API response completes
    Then fallbackCompact emits a compaction event with summary warning the user
    And no summarizer call is made
    And no compaction_start event is emitted

  # ── Abrupt growth ──────────────────────────────────────────────────────────

  Scenario: Auto-compact triggers on abrupt context growth
    Given previousRealInputTokens is 400,000
    And the last real input tokens is 470,000 (+17.5%, above 15% threshold)
    And the absolute threshold (80%) has NOT been reached
    When an API response completes
    Then abrupt-growth compaction is triggered
    And a compaction_start event is emitted with reason "growth"
    And consecutiveFallbacks is NOT incremented

  Scenario: Abrupt growth check does not trigger below 15% delta
    Given previousRealInputTokens is 400,000
    And the last real input tokens is 459,000 (+14.75%, below 15% threshold)
    When an API response completes
    Then abrupt-growth compaction is NOT triggered

  Scenario: Abrupt growth check skipped when previousRealInputTokens is 0
    Given previousRealInputTokens is 0 (fresh session or post-compaction)
    And the last real input tokens is 500,000
    When an API response completes
    Then abrupt-growth compaction is NOT triggered

  Scenario: Both triggers present — absolute threshold wins, growth skipped
    Given previousRealInputTokens is 400,000
    And the last real input tokens is 820,000 (exceeds both 80% threshold AND +15% growth)
    When an API response completes
    Then only one compaction runs (absolute threshold path)
    And abrupt-growth check does not run a second compaction

  # ── Model selection ────────────────────────────────────────────────────────

  Scenario: Compaction uses session model, not utility model
    Given the session has stickyModelOverride "claude-opus-4-5"
    When compaction runs (any trigger)
    Then the summarizer API call uses model "claude-opus-4-5"

  Scenario: Compaction uses base model when no sticky override
    Given the session has no stickyModelOverride
    And the base model is "claude-sonnet-4-6"
    When compaction runs (any trigger)
    Then the summarizer API call uses model "claude-sonnet-4-6"

  # ── State reset after compaction ───────────────────────────────────────────

  Scenario: previousRealInputTokens resets after compaction
    Given compaction completes successfully
    Then previousRealInputTokens is 0
    And on the next turn, abrupt-growth check is skipped (previousRealInputTokens == 0)

  # ── Sliding-window — turn semantics ────────────────────────────────────────

  Scenario: A logical turn includes the entire assistant tool loop
    Given a user prompt that triggers 30 assistant tool_use rounds before the final text answer
    When findUserTurnStarts() is called
    Then exactly ONE turn start is recorded for that prompt
    And the 30 tool_use / tool_result messages do NOT each count as a turn

  Scenario: Sliding window does not fire mid-tool-loop
    Given the session has more than SLIDING_START_TURN turns and the interval modulo matches
    And the last API response had stop_reason "tool_use"
    When the post-message compaction checks run
    Then slidingWindowCompact returns immediately without emitting events
    And no compaction_start is broadcast for the in-flight turn

  Scenario: Sliding window fires once at the end of a tool-loop turn
    Given a single user prompt produces 5 tool_use rounds + 1 final text response
    And the turn counter reaches SLIDING_START_TURN exactly on the final response
    When the post-message compaction checks run
    Then slidingWindowCompact runs exactly ONCE for this turn (on the final response, not on any tool round)

  # ── Sliding-window — turn-aligned split ────────────────────────────────────

  Scenario: Split is the start of the (N+1)-th turn, not a fixed message index
    Given SLIDING_CHUNK_TURNS = 10
    And turnStarts = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, ...] (mixed tool/no-tool turns)
    When sliding-window compaction runs
    Then splitAt equals turnStarts[10] (= 24 in this example)
    And messages.slice(0, splitAt) contains exactly 10 complete logical turns
    And remaining[0] is a non-tool_result-leading user message
    And no orphan tool_use/tool_result pair is created at the boundary

  Scenario: Sliding window absorbs pre-existing orphans in remaining via final sanitize
    Given remaining contains a legacy orphan tool_result inherited from a restored session
    When sliding-window compaction reconstructs the history
    Then sanitizeMessages is applied to the full reconstructed array
    And the orphan is replaced by a synthetic placeholder before the next API call

  # ── Turn counter is derived from history ──────────────────────────────────

  Scenario: Turn count survives restore
    Given a saved session whose history contains 35 user-turn starts
    When the session is restored from disk
    And the post-message compaction checks run after the first new turn
    Then findUserTurnStarts() returns 36 (35 historical + 1 new)
    And sliding-window fires because turnCount >= SLIDING_START_TURN

  Scenario: Synthetic summary counts as a fresh turn for the next cycle
    Given sliding-window just compacted 10 turns into [user(summary), assistant(ack), ...remaining]
    When findUserTurnStarts() is called on the new history
    Then user(summary) is recognized as turn #1 (it does NOT start with tool_result)
    And the next sliding-window cycle counts subsequent real user prompts on top of it

  Scenario: Second sliding-window compaction replaces the first summary, not accumulates
    Given the session had a first sliding-window compaction producing [user(summary_1), assistant(ack), ...turns_1..N]
    And enough additional turns have passed to trigger a second compaction
    When slidingWindowCompact runs again
    Then the oldest N turns (including summary_1 and assistant(ack)) are compacted into summary_2
    And this.messages is reconstructed as [user(summary_2), assistant(ack), ...remaining_turns]
    And there is exactly ONE summary block at position [0] (summary_1 is gone)
    And the message count decreases by the number of turns compacted

  # ── Failure semantics — history must never be destroyed ────────────────────
  # Added after the 2026-06-10 incident: a forced compaction on a 734k-token
  # session received an empty summarizer response (summaryLength: 0) and
  # replaced the entire history with it. These scenarios pin the contract:
  # compaction either produces a usable summary or changes NOTHING.

  Scenario: Empty summary aborts compaction and preserves history
    Given the session has 50 messages
    And the summarizer responds with zero text blocks
    When doCompact runs (any trigger)
    Then the session messages are NOT replaced
    And a compaction_failed event is emitted with engine "fallback" and a reason mentioning "empty"
    And no compaction event is emitted

  Scenario: Whitespace-only summary is treated as empty
    Given the summarizer responds with whitespace-only text
    When doCompact runs
    Then the session messages are NOT replaced
    And a compaction_failed event is emitted

  Scenario: Suspiciously short summary for a large context aborts compaction
    Given tokensBefore is 700,000 (above the 10,000-token floor-activation threshold)
    And the summarizer returns a summary below the 50-char floor
    When doCompact runs
    Then the session messages are NOT replaced
    And a compaction_failed event is emitted with a reason mentioning "short"

  Scenario: Short summary for a small context is accepted
    Given tokensBefore is 800 (below the 10,000-token floor-activation threshold)
    And the summarizer returns a 20-char summary
    When doCompact runs
    Then compaction completes normally (small sessions can have tiny summaries)

  Scenario: max_tokens exhaustion with no text triggers exactly one retry with a larger budget
    Given the summarizer first responds with stop_reason "max_tokens" and only thinking blocks (no text)
    And the second call returns a valid summary
    When doCompact runs
    Then the summarizer is called exactly twice
    And the second call uses a 4x max_tokens budget clamped to the model's output ceiling
    And compaction completes with the retry's summary

  Scenario: Retry also empty — compaction fails without touching history
    Given both summarizer calls return stop_reason "max_tokens" with zero text
    When doCompact runs
    Then the summarizer is called exactly twice (no infinite retry)
    And the session messages are NOT replaced
    And a compaction_failed event is emitted

  Scenario: Summarizer API error emits compaction_failed instead of silent swallow
    Given the summarizer call rejects with a 400 error
    When doCompact runs
    Then the error is logged
    And a compaction_failed event is emitted with the error message in the reason
    And the session messages are NOT replaced

  Scenario: doCompact sanitizes history before the summarizer call
    Given the session history contains an orphan tool_use without a matching tool_result
    When doCompact runs
    Then the messages sent to the summarizer contain a synthetic tool_result placeholder for the orphan
    And the in-memory session history is not mutated by the sanitization

  Scenario: Pre-compact backup is written before history replacement
    Given the summarizer returns a valid summary
    When doCompact runs
    Then the full pre-compaction history is written to sessions/archive/<label>_precompact_<timestamp>.json
    And the backup is NOT trimmed to MAX_MESSAGES
    And only then are the session messages replaced

  Scenario: Backup write failure aborts compaction
    Given the pre-compact backup write fails
    When doCompact runs
    Then the session messages are NOT replaced
    And a compaction_failed event is emitted with a reason mentioning "backup"

  Scenario: Old pre-compact backups are pruned
    Given 6 pre-compact backups already exist for the session label
    When a new backup is written
    Then only the newest 5 backups remain for that label

  Scenario: Summarizer usage is recorded with diagnostics
    Given the summarizer returns any response
    When doCompact runs
    Then stop_reason, content block types, and summary length are logged
    And the summarizer token usage is appended to usage.log

  Scenario: compaction_failed resolves the pending banner in the UI
    Given a compaction_pending banner is displayed (Engine B started)
    When a compaction_failed event arrives via SSE
    Then the pending banner is replaced by a failure banner stating history was preserved
