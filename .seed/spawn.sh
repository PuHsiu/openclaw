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
#   Anthropic  — add manually: security add-generic-password -s LLM_API_KEY_ANTHROPIC_SUBARU  -a openclaw -w <key>
#   Cerebras   — LLM_API_KEY_CEREBRAS_SUBARU   (already in keychain)
#   OpenRouter — LLM_API_KEY_OPENROUTER_SUBARU  (already in keychain)
#
# claude-code provider (optional):
#   The container image must have been built with --build-arg OPENCLAW_INSTALL_CLAUDE_CLI=1.
#   The Anthropic API key is forwarded as ANTHROPIC_API_KEY so the claude subprocess
#   can authenticate.  ~/.claude is also mounted read-only so any local OAuth session
#   (e.g. a Claude Max login) is available inside the container.

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

echo "==> Stopping & removing old container (if any)"
docker rm -f "$CONTAINER" 2>/dev/null || true

echo "==> Starting fresh container: $CONTAINER"

# Mount a persistent, writable credentials directory for the claude CLI.
# On first run: docker exec -it subaru.agent claude auth login
# Credentials are saved here and survive container restarts.
CLAUDE_CRED_DIR="$SUITE_DIR/claude-credentials"
mkdir -p "$CLAUDE_CRED_DIR"
CLAUDE_CRED_MOUNT=(-v "$CLAUDE_CRED_DIR:/home/node/.claude")
echo "  claude-credentials dir: $CLAUDE_CRED_DIR"

# Forward the Anthropic API key so the claude subprocess can authenticate even
# without an OAuth session (falls back to direct-API billing via the key).
ANTHROPIC_KEY_ENV=()
if [ -n "$ANTHROPIC_KEY" ]; then
  ANTHROPIC_KEY_ENV=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_KEY")
  echo "  ANTHROPIC_API_KEY: forwarded to container"
fi

# Optionally pass a pre-obtained Claude Code OAuth token via env.
# Usage: CLAUDE_CODE_OAUTH_TOKEN=<token> bash spawn.sh
CLAUDE_OAUTH_ENV=()
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  CLAUDE_OAUTH_ENV=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
  echo "  CLAUDE_CODE_OAUTH_TOKEN: forwarded to container"
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p 18789:18789 \
  -p 50001:18789 \
  -v "$SUITE_DIR:/home/node/.openclaw" \
  -v "$HOME/Realms/first.abode:/realms/first.abode" \
  -v "$HOME/Realms/forge:/realms/forge" \
  "${CLAUDE_CRED_MOUNT[@]}" \
  "${ANTHROPIC_KEY_ENV[@]}" \
  "${CLAUDE_OAUTH_ENV[@]+"${CLAUDE_OAUTH_ENV[@]}"}" \
  openclaw \
  node openclaw.mjs gateway --allow-unconfigured --bind lan

echo "==> Done. Gateway starting on port 18789 / 50001"
echo "    Container: $CONTAINER"
echo "    Suite dir: $SUITE_DIR"
echo "    Remember to approve Telegram pairing in the bot after first DM."
echo ""
echo "    claude-code provider:"
if [ ! -f "$CLAUDE_CRED_DIR/.credentials.json" ]; then
  echo "    ⚠  Not yet authenticated. Run once to enable claude-code inference:"
  echo "       docker exec -it $CONTAINER claude auth login"
else
  echo "    ✓ Credentials found at $CLAUDE_CRED_DIR/.credentials.json"
fi
