#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# JARVIS — Setup Wizard
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# --- Terminal helpers ---

BOLD="\033[1m"
DIM="\033[2m"
BLUE="\033[1;34m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
CYAN="\033[1;36m"
RESET="\033[0m"

info()    { printf "${BLUE}ℹ ${RESET}%s\n" "$1"; }
success() { printf "${GREEN}✓ ${RESET}%s\n" "$1"; }
warn()    { printf "${YELLOW}⚠ ${RESET}%s\n" "$1"; }
fail()    { printf "${RED}✗ ${RESET}%s\n" "$1"; exit 1; }
header()  { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n\n" "$1"; }
dim()     { printf "${DIM}  %s${RESET}\n" "$1"; }
step()    { printf "  ${DIM}→${RESET} %s\n" "$1"; }

ask() {
  local prompt="$1" default="$2" result
  if [ -n "$default" ]; then
    printf "  %s ${DIM}[%s]${RESET}: " "$prompt" "$default"
    read -r result
    echo "${result:-$default}"
  else
    printf "  %s: " "$prompt"
    read -r result
    echo "$result"
  fi
}

ask_secret() {
  local prompt="$1" result
  printf "  %s: " "$prompt"
  read -rs result
  echo ""
  echo "$result"
}

confirm() {
  local prompt="$1" default="${2:-n}" reply
  if [ "$default" = "y" ]; then
    printf "  %s ${DIM}[Y/n]${RESET}: " "$prompt"
    read -r reply
    case "$reply" in
      [nN]|[nN][oO]) return 1 ;;
      *) return 0 ;;
    esac
  else
    printf "  %s ${DIM}[y/N]${RESET}: " "$prompt"
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS]) return 0 ;;
      *) return 1 ;;
    esac
  fi
}

spinner() {
  local pid=$1 label="$2" log_file="${3:-}"
  local chars="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${BLUE}%s${RESET} %s" "${chars:$i:1}" "$label"
    i=$(( (i + 1) % ${#chars} ))
    sleep 0.1
  done
  local exit_code=0
  wait "$pid" 2>/dev/null || exit_code=$?
  printf "\r\033[K"
  if [ "$exit_code" -ne 0 ] && [ -n "$log_file" ]; then
    warn "$label failed (exit $exit_code)"
    dim "Log: $log_file"
    return "$exit_code"
  fi
  return "$exit_code"
}

run_step() {
  local label="$1" log_file="$2"
  shift 2
  "$@" > "$log_file" 2>&1 &
  local pid=$!
  spinner "$pid" "$label" "$log_file"
}

mask_key() {
  local key="$1"
  if [ ${#key} -le 12 ]; then
    echo "${key:0:4}****"
  else
    echo "${key:0:8}...${key: -4}"
  fi
}

port_in_use() {
  lsof -i ":$1" &>/dev/null 2>&1
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Banner
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

clear 2>/dev/null || true
echo ""
printf "${BOLD}${CYAN}"
cat << 'BANNER'
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
BANNER
printf "${RESET}"
echo ""
printf "${DIM}  Just A Rather Very Intelligent System — Setup Wizard${RESET}\n"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 1/6 — Prerequisites"

IS_MAC=false
[[ "$OSTYPE" == "darwin"* ]] && IS_MAC=true

HAS_BREW=false
command -v brew &>/dev/null && HAS_BREW=true

# Node.js
if ! command -v node &>/dev/null; then
  warn "Node.js not found."
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install Node.js via Homebrew?" "y"; then
      brew install node
    else
      fail "Node.js 20+ is required. Install from https://nodejs.org"
    fi
  else
    fail "Node.js 20+ is required. Install from https://nodejs.org"
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js 20+ required. Found: $(node -v). Update with: brew upgrade node"
fi
success "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org"
fi
success "npm $(npm -v)"

# Optional: ripgrep
if command -v rg &>/dev/null; then
  success "ripgrep $(rg --version | head -1 | awk '{print $2}') — fast search enabled"
else
  dim "ripgrep not found — grep will be used instead"
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install ripgrep for faster file search?" "y"; then
      run_step "Installing ripgrep..." /tmp/jarvis-setup-rg.log brew install ripgrep && success "ripgrep installed" || warn "ripgrep install failed — continuing without it"
    fi
  fi
fi

# Optional: poppler (PDF support)
if command -v pdftotext &>/dev/null; then
  success "poppler — PDF reading enabled"
else
  dim "poppler not found — PDF reading will be unavailable"
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install poppler for PDF support?"; then
      run_step "Installing poppler..." /tmp/jarvis-setup-poppler.log brew install poppler && success "poppler installed" || warn "poppler install failed — continuing without it"
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Detect & Configure API Keys
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 2/6 — AI Provider Setup"

ANTHROPIC_KEY=""
OPENAI_KEY=""
DEFAULT_MODEL=""

JARVIS_DIR="${JARVIS_HOME:-$HOME/.jarvis}"

# --- Key detection ---
# Priority: environment → ~/.jarvis/.env → shell config files

detect_key() {
  local var_name="$1"
  local found=""

  # 1. Current environment
  eval "found=\"\${$var_name:-}\""
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi

  # 2. ~/.jarvis/.env
  if [ -f "$JARVIS_DIR/.env" ]; then
    found=$(grep "^${var_name}=" "$JARVIS_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  fi

  # 3. Shell config files
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ]; then
      found=$(grep "export ${var_name}=" "$rc" 2>/dev/null | tail -1 | sed 's/^export [^=]*=//' | tr -d '"' | tr -d "'")
      if [ -n "$found" ]; then
        echo "$found"
        return 0
      fi
    fi
  done

  return 1
}

describe_source() {
  local var_name="$1"

  eval "local env_val=\"\${$var_name:-}\""
  [ -n "$env_val" ] && { echo "environment variable"; return; }

  if [ -f "$JARVIS_DIR/.env" ]; then
    local v
    v=$(grep "^${var_name}=" "$JARVIS_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$v" ] && { echo "~/.jarvis/.env"; return; }
  fi

  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ]; then
      local rcv
      rcv=$(grep "export ${var_name}=" "$rc" 2>/dev/null | tail -1)
      [ -n "$rcv" ] && { echo "$(basename "$rc")"; return; }
    fi
  done

  echo "unknown"
}

DETECTED_ANTHROPIC=$(detect_key "ANTHROPIC_API_KEY" || true)
DETECTED_OPENAI=$(detect_key "OPENAI_API_KEY" || true)

# Show what we found
FOUND_ANY=false
if [ -n "$DETECTED_ANTHROPIC" ]; then
  FOUND_ANY=true
  ANTHRO_SOURCE=$(describe_source "ANTHROPIC_API_KEY")
  success "Found Anthropic API key — $(mask_key "$DETECTED_ANTHROPIC") (from $ANTHRO_SOURCE)"
fi

if [ -n "$DETECTED_OPENAI" ]; then
  FOUND_ANY=true
  OPENAI_SOURCE=$(describe_source "OPENAI_API_KEY")
  success "Found OpenAI API key — $(mask_key "$DETECTED_OPENAI") (from $OPENAI_SOURCE)"
fi

$FOUND_ANY || dim "No existing API keys found in environment, .env, or shell config."

echo ""

# Decision flow
if [ -n "$DETECTED_ANTHROPIC" ] && [ -n "$DETECTED_OPENAI" ]; then
  info "Both providers detected."
  echo ""
  echo "  [1] Use both (recommended)"
  echo "  [2] Anthropic only"
  echo "  [3] OpenAI only"
  echo "  [4] Enter different keys"
  echo ""
  read -r -p "  Choice [1]: " KEY_CHOICE
  KEY_CHOICE=${KEY_CHOICE:-1}

  case $KEY_CHOICE in
    1) ANTHROPIC_KEY="$DETECTED_ANTHROPIC"; OPENAI_KEY="$DETECTED_OPENAI"; DEFAULT_MODEL="claude-sonnet-4-6" ;;
    2) ANTHROPIC_KEY="$DETECTED_ANTHROPIC"; DEFAULT_MODEL="claude-sonnet-4-6" ;;
    3) OPENAI_KEY="$DETECTED_OPENAI"; DEFAULT_MODEL="gpt-4o" ;;
    4) : ;;  # fall through to manual entry
    *) fail "Invalid choice." ;;
  esac

elif [ -n "$DETECTED_ANTHROPIC" ]; then
  if confirm "Use detected Anthropic key?" "y"; then
    ANTHROPIC_KEY="$DETECTED_ANTHROPIC"
    DEFAULT_MODEL="claude-sonnet-4-6"
  fi
  if confirm "Also configure OpenAI?"; then
    OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
    [ -z "$OPENAI_KEY" ] && warn "Skipped — you can add it later in ~/.jarvis/.env"
  fi

elif [ -n "$DETECTED_OPENAI" ]; then
  if confirm "Use detected OpenAI key?" "y"; then
    OPENAI_KEY="$DETECTED_OPENAI"
    DEFAULT_MODEL="gpt-4o"
  fi
  if confirm "Also configure Anthropic? (recommended)"; then
    ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
    [ -n "$ANTHROPIC_KEY" ] && DEFAULT_MODEL="claude-sonnet-4-6"
  fi
fi

# Manual entry if nothing set yet
if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ]; then
  echo ""
  info "Choose your AI provider:"
  echo ""
  echo "  [1] Anthropic (Claude) — recommended"
  echo "  [2] OpenAI (GPT-4o, o3, etc.)"
  echo "  [3] Both"
  echo ""
  read -r -p "  Choice [1]: " PROVIDER_CHOICE
  PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}

  case $PROVIDER_CHOICE in
    1)
      ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
      [ -z "$ANTHROPIC_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    2)
      OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
      [ -z "$OPENAI_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="gpt-4o"
      ;;
    3)
      ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
      OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
      [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ] && fail "At least one API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    *)
      fail "Invalid choice."
      ;;
  esac
fi

# Validate key format (non-blocking warning)
if [ -n "$ANTHROPIC_KEY" ] && [[ ! "$ANTHROPIC_KEY" =~ ^sk-ant- ]]; then
  warn "Anthropic key doesn't start with sk-ant- — this may not work"
fi

[ -z "$DEFAULT_MODEL" ] && DEFAULT_MODEL="claude-sonnet-4-6"

echo ""
PROVIDER_LABEL=""
[ -n "$ANTHROPIC_KEY" ] && PROVIDER_LABEL="Anthropic"
[ -n "$OPENAI_KEY" ] && PROVIDER_LABEL="${PROVIDER_LABEL:+$PROVIDER_LABEL + }OpenAI"
success "Provider: $PROVIDER_LABEL | Default model: $DEFAULT_MODEL"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Install Dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 3/6 — Dependencies"

# Force public npm registry — ignores user-level ~/.npmrc (which may point to
# a private registry like Nubank CodeArtifact, JFrog, Verdaccio, etc.). A
# project-level .npmrc also pins the registry when commands run from inside
# the repo, but these flags make setup.sh robust regardless of cwd.
NPM_OPTS="--userconfig=/dev/null --registry=https://registry.npmjs.org/"

# The root workspace install covers app/ and packages/* in one shot.
# We run app/ui separately because it has a Vite build step that npm
# workspaces doesn't trigger automatically.

run_step "Installing dependencies..." /tmp/jarvis-setup-npm-root.log \
  npm install $NPM_OPTS --silent \
  && success "Dependencies installed" \
  || fail "npm install failed — check /tmp/jarvis-setup-npm-root.log"

run_step "Installing UI dependencies..." /tmp/jarvis-setup-npm-ui.log \
  sh -c "cd '$REPO_DIR/app/ui' && npm install $NPM_OPTS --silent" \
  && success "UI dependencies installed" \
  || fail "UI npm install failed — check /tmp/jarvis-setup-npm-ui.log"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Build UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 4/6 — Building HUD"

run_step "Building Electron HUD..." /tmp/jarvis-setup-build.log \
  sh -c "cd '$REPO_DIR/app/ui' && npm run build --silent"

if [ -d "$REPO_DIR/app/ui/dist" ] && [ -n "$(ls -A "$REPO_DIR/app/ui/dist" 2>/dev/null)" ]; then
  success "HUD built successfully"
else
  warn "HUD build may have failed — check /tmp/jarvis-setup-build.log"
  if confirm "Show build log?" "y"; then
    tail -30 /tmp/jarvis-setup-build.log
  fi
  fail "Cannot continue without a working HUD build."
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Write Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 5/6 — Configuration"

mkdir -p "$JARVIS_DIR"
step "Config dir: $JARVIS_DIR"
echo ""

# --- settings.user.json ---
SETTINGS_USER="$JARVIS_DIR/settings.user.json"

if [ -f "$SETTINGS_USER" ]; then
  CURRENT_MODEL=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('$SETTINGS_USER','utf8'));console.log(s.model||'')}catch{}" 2>/dev/null || true)
  if [ -n "$CURRENT_MODEL" ] && [ "$CURRENT_MODEL" != "$DEFAULT_MODEL" ]; then
    info "Existing settings found (model: $CURRENT_MODEL)"
    if confirm "Update model to $DEFAULT_MODEL?"; then
      node -e "
        const fs = require('fs');
        const path = process.argv[1];
        const s = JSON.parse(fs.readFileSync(path, 'utf8'));
        s.model = process.argv[2];
        fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
      " "$SETTINGS_USER" "$DEFAULT_MODEL"
      success "Model updated to $DEFAULT_MODEL"
    else
      dim "Keeping model: $CURRENT_MODEL"
      DEFAULT_MODEL="$CURRENT_MODEL"
    fi
  else
    success "settings.user.json OK (model: ${CURRENT_MODEL:-$DEFAULT_MODEL})"
  fi
else
  cat > "$SETTINGS_USER" << EOJSON
{
  "model": "$DEFAULT_MODEL",
  "pieces": {}
}
EOJSON
  success "Created settings.user.json (model: $DEFAULT_MODEL)"
fi

# --- .env (chmod 600 — API keys are sensitive) ---
ENV_FILE="$JARVIS_DIR/.env"

write_env() {
  : > "$ENV_FILE"
  [ -n "$ANTHROPIC_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY" >> "$ENV_FILE"
  [ -n "$OPENAI_KEY" ]    && echo "OPENAI_API_KEY=$OPENAI_KEY"    >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

if [ -f "$ENV_FILE" ]; then
  EXISTING_ANTHROPIC=$(grep "^ANTHROPIC_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
  EXISTING_OPENAI=$(grep "^OPENAI_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)

  NEEDS_UPDATE=false
  [ -n "$ANTHROPIC_KEY" ] && [ "$ANTHROPIC_KEY" != "$EXISTING_ANTHROPIC" ] && NEEDS_UPDATE=true
  [ -n "$OPENAI_KEY" ]    && [ "$OPENAI_KEY"    != "$EXISTING_OPENAI"    ] && NEEDS_UPDATE=true

  if $NEEDS_UPDATE; then
    write_env
    success "~/.jarvis/.env updated"
  else
    success "~/.jarvis/.env is up to date"
  fi
else
  write_env
  success "~/.jarvis/.env created (permissions: 600)"
fi

# --- mcp.json (create default if missing) ---
MCP_FILE="$JARVIS_DIR/mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  echo '{ "mcpServers": {} }' > "$MCP_FILE"
  success "~/.jarvis/mcp.json created (empty — add MCP servers later)"
else
  success "~/.jarvis/mcp.json exists"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: macOS App
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if $IS_MAC; then
  header "Step 6/6 — macOS App"

  APP_DIR="$HOME/Applications/JARVIS.app"

  if [ -d "$APP_DIR" ]; then
    success "JARVIS.app already installed at $APP_DIR"
    if confirm "Reinstall/update JARVIS.app?"; then
      INSTALL_APP=true
    else
      INSTALL_APP=false
    fi
  else
    info "JARVIS can be installed as a native macOS app."
    dim "Opens from Spotlight (⌘+Space → JARVIS) or Launchpad."
    echo ""
    if confirm "Install JARVIS.app?" "y"; then
      INSTALL_APP=true
    else
      INSTALL_APP=false
    fi
  fi

  if $INSTALL_APP; then
    if [ -f "scripts/install-macos-app.sh" ]; then
      APP_INSTALL_LOG=/tmp/jarvis-setup-app.log
      bash scripts/install-macos-app.sh > "$APP_INSTALL_LOG" 2>&1
      APP_EXIT=$?
      if [ $APP_EXIT -eq 0 ] && [ -d "$APP_DIR" ]; then
        # Validate the launcher points to this repo
        LAUNCHER_REPO=$(grep "JARVIS_DIR=" "$APP_DIR/Contents/MacOS/jarvis" 2>/dev/null | head -1 | sed 's/.*JARVIS_DIR="\(.*\)"/\1/')
        if [ "$LAUNCHER_REPO" = "$REPO_DIR/app" ]; then
          success "JARVIS.app installed — launch via Spotlight (⌘+Space → JARVIS)"
        else
          warn "JARVIS.app installed but launcher points to: ${LAUNCHER_REPO:-unknown}"
          dim "Expected: $REPO_DIR/app — run setup again to fix"
        fi
      else
        warn "macOS app installation failed (exit $APP_EXIT)"
        dim "Log: $APP_INSTALL_LOG"
        tail -5 "$APP_INSTALL_LOG" | while IFS= read -r line; do dim "  $line"; done
      fi
    else
      warn "install-macos-app.sh not found. Skipping app creation."
    fi
  fi
else
  header "Step 6/6 — Platform"
  success "Linux/other detected — skipping macOS app creation"
  dim "Start JARVIS with: cd $REPO_DIR/app && npx tsx src/main.ts"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Validation — Full System Check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
if confirm "Run full system validation?" "y"; then

  HUD_PORT=50052
  JARVIS_TEST_LOG=/tmp/jarvis-setup-test.log
  CHECKS_PASSED=0
  CHECKS_FAILED=0

  check_pass() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; CHECKS_PASSED=$((CHECKS_PASSED + 1)); }
  check_fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; CHECKS_FAILED=$((CHECKS_FAILED + 1)); }
  check_warn() { printf "  ${YELLOW}⚠${RESET} %s\n" "$1"; }

  echo ""
  printf "  ${BOLD}Running checks...${RESET}\n"
  echo ""

  # ── Check 1: Port availability ──────────────────
  if port_in_use "$HUD_PORT"; then
    check_warn "Port $HUD_PORT already in use — testing against running instance"
    JARVIS_PID=""
    RUNNING_INSTANCE=true
  else
    RUNNING_INSTANCE=false

    # Source ~/.jarvis/.env for keys
    set -a
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && source "$ENV_FILE" || true
    set +a

    # Start headless (no Electron window during test)
    cd "$REPO_DIR/app"
    JARVIS_NO_HUD=1 npx tsx src/main.ts > "$JARVIS_TEST_LOG" 2>&1 &
    JARVIS_PID=$!
    cd "$REPO_DIR"

    # Wait for HTTP server to be ready
    SERVER_READY=false
    for i in $(seq 1 30); do
      printf "\r  ${BLUE}⠋${RESET} Starting JARVIS... (%ds)" "$i"
      if curl -sf "http://localhost:$HUD_PORT/hud" &>/dev/null; then
        SERVER_READY=true
        break
      fi
      if ! kill -0 "$JARVIS_PID" 2>/dev/null; then
        break  # process died
      fi
      sleep 1
    done
    printf "\r\033[K"

    if ! $SERVER_READY; then
      check_fail "Server did not start within 30s"
      dim "Log: $JARVIS_TEST_LOG"
      if confirm "Show startup log?"; then
        echo ""
        tail -25 "$JARVIS_TEST_LOG" | while IFS= read -r line; do dim "  $line"; done
        echo ""
      fi
      # Kill and bail out of validation
      kill "$JARVIS_PID" 2>/dev/null || true
      wait "$JARVIS_PID" 2>/dev/null || true
      CHECKS_FAILED=$((CHECKS_FAILED + 1))
      # Skip remaining checks
      SKIP_CHECKS=true
    else
      SKIP_CHECKS=false
    fi
  fi

  if [ "${SKIP_CHECKS:-false}" = "false" ]; then

    # ── Check 2: HTTP server responding ─────────────
    HUD_RESPONSE=$(curl -sf "http://localhost:$HUD_PORT/hud" 2>/dev/null || true)
    if echo "$HUD_RESPONSE" | grep -q '"reactor"'; then
      check_pass "HTTP server responding on port $HUD_PORT"
    else
      check_fail "HTTP server not responding correctly on port $HUD_PORT"
    fi

    # ── Check 3: Core pieces running ────────────────
    CORE_PIECES="jarvis-core capability-executor capability-loader chat-output chat-input"
    ALL_RUNNING=true
    FAILED_PIECES=""
    for piece in $CORE_PIECES; do
      STATUS=$(echo "$HUD_RESPONSE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('components',[]):
    if c['id']=='$piece':
        print(c.get('status','unknown'))
        break
" 2>/dev/null || true)
      if [ "$STATUS" != "running" ] && [ "$STATUS" != "waiting_tools" ] && [ "$STATUS" != "processing" ]; then
        ALL_RUNNING=false
        FAILED_PIECES="$FAILED_PIECES $piece($STATUS)"
      fi
    done
    if $ALL_RUNNING; then
      check_pass "All core pieces running"
    else
      check_fail "Some core pieces not running:$FAILED_PIECES"
    fi

    # ── Check 4: AI provider reachable ──────────────
    PROVIDER_OK=false
    if [ -n "$ANTHROPIC_KEY" ] || [ -n "$(grep '^ANTHROPIC_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)" ]; then
      # Minimal Anthropic API ping — count tokens only, no actual message
      ANTHRO_KEY="${ANTHROPIC_KEY:-$(grep '^ANTHROPIC_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "https://api.anthropic.com/v1/messages" \
        -H "x-api-key: $ANTHRO_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -H "content-type: application/json" \
        -d '{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
        --max-time 10 2>/dev/null || echo "000")
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "Anthropic API key valid (HTTP 200)"
        PROVIDER_OK=true
      elif [ "$HTTP_STATUS" = "401" ]; then
        check_fail "Anthropic API key invalid (HTTP 401 — check ~/.jarvis/.env)"
      elif [ "$HTTP_STATUS" = "000" ]; then
        check_warn "Anthropic API unreachable (network timeout)"
      else
        check_warn "Anthropic API returned HTTP $HTTP_STATUS"
      fi
    fi

    if ! $PROVIDER_OK && { [ -n "$OPENAI_KEY" ] || grep -q '^OPENAI_API_KEY=' "$ENV_FILE" 2>/dev/null; }; then
      OAPI_KEY="${OPENAI_KEY:-$(grep '^OPENAI_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}"
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X GET "https://api.openai.com/v1/models" \
        -H "Authorization: Bearer $OAPI_KEY" \
        --max-time 10 2>/dev/null || echo "000")
      if [ "$HTTP_STATUS" = "200" ]; then
        check_pass "OpenAI API key valid (HTTP 200)"
        PROVIDER_OK=true
      elif [ "$HTTP_STATUS" = "401" ]; then
        check_fail "OpenAI API key invalid (HTTP 401 — check ~/.jarvis/.env)"
      elif [ "$HTTP_STATUS" = "000" ]; then
        check_warn "OpenAI API unreachable (network timeout)"
      else
        check_warn "OpenAI API returned HTTP $HTTP_STATUS"
      fi
    fi

    # ── Check 5: Settings file valid JSON ───────────
    if node -e "JSON.parse(require('fs').readFileSync('$SETTINGS_USER','utf8'))" 2>/dev/null; then
      check_pass "settings.user.json is valid JSON"
    else
      check_fail "settings.user.json is malformed JSON"
    fi

    # ── Check 6: .env permissions ───────────────────
    if [ -f "$ENV_FILE" ]; then
      ENV_PERMS=$(stat -f "%A" "$ENV_FILE" 2>/dev/null || stat -c "%a" "$ENV_FILE" 2>/dev/null || echo "unknown")
      if [ "$ENV_PERMS" = "600" ]; then
        check_pass "~/.jarvis/.env permissions: 600 (secure)"
      else
        check_warn "~/.jarvis/.env permissions: $ENV_PERMS (expected 600)"
        chmod 600 "$ENV_FILE" && dim "  → fixed to 600"
      fi
    fi

    # ── Check 7: macOS app (if applicable) ──────────
    if $IS_MAC; then
      APP_DIR="$HOME/Applications/JARVIS.app"
      if [ -d "$APP_DIR" ] && [ -x "$APP_DIR/Contents/MacOS/jarvis" ]; then
        LAUNCHER_REPO=$(grep "JARVIS_DIR=" "$APP_DIR/Contents/MacOS/jarvis" 2>/dev/null | head -1 | sed 's/.*JARVIS_DIR="\(.*\)"/\1/')
        if [ "$LAUNCHER_REPO" = "$REPO_DIR/app" ]; then
          check_pass "JARVIS.app installed and points to this repo"
        else
          check_warn "JARVIS.app points to different repo: $LAUNCHER_REPO"
        fi
      else
        check_warn "JARVIS.app not installed (run setup again to install)"
      fi
    fi

    # Shutdown test instance
    if [ -n "$JARVIS_PID" ]; then
      kill "$JARVIS_PID" 2>/dev/null || true
      sleep 1
      kill -0 "$JARVIS_PID" 2>/dev/null && kill -9 "$JARVIS_PID" 2>/dev/null || true
      wait "$JARVIS_PID" 2>/dev/null || true
    fi

  fi  # end SKIP_CHECKS

  # ── Result ──────────────────────────────────────
  echo ""
  TOTAL=$((CHECKS_PASSED + CHECKS_FAILED))
  if [ "$CHECKS_FAILED" -eq 0 ]; then
    printf "  ${GREEN}${BOLD}All $TOTAL checks passed.${RESET}\n"
  else
    printf "  ${YELLOW}${BOLD}$CHECKS_PASSED/$TOTAL checks passed, $CHECKS_FAILED failed.${RESET}\n"
    dim "Fix the issues above, then run setup again."
  fi

fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Summary
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
printf "${GREEN}${BOLD}  ✓ JARVIS setup complete!${RESET}\n"
echo ""

printf "  ${BOLD}Provider${RESET}   $PROVIDER_LABEL\n"
printf "  ${BOLD}Model${RESET}      $DEFAULT_MODEL\n"
printf "  ${BOLD}HUD${RESET}        http://localhost:50052\n"
printf "  ${BOLD}gRPC${RESET}       localhost:50051\n"

echo ""
printf "  ${BOLD}How to start:${RESET}\n"
echo ""

if $IS_MAC && [ -d "$HOME/Applications/JARVIS.app" ]; then
  echo "    • Spotlight: ⌘+Space → JARVIS"
  echo "    • Terminal:  cd $REPO_DIR/app && npx tsx src/main.ts"
else
  echo "    cd $REPO_DIR/app && npx tsx src/main.ts"
fi

echo ""
printf "  ${BOLD}Configuration:${RESET}\n"
echo ""
printf "    ${DIM}~/.jarvis/.env${RESET}               API keys ${DIM}(chmod 600)${RESET}\n"
printf "    ${DIM}~/.jarvis/settings.user.json${RESET}  Model, pieces, plugins\n"
printf "    ${DIM}~/.jarvis/mcp.json${RESET}            MCP server connections\n"
printf "    ${DIM}~/.jarvis/plugins/${RESET}            Installed plugins\n"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
