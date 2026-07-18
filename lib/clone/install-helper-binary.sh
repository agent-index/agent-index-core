#!/usr/bin/env bash
# install-helper-binary.sh -- committed backend-matched signed-helper resolver+installer (darwin/linux)
# Twin of install-helper-binary.ps1. Encodes binwrongbackend, binfield(current_version),
# sha256-verify-or-abort, signing field, per-platform registration (macosregister:
# darwin registers the BUNDLE via the shipped installer/lsregister, never --register a bare file).
set -u
ROOT="${1:-}"; BACKEND="${2:-}"; ARCH="${3:-}"
die() { echo "FATAL: $*"; exit 2; }
[ -n "$ROOT" ] && [ -n "$BACKEND" ] && [ -n "$ARCH" ] || die "usage: install-helper-binary.sh <install_root> <backend> <arch>"
command -v python3 >/dev/null 2>&1 || die "python3 required"
DIRJSON="$ROOT/agent-index-resource-listings/infrastructure-directory.json"
[ -f "$DIRJSON" ] || die "infrastructure-directory.json not found at $DIRJSON"

OS="linux"; case "$(uname -s)" in Darwin) OS="darwin";; esac

# resolve fields via python (backend-matched entry; current_version; platform row)
read -r VERSION FILENAME SHA256 URLT DEST SIGNING SANE < <(python3 - "$DIRJSON" "$BACKEND" "$OS" "$ARCH" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); backend,os_,arch=sys.argv[2],sys.argv[3],sys.argv[4]
b=next((x for x in d.get('binaries',[]) if x.get('backend')==backend),None)
if not b: print("_ _ _ _ _ _ BADBACKEND"); sys.exit(0)
ver=b.get('current_version','')
if not ver: print("_ _ _ _ _ _ BADFIELD"); sys.exit(0)
p=next((x for x in b.get('platforms',[]) if x.get('os')==os_ and x.get('arch')==arch),None)
if not p: print("_ _ _ _ _ _ BADPLAT"); sys.exit(0)
fn=(p.get('filename','') or '').replace('{version}',ver)
url=(b.get('release_url_template','') or '').replace('{version}',ver).replace('{filename}',fn)
print(ver, fn, p.get('sha256',''), url, b.get('install_destination','') or 'mcp-servers/permission-helper-go', b.get('signing',''), "OK")
PY
)
case "$SANE" in
  BADBACKEND) die "no binaries[] entry for backend $BACKEND (binwrongbackend guard)";;
  BADFIELD)   die "binary entry has no current_version (binfield guard)";;
  BADPLAT)    die "no platform row for $OS/$ARCH";;
esac

DESTDIR="$ROOT/$DEST"; mkdir -p "$DESTDIR"; OUT="$DESTDIR/$FILENAME"
echo "Downloading helper $FILENAME ($VERSION) for backend $BACKEND ..."
curl -fsSL "$URLT" -o "$OUT" || die "download failed: $URLT"

GOT=$(shasum -a 256 "$OUT" 2>/dev/null | awk '{print $1}'); [ -z "$GOT" ] && GOT=$(sha256sum "$OUT" 2>/dev/null | awk '{print $1}')
if [ -n "$SHA256" ] && [ "$GOT" != "$SHA256" ]; then rm -f "$OUT"; die "sha256 mismatch (want $SHA256 got $GOT) -- deleted, no install"; fi
echo "$VERSION" > "$DESTDIR/version.txt"
chmod +x "$OUT" 2>/dev/null

[ "$SIGNING" = "unsigned-bypass" ] && echo "NOTE: helper build is intentionally unsigned (certs pending); a Gatekeeper/SmartScreen prompt at launch is expected -- see SIGNING.md."

if [ "$OS" = "darwin" ]; then
  # macosregister: register the BUNDLE, never --register a bare file
  INST="$ROOT/agent-index-core/lib/permission-helper-go/installer/darwin/install.sh"
  if [ -f "$INST" ]; then bash "$INST" "$OUT" || die "darwin bundle installer failed"; else
    die "darwin installer not found ($INST) -- cannot register URL scheme from a bare binary (macosregister)"; fi
else
  "$OUT" --register >/dev/null 2>&1 || die "helper --register failed (native host registration is a hard error)"
fi
echo "OK    helper installed at $OUT (v$VERSION, registered)"
exit 0
