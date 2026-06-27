#!/usr/bin/env bash
# verify-signed.sh — release gate (C.1, bug 20260626-8d20ea22-2).
# Fails non-zero if any release artifact is unsigned / not notarized, so an
# unsigned binary can never reach a release (Windows Smart App Control hard-blocks
# unsigned binaries with NO user bypass; macOS Gatekeeper blocks un-notarized).
#
# Run from the permission-helper-go dir after build-all.sh's signing stage:
#   bash verify-signed.sh <version>
#
# Verifies what the current host is able to verify:
#   - macOS host:   codesign --verify + spctl assessment + stapler validate (.app)
#   - Windows host: (run verify-signed.ps1 instead — signtool verify)
#   - Linux host:   gpg --verify of detached .asc (only if SIGN_LINUX=1)
# A platform it cannot check on this host is reported as SKIPPED (verify it on
# that platform or in CI), never as PASS.

set -uo pipefail
VERSION="${1:?usage: verify-signed.sh <version>}"
PROJECT="agent-index-show-plan"
DIST="dist"
HOST="$(uname -s)"
fail=0
note(){ printf "  %s\n" "$1"; }
bad(){ printf "  ✗ %s\n" "$1" >&2; fail=1; }
ok(){ printf "  ✓ %s\n" "$1"; }

echo "verify-signed: $PROJECT v$VERSION (host: $HOST)"

# ── macOS artifacts ───────────────────────────────────────────────────────────
if [[ "$HOST" == "Darwin" ]]; then
    for arch in amd64 arm64; do
        app="$DIST/Agent-Index Helper-${VERSION}-darwin-${arch}.app"
        bin="$DIST/${PROJECT}-${VERSION}-darwin-${arch}"
        if [[ -d "$app" ]]; then
            codesign --verify --deep --strict "$app" 2>/dev/null && ok "codesign: $app" || bad "codesign FAILED: $app"
            spctl --assess --type execute "$app" 2>/dev/null && ok "gatekeeper accepts: $app" || bad "spctl/Gatekeeper REJECTS: $app (notarize+staple?)"
            xcrun stapler validate "$app" 2>/dev/null && ok "stapled: $app" || bad "NOT stapled: $app"
        else
            bad "missing .app: $app"
        fi
        [[ -f "$bin" ]] && { codesign --verify "$bin" 2>/dev/null && ok "codesign: $bin" || bad "bare darwin binary unsigned: $bin"; }
    done
else
    note "SKIPPED macOS checks (not on a Mac) — verify on macOS or in a macOS CI runner."
fi

# ── Windows artifacts ─────────────────────────────────────────────────────────
# signtool is Windows-only; on non-Windows we can only note. Use verify-signed.ps1
# on a Windows host / CI. osslsigncode (if installed) can verify cross-platform.
for arch in amd64 arch64; do :; done
for arch in amd64 arm64; do
    exe="$DIST/${PROJECT}-${VERSION}-windows-${arch}.exe"
    [[ -f "$exe" ]] || { bad "missing: $exe"; continue; }
    if command -v osslsigncode >/dev/null 2>&1; then
        osslsigncode verify "$exe" >/dev/null 2>&1 && ok "authenticode: $exe" || bad "authenticode INVALID/absent: $exe"
    else
        note "SKIPPED Authenticode verify for $exe (no osslsigncode here) — run verify-signed.ps1 (signtool verify /pa) on Windows/CI."
    fi
done

# ── Linux artifacts (optional provenance) ─────────────────────────────────────
if [[ "${SIGN_LINUX:-0}" == "1" ]]; then
    for arch in amd64 arm64; do
        bin="$DIST/${PROJECT}-${VERSION}-linux-${arch}"
        if [[ -f "$bin.asc" ]]; then
            gpg --verify "$bin.asc" "$bin" >/dev/null 2>&1 && ok "gpg sig: $bin" || bad "gpg sig INVALID: $bin"
        else
            bad "SIGN_LINUX=1 but missing detached sig: $bin.asc"
        fi
    done
else
    note "Linux signing not requested (SIGN_LINUX=0) — no OS gatekeeper on Linux; provenance signatures optional."
fi

echo ""
if [[ "$fail" == "0" ]]; then echo "✓ verify-signed: all checks this host can perform PASSED"; exit 0
else echo "✗ verify-signed: FAILURES above — do NOT release"; exit 1; fi
