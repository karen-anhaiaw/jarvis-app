Feature: Chat
  As a user of JARVIS
  I want to send messages and receive streaming AI responses
  So that I can have a real-time conversation with the AI assistant

  Background:
    Given JARVIS is running and online
    And the HUD chat panel is open for session "main"

  # ─── Basic Messaging ────────────────────────────────────────────────────────

  Scenario: User sends a simple message and receives a response
    When the user types "Hello JARVIS" and presses Enter
    Then a POST /chat/send is made with sessionId "main" and prompt "Hello JARVIS"
    And the chat timeline shows a user entry with text "Hello JARVIS"
    And the AI streams a response via SSE delta events
    And the chat timeline shows an assistant entry with the full response text
    And the SSE stream delivers a "done" event with the full text

  Scenario: User sends a message while session is idle
    Given the session "main" is in state "idle"
    When the user sends a message "test"
    Then the message is dispatched immediately to the AI provider
    And a "prompt_dispatched" SSE event is emitted with the user entry

  Scenario: Response streams token by token
    When the AI provider yields multiple text_delta events
    Then each delta produces an SSE "delta" event delivered to the browser
    And the chat panel appends each token to the streaming text in real time

  # ─── Message Queue ───────────────────────────────────────────────────────────

  Scenario: User sends a second message while first is processing
    Given the session "main" is in state "processing"
    When the user sends "second message"
    Then the message is added to the pending queue
    And a "pending_queue" SSE event is emitted showing the queued message
    And the in-flight AI turn is NOT interrupted
    And the queue is drained after the current turn completes

  Scenario: Multiple queued messages are combined into one API call
    Given two messages are queued: "message A" and "message B"
    When the session becomes idle
    Then a single API call is made with text "message A\n\nmessage B"
    But the timeline shows two separate user entries: one for "message A" and one for "message B"
    And the "pending_queue" SSE is emitted empty after drain starts

  Scenario: Queue survives when session returns from waiting_tools
    Given the session "main" is in state "waiting_tools"
    And one message is queued: "queued while waiting"
    When the capability result arrives and the turn completes
    Then the queued message is drained and dispatched to the AI

  # ─── Abort (ESC) ─────────────────────────────────────────────────────────────

  Scenario: User presses ESC to abort the current turn
    Given the session "main" is in state "processing"
    When the user presses ESC
    Then POST /chat/abort is called with sessionId "main"
    And the AI stream is cancelled
    And an "aborted" SSE event is delivered
    And the session state transitions to "idle"

  Scenario: Abort preserves queued messages
    Given the session "main" is in state "processing"
    And one message is queued: "pending message"
    When the user presses ESC
    Then the queue still contains "pending message"
    And the queue is drained immediately after abort
    And "pending message" appears in the timeline as a user entry

  Scenario: Abort while waiting_tools cancels pending tool calls
    Given the session "main" is in state "waiting_tools"
    And tool "bash" with id "tool-1" is pending
    When the user presses ESC
    Then a "tool_cancelled" SSE event is emitted for "bash" with id "tool-1"
    And orphaned tool blocks are removed from message history
    And an "aborted" SSE event is delivered

  Scenario: Abort during processing when API resolves just before abort signal
    Given the session "main" is in state "processing"
    And the AI provider is about to return a tool_use response
    When the user presses ESC and the API response resolves concurrently
    Then the assistant message with tool_use blocks is NOT pushed to message history
    And no orphan tool_use blocks exist in message history
    And the next user message can be sent without a 400 error

  # ─── Tool Execution ──────────────────────────────────────────────────────────

  Scenario: AI requests a tool call
    Given the AI yields a tool_use block for tool "bash"
    Then a "tool_start" SSE event is emitted with name "bash"
    And a capability.request bus event is published for session "main"
    And the session state transitions to "waiting_tools"

  Scenario: Tool completes and AI continues
    Given the session "main" is in state "waiting_tools"
    And capability.result arrives for tool "bash" with output "file exists"
    Then a "tool_done" SSE event is emitted for "bash"
    And the tool output is added to the session message history
    And the AI stream resumes (continueAndStream)
    And the session transitions to "processing"

  # ─── Slash Commands ──────────────────────────────────────────────────────────

  Scenario: User sends a registered slash command
    Given "/help" is a registered slash command
    When the user types "/help" and presses Enter
    Then the command handler is called with empty args and sessionId "main"
    And the user entry "/ help" appears immediately in the timeline
    And NO ai.request is published on the bus

  Scenario: User sends an unregistered slash command
    Given "/unknown" is NOT a registered slash command
    When the user types "/unknown" and presses Enter
    Then an ai.request is published with prompt "/unknown"
    And the message is processed as a normal prompt

  # ─── Session Multiplexing ────────────────────────────────────────────────────

  Scenario: Multiple sessions receive independent SSE streams
    Given session "main" and session "actor-test" both have open SSE connections
    When an ai.stream event for "main" is published
    Then only the "main" SSE pool receives it
    And the "actor-test" pool receives nothing

  Scenario: Multiple browser tabs share the same session pool
    Given two browser tabs both connected to /chat-stream?sessionId=main
    When an ai.stream/delta event is published for "main"
    Then both tabs receive the delta SSE frame

  # ─── History Rehydration ─────────────────────────────────────────────────────

  Scenario: Browser reconnects and rehydrates chat history
    Given session "main" has 5 messages in history
    When the browser calls GET /chat/history?sessionId=main
    Then the response contains 5 parsed timeline entries
    And assistant messages have source "jarvis"
    And user messages have source "chat"

  Scenario: Pending greeting is appended once on reconnect
    Given a pending greeting "Back online, Sir." was set during boot
    When the browser calls GET /chat/history?sessionId=main
    Then the response includes an assistant entry with text "Back online, Sir."
    And a second call to GET /chat/history does NOT include the greeting again

  Scenario: History rehydration for actor session
    Given session "actor-alice" has messages in history
    When the browser calls GET /chat/history?sessionId=actor-alice
    Then the response contains the parsed entries for that session

  # ─── Choice System ───────────────────────────────────────────────────────────

  Scenario: AI presents a single-question choice card
    Given the AI issues a jarvis_ask_choice call with:
      | question | options                                          |
      | "Confirm?" | yes_confirm: "Confirm", no_cancel: "Cancel" |
    Then a kind:"choice" entry appears in the chat timeline
    And the HUD renders an interactive card with two options

  Scenario: User answers a choice card
    Given a pending choice with question "Confirm?" is in the history
    When the user selects "Confirm"
    Then a "[choice] Confirm? → Confirm" user message is sent
    And the choice entry's answers are filled with { value: "yes_confirm" }
    And the "[choice]" message is NOT shown as a user text entry in the timeline

  Scenario: Multiple simultaneous choice cards use FIFO ordering
    Given two pending choices: Q1 "First?" and Q2 "Second?"
    When the answer arrives for Q1
    Then Q1 is matched and removed from the pending queue
    And Q2 remains pending in the queue

  Scenario: User dismisses a choice card
    Given a pending choice is in the history
    When a "[choice] (dismissed)" message arrives
    Then the choice entry's answers are marked as dismissed
    And the choice is removed from the pending queue

  # ─── Error Handling ──────────────────────────────────────────────────────────

  Scenario: AI provider returns an error during streaming
    Given the AI stream yields an error event with message "rate limit exceeded"
    Then an "error" SSE event is delivered with the error message
    And the session transitions to "idle"
    And the error is visible in the chat timeline as an error banner

  Scenario: POST /chat/send with missing sessionId returns 400
    When a POST /chat/send is made without a sessionId field
    Then the response is 400 with error "sessionId is required"

  Scenario: SSE client disconnects mid-stream
    Given a browser tab is connected to /chat-stream?sessionId=main
    When the tab closes the connection
    Then the tab's ServerResponse is removed from the session pool
    And all subsequent SSE frames are delivered only to remaining connections
    And the AI stream is NOT interrupted

  # ─── Model Indicator (ModelPicker) ───────────────────────────────────────────
  # The footer model label must reflect the SESSION's effective model
  # (peekModel: next ?? sticky ?? base) fetched from /chat/session-info.
  # It must NEVER display the token-counter aggregate: that piece reports the
  # most-recent model ACROSS ALL sessions (scope ALL), so background sessions
  # (actors, mnemosyne) on other models would leak into this panel's footer.

  Scenario: Model indicator is session-scoped, not global
    Given the main session has a sticky model "claude-fable-5"
    And an actor session runs on "claude-sonnet-4-6"
    When the actor emits a usage event after responding
    Then the token-counter aggregate model may flip to "claude-sonnet-4-6"
    And the chat footer indicator for "main" still shows "claude-fable-5"

  Scenario: Model indicator updates after a model switch on the session
    Given the chat panel for "main" is open
    When the user selects "claude-opus-4-8" in the model picker
    Then a "/model claude-opus-4-8" command is sent to session "main"
    And the indicator reflects "claude-opus-4-8" on the next session-info poll

  Scenario: Model indicator for a not-yet-materialized session shows the provider default
    Given no session "actor-new" exists
    When the chat panel for "actor-new" polls /chat/session-info
    Then the response carries the provider default model from config
    And the indicator shows the default model label instead of a placeholder
