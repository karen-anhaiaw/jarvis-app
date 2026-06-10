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
