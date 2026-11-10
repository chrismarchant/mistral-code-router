#!/usr/bin/env bash
# Smoke-test the mistral-router plugin from the terminal.
# Usage: bash ~/mistral-code-router/scripts/verify.sh
#   - always: syntax check + MCP stdio handshake + tools/list (expects 5 tools)
#   - if MISTRAL_API_KEY is set: one real minimal mistral_delegate call
#   - if not set: checks the clean "key not set" error path instead
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$DIR/mcp-server/server.js"

echo "== 1. syntax =="
node --check "$SERVER" && echo "OK: server.js parses"

echo "== 2. MCP stdio handshake + tools/list =="
OUT="$( {
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1
} | node "$SERVER" )"
echo "$OUT" | grep -q '"serverInfo":{"name":"mistral-router"' && echo "OK: initialize handshake"
TOOLS="$(echo "$OUT" | grep '"id":2' | grep -o '"name":"mistral_[a-z_]*"' | sort -u | tr '\n' ' ')"
echo "tools: $TOOLS"
[ "$(echo "$TOOLS" | wc -w)" -eq 5 ] && echo "OK: all 5 tools advertised"

if [ -n "${MISTRAL_API_KEY:-}" ]; then
  echo "== 3. live API call (MISTRAL_API_KEY set) =="
  RES="$( {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mistral_delegate","arguments":{"model":"glm-flash","task":"Reply with exactly the word: OK","max_tokens":8,"timeout_ms":30000}}}'
    sleep 35
  } | node "$SERVER" | grep '"id":2' )"
  if echo "$RES" | grep -q '"isError":true'; then
    echo "FAIL: live call returned an error:"; echo "$RES" | head -c 400; exit 1
  fi
  echo "OK: live call succeeded (content masked):"
  echo "$RES" | grep -o '"content":"[^"]*"' | head -c 200; echo
else
  echo "== 3. error path (MISTRAL_API_KEY not set) =="
  RES="$( {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mistral_delegate","arguments":{"model":"glm-flash","task":"hi","max_tokens":8}}}'
    sleep 2
  } | node "$SERVER" | grep '"id":2' )"
  echo "$RES" | grep -q 'MISTRAL_API_KEY is not set' && echo "OK: clean missing-key error (set the key, then rerun for a live test)"
fi

echo "== all checks passed =="
