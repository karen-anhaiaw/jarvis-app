Feature: Turn Tracker — per-turn lifecycle aggregation (F5, Pillar B)
  One TurnSummary per conversation turn, published as system.event turn.summary.
  A turn = one traceId: prompt dispatch → session idle (1..N API round-trips).

  Background:
    Given a TurnTracker wired to a capturing EventBus

  # ── Lifecycle ──────────────────────────────────────────────────────────

  Scenario: Simple text-only turn produces a completed summary
    Given a turn begins for session "main" with traceId "t1" and source "chat-input"
    And the first text delta arrives 120ms after begin
    And a round-trip completes with usage input=100 output=50 cacheRead=1000 cacheWrite=200, stopReason "end_turn" and model "claude-opus-4-8"
    When the turn completes
    Then exactly one system.event "turn.summary" is published
    And the summary has outcome "completed", roundTrips 1, source "chat-input"
    And the summary ttftMs is approximately 120ms
    And the summary usage is input=100 output=50 cacheRead=1000 cacheWrite=200 totalInput=1300 total=1350
    And the summary stopReason is "end_turn" and model is "claude-opus-4-8"
    And the summary tools list is empty

  Scenario: Turn with one tool loop accumulates usage and tool stats
    Given a turn begins for session "main" with traceId "t2" and source "chat-input"
    And a round-trip completes with usage input=100 output=20, stopReason "tool_use" and model "m"
    And tools are dispatched: "bash" (id "tu1") and "read_file" (id "tu2")
    And tool results complete: "tu1" in 350ms with no error, "tu2" in 80ms with error
    And a round-trip completes with usage input=200 output=60, stopReason "end_turn" and model "m"
    When the turn completes
    Then the summary has roundTrips 2
    And the summary usage input is 300 and output is 80
    And the summary tools contain "bash" with durationMs 350 and isError false
    And the summary tools contain "read_file" with durationMs 80 and isError true
    And the summary stopReason is "end_turn"

  Scenario: Aborted turn closes with outcome aborted and keeps partial data
    Given a turn begins for session "main" with traceId "t3" and source "chat-input"
    And a round-trip completes with usage input=100 output=20, stopReason "tool_use" and model "m"
    And tools are dispatched: "bash" (id "tu9")
    When the turn is aborted
    Then exactly one system.event "turn.summary" is published
    And the summary has outcome "aborted" and roundTrips 1
    And the summary tools contain "bash" with no durationMs and isError false

  Scenario: Provider error closes the turn with outcome error
    Given a turn begins for session "main" with traceId "t4" and source "cron"
    When the turn errors with message "boom"
    Then the summary has outcome "error" and error "boom" and source "cron"

  # ── Idempotence / guards ───────────────────────────────────────────────

  Scenario: Closing a turn twice publishes only one summary
    Given a turn begins for session "main" with traceId "t5" and source "chat-input"
    And the turn completes
    When the turn is aborted
    Then exactly one system.event "turn.summary" is published

  Scenario: Closing an unknown trace is a no-op
    When a complete arrives for session "main" with unknown traceId "ghost"
    Then no system.event "turn.summary" is published

  Scenario: Accumulation events for a stale traceId are ignored
    Given a turn begins for session "main" with traceId "t6" and source "chat-input"
    When a round-trip with usage input=999 output=999 arrives for traceId "stale"
    And the turn completes
    Then the summary usage input is 0 and output is 0

  Scenario: A new begin for the same session force-closes a leaked open turn
    Given a turn begins for session "main" with traceId "t7" and source "chat-input"
    When a turn begins for session "main" with traceId "t8" and source "chat-input"
    Then a summary for traceId "t7" with outcome "error" and error "superseded" is published
    And the open turn for session "main" has traceId "t8"

  Scenario: Concurrent sessions track independent turns
    Given a turn begins for session "main" with traceId "tA" and source "chat-input"
    And a turn begins for session "actor-alice" with traceId "tB" and source "bus"
    When the turn for session "main" completes
    Then exactly one summary is published and its traceId is "tA"
    And the open turn for session "actor-alice" has traceId "tB"

  # ── TTFT ───────────────────────────────────────────────────────────────

  Scenario: Only the first delta sets TTFT
    Given a turn begins for session "main" with traceId "t9" and source "chat-input"
    And the first text delta arrives 100ms after begin
    And another text delta arrives 500ms after begin
    When the turn completes
    Then the summary ttftMs is approximately 100ms

  Scenario: A turn with no text deltas has no ttftMs
    Given a turn begins for session "main" with traceId "t10" and source "chat-input"
    When the turn completes
    Then the summary has no ttftMs

  # ── Cost estimation ────────────────────────────────────────────────────

  Scenario Outline: Cost is estimated for known model families
    Given pricing for model "<model>"
    When I estimate cost for usage input=1000000 output=1000000 cacheRead=1000000 cacheWrite=1000000
    Then the estimate is <usd> USD

    Examples:
      | model               | usd    |
      | claude-opus-4-8     | 110.25 |
      | claude-sonnet-4-6   | 22.05  |
      | claude-haiku-4-5    | 5.88   |

  Scenario: Unknown model family yields no cost
    Given pricing for model "claude-fable-5"
    When I estimate cost for usage input=1000 output=1000 cacheRead=0 cacheWrite=0
    Then the estimate is undefined

  # ── Tool duration plumbing ─────────────────────────────────────────────

  Scenario: Registry stamps per-call durationMs on results
    Given a registry with a tool "sleepy" that takes ~50ms
    When the registry executes a call to "sleepy"
    Then the result carries durationMs >= 50
    And the result durationMs is independent per call in a parallel batch

  Scenario: durationMs never reaches the provider API payload
    Given an Anthropic session with a pending tool_use "tu1"
    When addToolResults receives a result for "tu1" with durationMs 123
    Then the appended history tool_result block has no durationMs field

  # ── Ring buffer / derived metrics ──────────────────────────────────────

  Scenario: Tracker keeps only the last N summaries
    Given a tracker with capacity 3
    When 5 turns complete
    Then recent() returns the 3 newest summaries in reverse-chronological order

  Scenario: Percentile helper computes p50 and p95 over tool durations
    Given completed turns with tool durations [10, 20, 30, 40, 100]
    Then toolLatencyPercentiles() reports p50 30 and p95 100
