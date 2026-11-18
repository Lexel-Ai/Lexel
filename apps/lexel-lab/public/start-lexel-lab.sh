#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${LEXEL_LAB_PORT:-4173}"
URL="http://127.0.0.1:${PORT}/"

echo "Starting Lexel Lab at ${URL}"
if command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "${URL}") >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  (sleep 1 && open "${URL}") >/dev/null 2>&1 &
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "${PORT}" --bind 127.0.0.1
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "tcp://127.0.0.1:${PORT}" .
else
  echo "Error: python3 or npx is required to serve Lexel Lab locally." >&2
  exit 1
fi
