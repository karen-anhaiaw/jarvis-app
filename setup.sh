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
  # Reads a line from the terminal. UI is written to /dev/tty so the prompt
  # stays visible when called via $(...) capture; only the result goes to stdout.
  local prompt="$1" default="$2" result
  if [ -n "$default" ]; then
    printf "  %s ${DIM}[%s]${RESET}: " "$prompt" "$default" >/dev/tty
    read -r result </dev/tty
    echo "${result:-$default}"
  else
    printf "  %s: " "$prompt" >/dev/tty
    read -r result </dev/tty
    echo "$result"
  fi
}

ask_secret() {
  # Reads a secret from the terminal with no echo. UI is written to /dev/tty
  # so the prompt is visible even when called via $(...) capture.
  local prompt="$1" result
  printf "  %s: " "$prompt" >/dev/tty
  read -rs result </dev/tty
  echo "" >/dev/tty
  echo "$result"
}

prompt_api_key() {
  # Prompts for an API key with provider-specific guidance. UI is written to
  # /dev/tty so it works under $(...) capture; only the key value goes to stdout.
  local provider="$1" url="$2" prefix="$3" example="${4:-}"
  {
    echo ""
    printf "  ${BOLD}%s API key${RESET}\n" "$provider"
    printf "    ${DIM}→ Get one at:${RESET} %s\n" "$url"
    printf "    ${DIM}→ Starts with${RESET} \"%s\"" "$prefix"
    [ -n "$example" ] && printf " ${DIM}(e.g. %s)${RESET}" "$example"
    echo ""
    printf "    ${DIM}→ Input is hidden while you type — paste and press Enter.${RESET}\n"
    echo ""
  } >/dev/tty
  ask_secret "Paste your $provider API key"
}

# Ping a provider's models endpoint. Writes a brief response body excerpt
# (up to a few hundred chars) to /tmp/jarvis-setup-ping.body so callers can
# surface meaningful proxy error messages. Echoes the HTTP status code;
# "000" on connection error / timeout / DNS failure.
PING_BODY_FILE="/tmp/jarvis-setup-ping.body"

ping_anthropic() {
  curl -sk -o "$PING_BODY_FILE" -w "%{http_code}" -X GET "${2%/}/v1/models" \
    -H "x-api-key: $1" -H "anthropic-version: 2023-06-01" \
    --max-time 10 2>/dev/null || echo "000"
}

ping_openai() {
  curl -sk -o "$PING_BODY_FILE" -w "%{http_code}" -X GET "${2%/}/models" \
    -H "Authorization: Bearer $1" --max-time 10 2>/dev/null || echo "000"
}

# Best-effort extraction of a human-readable error from the ping response.
# Tries to pull error.message from a JSON body; falls back to first 200 chars.
extract_ping_error() {
  [ -f "$PING_BODY_FILE" ] || { echo ""; return; }
  local msg
  msg=$(node -e "try{const b=require('fs').readFileSync('$PING_BODY_FILE','utf8');const j=JSON.parse(b);process.stdout.write(j.error?.message||j.message||'')}catch{}" 2>/dev/null || true)
  if [ -n "$msg" ]; then
    echo "$msg" | head -c 240
  else
    head -c 200 "$PING_BODY_FILE" 2>/dev/null | tr -d '\n'
  fi
}

# Validates a provider key against the canonical (default) endpoint first.
# On any non-200, prompts the user for a proxy/gateway base URL and retries.
# Echoes the validated base URL to stdout (or empty if validation skipped /
# the user pressed Enter with a default-endpoint pass). Returns 0 on success,
# 1 if the user skipped or the proxy also failed.
#
#   $1 provider display label (Anthropic|OpenAI)
#   $2 provider id for JSON path (anthropic|openai)
#   $3 the key value
#   $4 default base URL
#   $5 ping function name
#   $6 initial candidate URL (from env var) — tested first if non-empty
validate_provider_key() {
  local label="$1" provider_id="$2" key="$3" default_base="$4" ping_fn="$5" initial="${6:-}"
  local base status candidates_label err

  if [ -n "$initial" ] && [ "$initial" != "$default_base" ]; then
    base="$initial"
    candidates_label="suggested URL"
  else
    base="$default_base"
    candidates_label="default endpoint"
  fi

  {
    echo ""
    printf "  ${BLUE}⠋${RESET} Validating %s key against %s (%s)...\n" "$label" "$base" "$candidates_label"
  } >/dev/tty

  status=$($ping_fn "$key" "$base")
  if [ "$status" = "200" ]; then
    success "$label key valid (HTTP 200 @ $base)" >/dev/tty
    [ "$base" != "$default_base" ] && echo "$base"
    return 0
  fi

  err=$(extract_ping_error)
  {
    warn "$label key rejected at $base (HTTP $status)"
    [ -n "$err" ] && dim "Server says: $err"
    dim "If you reach $label through a proxy (LiteLLM, Bedrock gateway, etc.),"
    dim "enter its base URL now. Leave blank to skip — you can fix later in"
    dim "~/.jarvis/settings.user.json (providers.${provider_id}.baseUrl)."
    echo ""
  } >/dev/tty

  local custom
  custom=$(ask "Custom $label base URL (blank to skip)" "$initial")

  if [ -z "$custom" ]; then
    warn "$label key validation skipped — saving as-is" >/dev/tty
    return 1
  fi

  printf "  ${BLUE}⠋${RESET} Re-testing against %s...\n" "$custom" >/dev/tty
  status=$($ping_fn "$key" "$custom")
  if [ "$status" = "200" ]; then
    success "$label key valid (HTTP 200 @ $custom)" >/dev/tty
    echo "$custom"
    return 0
  fi

  err=$(extract_ping_error)
  {
    warn "$label key still rejected at $custom (HTTP $status)"
    [ -n "$err" ] && dim "Server says: $err"
    dim "Saving the URL anyway — review ~/.jarvis/settings.user.json after setup."
  } >/dev/tty
  echo "$custom"
  return 1
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
# Priority: environment → settings.user.json → shell config files
SETTINGS_USER_EARLY="${JARVIS_DIR}/settings.user.json"

key_from_settings() {
  local provider="$1"
  [ -f "$SETTINGS_USER_EARLY" ] || return 1
  node -e "try{const s=JSON.parse(require('fs').readFileSync('$SETTINGS_USER_EARLY','utf8'));process.stdout.write(s.providers?.['$1']?.apiKey||'')}catch{}" "$provider" 2>/dev/null
}

detect_key() {
  local var_name="$1"
  local provider=""
  case "$var_name" in
    ANTHROPIC_API_KEY) provider="anthropic" ;;
    OPENAI_API_KEY)    provider="openai"    ;;
  esac
  local found=""

  # 1. Current environment
  eval "found=\"\${$var_name:-}\""
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi

  # 2. settings.user.json (providers.<provider>.apiKey)
  if [ -n "$provider" ]; then
    found=$(key_from_settings "$provider" || true)
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
  local provider=""
  case "$var_name" in
    ANTHROPIC_API_KEY) provider="anthropic" ;;
    OPENAI_API_KEY)    provider="openai"    ;;
  esac

  eval "local env_val=\"\${$var_name:-}\""
  [ -n "$env_val" ] && { echo "environment variable"; return; }

  if [ -n "$provider" ]; then
    local v
    v=$(key_from_settings "$provider" || true)
    [ -n "$v" ] && { echo "~/.jarvis/settings.user.json"; return; }
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

$FOUND_ANY || dim "No existing API keys found in environment, settings.user.json, or shell config."

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
    OPENAI_KEY=$(prompt_api_key "OpenAI" "https://platform.openai.com/api-keys" "sk-")
    [ -z "$OPENAI_KEY" ] && warn "Skipped — you can add it later in ~/.jarvis/settings.user.json (providers.openai.apiKey)"
  fi

elif [ -n "$DETECTED_OPENAI" ]; then
  if confirm "Use detected OpenAI key?" "y"; then
    OPENAI_KEY="$DETECTED_OPENAI"
    DEFAULT_MODEL="gpt-4o"
  fi
  if confirm "Also configure Anthropic? (recommended)"; then
    ANTHROPIC_KEY=$(prompt_api_key "Anthropic" "https://console.anthropic.com/settings/keys" "sk-ant-")
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
      ANTHROPIC_KEY=$(prompt_api_key "Anthropic" "https://console.anthropic.com/settings/keys" "sk-ant-")
      [ -z "$ANTHROPIC_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    2)
      OPENAI_KEY=$(prompt_api_key "OpenAI" "https://platform.openai.com/api-keys" "sk-")
      [ -z "$OPENAI_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="gpt-4o"
      ;;
    3)
      ANTHROPIC_KEY=$(prompt_api_key "Anthropic" "https://console.anthropic.com/settings/keys" "sk-ant-")
      OPENAI_KEY=$(prompt_api_key "OpenAI" "https://platform.openai.com/api-keys" "sk-")
      [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ] && fail "At least one API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    *)
      fail "Invalid choice."
      ;;
  esac
fi

# Validate keys against the provider endpoint NOW (before npm install / build),
# so the user gets fast feedback on bad keys / proxy needs. Resulting baseUrl
# overrides (if any) are persisted to settings.user.json in Step 5.
ANTHROPIC_BASE_URL_OVERRIDE=""
OPENAI_BASE_URL_OVERRIDE=""

if [ -n "$ANTHROPIC_KEY" ]; then
  ANTHROPIC_BASE_URL_OVERRIDE=$(validate_provider_key \
    "Anthropic" "anthropic" "$ANTHROPIC_KEY" "https://api.anthropic.com" ping_anthropic "${ANTHROPIC_BASE_URL:-}") || true
fi

if [ -n "$OPENAI_KEY" ]; then
  OPENAI_BASE_URL_OVERRIDE=$(validate_provider_key \
    "OpenAI" "openai" "$OPENAI_KEY" "https://api.openai.com/v1" ping_openai "${OPENAI_BASE_URL:-}") || true
fi

[ -z "$DEFAULT_MODEL" ] && DEFAULT_MODEL="claude-sonnet-4-6"

echo ""
PROVIDER_LABEL=""
[ -n "$ANTHROPIC_KEY" ] && PROVIDER_LABEL="Anthropic"
[ -n "$OPENAI_KEY" ] && PROVIDER_LABEL="${PROVIDER_LABEL:+$PROVIDER_LABEL + }OpenAI"
success "Provider: $PROVIDER_LABEL | Default model: $DEFAULT_MODEL"
[ -n "$ANTHROPIC_BASE_URL_OVERRIDE" ] && dim "Anthropic baseUrl: $ANTHROPIC_BASE_URL_OVERRIDE"
[ -n "$OPENAI_BASE_URL_OVERRIDE" ]    && dim "OpenAI baseUrl:    $OPENAI_BASE_URL_OVERRIDE"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Install Dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 3/6 — Dependencies"

# Force public npm registry — isolates from ANY authenticated private registry
# (Nubank CodeArtifact, JFrog, Verdaccio, etc.). npm has four config layers;
# neutralizing only ~/.npmrc (--userconfig) leaves a global npmrc — or a
# parent-directory .npmrc picked up by the cwd cascade (e.g. ~/dev/nu/.npmrc) —
# free to inject a //codeartifact.../:_authToken=. An expired token there fails
# the install with E401.
#
# We isolate via npm_config_* ENV VARS (highest precedence) instead of flags:
#   - npm 11 / @npmcli/config REJECTS the same path in two config levels
#     ("double-loading config /dev/null as global, previously loaded as user"),
#     so --userconfig=/dev/null --globalconfig=/dev/null is invalid.
#   - Two DISTINCT empty temp files sidestep that: each config level loads its
#     own file, both empty, so no private registry/authToken leaks in.
#   - npm_config_registry pins the public registry.
# The project's own .npmrc (public registry) still pins the registry via cwd.
#
# NOTE: no --silent. Silencing npm hides the real error on failure — run_step
# redirects stdout+stderr to a log, and --silent leaves that log empty on
# exit 1, making failures undebuggable. Let npm speak.
NPM_USERCONFIG_TMP=$(mktemp "${TMPDIR:-/tmp}/jarvis-npmrc-user.XXXXXX")
NPM_GLOBALCONFIG_TMP=$(mktemp "${TMPDIR:-/tmp}/jarvis-npmrc-global.XXXXXX")
trap 'rm -f "$NPM_USERCONFIG_TMP" "$NPM_GLOBALCONFIG_TMP"' EXIT
export npm_config_userconfig="$NPM_USERCONFIG_TMP"
export npm_config_globalconfig="$NPM_GLOBALCONFIG_TMP"
export npm_config_registry="https://registry.npmjs.org/"

# The root workspace install covers app/ and packages/* in one shot.
# We run app/ui separately because it has a Vite build step that npm
# workspaces doesn't trigger automatically. The npm_config_* env vars above
# are inherited by both installs (and by the sh -c subshell).

run_step "Installing dependencies..." /tmp/jarvis-setup-npm-root.log \
  npm install \
  && success "Dependencies installed" \
  || fail "npm install failed — check /tmp/jarvis-setup-npm-root.log"

run_step "Installing UI dependencies..." /tmp/jarvis-setup-npm-ui.log \
  sh -c "cd '$REPO_DIR/app/ui' && npm install" \
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

# Committed defaults (~/.jarvis/settings.json) are synced from the repo by
# scripts/bootstrap.sh, which the JARVIS.app launcher runs on every boot.
# No need to sync here — setup.sh's job is the interactive wizard part.

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

# Persist API keys + baseUrls into providers.<provider>.{apiKey,baseUrl}.
# settings.user.json is the single canonical store for credentials — the
# runtime reads from there directly (or falls back to shell env vars if a
# field is missing). No separate .env file.
node -e "
  const fs = require('fs');
  const [path, anthroKey, anthroUrl, openaiKey, openaiUrl] = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(path, 'utf8'));
  s.providers = s.providers || {};
  const set = (provider, field, value) => {
    if (!value) return;
    s.providers[provider] = s.providers[provider] || {};
    s.providers[provider][field] = value;
  };
  set('anthropic', 'apiKey',  anthroKey);
  set('anthropic', 'baseUrl', anthroUrl);
  set('openai',    'apiKey',  openaiKey);
  set('openai',    'baseUrl', openaiUrl);
  fs.writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
" "$SETTINGS_USER" "$ANTHROPIC_KEY" "$ANTHROPIC_BASE_URL_OVERRIDE" "$OPENAI_KEY" "$OPENAI_BASE_URL_OVERRIDE"

# settings.user.json now contains secrets — lock it down.
chmod 600 "$SETTINGS_USER"
success "settings.user.json updated (mode 600)"
[ -n "$ANTHROPIC_KEY" ]               && dim "  providers.anthropic.apiKey  saved"
[ -n "$ANTHROPIC_BASE_URL_OVERRIDE" ] && dim "  providers.anthropic.baseUrl saved"
[ -n "$OPENAI_KEY" ]                  && dim "  providers.openai.apiKey     saved"
[ -n "$OPENAI_BASE_URL_OVERRIDE" ]    && dim "  providers.openai.baseUrl    saved"

# Migrate any legacy ~/.jarvis/.env (no longer read by JARVIS) — keys are now
# in settings.user.json. We remove it to avoid drift and confusion.
LEGACY_ENV="$JARVIS_DIR/.env"
if [ -f "$LEGACY_ENV" ]; then
  rm -f "$LEGACY_ENV"
  dim "Removed legacy ~/.jarvis/.env (credentials now live in settings.user.json)"
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
        # Validate the launcher points to this repo. The launcher stores the
        # install-time path in `REPO_DIR="..."` (JARVIS_DIR is derived from it
        # at runtime as "$REPO_DIR/app"), so we compare against REPO_DIR.
        LAUNCHER_REPO=$(grep "^REPO_DIR=" "$APP_DIR/Contents/MacOS/jarvis" 2>/dev/null | head -1 | sed 's/.*REPO_DIR="\(.*\)"/\1/')
        if [ "$LAUNCHER_REPO" = "$REPO_DIR" ]; then
          success "JARVIS.app installed — launch via Spotlight (⌘+Space → JARVIS)"
        else
          warn "JARVIS.app installed but launcher points to: ${LAUNCHER_REPO:-unknown}"
          dim "Expected: $REPO_DIR — run setup again to fix"
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

    # No env sourcing needed: JARVIS reads credentials from settings.user.json.

    # Start headless (no Electron window during test)
    cd "$REPO_DIR/app"
    JARVIS_NO_HUD=1 npx tsx src/main.ts > "$JARVIS_TEST_LOG" 2>&1 &
    JARVIS_PID=$!
    cd "$REPO_DIR"

    # Wait for HTTP server to be ready
    SERVER_READY=false
    for i in $(seq 1 30); do
      printf "\r  ${BLUE}⠋${RESET} Starting JARVIS... (%ds)" "$i"
      if curl -skf "https://localhost:$HUD_PORT/hud" &>/dev/null; then
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
    HUD_RESPONSE=$(curl -skf "https://localhost:$HUD_PORT/hud" 2>/dev/null || true)
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
      # Healthy states vary by piece: generic pieces report "running"; the
      # jarvis-core reactor reports "online" when idle (or processing/
      # waiting_tools when busy). All of these mean the piece is alive.
      case "$STATUS" in
        running|waiting_tools|processing|online|idle) ;;
        *)
          ALL_RUNNING=false
          FAILED_PIECES="$FAILED_PIECES $piece($STATUS)"
          ;;
      esac
    done
    if $ALL_RUNNING; then
      check_pass "All core pieces running"
    else
      check_fail "Some core pieces not running:$FAILED_PIECES"
    fi

    # ── Check 4: AI provider reachable ──────────────
    # Key validation already happened inline in Step 2 (with interactive proxy
    # URL fallback). This is just a smoke test against the baseUrl currently
    # persisted in settings.user.json. Credentials come from settings.user.json
    # (canonical) with a fallback to the shell env var — mirrors the runtime.
    get_settings_field() {
      node -e "try{const s=JSON.parse(require('fs').readFileSync('$SETTINGS_USER','utf8'));process.stdout.write(s.providers?.['$1']?.['$2']||'')}catch{}" 2>/dev/null || true
    }

    PROVIDER_OK=false
    ANTHRO_KEY=$(get_settings_field "anthropic" "apiKey")
    ANTHRO_KEY="${ANTHRO_KEY:-${ANTHROPIC_KEY:-${ANTHROPIC_API_KEY:-}}}"
    if [ -n "$ANTHRO_KEY" ]; then
      ANTHRO_BASE=$(get_settings_field "anthropic" "baseUrl"); ANTHRO_BASE="${ANTHRO_BASE:-https://api.anthropic.com}"
      STATUS=$(ping_anthropic "$ANTHRO_KEY" "$ANTHRO_BASE")
      if [ "$STATUS" = "200" ]; then
        check_pass "Anthropic key valid (HTTP 200 @ $ANTHRO_BASE)"
        PROVIDER_OK=true
      else
        check_fail "Anthropic key rejected (HTTP $STATUS @ $ANTHRO_BASE)"
        dim "Edit $SETTINGS_USER (providers.anthropic.{apiKey,baseUrl})"
      fi
    fi

    OAPI_KEY=$(get_settings_field "openai" "apiKey")
    OAPI_KEY="${OAPI_KEY:-${OPENAI_KEY:-${OPENAI_API_KEY:-}}}"
    if ! $PROVIDER_OK && [ -n "$OAPI_KEY" ]; then
      OAPI_BASE=$(get_settings_field "openai" "baseUrl"); OAPI_BASE="${OAPI_BASE:-https://api.openai.com/v1}"
      STATUS=$(ping_openai "$OAPI_KEY" "$OAPI_BASE")
      if [ "$STATUS" = "200" ]; then
        check_pass "OpenAI key valid (HTTP 200 @ $OAPI_BASE)"
        PROVIDER_OK=true
      else
        check_fail "OpenAI key rejected (HTTP $STATUS @ $OAPI_BASE)"
        dim "Edit $SETTINGS_USER (providers.openai.{apiKey,baseUrl})"
      fi
    fi

    # ── Check 5: Settings file integrity ────────────
    if node -e "JSON.parse(require('fs').readFileSync('$SETTINGS_USER','utf8'))" 2>/dev/null; then
      check_pass "settings.user.json is valid JSON"
    else
      check_fail "settings.user.json is malformed JSON"
    fi

    # ── Check 6: settings.user.json permissions ─────
    SETTINGS_PERMS=$(stat -f "%A" "$SETTINGS_USER" 2>/dev/null || stat -c "%a" "$SETTINGS_USER" 2>/dev/null || echo "unknown")
    if [ "$SETTINGS_PERMS" = "600" ]; then
      check_pass "settings.user.json permissions: 600 (secure)"
    else
      check_warn "settings.user.json permissions: $SETTINGS_PERMS (expected 600 since it holds API keys)"
      chmod 600 "$SETTINGS_USER" && dim "  → fixed to 600"
    fi

    # ── Check 7: macOS app (if applicable) ──────────
    if $IS_MAC; then
      APP_DIR="$HOME/Applications/JARVIS.app"
      if [ -d "$APP_DIR" ] && [ -x "$APP_DIR/Contents/MacOS/jarvis" ]; then
        LAUNCHER_REPO=$(grep "^REPO_DIR=" "$APP_DIR/Contents/MacOS/jarvis" 2>/dev/null | head -1 | sed 's/.*REPO_DIR="\(.*\)"/\1/')
        if [ "$LAUNCHER_REPO" = "$REPO_DIR" ]; then
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
printf "  ${BOLD}HUD${RESET}        https://localhost:50052\n"
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
printf "    ${DIM}~/.jarvis/settings.user.json${RESET}  API keys, model, providers, pieces ${DIM}(chmod 600)${RESET}\n"
printf "    ${DIM}~/.jarvis/mcp.json${RESET}            MCP server connections\n"
printf "    ${DIM}~/.jarvis/plugins/${RESET}            Installed plugins\n"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
