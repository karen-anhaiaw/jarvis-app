Feature: OpenAI provider parity
  # WHY: the OpenAI session diverged from the Anthropic session in four ways
  # that corrupt history or pollute the bus (review 2026-06-10, B2-B4 + D5).
  # These scenarios pin the corrected contract.

  # ── F2.1: assistant text must survive tool calls (B2) ───────────────────
  # OpenAI allows an assistant message to carry BOTH content and tool_calls.
  # The old code discarded fullText whenever tool calls were present, and
  # addToolResults built the assistant message with tool_calls only — the
  # model's reasoning before the tools vanished from history.

  Scenario: Assistant text with tool calls is preserved in history
    Given a stream that yields text "Let me check that file" and a tool call "read_file"
    When the stream completes and tool results are added
    Then the history's assistant message has content "Let me check that file"
    And the same assistant message carries the tool_calls

  Scenario: Text-only turn is saved as a plain assistant message
    Given a stream that yields only text "Done"
    When the stream completes
    Then the history ends with an assistant message with content "Done"

  Scenario: Pending text is consumed once
    Given a turn with text and tools followed by a text-only continuation
    When tool results are added and the continuation completes
    Then only the first assistant message carries the pre-tool text

  # ── F2.2: context injection must not fabricate turns (B3) ───────────────
  # The old injector pushed a fake user "<context>" + fake assistant
  # "Understood. I have the context." pair on EVERY injected turn —
  # permanent history pollution and growing token cost. Parity with
  # Anthropic: injections prepend to the REAL user message of the turn.

  Scenario: Injections prepend to the user message
    Given a context injector returning "memory snippet"
    When sendAndStream is called with prompt "hello"
    Then exactly ONE message is added to history before the API call
    And it is a user message containing "<context>" and "memory snippet" and "hello"
    And no assistant message saying "Understood" exists

  Scenario: No injections means the plain prompt
    Given a context injector returning nothing
    When sendAndStream is called with prompt "hello"
    Then the user message content is exactly "hello"

  # ── F2.3: no malformed events on the bus (B4) ────────────────────────────
  # The old code published ai.stream with `type: "delta"` — the channel
  # contract is `event:`. It fell through every switch silently and logged
  # as INFO noise. The streaming-verb/model payload now ships as the
  # internal event "streaming_started" (not in the public union — cast).

  Scenario: Streaming start is announced with a well-formed event
    When streamFromAPI begins
    Then the bus receives an ai.stream message with event "streaming_started"
    And it carries data.streamingVerb and data.model
    And no ai.stream message with a "type" field but no "event" field is published

  # ── F2.4: abort cleanup is additive, never destructive (D5) ──────────────
  # Old loop popped ALL trailing role:"tool" messages unconditionally —
  # destroying valid completed sequences and orphaning their assistant
  # tool_calls (API 400). Ported semantics from the tested Anthropic
  # cleanup: every tool_call id must end with a matching tool result;
  # missing pieces are ADDED with "[Tool execution was aborted by user]".

  Scenario: Abort before any tool message exists adds the full synthetic pair
    Given a history ending with a user message and pending calls [t1, t2]
    When cleanupAbortedTools runs
    Then an assistant message with tool_calls [t1, t2] is appended
    And tool result messages for t1 and t2 with the aborted notice are appended

  Scenario: Completed previous sequences are never touched
    Given a history with a COMPLETE tool sequence (assistant tool_calls + tool result)
    And pending calls for a new turn
    When cleanupAbortedTools runs
    Then the completed sequence is unchanged
    And only the pending pair is appended

  Scenario: Existing tool_call without result gains only the synthetic result
    Given a history where the assistant tool_calls for t1 already exist without a result
    When cleanupAbortedTools runs with pending [t1]
    Then no duplicate assistant message is added
    And a tool result for t1 with the aborted notice is appended

  Scenario: Orphaned non-pending tool_calls get emergency results
    Given a history containing an assistant tool_calls for tX with no result
    When cleanupAbortedTools runs with pending [t1]
    Then tX also receives a synthetic aborted result
    # Final invariant: NO tool_call id remains without a matching tool message.
