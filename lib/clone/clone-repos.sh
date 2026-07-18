#!/usr/bin/env bash
# clone-repos.sh -- committed, parameterized repo clone/pin tool (darwin/linux twin of clone-repos.ps1)
# Level-3 tooling: the agent emits ONLY a data manifest; ALL clone/tag/binary logic is committed here.
# Usage: bash clone-repos.sh <manifest.json>
set -u
MANIFEST="${1:-}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "FATAL: $*"; exit 2; }
[ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
command -v python3 >/dev/null 2>&1 || die "python3 required to parse the manifest"

# extract scalar fields
MODE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('mode',''))" "$MANIFEST")
ARCH=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('host_arch',''))" "$MANIFEST")
ROOT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('install_root',''))" "$MANIFEST")
BACKEND=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('backend',''))" "$MANIFEST")
[ "$MODE" = "infra" ] || [ "$MODE" = "collections" ] || die "mode must be infra|collections (got: $MODE)"
[ -n "$ROOT" ] || die "install_root required"
[ -d "$ROOT" ] || die "install_root does not exist: $ROOT"
[ "$MODE" = "infra" ] && [ -z "$BACKEND" ] && die "backend required in infra mode"

# repos as TSV: name<TAB>git_url<TAB>version
REPOS=$(python3 -c "
import json,sys
m=json.load(open(sys.argv[1]))
for r in m.get('repos',[]):
    print('%s\t%s\t%s'%(r.get('name',''),r.get('git_url',''),r.get('version','')))
" "$MANIFEST")

highest_tag() { # $1=git_url ; echoes highest v* tag or nothing
  git ls-remote --tags --refs "$1" 2>/dev/null \
    | sed -n 's#.*refs/tags/\(v[0-9][^\^]*\)$#\1#p' \
    | sort -t. -k1,1V | tail -n1
}
json_version() { # $1=dir ; echoes version from collection.json or adapter.json
  for f in collection.json adapter.json; do
    if [ -f "$1/$f" ]; then
      python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version',''))" "$1/$f" 2>/dev/null && return
    fi
  done
}
clean_checkout() { # $1=dir $2=ref
  rm -f "$1/.git/index.lock" 2>/dev/null
  git -C "$1" fetch --tags --depth=1 origin >/dev/null 2>&1
  git -C "$1" reset --hard >/dev/null 2>&1
  git -C "$1" checkout "$2" >/dev/null 2>&1 || git -C "$1" reset --hard "$2" >/dev/null 2>&1
}

OK=0; FAILED=""
echo ""
while IFS=$'\t' read -r NAME URL WANT; do
  [ -n "$NAME" ] && [ -n "$URL" ] || { echo "FAILED (manifest entry missing name/git_url)"; FAILED="$FAILED ?"; continue; }
  DIR="$ROOT/$NAME"
  if [ "$MODE" = "collections" ]; then
    if [ ! -d "$DIR" ]; then
      git clone --depth=1 "$URL" "$DIR" >/dev/null 2>&1 || { echo "FAILED $NAME -- git clone failed"; FAILED="$FAILED $NAME"; continue; }
    else
      rm -f "$DIR/.git/index.lock" 2>/dev/null; git -C "$DIR" fetch --depth=1 origin >/dev/null 2>&1; git -C "$DIR" reset --hard '@{u}' >/dev/null 2>&1
    fi
    [ -f "$DIR/collection.json" ] || { echo "FAILED $NAME -- collection.json missing"; FAILED="$FAILED $NAME"; continue; }
    SHA=$(git -C "$DIR" rev-parse HEAD 2>/dev/null); BR=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
    echo "OK    $NAME -- cloned at $BR@$SHA (collection, HEAD-pinned)"; OK=$((OK+1)); continue
  fi
  # infra: three-way discrimination
  TAG=$(highest_tag "$URL")
  if [ -n "$TAG" ]; then
    if [ ! -d "$DIR" ]; then
      git clone --depth=1 --branch "$TAG" "$URL" "$DIR" >/dev/null 2>&1 || { echo "FAILED $NAME -- clone --branch $TAG failed"; FAILED="$FAILED $NAME"; continue; }
    else
      clean_checkout "$DIR" "$TAG"
    fi
    echo "OK    $NAME -- cloned at $TAG (release tag)"; OK=$((OK+1)); continue
  fi
  # zero tags -> branch-HEAD vs phantom
  if [ ! -d "$DIR" ]; then
    git clone --depth=1 "$URL" "$DIR" >/dev/null 2>&1 || { echo "FAILED $NAME -- clone (default branch) failed"; FAILED="$FAILED $NAME"; continue; }
  else
    rm -f "$DIR/.git/index.lock" 2>/dev/null; git -C "$DIR" fetch --depth=1 origin >/dev/null 2>&1; git -C "$DIR" reset --hard '@{u}' >/dev/null 2>&1
  fi
  VER=$(json_version "$DIR")
  if [ -n "$VER" ] && { [ -z "$WANT" ] || [ "$VER" = "$WANT" ]; }; then
    SHA=$(git -C "$DIR" rev-parse HEAD 2>/dev/null); BR=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
    echo "OK    $NAME -- cloned at $BR@$SHA (branch-HEAD distribution, no release tags)"; OK=$((OK+1))
  else
    echo "FAILED $NAME -- ERROR: no release tag found and version mismatch (want=$WANT got=$VER) -- phantom (tagnofallback)"; FAILED="$FAILED $NAME"
  fi
done <<< "$REPOS"

echo ""
FCOUNT=$(echo $FAILED | wc -w | tr -d ' ')
echo "clone summary: $OK ok, $FCOUNT failed${FAILED:+:$FAILED}"

if [ "$MODE" = "infra" ] && [ "$FCOUNT" -eq 0 ]; then
  bash "$SELF_DIR/install-helper-binary.sh" "$ROOT" "$BACKEND" "$ARCH" || { echo "FATAL: helper binary install/registration failed"; exit 2; }
fi
[ "$FCOUNT" -eq 0 ] || exit 1
exit 0
