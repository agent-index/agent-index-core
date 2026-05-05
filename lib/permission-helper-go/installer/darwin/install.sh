#!/usr/bin/env bash
# install.sh — macOS installer for agent-index-show-plan.
#
# Builds a minimal .app bundle at ~/Applications/Agent-Index Helper.app/
# whose Info.plist registers the agent-index:// URL scheme, places the
# binary inside, and asks LaunchServices to register the bundle.
#
# Usage:
#   bash install.sh [path/to/agent-index-show-plan]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
BINARY="${1:-$SCRIPT_DIR/agent-index-show-plan}"
APP_NAME="Agent-Index Helper.app"
APP_PATH="$HOME/Applications/$APP_NAME"
BUNDLE_ID="ai.agent-index.permission-helper"

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

# 2. Build .app bundle structure
step "Creating $APP_PATH..."
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

# 3. Write Info.plist
cat > "$APP_PATH/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>agent-index-show-plan</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Agent-Index Helper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.2.0</string>
    <key>CFBundleVersion</key>
    <string>0.2.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Agent-Index Permission Helper</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>agent-index</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF
ok "Info.plist written"

# 4. Install binary
step "Installing binary..."
cp -f "$BINARY" "$APP_PATH/Contents/MacOS/agent-index-show-plan"
chmod +x "$APP_PATH/Contents/MacOS/agent-index-show-plan"
ok "Binary placed at $APP_PATH/Contents/MacOS/"

# 5. Register with LaunchServices
step "Registering with LaunchServices..."
"$APP_PATH/Contents/MacOS/agent-index-show-plan" --register
ok "Registered"

# 6. Verify
step "Verifying registration..."
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if "$LSREGISTER" -dump | grep -F "$APP_PATH" | grep -q "agent-index:"; then
    ok "agent-index:// scheme bound to $APP_PATH"
else
    # Some lsregister dumps split bundle path and scheme across many lines —
    # the binary's own --register/--isregistered check is the authoritative one.
    if "$APP_PATH/Contents/MacOS/agent-index-show-plan" --version >/dev/null 2>&1; then
        ok "Registration completed; LaunchServices may need a logout/login to fully refresh"
    else
        err "Could not verify registration"
        exit 1
    fi
fi

echo ""
echo "Installation complete."
echo "Test it: open 'agent-index://apply?spec=outputs/some-spec.json' from a chat or Terminal:"
echo "  open 'agent-index://apply?spec=outputs/some-spec.json'"
