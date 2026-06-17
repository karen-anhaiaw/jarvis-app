#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JARVIS Bootstrap Script
# Run once on a new machine after cloning jarvis-app.
# Installs all plugins from GitHub and sets up ~/.jarvis structure.
#
# Usage: ./scripts/bootstrap.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

JARVIS_DIR="$HOME/.jarvis"
PLUGINS_DIR="$JARVIS_DIR/plugins"
SECRETS_DIR="$JARVIS_DIR/secrets"
SKILLS_DIR="$JARVIS_DIR/skills"
ROLES_DIR="$JARVIS_DIR/roles"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

echo ""
echo "╔══════════════════════════════════════╗"
echo "║      JARVIS Bootstrap                ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Create directory structure ────────────────────────────────────────────
log "Creating ~/.jarvis directory structure..."
mkdir -p "$JARVIS_DIR"/{plugins,secrets,sessions,sessions/archive,logs,recordings,certs,reminders,mnemosyne,oauth,skills,roles,slack-hook,skills}

# ── 2. Install plugins from GitHub ───────────────────────────────────────────
echo ""
echo "── Plugins ──────────────────────────────"

declare -A PLUGINS=(
  ["jarvis-plugin-actors"]="github.com/giovanibarili/jarvis-plugin-actors"
  ["jarvis-plugin-browser"]="github.com/giovanibarili/jarvis-plugin-browser"
  ["jarvis-plugin-canvas"]="github.com/giovanibarili/jarvis-plugin-canvas"
  ["jarvis-plugin-kanban"]="github.com/giovanibarili/jarvis-plugin-kanban"
  ["jarvis-plugin-mnemosyne"]="github.com/giovanibarili/jarvis-plugin-mnemosyne"
  ["jarvis-plugin-never-forget"]="github.com/giovanibarili/jarvis-plugin-never-forget"
  ["jarvis-plugin-skills"]="github.com/giovanibarili/jarvis-plugin-skills"
  ["jarvis-plugin-slack-hook"]="github.com/giovanibarili/jarvis-plugin-slack-hook"
  ["jarvis-plugin-tasks"]="github.com/giovanibarili/jarvis-plugin-tasks"
  ["jarvis-plugin-voice"]="github.com/giovanibarili/jarvis-plugin-voice"
)

for plugin in "${!PLUGINS[@]}"; do
  repo="${PLUGINS[$plugin]}"
  dest="$PLUGINS_DIR/$plugin"
  git_url="https://$repo.git"

  if [ -d "$dest/.git" ]; then
    warn "$plugin already installed — pulling latest..."
    git -C "$dest" pull --quiet origin main 2>/dev/null || \
      git -C "$dest" pull --quiet origin master 2>/dev/null || \
      warn "$plugin: pull failed (may be on a feature branch)"
  else
    log "Cloning $plugin..."
    git clone --quiet "$git_url" "$dest" || { err "Failed to clone $plugin from $git_url"; continue; }
  fi

  # Install npm deps if package.json exists
  if [ -f "$dest/package.json" ]; then
    log "  Installing npm deps for $plugin..."
    (cd "$dest" && npm install --silent 2>/dev/null) || warn "  npm install failed for $plugin"
  fi
done

# ── 3. Skills and Roles (from claude-dotfiles) ───────────────────────────────
echo ""
echo "── Skills & Roles ───────────────────────"

DOTFILES="$HOME/dev/personal/claude-dotfiles"
if [ -d "$DOTFILES" ]; then
  # Sync skills
  if [ -d "$DOTFILES/.jarvis/skills" ]; then
    log "Syncing skills from claude-dotfiles..."
    rsync -a --delete "$DOTFILES/.jarvis/skills/" "$SKILLS_DIR/"
  fi
  # Sync roles
  if [ -d "$DOTFILES/.jarvis/roles" ]; then
    log "Syncing roles from claude-dotfiles..."
    rsync -a --delete "$DOTFILES/.jarvis/roles/" "$ROLES_DIR/"
  fi
else
  warn "claude-dotfiles not found at $DOTFILES — skills/roles not synced."
  warn "Clone it: git clone https://github.com/giovanibarili/claude-dotfiles $DOTFILES"
fi

# ── 4. Secrets (template only — user must fill) ──────────────────────────────
echo ""
echo "── Secrets ──────────────────────────────"

WHITELIST="$SECRETS_DIR/slack-whitelist.json"
if [ ! -f "$WHITELIST" ]; then
  log "Creating slack-whitelist.json template..."
  cat > "$WHITELIST" << 'EOF'
{
  "YOUR_SLACK_USER_ID": { "tier": "admin", "name": "Your Name" }
}
EOF
  warn "Edit $WHITELIST with your actual Slack user ID."
fi

SLACK_APP="$SECRETS_DIR/slack-app.json"
if [ ! -f "$SLACK_APP" ]; then
  log "Creating slack-app.json template..."
  cat > "$SLACK_APP" << 'EOF'
{
  "botToken": "xoxb-YOUR-BOT-TOKEN",
  "userToken": "xoxp-YOUR-USER-TOKEN",
  "appToken": "xapp-YOUR-APP-TOKEN"
}
EOF
  warn "Edit $SLACK_APP with your Slack app tokens."
fi

# ── 5. MCP config template ───────────────────────────────────────────────────
echo ""
echo "── MCP ──────────────────────────────────"

MCP_FILE="$JARVIS_DIR/mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  log "Creating mcp.json template..."
  cp "$(dirname "$0")/../app/.jarvis/mcp.json" "$MCP_FILE" 2>/dev/null || \
    cat > "$MCP_FILE" << 'EOF'
{
  "servers": {}
}
EOF
  warn "Configure $MCP_FILE with your MCP server endpoints and tokens."
fi

# ── 6. settings.user.json (providers/API keys) ───────────────────────────────
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

# ── 7. knowledge-domains.json ────────────────────────────────────────────────
KDOMAINS="$JARVIS_DIR/knowledge-domains.json"
if [ ! -f "$KDOMAINS" ]; then
  log "Creating knowledge-domains.json template..."
  cat > "$KDOMAINS" << 'EOF'
{
  "default": "personal",
  "domains": {
    "personal": {
      "path": "~/dev/personal/claude-dotfiles",
      "git_url": "https://github.com/giovanibarili/claude-dotfiles.git",
      "git_path": "knowledge"
    }
  }
}
EOF
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  Bootstrap complete!                 ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Required manual steps:"
echo "  1. Edit ~/.jarvis/settings.user.json  — add your API keys"
echo "  2. Edit ~/.jarvis/secrets/slack-app.json  — add Slack tokens"
echo "  3. Edit ~/.jarvis/secrets/slack-whitelist.json — add your Slack user ID"
echo "  4. Edit ~/.jarvis/mcp.json — configure MCP servers"
echo "  5. Run OAuth flows for Atlassian/Glean/Miro/Slack via JARVIS MCP manager"
echo ""
echo "Then start JARVIS: npm start (from jarvis-app/)"
echo ""
