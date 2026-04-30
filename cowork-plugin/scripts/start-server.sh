#!/usr/bin/env bash
# agent-index-filesystem Cowork plugin — validation script
#
# Validates that the exec bundle is present in the Cowork mount.
# This script does NOT start a server — the on-demand executor
# (aifs-exec.sh) is called directly by Claude via bash.
#
# In Cowork, the user's selected folder is mounted under $HOME/mnt/{name}/.
# The session name varies, but $HOME always resolves to the session root.
# This script scans for agent-index.json to find the workspace.

set -euo pipefail

# --- Discover the agent-index workspace ---
PROJECT_DIR=""
for dir in "$HOME"/mnt/*/; do
  if [ -f "$dir/agent-index.json" ]; then
    PROJECT_DIR="$dir"
    break
  fi
done

if [ -z "$PROJECT_DIR" ]; then
  echo "agent-index-filesystem plugin: No agent-index workspace found in Cowork mounts." >&2
  echo "Make sure your Cowork session is pointed at a folder containing agent-index.json." >&2
  exit 1
fi

# --- Read exec bundle path from agent-index.json ---
BUNDLE_REL=$(python3 -c "
import json
with open('${PROJECT_DIR}/agent-index.json') as f:
    config = json.load(f)
print(config.get('remote_filesystem', {})
    .get('exec', {})
    .get('bundle_path', 'mcp-servers/filesystem/aifs-exec.bundle.js'))
")

BUNDLE_PATH="${PROJECT_DIR}/${BUNDLE_REL}"

if [ ! -f "$BUNDLE_PATH" ]; then
  echo "agent-index-filesystem plugin: Exec bundle not found at $BUNDLE_PATH" >&2
  echo "The bootstrap zip may be incomplete. Ask your org admin for an updated bootstrap zip." >&2
  exit 1
fi

echo "agent-index-filesystem plugin: Exec bundle verified at $BUNDLE_PATH" >&2
echo "Remote filesystem operations use on-demand execution via aifs-exec.sh." >&2

# No server to start — the exec wrapper is called directly by Claude.
# Exit cleanly so the plugin reports success.
exit 0
