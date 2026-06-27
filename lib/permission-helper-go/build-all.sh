#!/usr/bin/env bash
# build-all.sh — Cross-compile agent-index-show-plan for all 6 release targets.
#
# Produces raw binaries in dist/ named per the agent-index registry's
# filename template:
#   agent-index-show-plan-<version>-<os>-<arch>[.exe]
#
# Plus dist/checksums.txt with sha256 hashes — paste these into
# infrastructure-directory.json -> binaries[].platforms[].sha256.
#
# Usage:
#   bash build-all.sh                 # uses git-tag-derived version
#   bash build-all.sh 0.2.0           # explicit version

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

# Derive version: first positional arg, else latest tag, else 0.0.0-dev.
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
    if VERSION=$(git describe --tags --abbrev=0 2>/dev/null); then
        VERSION="${VERSION#v}"
    else
        VERSION="0.0.0-dev"
    fi
fi

echo "Building agent-index-show-plan v${VERSION}"
mkdir -p dist
# Clean only THIS build's gdrive artifacts for this version. Do NOT use the bare
# agent-index-show-plan-* glob — it also matches agent-index-show-plan-onedrive-*
# and would wipe the onedrive binaries that build-onedrive-b.sh writes to the same
# dist/ (they share it). The onedrive files have "onedrive-" before the version, so
# scoping to -${VERSION}- leaves them untouched.
rm -f "dist/agent-index-show-plan-${VERSION}-"*

PROJECT="agent-index-show-plan"
LDFLAGS="-s -w -X main.Version=${VERSION}"

build_one() {
    local goos="$1"
    local goarch="$2"
    local ext="$3"
    local name="${PROJECT}-${VERSION}-${goos}-${goarch}${ext}"
    local out="dist/${name}"

    echo "  → ${goos}/${goarch}"
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
        go build -trimpath -ldflags "$LDFLAGS" \
        -o "$out" ./cmd/agent-index-show-plan
}

build_one windows amd64 .exe
build_one windows arm64 .exe
build_one darwin  amd64 ""
build_one darwin  arm64 ""
build_one linux   amd64 ""
build_one linux   arm64 ""

# ── Package the macOS .app bundles (C.1, bug 20260626-8d20ea22 macosregister) ──
# macOS registers BUNDLES, not loose executables, so the release must ship a .app
# (a bare binary can never register agent-index://). Assemble on any host; signing
# + notarization happen in the signing stage below (macOS-only).
echo ""
echo "Packaging macOS .app bundles..."
for arch in amd64 arm64; do
    app="dist/Agent-Index Helper-${VERSION}-darwin-${arch}.app"
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS"
    # Reuse the canonical Info.plist from the installer by running it in package-only
    # mode is overkill; assemble directly so this works off-Mac too.
    cp "dist/${PROJECT}-${VERSION}-darwin-${arch}" "$app/Contents/MacOS/agent-index-show-plan"
    chmod +x "$app/Contents/MacOS/agent-index-show-plan"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>agent-index-show-plan</string>
  <key>CFBundleIdentifier</key><string>ai.agent-index.permission-helper</string>
  <key>CFBundleName</key><string>Agent-Index Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>Agent-Index Permission Helper</string>
    <key>CFBundleURLSchemes</key><array><string>agent-index</string></array>
  </dict></array>
</dict></plist>
PLIST
    echo "  → ${app}"
done

# ── Signing stage (C.1, bug 20260626-8d20ea22-2 binsigning) ───────────────────
# Sign BEFORE computing checksums so the directory SHA256s pin the SIGNED bytes.
# Signing is host/CI-specific (signtool/Trusted Signing on Windows; codesign +
# notarytool + stapler on macOS; optional gpg on Linux) — see SIGNING.md. The
# per-environment signer is sign.sh; it must exist when SIGN=1.
# ── THE SIGNING SWITCH ────────────────────────────────────────────────────────
# SIGN=1 (default, enforced): sign every artifact, then a verify-signed gate fails
#         the build if anything is unsigned. Use once certs exist.
# SIGN=0 (bypass): skip signing AND the verify gate; produce UNSIGNED binaries with
#         real SHAs so the rest of the pipeline (push → install → ms-install-7) can
#         run while certs are pending. Windows Smart App Control will block these;
#         testers use the SAC Evaluation-mode workaround (SIGNING.md). When you ship
#         a SIGN=0 build you MUST set the directory binary entries to
#         "signing": "unsigned-bypass" so runtime guidance adapts (and BUMP the
#         binary version when you later flip to a signed build, so members re-pull).
SIGN="${SIGN:-1}"
if [[ "$SIGN" == "1" ]]; then
    if [[ -x ./sign.sh ]]; then
        echo ""; echo "Signing artifacts (sign.sh)..."
        ./sign.sh "$VERSION" || { err "sign.sh failed"; exit 1; }
    else
        err "SIGN=1 but ./sign.sh is missing. Provide it (SIGNING.md), or set SIGN=0 to ship an UNSIGNED bypass build for testers."
        exit 1
    fi
else
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "  ⚠  SIGN=0 — SIGNING BYPASSED. Building UNSIGNED binaries."
    echo "     Windows Smart App Control WILL block these (no user bypass);"
    echo "     testers use SAC Evaluation mode (see SIGNING.md). Set the"
    echo "     directory binary 'signing' field to 'unsigned-bypass'."
    echo "════════════════════════════════════════════════════════════════"
fi

echo ""
echo "Computing SHA256 checksums (post-signing)..."
cd dist
shasum -a 256 ${PROJECT}-* > checksums.txt
cat checksums.txt
cd - >/dev/null

# ── Verify-signed gate — only when SIGN=1 ─────────────────────────────────────
if [[ "$SIGN" == "1" && -x ./verify-signed.sh ]]; then
    echo ""; echo "Verifying signatures (verify-signed.sh)..."
    ./verify-signed.sh "$VERSION" || { err "verify-signed gate FAILED — do not release."; exit 1; }
fi

echo ""
echo "✓ build complete. Artifacts in dist/ (binaries + macOS .app bundles)"
echo ""
echo "Next steps:"
echo "  1. Upload all dist/${PROJECT}-* AND the dist/*.app (zipped) as release assets"
echo "     to v${VERSION} on agent-index/agent-index-permissions-binaries."
echo "  2. Paste the per-line sha256 values from dist/checksums.txt (SIGNED bytes) into"
echo "     dev_source/agent-index-resource-listings/infrastructure-directory.json"
echo "     under the matching binaries[].platforms[].sha256."
echo "  3. Re-run the binaries push so the updated directory reaches the remote filesystem."
echo ""
echo "  See SIGNING.md for cert/account setup and the sign.sh contents per platform."
