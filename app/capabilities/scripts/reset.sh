#!/bin/bash
# Restart JARVIS — saves conversation state before killing
# $1 = optional startup message for next boot

JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# startup-prompt.txt is read by jarvisPath("startup-prompt.txt") → ~/.jarvis/startup-prompt.txt
STARTUP_PROMPT_FILE="${JARVIS_HOME:-$HOME/.jarvis}/startup-prompt.txt"
MESSAGE="$1"

# Save startup prompt if provided
if [ -n "$MESSAGE" ]; then
  mkdir -p "$JARVIS_DIR/.jarvis"
  echo "$MESSAGE" > "$STARTUP_PROMPT_FILE"
fi

echo "__TYPE__:text"
echo "JARVIS restarting... conversation saved, will resume on restart."

# Background: wait a moment (let the tool response return), then restart
(
  sleep 1

  # Signal JARVIS to save and shut down gracefully (SIGINT → triggers saveAll)
  pkill -INT -f "tsx src/main.ts" 2>/dev/null
  sleep 3

  # Force kill if still alive
  pkill -9 -f "tsx src/main.ts" 2>/dev/null
  pkill -9 -f "bash start.sh" 2>/dev/null
  pkill -f Electron 2>/dev/null
  sleep 1

  # Start fresh (build UI + start backend)
  cd "$JARVIS_DIR"
  nohup bash start.sh > /tmp/jarvis.log 2>&1 &
) &

exit 0
