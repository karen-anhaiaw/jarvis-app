Feature: Anthropic API call retry with configurable rate-limit wait
  As JARVIS talking to the Anthropic API
  I want transient API failures (rate limits, overload, network) to be retried automatically
  So that a single 429/5xx does not surface as a hard error to the user

  Background:
    Given an AnthropicSession is streaming a turn via streamFromAPI
    And retry settings are enabled with maxRetries=5, rateLimitWaitMs=15000, backoffBaseMs=2000

  # ─── Rate limit (429) ──────────────────────────────────────────────────────

  Scenario: 429 without retry-after waits the configured rate-limit wait
    Given the API call fails with HTTP 429 and no retry-after header
    When streamFromAPI catches the error
    Then it emits a text_delta announcing the wait ("rate limit ... aguardando 15s ... tentativa 1/5")
    And it waits 15000 ms
    And it retries the same API call
    And on success the turn proceeds normally with no error yielded

  Scenario: 429 with retry-after header respects the header value
    Given the API call fails with HTTP 429 and a retry-after header of "8"
    When streamFromAPI catches the error
    Then it waits 8000 ms (the header value, not the configured 15000)
    And it retries the same API call

  Scenario: retry-after given in HTTP-date format is honored
    Given the API call fails with HTTP 429 and a retry-after header as an HTTP-date 3 seconds in the future
    When streamFromAPI catches the error
    Then it waits approximately 3000 ms
    And it retries the same API call

  # ─── Overload (529) and 5xx ────────────────────────────────────────────────

  Scenario: 529 overloaded retries with exponential backoff
    Given the API call fails with HTTP 529
    When streamFromAPI catches the error
    Then it waits backoffBaseMs * 2^(attempt-1) ms (2s, 4s, 8s, 16s, 32s)
    And it retries the same API call up to maxRetries times

  Scenario: 500/502/503 server errors retry with exponential backoff
    Given the API call fails with HTTP 503
    When streamFromAPI catches the error
    Then it retries with exponential backoff up to maxRetries times

  Scenario: transient network errors retry with exponential backoff
    Given the API call fails with "ECONNRESET" (or terminated/socket/ETIMEDOUT/other side closed)
    When streamFromAPI catches the error
    Then it retries with exponential backoff up to maxRetries times

  # ─── Non-retryable errors ──────────────────────────────────────────────────

  Scenario: pure 400 is NOT retried
    Given the API call fails with HTTP 400 (malformed payload)
    When streamFromAPI catches the error
    Then it does NOT retry
    And it yields a human-readable error immediately

  Scenario Outline: deterministic client errors are NOT retried
    Given the API call fails with HTTP <status>
    When streamFromAPI catches the error
    Then it does NOT retry
    And it yields a human-readable error immediately

    Examples:
      | status |
      | 400    |
      | 401    |
      | 403    |
      | 404    |
      | 422    |

  # ─── Retry budget exhaustion ───────────────────────────────────────────────

  Scenario: exhausting maxRetries yields the final error
    Given the API call fails with HTTP 429 on every attempt
    When streamFromAPI has retried maxRetries (5) times
    Then it stops retrying
    And it yields the human-readable rate-limit error

  # ─── Abort precedence ──────────────────────────────────────────────────────

  Scenario: abort during a retry wait cancels immediately
    Given the API call failed with HTTP 429 and streamFromAPI is waiting to retry
    When the user aborts (AbortController fires)
    Then the wait is interrupted
    And it yields { type: "error", error: "aborted" }
    And it does NOT retry

  Scenario: abort takes precedence over any retryable error
    Given the API call fails because the request was aborted
    When streamFromAPI catches the error
    Then it treats it as an abort (not a retryable error)
    And it yields { type: "error", error: "aborted" }

  # ─── Interaction with existing fallbacks ───────────────────────────────────

  Scenario: beta 400 still falls back to the standard path (not the retry loop)
    Given the beta API call fails with a beta-specific 400
    When the beta catch block runs
    Then it disables beta and falls through to the standard path as today
    And the retry loop is NOT involved for that specific fallback

  Scenario: image processing error still strips images and retries as today
    Given the API call fails with "Could not process image"
    When streamFromAPI catches the error
    Then it strips images and retries via the existing image-recovery path
    And this is independent of the rate-limit retry budget

  # ─── Configuration ─────────────────────────────────────────────────────────

  Scenario: retry disabled reverts to legacy behavior
    Given retry settings are disabled (enabled=false)
    When the API call fails with HTTP 429
    Then streamFromAPI does NOT retry
    And it yields the error immediately (legacy behavior)

  Scenario: settings are read fresh per turn
    Given the user changes rateLimitWaitMs in settings.user.json between turns
    When the next turn hits a 429
    Then the new wait value is used (no restart required)
