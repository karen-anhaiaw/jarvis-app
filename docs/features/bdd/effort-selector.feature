Feature: Effort Selector (mission Gearbox)
  As the operator (Sir)
  I want to choose the reasoning effort per model in the HUD model picker
  So that I can trade cost/latency for reasoning depth per session

  Background:
    Given the HUD model picker reads its catalog from GET /chat/models
    And effort is a provider-interpreted key in an open params map
    And effort applies to the live session (never recreates it via factory)

  # ─── Catalog (config/index.ts) ──────────────────────────────────────────

  Scenario: Anthropic non-Haiku model expands into 4 effort rows
    Given the model "claude-opus-4-8" with provider "anthropic"
    When getModelCatalogExpanded is called
    Then it yields 4 rows for that model
    And the labels are "Opus 4.8 Max", "Opus 4.8 High", "Opus 4.8 Medium", "Opus 4.8 Low"
    And each row carries effort one of "max","high","medium","low"

  Scenario: Haiku exposes exactly one row without effort
    Given the model "claude-haiku-4-5" with provider "anthropic"
    When getModelCatalogExpanded is called
    Then it yields exactly 1 row for that model
    And that row has no effort field

  Scenario: OpenAI and DeepSeek models expose one row each without effort
    Given a model with provider "openai" or "deepseek"
    When getModelCatalogExpanded is called
    Then it yields exactly 1 row for that model
    And that row has no effort field

  Scenario: The exposed effort set never includes rejected API values
    When getModelCatalogExpanded is called for any Anthropic non-Haiku model
    Then no row has effort "minimal"
    And no row has effort "xhigh"

  # ─── Session (session.ts resolveEffort) ─────────────────────────────────

  Scenario: Seed effort applies when no override is set
    Given an AnthropicSession created with highEffort true for a non-Haiku model
    When resolveEffort runs with no stickyParams
    Then the resolved effort is "max"

  Scenario: Background session seed is high
    Given an AnthropicSession created with highEffort false for a non-Haiku model
    When resolveEffort runs with no stickyParams
    Then the resolved effort is "high"

  Scenario: Sticky params override the seed
    Given an AnthropicSession created with highEffort true for a non-Haiku model
    When setStickyParams is called with effort "low"
    And resolveEffort runs
    Then the resolved effort is "low"

  Scenario: Clearing sticky params reverts to seed
    Given a session whose stickyParams.effort was "low"
    When setStickyParams is called with undefined
    And resolveEffort runs
    Then the resolved effort equals the seed

  Scenario: Haiku ignores effort even when a params map leaks in
    Given an AnthropicSession for model "claude-haiku-4-5"
    When setStickyParams is called with effort "max"
    And resolveEffort runs with model "claude-haiku-4-5"
    Then the resolved effort is undefined

  Scenario: Usage log records the effort actually sent
    Given a session whose resolved effort is "medium"
    When a usage entry is logged for a turn
    Then the logged effort equals "medium"
    And it does not hardcode "xhigh" or "high"

  # ─── Router (model-router.ts parse + apply) ─────────────────────────────

  Scenario: Router parses /model with a JSON params suffix
    Given the command '/model claude-opus-4-8 {"effort":"high"}'
    When the router parses it
    Then the model is "claude-opus-4-8"
    And the params map is { effort: "high" }

  Scenario: Router applies model and params atomically on the live session
    Given a live session for "main"
    When setStickyModel is called with model "claude-opus-4-8" and params { effort: "high" }
    Then session.setStickyModelOverride was called with "claude-opus-4-8"
    And session.setStickyParams was called with { effort: "high" }

  Scenario: Malformed JSON suffix applies the model and ignores params
    Given the command '/model claude-opus-4-8 {effort:high'
    When the router parses it
    Then the model is "claude-opus-4-8"
    And the params map is empty
    And a warning is logged

  Scenario: Switch banner shows model short-name and effort label
    Given a switch to "claude-opus-4-8" with params { effort: "high" }
    When the banner is emitted
    Then the banner text contains "Opus 4.8"
    And the banner text contains "High"

  Scenario: Params survive the first-turn session-creation race
    Given no session exists yet for "actor-x"
    When the router routes a request with a pending model and params
    And the session is later created
    Then setStickyParams is applied on session creation with the pending params

  # ─── Persistence (conversation-store + SessionManager) ──────────────────

  Scenario: Effort params persist across restart
    Given a session route with sticky "claude-opus-4-8" and params { effort: "low" }
    When the route state is saved and reloaded
    Then the reloaded route has params { effort: "low" }

  Scenario: Boot restores saved params onto the session
    Given a saved route with params { effort: "low" } for "main"
    When the session is materialized on boot
    Then session.setStickyParams is called with { effort: "low" }

  # ─── Server + UI (server.ts + ModelPicker.tsx) ──────────────────────────

  Scenario: /chat/models returns the expanded cartesian catalog
    When GET /chat/models is called
    Then the response is getModelCatalogExpanded output
    And it contains "Opus 4.8 Max" and "Opus 4.8 Low"

  Scenario: session-info returns the current effort
    Given a session with stickyParams.effort "high"
    When GET /chat/session-info is called for it
    Then the response includes effort "high"

  Scenario: Picker marks the active row by model and effort combined
    Given the current model is "claude-opus-4-8" and current effort is "high"
    When the dropdown renders
    Then only the "Opus 4.8 High" row is marked active
    And "Opus 4.8 Max" is not marked active

  Scenario: Selecting a row sends model and effort as a JSON command
    Given the user clicks the "Opus 4.8 Medium" row
    When selectModel fires
    Then it POSTs '/model claude-opus-4-8 {"effort":"medium"}'

  Scenario: Selecting a no-effort model sends a bare /model command
    Given the user clicks the "Haiku 4.5" row
    When selectModel fires
    Then it POSTs '/model claude-haiku-4-5' with no JSON suffix

  # ─── Compatibility (@jarvis/core MINOR) ─────────────────────────────────

  Scenario: Providers without setStickyParams keep working
    Given a session object that does not implement setStickyParams
    When the router applies params to it
    Then no error is thrown
    And the model override is still applied
