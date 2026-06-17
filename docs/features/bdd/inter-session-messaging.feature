Feature: Inter-session message attribution and reply routing
  # WHY: when session A publishes ai.request into session B, B's LLM needs to
  # know (1) WHO sent the message — otherwise it may treat it as input from
  # the human user — and (2) WHERE to deliver the answer when a reply is
  # expected. Before mission jarvis-fix, only messages carrying replyTo got a
  # preamble; fire-and-forget inter-session messages arrived as bare text
  # with no origin (evidenced live 2026-06-10: a bare "pong" from an actor).
  #
  # Internal sources are exempt:
  #   chat-input   — the human user; no preamble ever
  #   jarvis-core  — self-routing (dispatches, result forwarding)
  #   cron         — self-prefixes its text with [CRON job "id"]

  Scenario: Message from the human user gets no preamble
    Given an ai.request with source "chat-input" and text "hello"
    When the dispatch text is built
    Then it is the plain text "hello" (with reminders prepended when present)

  Scenario: Message from jarvis-core gets no preamble
    Given an ai.request with source "jarvis-core" and replyTo "main"
    When the dispatch text is built
    Then it is plain text without any [SYSTEM] preamble

  Scenario: Message from cron gets no preamble
    Given an ai.request with source "cron" and text "[CRON job \"x\"] tick"
    When the dispatch text is built
    Then it is plain text without any [SYSTEM] preamble

  Scenario: Inter-session message WITH replyTo carries origin + reply routing
    Given an ai.request with source "actor-alice", replyTo "main" and text "What is 2+2?"
    When the dispatch text is built
    Then it has two blocks
    And block 0 identifies the sender session "actor-alice"
    And block 0 instructs delivery via bus_publish to session "main"
    And block 1 is the original text (with reminders prepended when present)

  Scenario: Inter-session message WITHOUT replyTo carries origin attribution
    Given an ai.request with source "actor-alpha" and no replyTo and text "pong"
    When the dispatch text is built
    Then it has two blocks
    And block 0 identifies the sender session "actor-alpha"
    And block 0 states the message is fire-and-forget with no reply channel
    And block 0 does NOT instruct any bus_publish reply
    And block 1 is the original text

  Scenario: Reminders compose with the preamble
    Given an ai.request with source "actor-alice", replyTo "main", text "hi" and one system reminder "be brief"
    When the dispatch text is built
    Then block 1 starts with the <system-reminder> block followed by "hi"

  # ── Queued messages (drainQueue) — F2.6 ─────────────────────────────────
  # WHY: drainQueue combines N queued messages into ONE API call for token
  # efficiency. But one API call produces ONE response — request-reply
  # messages cannot share a combined turn (whose replyTo wins?), and
  # inter-session attribution is per-message. Pre-mission bug: drain
  # DISCARDED replyTo entirely (request-reply to a busy session never
  # routed back) and skipped attribution. Fix: segmented drain.

  Scenario: Plain user messages still combine into one API call
    Given a session queue with 3 messages from "chat-input" and no replyTo
    When the queue is drained
    Then all 3 messages combine into a single dispatch

  Scenario: A queued message with replyTo dispatches SOLO with reply routing
    Given a session queue whose head message has source "actor-alice" and replyTo "main"
    When the queue is drained
    Then the head message dispatches alone
    And its replyTo routing is registered (the response will be routed to "main")
    And its dispatch text carries the origin + reply instruction preamble

  Scenario: A queued inter-session fire-and-forget message dispatches SOLO with attribution
    Given a session queue whose head message has a live-session source and no replyTo
    When the queue is drained
    Then the head message dispatches alone
    And its dispatch text carries the origin-only preamble

  Scenario: Mixed queue drains in segments preserving order
    Given a session queue with [plain, plain, replyTo-message, plain]
    When the queue is drained
    Then the first dispatch combines the 2 plain messages
    And the remaining [replyTo-message, plain] stay queued for the next drain
    # consumeStream re-drains after each turn completes — order is preserved.
