#!/usr/bin/env sh
# Qingping Wenfang launcher (Linux/macOS)
set -e
cd "$(dirname "$0")"

: "${WORKSHOP_PORT:=4580}"
export WORKSHOP_PORT

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20+ from https://nodejs.org" >&2
  exit 1
fi

printf 'Qingping Wenfang - open http://127.0.0.1:%s\n' "$WORKSHOP_PORT"
printf 'Press Ctrl+C to stop.\n'
exec node workshop/server.mjs
