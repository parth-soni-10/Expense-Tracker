#!/usr/bin/env bash
# serve.sh — Local dev server for cents.
#
# Browsers refuse to load ES modules over file://, so opening index.html
# directly shows a blank page. This script picks the first available
# static server (python3 → python → npx serve) and listens on a port.
#
# Usage:
#   ./serve.sh            (default port 8080)
#   ./serve.sh 9000       (custom port)
#
# Stop with Ctrl+C.

set -euo pipefail
PORT="${1:-8080}"

if [[ ! -f "index.html" ]] && [[ "${1:-}" != "-h" ]] && [[ "${1:-}" != "--help" ]]; then
  echo "Usage: ./serve.sh [port]"
  echo "  port   optional, default 8080"
  echo ""
  echo "error: run this from the project root (the folder that contains index.html)" >&2
  exit 1
fi

if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
  echo "Usage: ./serve.sh [port]"
  echo "  port   optional, default 8080"
  echo ""
  echo "Picks python3, then python, then py, then npx serve, and listens on the given port."
  echo "Open the printed URL in your browser. Ctrl+C to stop."
  exit 0
fi

# Each candidate is PROBED, not just looked for. On Windows, `python3`/`python`
# often resolve to the Microsoft Store's App Execution Alias: a real file on
# PATH that only prints "Python was not found" and exits — so `command -v`
# succeeds, the script announces a server, and nothing ever listens (a silent
# failure with a success message, the worst kind). Running the interpreter is
# the only check that tells a Python from a stub, and `py` is the launcher that
# actually works on those machines.
if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then
  echo "→ cents. serving on http://localhost:$PORT/   (via python3)"
  echo "  Open that URL in your browser. Press Ctrl+C to stop."
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1 && python -c 'pass' >/dev/null 2>&1; then
  echo "→ cents. serving on http://localhost:$PORT/   (via python)"
  echo "  Open that URL in your browser. Press Ctrl+C to stop."
  exec python -m http.server "$PORT"
elif command -v py >/dev/null 2>&1 && py -c 'pass' >/dev/null 2>&1; then
  echo "→ cents. serving on http://localhost:$PORT/   (via py)"
  echo "  Open that URL in your browser. Press Ctrl+C to stop."
  exec py -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  echo "→ cents. serving on http://localhost:$PORT/   (via npx serve)"
  echo "  Open that URL in your browser. Press Ctrl+C to stop."
  exec npx --yes serve -l "$PORT" .
else
  echo "error: no static server found. Install one of: python3, python, py, or node/npm." >&2
  exit 1
fi
