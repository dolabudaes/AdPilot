#!/usr/bin/env bash
# Prefer: ADPILOT_VENV > activated VIRTUAL_ENV > repo .venv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${ADPILOT_VENV:-${VIRTUAL_ENV:-$ROOT/.venv}}"
BIN="$VENV/bin"
if [[ ! -x "$BIN/python" ]]; then
  echo "Python venv not found at: $VENV" >&2
  echo "Create one, then either activate it or set ADPILOT_VENV=/path/to/venv" >&2
  echo "  python3 -m venv \"$VENV\" && \"$BIN/pip\" install -r \"$ROOT/apps/api/requirements.txt\"" >&2
  exit 1
fi
export PATH="$BIN:$PATH"
exec "$@"
