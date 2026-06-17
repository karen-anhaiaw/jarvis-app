Feature: End-to-end tracing and structured logging (Pillar C, F4)
  One conversation turn is reconstructable from logs alone by filtering traceId.
  The ring buffer carries structured ctx; the log file is NDJSON; child loggers
  feed the ring buffer; tool handlers, cron fires, and provider sessions carry
  the turn's traceId.

  # ─── Item 16: LogEntry.ctx ───

  Scenario: Ring buffer entry carries the structured context object
    When code calls log.info({ sessionId: "main", traceId: "abc12345" }, "hello")
    Then the ring buffer entry has msg "hello"
    And entry.ctx.sessionId is "main"
    And entry.ctx.traceId is "abc12345"

  Scenario: String-only log call produces entry without ctx
    When code calls log.info("plain message")
    Then the ring buffer entry has msg "plain message"
    And entry.ctx is undefined

  # ─── Item 16b: proxied child() ───

  Scenario: Child logger calls land in the ring buffer with merged bindings
    Given a child logger created with log.child({ plugin: "voice" })
    When the child logs info({ event: "x" }, "from child")
    Then a ring buffer entry exists with msg "from child"
    And entry.ctx.plugin is "voice"
    And entry.ctx.event is "x"

  Scenario: Grandchild logger also lands in the ring buffer
    Given child = log.child({ a: 1 }) and grandchild = child.child({ b: 2 })
    When grandchild logs info("deep")
    Then a ring buffer entry exists with msg "deep" and ctx containing a=1 and b=2

  # ─── Item 19: NDJSON file ───

  Scenario: Log file target is raw NDJSON, console stays pretty
    Given the logger transport configuration
    Then the file target is pino/file (raw JSON lines) at level debug
    And the pretty target exists only when LOG_LEVEL is set (console)

  # ─── Item 17: traceId at the edges ───

  Scenario: Executor injects __traceId into tool input
    Given a capability.request with traceId "feed1234"
    When the executor runs the tool
    Then the handler receives input.__traceId === "feed1234"

  Scenario: MCP handler strips executor context fields before calling the server
    Given an MCP tool handler receiving input with __sessionId, __toolUseId, __traceId
    When it calls the MCP server
    Then the arguments sent contain none of the __ fields

  Scenario: Cron fire generates one traceId shared by log and published request
    When a cron job fires in prompt mode
    Then the "executing job" log carries a fresh traceId
    And the published ai.request carries the SAME traceId

  Scenario: Provider session logs carry the turn traceId
    Given JarvisCore set turn trace "cafe0001" on the session before dispatch
    When the session logs its API-call entry
    Then the log ctx includes traceId "cafe0001"

  # ─── Item 18: per-turn child in JarvisCore ───

  Scenario: All turn-scoped JarvisCore logs carry traceId and sessionId
    Given a prompt dispatched to session "main" with traceId "beef5678"
    When the turn runs to completion
    Then every JarvisCore log line of that turn has ctx.traceId "beef5678" and ctx.sessionId "main"
