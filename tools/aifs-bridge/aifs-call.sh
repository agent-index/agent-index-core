#!/usr/bin/env bash
# aifs-call — CLI wrapper for calling aifs tools through the bridge daemon.
#
# Usage:
#   aifs-call.sh <tool_name> [json_args]
#   aifs-call.sh aifs_read '{"path":"/projects"}'
#   aifs-call.sh aifs_list '{"path":"/","recursive":false}'
#   aifs-call.sh aifs_auth_status
#   aifs-call.sh --health
#   aifs-call.sh --tools
#   aifs-call.sh --start [--port PORT] [--config PATH]
#   aifs-call.sh --stop
#
# The bridge daemon must be running. Use --start to launch it.

set -euo pipefail

BRIDGE_PORT="${AIFS_BRIDGE_PORT:-7819}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Discover config (same logic as start-server.sh) ---
find_config() {
  if [ -n "${AIFS_CONFIG_PATH:-}" ]; then
    echo "$AIFS_CONFIG_PATH"
    return
  fi
  for dir in "$HOME"/mnt/*/; do
    if [ -f "$dir/agent-index.json" ]; then
      echo "$dir/agent-index.json"
      return
    fi
  done
  echo ""
}

# --- Check if bridge is running ---
bridge_running() {
  curl -s --max-time 2 "${BRIDGE_URL}/health" > /dev/null 2>&1
}

# --- Commands ---

case "${1:-}" in
  --start)
    shift
    if bridge_running; then
      echo "Bridge already running on port ${BRIDGE_PORT}"
      curl -s "${BRIDGE_URL}/health" | python3 -m json.tool 2>/dev/null || true
      exit 0
    fi

    CONFIG_PATH="$(find_config)"
    if [ -z "$CONFIG_PATH" ]; then
      echo "Error: Cannot find agent-index.json" >&2
      exit 1
    fi

    echo "Starting aifs-bridge on port ${BRIDGE_PORT}..."
    nohup node "${SCRIPT_DIR}/aifs-bridge.mjs" --port "$BRIDGE_PORT" --config "$CONFIG_PATH" "$@" \
      > /tmp/aifs-bridge.log 2>&1 &
    BRIDGE_PID=$!
    echo "Bridge PID: ${BRIDGE_PID}"

    # Wait for ready signal
    for i in $(seq 1 30); do
      if bridge_running; then
        echo "Bridge ready."
        curl -s "${BRIDGE_URL}/health" | python3 -m json.tool 2>/dev/null || true
        exit 0
      fi
      sleep 0.5
    done

    echo "Error: Bridge did not start within 15 seconds" >&2
    echo "Check /tmp/aifs-bridge.log for details" >&2
    exit 1
    ;;

  --stop)
    if bridge_running; then
      curl -s -X POST "${BRIDGE_URL}/shutdown" | python3 -m json.tool 2>/dev/null || true
      echo "Bridge stopped."
    else
      echo "Bridge not running."
    fi
    exit 0
    ;;

  --health)
    if bridge_running; then
      curl -s "${BRIDGE_URL}/health" | python3 -m json.tool 2>/dev/null || true
    else
      echo '{"bridge":"not_running"}'
      exit 1
    fi
    exit 0
    ;;

  --tools)
    if ! bridge_running; then
      echo "Error: Bridge not running. Use --start first." >&2
      exit 1
    fi
    curl -s "${BRIDGE_URL}/tools" | python3 -m json.tool 2>/dev/null || true
    exit 0
    ;;

  --restart)
    if ! bridge_running; then
      echo "Error: Bridge not running. Use --start first." >&2
      exit 1
    fi
    curl -s -X POST "${BRIDGE_URL}/restart" | python3 -m json.tool 2>/dev/null || true
    exit 0
    ;;

  -h|--help|"")
    echo "Usage:"
    echo "  aifs-call.sh --start [flags]   Start the bridge daemon (flags: --port, --config, --bundle, --env)"
    echo "  aifs-call.sh --stop           Stop the bridge daemon"
    echo "  aifs-call.sh --health         Check bridge status"
    echo "  aifs-call.sh --tools          List available tools"
    echo "  aifs-call.sh --restart        Restart the MCP server"
    echo "  aifs-call.sh <tool> [args]    Call an aifs tool"
    echo ""
    echo "Examples:"
    echo "  aifs-call.sh aifs_auth_status"
    echo "  aifs-call.sh aifs_read '{\"path\":\"/projects\"}'"
    echo "  aifs-call.sh aifs_list '{\"path\":\"/\",\"recursive\":false}'"
    exit 0
    ;;

  *)
    # Tool call
    TOOL="$1"
    ARGS="${2:-{}}"

    if ! bridge_running; then
      echo "Bridge not running. Starting..." >&2
      "$0" --start >&2
    fi

    RESULT=$(curl -s -X POST "${BRIDGE_URL}/call" \
      -H "Content-Type: application/json" \
      -d "{\"tool\":\"${TOOL}\",\"args\":${ARGS}}")

    echo "$RESULT"
    ;;
esac
