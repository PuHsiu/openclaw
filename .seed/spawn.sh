#!/usr/bin/env bash
# Spawn a fresh subaru agent container.
# Usage: bash spawn.sh [suite-dir] [container-name]
#
# Defaults:
#   suite-dir      = ~/Realms/first.abode/subaru.suite
#   container-name = subaru.agent
#
# API keys are read from macOS Keychain (never stored in this file).
# Keychain service names used:
#   Anthropic  — LLM_API_KEY_ANTHROPIC_SUBARU  (used only for non-claude-code fallback models)
#   Cerebras   — LLM_API_KEY_CEREBRAS_SUBARU
#   OpenRouter — LLM_API_KEY_OPENROUTER_SUBARU
#
# claude-code OAuth credentials:
#   Stored persistently on the host at: <suite-dir>/claude-credentials/
#     .credentials.json   — OAuth token (written by `claude auth login`)
#     .claude.json        — CLI state (backed up by claude automatically)
#   Both files survive container rebuilds because the directory is mounted as
#   a volume at /home/node/.claude inside the container.
#   The Dockerfile installs the claude CLI by default (OPENCLAW_INSTALL_CLAUDE_CLI=1).
#   Note: the claude-code provider clears ANTHROPIC_API_KEY before spawning the
#   subprocess, so the claude CLI always uses its own OAuth token, never the API key.
#
#   First-time auth (if .credentials.json is missing):
#     docker exec -it <container> claude auth login

set -euo pipefail

SEED_DIR="$(cd "$(dirname "$0")" && pwd)"
SUITE_DIR="${1:-$HOME/Realms/first.abode/subaru.suite}"
CONTAINER="${2:-subaru.agent}"

# ---------------------------------------------------------------------------
# Keychain helpers
# ---------------------------------------------------------------------------

keychain_get() {
  local service="$1"
  security find-generic-password -s "$service" -w 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Read API keys from keychain
# ---------------------------------------------------------------------------

echo "==> Reading API keys from keychain"
ANTHROPIC_KEY="$(keychain_get "LLM_API_KEY_ANTHROPIC_SUBARU")"
CEREBRAS_KEY="$(keychain_get "LLM_API_KEY_CEREBRAS_SUBARU")"
OPENROUTER_KEY="$(keychain_get "LLM_API_KEY_OPENROUTER_SUBARU")"

if [ -z "$ANTHROPIC_KEY" ] && [ -z "$CEREBRAS_KEY" ] && [ -z "$OPENROUTER_KEY" ]; then
  echo "ERROR: No API keys found in keychain. Add them with:"
  echo "  security add-generic-password -s LLM_API_KEY_ANTHROPIC_SUBARU  -a openclaw -w <key>"
  echo "  security add-generic-password -s LLM_API_KEY_CEREBRAS_SUBARU   -a openclaw -w <key>"
  echo "  security add-generic-password -s LLM_API_KEY_OPENROUTER_SUBARU -a openclaw -w <key>"
  exit 1
fi

[ -n "$ANTHROPIC_KEY" ]  && echo "  anthropic:  found" || echo "  anthropic:  not in keychain, skipping"
[ -n "$CEREBRAS_KEY" ]   && echo "  cerebras:   found" || echo "  cerebras:   not in keychain, skipping"
[ -n "$OPENROUTER_KEY" ] && echo "  openrouter: found" || echo "  openrouter: not in keychain, skipping"

# ---------------------------------------------------------------------------
# Build auth-profiles.json from keychain values
# ---------------------------------------------------------------------------

build_auth_profiles() {
  python3 - <<PYEOF
import json

profiles = {}

anthropic  = """$ANTHROPIC_KEY"""
cerebras   = """$CEREBRAS_KEY"""
openrouter = """$OPENROUTER_KEY"""

if anthropic.strip():
    profiles["anthropic:default"]  = {"type": "api_key", "provider": "anthropic",  "key": anthropic.strip()}
if cerebras.strip():
    profiles["cerebras:default"]   = {"type": "api_key", "provider": "cerebras",   "key": cerebras.strip()}
if openrouter.strip():
    profiles["openrouter:default"] = {"type": "api_key", "provider": "openrouter", "key": openrouter.strip()}

# claude-code uses the host `claude` CLI for auth — no API key needed.
# The "custom-local" marker satisfies the pi-coding-agent registry credential
# check so claude-code/sonnet is visible as an available model.
profiles["claude-code:default"] = {"type": "api_key", "provider": "claude-code", "key": "custom-local"}

print(json.dumps({"version": 1, "profiles": profiles}, indent=2))
PYEOF
}

# ---------------------------------------------------------------------------
# Seed config into suite dir
# ---------------------------------------------------------------------------

echo "==> Seeding config into: $SUITE_DIR"
mkdir -p "$SUITE_DIR/agents/main/agent"
mkdir -p "$SUITE_DIR/workspace/config"
cp "$SEED_DIR/openclaw.json" "$SUITE_DIR/openclaw.json"
build_auth_profiles > "$SUITE_DIR/agents/main/agent/auth-profiles.json"
cp "$SEED_DIR/workspace/config/mcporter.json" "$SUITE_DIR/workspace/config/mcporter.json"

# ---------------------------------------------------------------------------
# Build / update the openclaw image
# ---------------------------------------------------------------------------

REPO_ROOT="$(dirname "$SEED_DIR")"
echo "==> Building openclaw image (with claude-code CLI)…"
docker build \
  --build-arg OPENCLAW_INSTALL_CLAUDE_CLI=1 \
  -t openclaw \
  "$REPO_ROOT"

echo "==> Stopping & removing old container (if any)"
docker rm -f "$CONTAINER" 2>/dev/null || true

echo "==> Starting fresh container: $CONTAINER"

# ---------------------------------------------------------------------------
# Claude OAuth credentials volume
# ---------------------------------------------------------------------------
# ~/.claude/ is mounted from this host directory so OAuth tokens survive rebuilds.
# On first auth: docker exec -it <container> claude auth login
# The claude CLI writes .credentials.json and .claude.json into this directory.
#
# .claude.json lives at ~/.claude.json (HOME root), one level above the mount.
# We store it inside the volume as ~/.claude/.claude.json and symlink it into
# place at container startup via the shell wrapper below.
CLAUDE_CRED_DIR="$SUITE_DIR/claude-credentials"
mkdir -p "$CLAUDE_CRED_DIR"
echo "  claude-credentials dir: $CLAUDE_CRED_DIR"

# Forward the Anthropic API key for non-claude-code fallback models (anthropic/*).
# The claude-code provider clears this before spawning the claude subprocess,
# so it does not affect OAuth-based claude-code inference.
ANTHROPIC_KEY_ENV=()
if [ -n "$ANTHROPIC_KEY" ]; then
  ANTHROPIC_KEY_ENV=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_KEY")
  echo "  ANTHROPIC_API_KEY: forwarded (for anthropic/* fallback models)"
fi

# Startup wrapper: symlink ~/.claude.json → ~/.claude/.claude.json so the
# claude CLI finds its state file even though HOME root is not a volume.
# The ln is idempotent; errors are suppressed so a stale link does not abort.
GATEWAY_CMD='ln -sf /home/node/.claude/.claude.json /home/node/.claude.json 2>/dev/null || true; exec node openclaw.mjs gateway --allow-unconfigured --bind lan'

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p 18789:18789 \
  -p 50001:18789 \
  -e TZ=Asia/Taipei \
  -v "$SUITE_DIR:/home/node/.openclaw" \
  -v "$HOME/Realms/first.abode:/realms/first.abode" \
  -v "$HOME/Realms/forge:/realms/forge" \
  -v "$CLAUDE_CRED_DIR:/home/node/.claude" \
  "${ANTHROPIC_KEY_ENV[@]}" \
  openclaw \
  sh -c "$GATEWAY_CMD"

echo "==> Done. Gateway starting on port 18789 / 50001"
echo "    Container: $CONTAINER"
echo "    Suite dir: $SUITE_DIR"
echo "    Remember to approve Telegram pairing in the bot after first DM."
echo ""
echo "    claude-code OAuth:"
if [ ! -f "$CLAUDE_CRED_DIR/.credentials.json" ]; then
  echo "    ⚠  Not yet authenticated. Run once:"
  echo "       docker exec -it $CONTAINER claude auth login"
  echo "    Token will be saved to: $CLAUDE_CRED_DIR/.credentials.json"
else
  echo "    ✓ OAuth token: $CLAUDE_CRED_DIR/.credentials.json"
  echo "    ✓ CLI state:   $CLAUDE_CRED_DIR/.claude.json"
fi
