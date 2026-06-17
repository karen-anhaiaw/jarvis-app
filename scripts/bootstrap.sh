#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JARVIS Bootstrap Script
# Run once on a new machine after cloning jarvis-app to scaffold ~/.jarvis
# with the directory structure and config templates.
#
# Scope: this script only writes ~/.jarvis/ scaffolding. It does NOT touch:
#   • Plugins        — PluginManager auto-clones, npm-installs, and runs each
#                      plugin's own bootstrap (skills/roles/secrets templates
#                      declared in the plugin's plugin.json) at JARVIS startup
#                      for every plugin listed in settings.{json,user.json}.
#   • External repos — no dotfiles, no personal directories.
#
# Usage: ./scripts/bootstrap.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

JARVIS_DIR="$HOME/.jarvis"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      JARVIS Bootstrap                ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Create core directory structure ───────────────────────────────────────
# Only JARVIS-core directories. Plugin-specific dirs (skills, roles, secrets,
# slack-hook, mnemosyne, etc.) are created on demand by each plugin's own
# bootstrap (runPluginBootstrap in plugin-manager.ts).
log "Creating ~/.jarvis core directory structure..."
mkdir -p "$JARVIS_DIR"/{plugins,sessions,logs,certs,oauth}

# ── 2. Sync committed defaults (settings.json) ───────────────────────────────
# settings.ts loads defaults from ~/.jarvis/settings.json (committed defaults
# shipped with the app) and user overrides from ~/.jarvis/settings.user.json.
# Always overwrite the defaults file from the repo on bootstrap so layout/piece
# defaults stay in sync with the installed jarvis-app version. User customizations
# live exclusively in settings.user.json and are never touched here.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULTS_SRC="$REPO_DIR/app/.jarvis/settings.json"
DEFAULTS_DST="$JARVIS_DIR/settings.json"
if [ -f "$DEFAULTS_SRC" ]; then
  cp -f "$DEFAULTS_SRC" "$DEFAULTS_DST"
  log "Synced settings.json defaults from $DEFAULTS_SRC"
else
  warn "settings.json defaults not found at $DEFAULTS_SRC (skipping)"
fi

# ── 3. MCP config template ───────────────────────────────────────────────────
echo ""
echo "── MCP ──────────────────────────────────"

MCP_FILE="$JARVIS_DIR/mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  log "Creating mcp.json template..."
  cat > "$MCP_FILE" << 'EOF'
{
  "servers": {}
}
EOF
  warn "Configure $MCP_FILE with your MCP server endpoints and tokens."
fi

# ── 4. settings.user.json (providers/API keys) ───────────────────────────────
echo ""
echo "── Settings ─────────────────────────────"

USER_SETTINGS="$JARVIS_DIR/settings.user.json"
if [ ! -f "$USER_SETTINGS" ]; then
  log "Creating settings.user.json template..."
  cat > "$USER_SETTINGS" << 'EOF'
{
  "providers": {
    "anthropic": {
      "apiKey": "YOUR_ANTHROPIC_API_KEY"
    },
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "YOUR_OPENAI_API_KEY"
    }
  },
  "model": "claude-sonnet-4-6"
}
EOF
  warn "Edit $USER_SETTINGS with your API keys."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Bootstrap complete!                 ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Required manual steps:"
echo "  1. Edit ~/.jarvis/settings.user.json  — add your API keys"
echo "  2. Edit ~/.jarvis/mcp.json — configure MCP servers"
echo ""
echo "Optional:"
echo "  • Plugins listed in settings.{json,user.json} are auto-cloned by"
echo "    the PluginManager on first JARVIS start (each plugin runs its"
echo "    own bootstrap to drop its templates / secrets / skills)."
echo ""
echo "Then start JARVIS: npm start (from jarvis-app/)"
echo ""
