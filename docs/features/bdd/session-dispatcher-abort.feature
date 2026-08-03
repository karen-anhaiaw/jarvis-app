Feature: SessionDispatcher abort — no zombie sessions, queue always drains
  # WHY: aborting a session while a tool (e.g. bash) is in flight left the
  # dispatcher in a zombie state — SessionManager.stateStack returned to idle
  # but SessionDispatcher.d.running stayed true. Every subsequent ai.request
  # then hit the `if (d.running)` branch and only enqueued; nothing ever called
  # drainQueue, so the pending queue was stuck forever (observed live:
  # actor-dp-link with managerState=idle, stack=[], running=true, queueLen=1).
  #
  # ROOT CAUSE: two sources of truth for "is the session busy?" —
  # SessionManager.stateStack and SessionDispatcher.d.running — updated
  # inconsistently on the abort path. The fix makes d.running RECONCILE with
  # the stateStack at the end of abort(): if the manager says idle, the
  # dispatcher obeys (running=false) and drains. Idempotent and self-consistent
  # regardless of whether the stream yielded cleanly.

  Background:
    Given a SessionDispatcher wired to a SessionManager and bus
    And a session "main"

  # ── The core fix: no zombie after abort ────────────────────────────────

  Scenario: Abort while waiting_tools resets running and drains the queue
    Given session "main" is in "waiting_tools" with a pending bash tool
    And one message is queued for "main"
    When abort("main") is called
    Then SessionManager state for "main" is "idle"
    And dispatcher running for "main" is false
    And the queued message is drained (dispatchToSession is invoked)

  Scenario: Abort while processing reconciles running to the stack truth
    # Case B: the stream may not yield a clean "aborted" event. The abort must
    # NOT rely on consumeStream to reset running — it reconciles against the
    # stateStack. If the manager popped back to idle, running becomes false.
    Given session "main" is in "processing"
    And the underlying stream will never emit an aborted event
    When abort("main") is called
    And the SessionManager state for "main" has returned to "idle"
    Then dispatcher running for "main" is false

  Scenario: Abort never leaves a zombie (running=true while manager idle)
    # The invariant that was violated live. After abort settles, the two
    # sources of truth must agree.
    Given session "main" is busy with a tool in flight
    When abort("main") is called
    And the abort has fully settled
    Then it is never the case that SessionManager is idle while dispatcher running is true

  Scenario: Draining after abort dispatches the previously stuck message
    Given session "main" was aborted and reset to idle
    And a message "retry this" was stuck in the queue
    When the queue drains
    Then "retry this" is dispatched to the session
    And the pending queue for "main" is empty

  # ── Safety / idempotency ───────────────────────────────────────────────

  Scenario: Abort on an unknown session is a safe no-op
    When abort("ghost") is called
    Then no error is thrown
    And dispatcher running for "ghost" is false

  Scenario: Abort on an already-idle session does not corrupt the queue
    Given session "main" is idle with two messages queued
    When abort("main") is called
    Then the two queued messages are preserved
    And they drain in FIFO order
