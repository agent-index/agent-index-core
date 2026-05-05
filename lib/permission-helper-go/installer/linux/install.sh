#!/usr/bin/env bash
# install.sh — Linux installer for agent-index-show-plan.
#
# Lays the binary at ~/.local/bin/, runs --register to write the
# .desktop file under ~/.local/share/applications/ and bind the
# agent-index:// scheme via xdg-mime.
#
# Usage:
#   bash install.sh [path/to/agent-index-show-plan]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
BINARY="${1:-$SCRIPT_DIR/agent-index-show-plan}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
DEST_PATH="$INSTALL_DIR/agent-index-show-plan"

step() { printf "→ %s\n" "$1"; }
ok()   { printf "✓ %s\n" "$1"; }
err()  { printf "✗ %s\n" "$1" >&2; }

# 1. Verify source binary
step "Locating binary..."
if [[ ! -x "$BINARY" ]]; then
    err "Binary not found or not executable: $BINARY"
    echo "Pass the path as the first argument: bash install.sh /path/to/agent-index-show-plan"
    exit 1
fi
ok "Found $BINARY"

# 2. Sanity check: xdg-utils available
step "Checking for xdg-utils..."
if ! command -v xdg-mime >/dev/null 2>&1; then
    err "xdg-mime not found on PATH; install xdg-utils first"
    echo "On Debian/Ubuntu:  sudo apt install xdg-utils"
    echo "On Fedora:         sudo dnf install xdg-utils"
    echo "On Arch:           sudo pacman -S xdg-utils"
    exit 1
fi
ok "xdg-utils present"

# 3. Install binary
step "Installing binary to $DEST_PATH..."
mkdir -p "$INSTALL_DIR"
cp -f "$BINARY" "$DEST_PATH"
chmod +x "$DEST_PATH"
ok "Binary installed"

# 4. Register URL scheme
step "Registering agent-index:// URL scheme handler..."
"$DEST_PATH" --register
ok "Scheme registered"

# 5. Verify
step "Verifying registration..."
HANDLER=$(xdg-mime query default x-scheme-handler/agent-index 2>/dev/null || true)
if [[ "$HANDLER" == "agent-index-show-plan.desktop" ]]; then
    ok "agent-index:// is bound to agent-index-show-plan.desktop"
else
    err "Verification failed; default handler reported as: '$HANDLER'"
    echo "You may need to log out and back in for the binding to take effect on some desktop environments."
    exit 1
fi

# 6. PATH check (informational — not fatal)
if ! command -v agent-index-show-plan >/dev/null 2>&1; then
    echo ""
    echo "Note: $INSTALL_DIR is not on your PATH. The URL handler still works,"
    echo "but if you want to invoke 'agent-index-show-plan' directly, add this to your shell rc:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "Installation complete."
echo "Test it: xdg-open 'agent-index://apply?spec=outputs/some-spec.json'"
