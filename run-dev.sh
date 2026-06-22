#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────────────
# Dev server launcher for the EVE Industrial Tool.
#
# WHY THIS EXISTS:
#   The production server runs uvicorn WITHOUT --reload, so edits to Python,
#   Jinja2 templates, JS and CSS were NOT picked up — old code kept running and
#   wasted whole debugging sessions (the infamous "cache trap").
#
#   This script runs uvicorn WITH --reload and explicitly watches the template,
#   JS and CSS files too, so saving any of them restarts the server and serves
#   fresh content immediately.
#
# USAGE:
#   ./run-dev.sh                 # http://0.0.0.0:8082
#   PORT=9000 ./run-dev.sh       # custom port
#
# NOTE: The app is normally served by the Docker container on HOST port 8082
# (docker-compose maps "8082:8080"). This dev server uses the SAME external
# port 8082, so Playwright/curl (BASE_URL=http://localhost:8082) reach it too.
# If 8082 is already taken (e.g. the Docker container is up), free it first:
#   docker compose down            # or:  sudo pkill -f 'uvicorn app.main:app'
# ───────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo root = directory containing this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8082}"   # host port (Docker maps 8082 -> container 8080); matches Playwright BASE_URL

echo "Starting uvicorn (dev, --reload) on ${HOST}:${PORT} from $(pwd)"
echo "Watching: app/ (Python) + templates/static (*.html, *.js, *.css)"

exec uvicorn app.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --reload \
  --reload-dir app \
  --reload-include "*.html" \
  --reload-include "*.js" \
  --reload-include "*.css"
