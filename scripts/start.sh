#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JARVIS Start Script
#
# Launches JARVIS from a bash shell. Works on macOS, Linux, and — the reason
# this script exists — Windows under Git Bash (MSYS2).
#
# WHY GIT BASH ON WINDOWS
#   JARVIS capabilities declare `"command": "bash"` (see app/capabilities/*.json)
#   and are spawned by the capability loader with shell:true on win32, which
#   routes through cmd.exe. cmd.exe resolves binaries via PATH.
#
#   When node.exe is launched from inside Git Bash, MSYS2 converts the POSIX
#   PATH (/usr/bin) into a native Windows PATH (C:\Program Files\Git\usr\bin)
#   before exec'ing the native process. That makes `bash` resolvable to cmd.exe,
#   so every bash-backed capability works with zero code changes.
#
#   This script verifies that claim (see PREFLIGHT below) instead of assuming it.
#
# Usage:
#   ./scripts/start.sh            # normal start
#   ./scripts/start.sh --dev      # tsx watch mode
#   ./scripts/start.sh --check    # run preflight only, do not start JARVIS
#
# On Windows you may also double-click / run start-windows.cmd, which locates
# Git Bash and re-launches this script under it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_DIR/app"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
dim()  { echo -e "${DIM}  $*${NC}"; }

MODE="start"
for arg in "$@"; do
  case "$arg" in
    --dev)   MODE="dev" ;;
    --check) MODE="check" ;;
    *) die "Unknown argument: $arg (expected --dev or --check)" ;;
  esac
done

# ── Platform detection ───────────────────────────────────────────────────────
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1; PLATFORM="Windows (Git Bash / MSYS2)" ;;
  Darwin)               IS_WINDOWS=0; PLATFORM="macOS" ;;
  Linux)                IS_WINDOWS=0; PLATFORM="Linux" ;;
  *)                    IS_WINDOWS=0; PLATFORM="$(uname -s)" ;;
esac

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      JARVIS Start                    ║"
echo "╚══════════════════════════════════════╝"
echo ""
ok "Platform: $PLATFORM"

# ── Toolchain checks ─────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node not found on PATH. Install Node.js and retry."
command -v npm  >/dev/null 2>&1 || die "npm not found on PATH. Install Node.js and retry."
ok "node $(node --version)  ·  npm $(npm --version)"

command -v bash >/dev/null 2>&1 || die "bash not found on PATH (impossible — you are running this in bash)."
ok "bash $(bash --version | head -1 | sed 's/^GNU bash, version //')"

# ── PREFLIGHT: can a spawned child resolve `bash` the way JARVIS will? ────────
# This mirrors exactly what app/src/capabilities/loader.ts does at the single
# spawn choke point: spawn(command, args, { shell: true }) on win32.
# On Unix the loader uses shell:false and spawns `bash` directly from PATH,
# which we already proved above — so the cmd.exe hop is Windows-only.
if [ "$IS_WINDOWS" -eq 1 ]; then
  if MSYS_NO_PATHCONV=1 cmd.exe /c "bash --version" >/dev/null 2>&1; then
    ok "Preflight: cmd.exe resolves 'bash' — capabilities will run"
  else
    echo ""
    die "Preflight FAILED: cmd.exe cannot resolve 'bash'.
     JARVIS capabilities spawn through cmd.exe on Windows and will all fail.

     Fix: add Git's binary directory to the SYSTEM PATH, e.g.
       C:\\Program Files\\Git\\usr\\bin
     then open a new Git Bash and retry.

     Diagnose with:  MSYS_NO_PATHCONV=1 cmd.exe /c \"where bash\""
  fi
fi

# ── Repo sanity ──────────────────────────────────────────────────────────────
[ -d "$APP_DIR" ] || die "app/ not found at $APP_DIR — is this the jarvis-app repo?"
[ -d "$REPO_DIR/node_modules" ] || warn "node_modules/ missing at repo root — run 'npm install' first"
[ -d "$HOME/.jarvis" ] || warn "~/.jarvis not found — run ./scripts/bootstrap.sh first"
ok "Repo: $REPO_DIR"

if [ "$MODE" = "check" ]; then
  echo ""
  ok "Preflight complete. JARVIS not started (--check)."
  exit 0
fi

# ── Launch ───────────────────────────────────────────────────────────────────
echo ""
dim "Starting JARVIS ($MODE)…"
echo ""
cd "$APP_DIR"
exec npm run "$MODE"
