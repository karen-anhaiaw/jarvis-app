Feature: Phantom session prevention
  # WHY: SessionManager.get() lazily CREATES a session for any unknown id —
  # with the full default system prompt (expensive cache write) and NOT the
  # role the id originally had (e.g. a killed actor). Any code path that
  # passes an unvalidated session id into get() can therefore materialize a
  # "phantom": a full JARVIS session that answers as the wrong persona,
  # persists itself to disk on idle, and resurrects on the next reference.
  # Review 2026-06-10, findings G1 (inspector tools), G2 (cron fire),
  # G3 (bus_publish typos).

  # ── G1: session inspector tools ─────────────────────────────────────────

  Scenario: session_info on an unknown session returns an error
    Given no session named "ghost-x" exists
    When the session_info tool is called with session_id "ghost-x"
    Then the result is an error mentioning "not found"
    And the result lists the active session ids
    And no session named "ghost-x" was created

  Scenario: session_info on an existing session returns its metadata
    Given a session named "main" exists
    When the session_info tool is called with session_id "main"
    Then the result contains sessionId "main" and a messageCount

  Scenario: session_get_messages on an unknown session returns an error
    Given no session named "ghost-y" exists
    When the session_get_messages tool is called with session_id "ghost-y"
    Then the result is an error mentioning "not found"
    And no session named "ghost-y" was created

  Scenario: session_get_messages on an existing session returns history
    Given a session named "main" exists with 4 messages
    When the session_get_messages tool is called with session_id "main"
    Then the result contains total 4

  # ── G2: cron fire-time target validation ────────────────────────────────

  Scenario: prompt-mode cron job fires for a live target
    Given a session named "main" exists
    And a cron job with target "main"
    When the job fires
    Then an ai.request is published with target "main"

  Scenario: prompt-mode cron job with a dead target is skipped with a warning
    Given no session named "actor-dead" exists
    And a cron job with target "actor-dead"
    When the job fires
    Then no ai.request is published with target "actor-dead"
    And a warning is delivered to the default session mentioning the job id and dead target
    And the warning asks whether to keep or delete the job

  Scenario: delegate-mode cron result to a dead reply_to falls back to default session
    Given no session named "actor-dead" exists
    And a delegate cron job with reply_to "actor-dead"
    When the delegate completes
    Then the result is published to the default session instead
    And the message notes it was redirected from "actor-dead"

  # ── G3: bus_publish target validation ───────────────────────────────────

  Scenario: bus_publish to an existing session passes through
    Given a session named "actor-alice" exists
    When bus_publish is called with channel "ai.request" and target "actor-alice"
    Then the message is published

  Scenario: bus_publish to an unknown ai.request target is rejected
    Given no session named "actor-alic" exists
    When bus_publish is called with channel "ai.request" and target "actor-alic"
    Then the call returns an error mentioning "does not exist"
    And the error lists the active session ids
    And no message is published
    And no session named "actor-alic" was created

  Scenario: bus_publish to non-ai.request channels is not target-validated
    When bus_publish is called with channel "system.event" and target "anything"
    Then the message is published
