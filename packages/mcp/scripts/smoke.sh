#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# stable-mcp automated smoke test (no funds required).
#
# What it does, end to end, with zero manual steps:
#   1. installs deps + builds if needed
#   2. checks the boot guard (refuses non-testnet)
#   3. boots the server on a test port with a throwaway key
#   4. runs the 8 transport/auth/session/guard checks
#   5. prints a PASS/FAIL line per check and a final summary
#   6. shuts the server down
#
# Run:  bash scripts/smoke.sh
# Exit: 0 if every check passed, 1 otherwise.
# ─────────────────────────────────────────────────────────────────────────────
set -u

# Resolve repo paths relative to this script so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

PORT="${PORT:-3111}"
TOK="smoke-token-123"
PV="2025-11-25"
URL="http://localhost:${PORT}/mcp"
HOSTHDR="localhost:${PORT}"
# Throwaway anvil test key — never funded, only used so the server can boot.
TEST_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
ACCEPT="Accept: application/json, text/event-stream"
CTYPE="Content-Type: application/json"
LOG="$(mktemp -t stablemcp.XXXXXX)"
SERVER_PID=""

# Colors (only if attached to a terminal).
if [ -t 1 ]; then GRN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'
else GRN=""; RED=""; DIM=""; BLD=""; RST=""; fi

PASS=0; FAIL=0
check() { # check "label" "expected" "actual"
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf "  ${GRN}PASS${RST}  %-34s expected=%s got=%s\n" "$label" "$expected" "$actual"
    PASS=$((PASS+1))
  else
    printf "  ${RED}FAIL${RST}  %-34s expected=%s ${RED}got=%s${RST}\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL+1))
  fi
}
check_contains() { # check_contains "label" "needle" "haystack"
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q "$needle"; then
    printf "  ${GRN}PASS${RST}  %-34s found: %s\n" "$label" "$needle"
    PASS=$((PASS+1))
  else
    printf "  ${RED}FAIL${RST}  %-34s ${RED}missing: %s${RST}\n" "$label" "$needle"
    FAIL=$((FAIL+1))
  fi
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT

echo "${BLD}stable-mcp smoke test${RST}  (port ${PORT})"
echo

# ── 0. deps + build ──────────────────────────────────────────────────────────
echo "${BLD}Setup${RST}"
if [ ! -d node_modules/@modelcontextprotocol ] || [ ! -d node_modules/@stablechain ]; then
  echo "  installing deps from package.json (this runs once)…"
  npm install >/dev/null 2>&1 \
    && echo "  ${GRN}deps installed${RST}" || { echo "  ${RED}npm install failed${RST}"; exit 1; }
else
  echo "  ${DIM}deps present${RST}"
fi
echo "  building (tsc)…"
if npm run build >/dev/null 2>&1; then echo "  ${GRN}build clean -> dist/index.js${RST}"
else echo "  ${RED}build failed${RST}; running tsc to show errors:"; ./node_modules/.bin/tsc; exit 1; fi
echo

# ── 1. boot guard: non-testnet must refuse to start ──────────────────────────
echo "${BLD}Boot guard${RST}"
GUARD_OUT="$(STABLE_NETWORK=mainnet STABLE_PRIVATE_KEY="$TEST_KEY" MCP_AUTH_TOKEN=x \
            node dist/index.js 2>&1)"
GUARD_CODE=$?
if [ "$GUARD_CODE" -ne 0 ] && printf '%s' "$GUARD_OUT" | grep -q "testnet-only"; then
  printf "  ${GRN}PASS${RST}  %-34s exited non-zero with 'testnet-only'\n" "mainnet refused"
  PASS=$((PASS+1))
else
  printf "  ${RED}FAIL${RST}  %-34s code=%s out=%s\n" "mainnet refused" "$GUARD_CODE" "$GUARD_OUT"
  FAIL=$((FAIL+1))
fi
echo

# ── boot the real (testnet) server ───────────────────────────────────────────
echo "${BLD}Booting server${RST}  (testnet, throwaway key)"
# Free the port if a stale server is squatting on it.
STALE=$(lsof -ti "tcp:${PORT}" 2>/dev/null)
if [ -n "$STALE" ]; then echo "  ${DIM}freeing port ${PORT} (killing ${STALE})${RST}"; kill $STALE 2>/dev/null; sleep 0.5; fi
STABLE_NETWORK=testnet STABLE_PRIVATE_KEY="$TEST_KEY" MCP_AUTH_TOKEN="$TOK" \
  PORT="$PORT" ALLOWED_HOSTS="$HOSTHDR" HOST=127.0.0.1 \
  node dist/index.js >"$LOG" 2>&1 &
SERVER_PID=$!

# wait up to 5s for "listening"
for _ in $(seq 1 25); do
  grep -q "listening" "$LOG" && break
  sleep 0.2
done
if ! grep -q "listening" "$LOG"; then
  echo "  ${RED}server did not start${RST}; log:"; cat "$LOG"; exit 1
fi
echo "  ${GRN}up${RST}  $(grep listening "$LOG")"
echo

INIT_BODY="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$PV\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"1\"}}}"

# ── transport / auth / guard checks ──────────────────────────────────────────
echo "${BLD}Checks${RST}"

# 1. no token -> 401
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" -H "$ACCEPT" -H "$CTYPE" -d "$INIT_BODY")
check "1. no token -> 401" "401" "$code"

# 1b. bad Host -> 403 (DNS-rebinding guard)
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer $TOK" -H "Host: evil.example" -H "$ACCEPT" -H "$CTYPE" -d "$INIT_BODY")
check "1b. bad Host -> 403" "403" "$code"

# 2. initialize -> capture session id from response header
SID=$(curl -sD - -o /dev/null -X POST "$URL" \
  -H "Authorization: Bearer $TOK" -H "$ACCEPT" -H "$CTYPE" -d "$INIT_BODY" \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')
if [ -n "$SID" ]; then printf "  ${GRN}PASS${RST}  %-34s session=%s\n" "2. initialize -> session id" "$SID"; PASS=$((PASS+1));
else printf "  ${RED}FAIL${RST}  %-34s no MCP-Session-Id header\n" "2. initialize -> session id"; FAIL=$((FAIL+1)); fi

auth=(-H "Authorization: Bearer $TOK" -H "MCP-Session-Id: $SID" -H "MCP-Protocol-Version: $PV" -H "$ACCEPT" -H "$CTYPE")

# 3. notifications/initialized -> 202
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" "${auth[@]}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
check "3. initialized -> 202" "202" "$code"

# 4. tools/list -> the 5 tool names
tools=$(curl -s -X POST "$URL" "${auth[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
n=$(printf '%s' "$tools" | grep -o '"name":"stable_[a-z_]*"' | sort -u | wc -l | tr -d ' ')
check "4. tools/list -> 5 tools" "5" "$n"
check_contains "   - stable_transfer"     '"name":"stable_transfer"'     "$tools"
check_contains "   - stable_quote_bridge" '"name":"stable_quote_bridge"' "$tools"
check_contains "   - stable_bridge"       '"name":"stable_bridge"'       "$tools"
check_contains "   - stable_list_chains"  '"name":"stable_list_chains"'  "$tools"
check_contains "   - stable_balance"      '"name":"stable_balance"'      "$tools"

# 5. list_chains -> chain list with name+chainId
chains=$(curl -s -X POST "$URL" "${auth[@]}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"stable_list_chains","arguments":{}}}')
check_contains "5. list_chains -> chains[]" '"chainId"' "$chains"

# 5b. balance -> own wallet USDT balance on stable chain (read-only, no funds needed)
bal=$(curl -s -X POST "$URL" "${auth[@]}" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"stable_balance","arguments":{}}}')
check_contains "5b. balance -> balance field" '"balance"' "$bal"

# 6. invalid input (bad address) -> zod rejects the call
badin=$(curl -s -X POST "$URL" "${auth[@]}" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"stable_transfer","arguments":{"to":"0xnothex","amount":1}}}')
check_contains "6. bad address rejected" '0x-prefixed' "$badin"

# 7. bad protocol version -> 400
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer $TOK" -H "MCP-Session-Id: $SID" -H "MCP-Protocol-Version: 1999-01-01" -H "$ACCEPT" -H "$CTYPE" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}')
check "7. bad protocol version -> 400" "400" "$code"

# 8. DELETE terminates, reused id -> 404
dcode=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$URL" \
  -H "Authorization: Bearer $TOK" -H "MCP-Session-Id: $SID" -H "MCP-Protocol-Version: $PV" -H "$ACCEPT")
check "8a. DELETE session -> 200" "200" "$dcode"
rcode=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" "${auth[@]}" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}')
check "8b. reuse dead session -> 404" "404" "$rcode"

echo
echo "${BLD}Summary${RST}: ${GRN}${PASS} passed${RST}, $( [ "$FAIL" -gt 0 ] && echo "${RED}${FAIL} failed${RST}" || echo "0 failed" )"
[ "$FAIL" -eq 0 ] && echo "${GRN}ALL GREEN${RST}" || echo "${RED}SOME CHECKS FAILED${RST}"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
