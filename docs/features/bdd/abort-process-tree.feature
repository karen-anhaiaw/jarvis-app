Feature: Aborting a bash tool kills the WHOLE process tree, not just the child
  # WHY THIS EXISTS (bug 2026-08-03, found by a live abort test):
  #   The user ran a 60s bash batch and aborted it. The direct bash process
  #   died, but a background grandchild (`sleep`) survived — reparented to init
  #   (PID 1) as an orphan. This leaks processes on every aborted bash that
  #   spawned children.
  #
  # THE PROCESS TOPOLOGY (this is the load-bearing detail):
  #   The `bash` tool is a declarative capability (capabilities/bash.json) whose
  #   handler runs a wrapper script:
  #
  #     execWithProgress spawn (detached, process group A)
  #      └─ bash bash-exec.sh              (group A)
  #           └─ timeout N bash -c "<cmd>" (group B  ← SEPARATE group!)
  #                └─ <the real command>  (group B)
  #                     └─ any grandchildren (group B)
  #
  #   CRITICAL FACT proven empirically: GNU/BSD `timeout` runs its target in its
  #   OWN process group (verified: timeout's pgid == its own pid, distinct from
  #   the script's pgid). So killing the SCRIPT's process group (group A) does
  #   NOT reach the timeout or the real command — they live in group B and get
  #   orphaned.
  #
  # TWO-LAYER FIX (both layers are required — do not remove either):
  #   1. loader.ts killTree(): spawns the tool detached (POSIX process-group
  #      leader) and, on abort, signals the child's group with a negative pid
  #      plus a SIGKILL escalation. This handles capabilities that do NOT wrap
  #      with `timeout`.
  #   2. capabilities/scripts/bash-exec.sh: a `trap TERM/INT` that captures the
  #      timeout child's pid and kills the TIMEOUT's group (kill -TERM
  #      -"$timeout_pid"), with SIGKILL escalation, before exiting. This is what
  #      actually reaches group B. Without the trap, the trap targeting the
  #      wrong group, or a synchronous foreground `timeout` (which blocks signal
  #      handling), the grandchild survives.
  #
  # REGRESSION GUARD — do not repeat the original mistake:
  #   The first unit test used `bash -c "sleep &"` DIRECTLY. That does not
  #   reproduce production (no bash-exec.sh, no timeout, no separate group), so
  #   it passed while the real path leaked. Any test for this behaviour MUST run
  #   the real bash-exec.sh end to end. See loader-abort-tree.test.ts:
  #   "aborting the real bash-exec.sh kills the grandchild spawned under timeout".

  Scenario: Aborting a bash tool that spawned a background grandchild kills the grandchild
    Given the bash tool runs "sleep 600 & <parent stays busy>"
    And the grandchild sleep is alive
    When the user aborts the tool
    Then the direct child is killed
    And the timeout process is killed
    And the grandchild sleep is killed
    And no orphaned process is reparented to init

  Scenario: The bash-exec.sh trap targets the timeout's process group, not the script's
    # Regression anchor: `kill 0` / `kill -<script_pgid>` is WRONG here because
    # timeout lives in a different group. The trap must use the timeout child's
    # pid as a negative kill target.
    Given bash-exec.sh has launched "timeout N bash -c <cmd>" in the background
    When bash-exec.sh receives SIGTERM
    Then it signals the timeout process group via kill -TERM -"$timeout_pid"
    And it escalates to SIGKILL for processes that ignore SIGTERM

  Scenario: Normal (non-aborted) bash execution is unaffected by the trap
    # The signal-handling rework must not change happy-path behaviour.
    When the bash tool runs "echo ok" to completion
    Then it returns exit_code 0 and the output "ok"

  Scenario: The timeout path still fires on a genuine timeout
    When the bash tool runs "sleep 5" with a 2s timeout
    Then it returns exit_code 124 (timeout after 2s)

  Scenario: killTree is a safe no-op when the process already exited
    Given a spawned child that has already exited
    When killTree is called on it
    Then it does not throw (ESRCH is swallowed)
