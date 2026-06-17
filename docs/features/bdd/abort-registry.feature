Feature: Abort Registry — per-tool abort controllers
  # WHY: registry.execute() runs tool calls in PARALLEL (Promise.all).
  # The old design kept ONE AbortController per sessionId in two separate
  # places (capabilities/loader.ts and mcp/manager.ts). With 2+ tools in
  # the same turn, the second register() overwrote the first — ESC then
  # aborted only the LAST tool, leaving earlier ones running as orphans
  # (bash processes producing side effects after the user aborted).
  # The AbortRegistry keys controllers by (sessionId, toolUseId) so a
  # session abort kills EVERY in-flight tool of that session.

  Background:
    Given a fresh AbortRegistry

  # ── Registration & release ─────────────────────────────────────────────

  Scenario: Register returns a live signal
    When register("main", "tool-1") is called
    Then the returned signal is not aborted
    And activeCount("main") is 1

  Scenario: Release removes the controller without aborting
    Given register("main", "tool-1") returning signal S1
    When release("main", "tool-1") is called
    Then activeCount("main") is 0
    And signal S1 is not aborted

  Scenario: Missing toolUseId falls back to a unique key (no collision)
    When register("main", undefined) is called twice
    Then activeCount("main") is 2

  # ── The core fix: parallel tools all abort ─────────────────────────────

  Scenario: Abort kills ALL parallel tools of the session
    Given register("main", "tool-1") returning signal S1
    And register("main", "tool-2") returning signal S2
    And register("main", "tool-3") returning signal S3
    When abortSession("main") is called
    Then it returns 3
    And signals S1, S2 and S3 are all aborted
    And activeCount("main") is 0

  Scenario: Abort is session-isolated
    Given register("main", "tool-1") returning signal S1
    And register("actor-alice", "tool-9") returning signal S9
    When abortSession("main") is called
    Then signal S1 is aborted
    And signal S9 is not aborted
    And activeCount("actor-alice") is 1

  Scenario: Abort on a session with no tools is a safe no-op
    When abortSession("ghost") is called
    Then it returns 0

  Scenario: Released tools are not aborted later
    Given register("main", "tool-1") returning signal S1
    And release("main", "tool-1") is called
    When abortSession("main") is called
    Then it returns 0
    And signal S1 is not aborted

  # ── Bus wiring ──────────────────────────────────────────────────────────

  Scenario: ai.stream aborted event aborts the target session's tools
    Given the registry is wired to the bus
    And register("main", "tool-1") returning signal S1
    And register("main", "tool-2") returning signal S2
    When an ai.stream message with event "aborted" and target "main" is published
    Then signals S1 and S2 are aborted

  Scenario: ai.stream aborted without target is ignored
    Given the registry is wired to the bus
    And register("main", "tool-1") returning signal S1
    When an ai.stream message with event "aborted" and no target is published
    Then signal S1 is not aborted

  Scenario: Other ai.stream events do not abort
    Given the registry is wired to the bus
    And register("main", "tool-1") returning signal S1
    When an ai.stream message with event "complete" and target "main" is published
    Then signal S1 is not aborted
