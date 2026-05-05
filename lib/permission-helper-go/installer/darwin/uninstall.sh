#!/usr/bin/env bash
# uninstall.sh — Removes the Agent-Index Helper.app bundle and its
# LaunchServices registration.
set -euo pipefail

APP_PATH="$HOME/Applications/Agent-Index Helper.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ -d "$APP_PATH" ]]; then
    "$APP_PATH/Contents/MacOS/agent-index-show-plan" --unregister || true
    "$LSREGISTER" -u "$APP_PATH" || true
    rm -rf "$APP_PATH"
    echo "✓ Removed $APP_PATH"
else
    echo "Nothing to uninstall at $APP_PATH"
fi
