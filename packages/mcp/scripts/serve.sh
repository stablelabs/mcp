#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run stable-mcp for real use (e.g. connecting the Claude Desktop app).
# Loads config from .env, builds, frees the port, and runs in the foreground.
#
# Run:  bash scripts/serve.sh      (Ctrl-C to stop)
# ─────────────────────────────────────────────────────────────────────────────
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

if [ ! -f .env ]; then
  echo "No .env found. Copy the template first:  cp .env.example .env  (then fill it in)"; exit 1
fi

# deps + build
if [ ! -d node_modules/@modelcontextprotocol ] || [ ! -d node_modules/@stablechain ]; then
  echo "installing deps from package.json (once)…"; npm install >/dev/null 2>&1
fi
echo "building…"
npm run build >/dev/null 2>&1 || { echo "build failed:"; ./node_modules/.bin/tsc; exit 1; }

# load env (lines use `export`, so sourcing sets them)
. ./.env

# free the port if something is squatting
STALE=$(lsof -ti "tcp:${PORT:-3000}" 2>/dev/null)
[ -n "$STALE" ] && { echo "freeing port ${PORT:-3000} (killing ${STALE})"; kill $STALE 2>/dev/null; sleep 0.5; }

echo "starting stable-mcp on localhost:${PORT:-3000}/mcp  (Ctrl-C to stop)"
exec node dist/index.js
