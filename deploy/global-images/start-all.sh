#!/usr/bin/env bash
# One-shot bring-up of the memory → memory-hub → proxy trio.
#
# Order: start memory (kernel) first, wait healthy; then memory-hub (panel + knowledge),
# wait healthy; finally proxy. Any step failure aborts and prints container logs.
#
# Usage:
#   ./start-all.sh            # use local images directly if present
#   PULL=1 ./start-all.sh     # docker pull the three images first, upgrade to latest
#
# Prerequisite: cp .env.example .env and fill in both LLM parameter groups (REPLACE_ME → real values).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env

# Validate all required params in one shot, to avoid discovering missing proxy params after memory is up
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
# Enable the full pipeline by default (auth + sessionInit + tdai injection).
# Users can disable it with PROXY_FULL_STACK=0; or override the three switches individually in .env.
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ All services ready ═════════════════════════════════════"
print_endpoints

# Print Claude Code / proxy usage commands
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ Use Claude Code via proxy ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key saved at: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  View logs:  docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  Stop services:  ./stop-all.sh"
echo ""
