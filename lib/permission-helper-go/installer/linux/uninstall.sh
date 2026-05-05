#!/usr/bin/env bash
# uninstall.sh — Removes the Linux install of agent-index-show-plan.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
DEST_PATH="$INSTALL_DIR/agent-index-show-plan"

if [[ -x "$DEST_PATH" ]]; then
    "$DEST_PATH" --unregister || true
    rm -f "$DEST_PATH"
    echo "✓ Removed $DEST_PATH"
else
    echo "Nothing to uninstall at $DEST_PATH"
fi

# Final cleanup: remove .desktop file if it lingers.
DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/agent-index-show-plan.desktop"
if [[ -f "$DESKTOP" ]]; then
    rm -f "$DESKTOP"
    update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
    echo "✓ Removed $DESKTOP"
fi
