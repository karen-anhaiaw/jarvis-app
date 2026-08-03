#!/bin/bash
# bash-exec.sh — Execute shell command with configurable timeout and cwd
# Usage: bash-exec.sh <command> [timeout_seconds] [cwd]
#
# ⚠️  ABORT / SIGNAL HANDLING IS LOAD-BEARING — DO NOT "SIMPLIFY" IT.
#   The execution section below runs `timeout N bash -c "$COMMAND"` in the
#   BACKGROUND with a TERM/INT trap on purpose. Reason: `timeout` (coreutils)
#   puts its target in its OWN process group, so when JARVIS aborts a tool by
#   killing THIS script's process group, the timeout + the real command + any
#   grandchildren survive as orphans (reparented to init). The trap captures the
#   timeout's pid and kills the TIMEOUT's group. Running timeout synchronously in
#   the foreground, or trapping `kill 0` (this script's group), reintroduces the
#   orphan-process leak the user hit on 2026-08-03.
#   See docs/features/bdd/abort-process-tree.feature and loader.ts killTree().

COMMAND="$1"
TIMEOUT="${2:-30}"
CWD="$3"

if [ -z "$COMMAND" ]; then
  echo "__TYPE__:error"
  echo "command is required"
  exit 0
fi

# Sanitize timeout (1-600)
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [ "$TIMEOUT" -lt 1 ]; then
  TIMEOUT=30
fi
if [ "$TIMEOUT" -gt 600 ]; then
  TIMEOUT=600
fi

# Safety controls — block destructive patterns
BLOCKED_PATTERNS=(
  "rm -rf /"
  "rm -rf /*"
  "mkfs\."
  "dd if=.* of=/dev/"
  "> /dev/sd"
  "chmod -R 777 /"
  ":(){ :|:& };:"
)

for pat in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pat"; then
    echo "__TYPE__:error"
    echo "Command blocked by safety controls: matches destructive pattern"
    exit 0
  fi
done

# Set working directory
if [ -n "$CWD" ]; then
  CWD="${CWD/#\~/$HOME}"
  if [ ! -d "$CWD" ]; then
    echo "__TYPE__:error"
    echo "Working directory not found: $CWD"
    exit 0
  fi
  cd "$CWD"
else
  # Default to project root
  cd "$(dirname "$0")/../.." 2>/dev/null
fi

# Execute with timeout, capture stdout and stderr separately.
#
# SIGNAL PROPAGATION (abort fix, 2026-08-03):
#   When the user aborts, the JARVIS capability executor kills this script's
#   process GROUP (process.kill(-pid, SIGTERM) — see loader.ts killTree). If we
#   run `timeout ... bash -c "$COMMAND"` synchronously in the foreground, this
#   shell dies on SIGTERM but the `timeout` child and its own children (the
#   actual command, e.g. `sleep`) are NOT reliably signalled — they get
#   reparented to init (PID 1) and linger as orphans. Proven empirically:
#   without the trap, an aborted `sleep 600` survived; with it, the whole tree
#   dies.
#
#   Fix: run the timeout in the BACKGROUND, remember its PID, and install a trap
#   that, on TERM/INT, kills the entire process group (kill -TERM 0 signals
#   every process in this script's group, including timeout + grandchildren)
#   before exiting. `wait` lets the trap fire promptly instead of blocking
#   uninterruptibly in the foreground child.
TMPOUT=$(mktemp)
TMPERR=$(mktemp)

_timeout_pid=""
_on_term() {
  # CRITICAL: `timeout` (coreutils) runs its target in its OWN process group
  # (verified: timeout's pgid == its own pid, distinct from this script's pgid).
  # So `kill 0` (this script's group) does NOT reach the timeout or the real
  # command's children — they'd be reparented to init as orphans (the exact bug:
  # an aborted `sleep 600` survived). We must signal the TIMEOUT's group, using
  # its pid as a negative target: kill -TERM -"$_timeout_pid".
  if [ -n "$_timeout_pid" ]; then
    kill -TERM -"$_timeout_pid" 2>/dev/null   # whole timeout group
    kill -TERM "$_timeout_pid" 2>/dev/null    # and the timeout leader itself
    sleep 0.1
    kill -KILL -"$_timeout_pid" 2>/dev/null   # escalate for TERM-ignorers
    kill -KILL "$_timeout_pid" 2>/dev/null
  fi
  exit 143  # 128 + SIGTERM(15)
}
trap _on_term TERM INT

# Run timeout in the background so the trap can fire promptly (a foreground
# child blocks signal handling until it returns). setsid is NOT used — timeout
# already leads its own group, which is exactly the handle we target above.
timeout "$TIMEOUT" bash -c "$COMMAND" > "$TMPOUT" 2> "$TMPERR" &
_timeout_pid=$!
wait "$_timeout_pid"
EXIT_CODE=$?

trap - TERM INT

STDOUT=$(cat "$TMPOUT")
STDERR=$(cat "$TMPERR")
rm -f "$TMPOUT" "$TMPERR"

# Truncate output if too large (1MB)
MAX_LEN=1048576
if [ ${#STDOUT} -gt $MAX_LEN ]; then
  STDOUT="${STDOUT:0:$MAX_LEN}
... (output truncated at 1MB)"
fi

if [ $EXIT_CODE -eq 124 ]; then
  echo "__TYPE__:text"
  echo "exit_code: 124 (timeout after ${TIMEOUT}s)"
  echo "---"
  echo "$STDOUT"
  if [ -n "$STDERR" ]; then
    echo "---stderr---"
    echo "$STDERR"
  fi
  exit 0
fi

echo "__TYPE__:text"
echo "exit_code: $EXIT_CODE"
echo "---"
echo "$STDOUT"
if [ -n "$STDERR" ]; then
  echo "---stderr---"
  echo "$STDERR"
fi
