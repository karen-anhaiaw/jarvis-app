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
