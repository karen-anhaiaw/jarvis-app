Feature: HUD truth — rev/gap detection, reactor pull-direct, reconciliation, staleness (F6, Pillar A)
  The HUD must never silently lie. Lost deltas are detectable (rev),
  the reactor reads JarvisCore directly, drifted/lost panels self-heal
  (reconciliation), and every panel exposes its age (updatedAt).

  Background:
    Given a HudState wired to a real EventBus
    And a fake SSE client capturing written deltas

  # ── Monotonic rev ──────────────────────────────────────────────────────

  Scenario: Every pushed delta carries a per-panel monotonic rev
    When piece "p1" is added with data {a: 1}
    And piece "p1" is updated with data {a: 2}
    And piece "p1" is updated with data {a: 3}
    Then the captured deltas for "p1" carry revs 1, 2, 3

  Scenario: Unchanged updates do not consume revs
    When piece "p1" is added with data {a: 1}
    And piece "p1" is updated with data {a: 1}
    Then only one delta for "p1" was pushed
    And the rev of the last delta for "p1" is 1

  Scenario: Remove carries the next rev and re-add continues the sequence
    When piece "p1" is added with data {a: 1}
    And piece "p1" is removed
    And piece "p1" is added with data {a: 9}
    Then the captured deltas for "p1" carry revs 1, 2, 3
    And the last delta is a set with data {a: 9}

  Scenario: Revs are independent per panel
    When piece "p1" is added with data {a: 1}
    And piece "p2" is added with data {b: 1}
    And piece "p2" is updated with data {b: 2}
    Then the last rev for "p1" is 1
    And the last rev for "p2" is 2

  Scenario: The full snapshot exposes each component's current rev
    When piece "p1" is added and updated twice with changing data
    Then getState() reports component "p1" with rev 3

  # ── updatedAt / staleness source ───────────────────────────────────────

  Scenario: updatedAt is stamped on add and on real content change only
    Given a controllable clock starting at T
    When piece "p1" is added with data {a: 1}
    Then component "p1" has updatedAt T
    When the clock advances 5000ms
    And piece "p1" is updated with data {a: 1}
    Then component "p1" still has updatedAt T
    When piece "p1" is updated with data {a: 2}
    Then component "p1" has updatedAt T+5000

  Scenario: updatedAt never causes a push by itself
    When piece "p1" is added with data {a: 1}
    And the clock advances and piece "p1" is updated with identical data
    Then only one delta for "p1" was pushed

  # ── Reactor pull-direct ────────────────────────────────────────────────

  Scenario: getReactor uses the registered source instead of the panel copy
    Given a reactor source returning status "processing" label "PROCESSING"
    When the source is registered via setReactorSource
    Then getState().reactor is {status: "processing", coreLabel: "PROCESSING"}
    And the jarvis-core panel copy is NOT consulted

  Scenario: A throwing reactor source falls back to the panel copy
    Given a reactor source that throws
    And a jarvis-core panel with data {status: "online", coreLabel: "ONLINE"}
    Then getState().reactor is {status: "online", coreLabel: "ONLINE"}

  Scenario: JarvisCore.getReactorState derives from globalState directly
    Given a JarvisCore in state "waiting_tools"
    Then getReactorState() returns {status: "waiting_tools", coreLabel: "WAITING TOOLS"}

  # ── Reconciliation ─────────────────────────────────────────────────────

  Scenario: A lost add is healed by the reconciliation tick
    Given a producer registered for "p9" returning a full panel snapshot
    And piece "p9" is NOT in the HudState map
    When a reconciliation tick runs
    Then piece "p9" exists in the map
    And a set delta for "p9" was pushed
    And a warning was logged for the re-add

  Scenario: Content drift is healed by the reconciliation tick
    Given piece "p1" added with data {a: 1}
    And a producer registered for "p1" returning data {a: 42}
    When a reconciliation tick runs
    Then the last delta for "p1" carries data {a: 42}

  Scenario: A healthy system pushes zero deltas on a tick
    Given piece "p1" added with data {a: 1}
    And a producer registered for "p1" returning data {a: 1}
    When a reconciliation tick runs
    Then no new deltas were pushed

  Scenario: A producer returning undefined is skipped
    Given a producer registered for "p1" returning undefined
    When a reconciliation tick runs
    Then no new deltas were pushed

  Scenario: Reactor drift is pushed on the reconciliation tick
    Given a registered reactor source whose status changes between ticks
    When a reconciliation tick runs
    Then a delta carrying the new reactor was pushed

  Scenario: Update for an unknown pieceId logs a warning instead of silence
    When piece "ghost" receives an update without a prior add
    Then no delta is pushed for "ghost"
    And a warning mentioning "ghost" was logged

  # ── Frontend (live validation — no UI test runner in repo) ────────────

  Scenario: Client detects a rev gap and resyncs from GET /hud
    Given the HUD is connected and rendering panel "p1" at rev 3
    When the client receives a delta for "p1" with rev 5
    Then the client fetches GET /hud once and replaces its store
    And the panel renders the snapshot state

  Scenario: Client ignores duplicate or stale deltas
    Given the HUD is connected and rendering panel "p1" at rev 5
    When the client receives a delta for "p1" with rev 5
    Then the store is unchanged

  Scenario: Panels older than the threshold render a staleness indicator
    Given a panel whose updatedAt is older than 60 seconds
    Then its header shows the stale marker and an age tooltip

  # ── F6.1 — SSE subscribe storm (live defect 2026-06-11) ──────────────────
  # Root cause: inline-arrow subscribe passed to useSyncExternalStore → new
  # identity per render → React re-subscribes per render → refCount 1→0→1 →
  # disconnect+connect per render → snapshot replay → notify → re-render → ∞.
  # Ignites only when exactly ONE subscriber crosses zero (sleep/wake seeded
  # the single-subscriber state). Observed: ~770 reconnects/s, node 53% CPU.
  # Frontend scenarios — live-validation (no UI test runner).

  Scenario: Hook subscribe identity is stable across renders
    Given a component using useHudState, useHudPiece or useHudReactor
    When the component re-renders for any reason
    Then useSyncExternalStore receives the same subscribe function reference
    And React does not unsubscribe and resubscribe
    And the server logs zero SSE connect or disconnect events

  Scenario: Transient refCount zero does not recycle the SSE connection
    Given the HUD store has exactly one subscriber
    When the subscriber unsubscribes and a new one subscribes within the grace window
    Then the EventSource is never closed
    And no new connection is opened on the server

  Scenario: Sustained zero subscribers closes the connection after the grace window
    Given the HUD store has exactly one subscriber
    When the subscriber unsubscribes and nothing resubscribes within the grace window
    Then the EventSource is closed exactly once
