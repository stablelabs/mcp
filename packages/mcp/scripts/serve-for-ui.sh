#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Boot stable-mcp AND launch the MCP Inspector UI, pre-filled to connect.
#
# Use this to click around the 4 tools in a browser instead of curl.
#
# Run (no funds, throwaway key — read-only tools work, writes will error):
#     bash scripts/serve-for-ui.sh
#
# Run with YOUR funded testnet key (transfer/bridge will actually send):
#     STABLE_PRIVATE_KEY=0xYOURKEY bash scripts/serve-for-ui.sh
#
# Ctrl-C once stops both the server and the Inspector.
# ─────────────────────────────────────────────────────────────────────────────
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

PORT="${PORT:-3111}"
TOK="${MCP_AUTH_TOKEN:-ui-token-123}"
URL="http://localhost:${PORT}/mcp"
# Throwaway key unless you pass your own. Read-only tools (list_chains, quote) work
# even unfunded; transfer/bridge need a funded testnet key + RPC.
KEY="${STABLE_PRIVATE_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"

if [ -t 1 ]; then GRN=$'\033[32m'; CYN=$'\033[36m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else GRN=""; CYN=""; BLD=""; DIM=""; RST=""; fi

# deps + build
if [ ! -d node_modules/@modelcontextprotocol ] || [ ! -d node_modules/@stablechain ]; then
  echo "installing deps from package.json (once)…"
  npm install >/dev/null 2>&1
fi
npm run build >/dev/null 2>&1 || { echo "build failed"; ./node_modules/.bin/tsc; exit 1; }

# free the port
STALE=$(lsof -ti "tcp:${PORT}" 2>/dev/null); [ -n "$STALE" ] && { kill $STALE 2>/dev/null; sleep 0.5; }

SERVER_PID=""; INSPECTOR_PID=""
cleanup() { [ -n "$INSPECTOR_PID" ] && kill "$INSPECTOR_PID" 2>/dev/null
            [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

# boot server
STABLE_NETWORK=testnet STABLE_PRIVATE_KEY="$KEY" MCP_AUTH_TOKEN="$TOK" \
  PORT="$PORT" ALLOWED_HOSTS="localhost:${PORT}" HOST=127.0.0.1 \
  node dist/index.js &
SERVER_PID=$!
sleep 1

cat <<EOF

${BLD}════════════════════════════════════════════════════════════════════${RST}
${BLD}  stable-mcp is running. Connect the Inspector with these values:${RST}
${BLD}════════════════════════════════════════════════════════════════════${RST}

  Transport Type : ${CYN}Streamable HTTP${RST}
  URL            : ${CYN}${URL}${RST}
  Auth header    : add a header named ${CYN}Authorization${RST}
                   with value        ${CYN}Bearer ${TOK}${RST}

  ${DIM}(The Inspector opens in your browser in a few seconds. If it asks for a
   proxy token, it's pre-filled in the URL it prints below — just click it.)${RST}

  Funds: $( [ "$KEY" = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" ] \
    && echo "${DIM}throwaway key — list_chains & quote work; transfer/bridge will error.${RST}" \
    || echo "${GRN}your key — transfer/bridge will SEND real testnet transactions.${RST}" )

  Press ${BLD}Ctrl-C${RST} here to stop the server and Inspector.
${BLD}════════════════════════════════════════════════════════════════════${RST}

EOF

# launch inspector (foreground-ish; it prints its own URL with the proxy token)
npx @modelcontextprotocol/inspector &
INSPECTOR_PID=$!
wait "$INSPECTOR_PID"
