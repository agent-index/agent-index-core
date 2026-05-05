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
rm -f dist/agent-index-show-plan-*

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

echo ""
echo "Computing SHA256 checksums..."
cd dist
shasum -a 256 ${PROJECT}-* > checksums.txt
cat checksums.txt
cd - >/dev/null

echo ""
echo "✓ build complete. Artifacts in dist/"
echo ""
echo "Next steps:"
echo "  1. Upload all dist/${PROJECT}-* (NOT checksums.txt) as release assets"
echo "     to v${VERSION} on agent-index/agent-index-permissions-binaries."
echo "  2. Paste the per-line sha256 values from dist/checksums.txt into"
echo "     dev_source/agent-index-resource-listings/infrastructure-directory.json"
echo "     under binaries[0].platforms[].sha256 (six entries to update)."
echo "  3. Re-run the push-3.4.0.sh push script so the updated directory"
echo "     reaches the remote filesystem."
