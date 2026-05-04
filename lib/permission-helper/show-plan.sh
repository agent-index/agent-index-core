#!/usr/bin/env bash
# show-plan.sh — Canonical invocation entry for agent-index-show-plan.
#
# Usage: show-plan.sh <spec-file-path> [--cli]
#
# This wrapper exists so callers (the agent-side skill, consumer admin
# tasks) have a single stable invocation regardless of where node is
# installed or how the helper is laid out at runtime. The wrapper
# resolves node and invokes show-plan.js next to itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE:-node}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "[helper] Node.js not found on PATH (looked for: $NODE_BIN)" >&2
  echo "[helper] Install Node 18+ or set NODE=/path/to/node" >&2
  exit 5
fi

exec "$NODE_BIN" "$SCRIPT_DIR/show-plan.js" "$@"
