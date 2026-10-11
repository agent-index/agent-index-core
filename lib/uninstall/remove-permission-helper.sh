#!/usr/bin/env bash
# remove-permission-helper.sh -- removes the retired permission-change-helper from a macOS or Linux machine
# (agent-index-core 4.0.0, lib/uninstall; Level 3). Run natively by apply-updates (and create-org/member-bootstrap
# on an old install). Idempotent: every step treats "not found" as ok.
# Usage: bash remove-permission-helper.sh <agent-index install folder>
# Output: one JSON line {"handler_removed":bool,"binary_removed":bool,"stray_ext_removed":bool,"errors":[...]}
# Exit: 0 = every step ok or nothing to remove; 1 = partial failure (never blocks an update).
set -u
ROOT="${1:-}"
[ -n "$ROOT" ] || { echo '{"handler_removed":false,"binary_removed":false,"stray_ext_removed":false,"errors":["usage: remove-permission-helper.sh <install folder>"]}'; exit 1; }
handler=false; binary=false; stray=false; errs=()

if [ "$(uname -s)" = "Darwin" ]; then
  APP="$HOME/Applications/Agent-Index Helper.app"
  LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -d "$APP" ]; then
    [ -x "$LSREG" ] && "$LSREG" -u "$APP" >/dev/null 2>&1
    if rm -rf "$APP"; then handler=true; binary=true; else errs+=("app bundle: could not remove $APP"); fi
  fi
else
  DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications/agent-index-show-plan.desktop"
  if [ -f "$DESKTOP" ]; then
    if rm -f "$DESKTOP"; then handler=true; command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1
    else errs+=("desktop entry: could not remove $DESKTOP"); fi
  fi
  LEGACY="${INSTALL_DIR:-$HOME/.local/bin}/agent-index-show-plan"
  if [ -e "$LEGACY" ]; then if rm -f "$LEGACY"; then binary=true; else errs+=("legacy binary: could not remove $LEGACY"); fi; fi
fi

DIR="$ROOT/mcp-servers/permission-helper-go"
if [ -d "$DIR" ]; then
  ls -d "$DIR"/*'{ext}'* >/dev/null 2>&1 && stray=true
  if rm -rf "$DIR"; then binary=true; else errs+=("install dir: could not remove $DIR"); fi
fi

json_errs=$(printf '%s\n' "${errs[@]+"${errs[@]}"}" | python3 -c 'import json,sys;print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))' 2>/dev/null || echo '[]')
echo "{\"handler_removed\":$handler,\"binary_removed\":$binary,\"stray_ext_removed\":$stray,\"errors\":$json_errs}"
[ ${#errs[@]} -eq 0 ] && exit 0 || exit 1
# AIFS:FILE-END
