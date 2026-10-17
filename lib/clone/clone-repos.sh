#!/usr/bin/env bash
# clone-repos.sh -- committed, parameterized repo clone/pin tool (darwin/linux twin of clone-repos.ps1)
# Level-3 tooling: the agent emits ONLY a data manifest; ALL clone/ref logic is committed here.
# Which ref each repo gets is decided by resolve-refs.js (core 3.32.0) -- shared with the .ps1 twin so
# the two platforms can't disagree. Distribution channels: a manifest `channel` makes every repo that
# has a `channel/<channel>` branch come from that branch head; the rest fall back to the normal rule.
# Every run records what it chose in <install_root>/.agent-index/clone-resolution.json.
# Usage: bash clone-repos.sh <manifest.json>
set -u
MANIFEST="${1:-}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "FATAL: $*"; exit 2; }
[ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
command -v python3 >/dev/null 2>&1 || die "python3 required to parse the manifest"
command -v git >/dev/null 2>&1 || die "git required"

field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8-sig')).get(sys.argv[2]) or '')" "$MANIFEST" "$1"; }
MODE=$(field mode); ARCH=$(field host_arch); ROOT=$(field install_root); BACKEND=$(field backend); CHANNEL=$(field channel)
[ "$MODE" = "infra" ] || [ "$MODE" = "collections" ] || die "mode must be infra|collections (got: $MODE)"
[ -n "$ROOT" ] || die "install_root required"
[ -d "$ROOT" ] || die "install_root does not exist: $ROOT"
[ "$MODE" = "infra" ] && [ -z "$BACKEND" ] && die "backend required in infra mode"

if command -v node >/dev/null 2>&1; then
  PLAN=$(node "$SELF_DIR/resolve-refs.js" "$MANIFEST") || die "ref resolution failed: $PLAN"
else
  # No Node on this host. Released code still works (built-in tag resolution, numeric sort);
  # distribution channels need resolve-refs.js and therefore Node.
  [ -z "$CHANNEL" ] || die "distribution channel '$CHANNEL' needs Node.js on this host (install Node, or clear the channel)"
  PLAN=$(python3 - "$MANIFEST" <<'PYF'
import json,sys,subprocess,re
m=json.load(open(sys.argv[1],encoding='utf-8-sig')); mode=m.get('mode'); out={'ok':True,'channel':None,'mode':mode,'repos':[],'errors':[]}
def key(t):
    mm=re.match(r'^v(\d+(?:\.\d+)*)$',t); return tuple(int(x) for x in mm.group(1).split('.')) if mm else None
for r in m.get('repos',[]):
    n,u=r.get('name'),r.get('git_url')
    if not n or not u: out['errors'].append({'name':n,'error':'manifest entry missing name/git_url'}); continue
    try: txt=subprocess.run(['git','ls-remote','--symref',u,'HEAD','refs/heads/*','refs/tags/*'],capture_output=True,text=True,timeout=60,check=True).stdout
    except Exception as e: out['errors'].append({'name':n,'error':'git ls-remote failed: %s'%e}); continue
    dflt=None; heads={}; tags={}
    for line in txt.splitlines():
        a=line.split('\t')
        if line.startswith('ref: refs/heads/') and line.endswith('HEAD'): dflt=line.split()[1][len('refs/heads/'):]; continue
        if len(a)!=2: continue
        if a[1].startswith('refs/heads/'): heads[a[1][11:]]=a[0]
        elif a[1].startswith('refs/tags/'):
            t=a[1][10:]
            if t.endswith('^{}'): tags[t[:-3]]=a[0]
            else: tags.setdefault(t,a[0])
    base={'name':n,'git_url':u,'mode':mode,'want_version':r.get('version')}
    rel=sorted([t for t in tags if key(t)],key=key)
    if mode=='infra' and rel: out['repos'].append(dict(base,ref_type='tag',ref=rel[-1],commit=tags[rel[-1]])); continue
    if mode=='collections' and r.get('version'):
        t='v'+str(r['version']).lstrip('v')
        if t in tags: out['repos'].append(dict(base,ref_type='tag',ref=t,commit=tags[t]))
        elif not rel and (dflt or 'main' in heads or 'master' in heads):
            dflt=dflt or ('main' if 'main' in heads else 'master'); out['repos'].append(dict(base,ref_type='branch_head',ref=dflt,commit=heads.get(dflt)))
        else: out['errors'].append({'name':n,'error':'release tag %s not found on the remote (manifest version %s); refusing to fall back to the default branch (tagnofallback)'%(t,r['version'])})
        continue
    dflt=dflt or ('main' if 'main' in heads else ('master' if 'master' in heads else None))
    if not dflt: out['errors'].append({'name':n,'error':'remote has no default branch and no usable tag'}); continue
    out['repos'].append(dict(base,ref_type='branch_head',ref=dflt,commit=heads.get(dflt)))
print(json.dumps(out))
PYF
) || die "ref resolution failed"
  echo "note: Node.js not found on this host -- using built-in release-tag resolution (fine for released code)"
fi
[ -n "$CHANNEL" ] && echo "distribution channel: $CHANNEL (repos with a channel/$CHANNEL branch come from it; the rest from the normal rule)"

# Decisions as TSV: name<TAB>git_url<TAB>ref_type<TAB>ref<TAB>want_version ; resolver errors as "ERR<TAB>name<TAB>msg"
ROWS=$(python3 -c "
import json,sys
p=json.loads(sys.stdin.read())
for r in p.get('repos',[]): print('\t'.join([r['name'],r['git_url'],r['ref_type'],r['ref'],r.get('want_version') or '']))
for e in p.get('errors',[]): print('ERR\t%s\t%s'%(e.get('name') or '?', e.get('error')))
" <<< "$PLAN")

json_version() { # $1=dir ; version from collection.json or adapter.json
  for f in collection.json adapter.json; do
    if [ -f "$1/$f" ]; then
      python3 -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8-sig')).get('version',''))" "$1/$f" 2>/dev/null && return
    fi
  done
}
# Each checkout sets ERR (git's own stderr, one line) on failure. A target folder that exists but has
# no .git is cloned into when empty, else refused (bug 20261010-8d20ea22-145943-72ef).
ERR=""
gitq() { # run git, keep its output for ERR on failure
  local out sub="$1"; [ "$1" = "-C" ] && sub="$3"
  out=$(git "$@" 2>&1) && return 0
  ERR="git $sub failed: $(echo "$out" | tr '\n' ' ' | sed 's/  */ /g;s/ $//')"; return 1
}
fresh_clone() { # $1=dir $2=url $3=ref -> 0 = cloned, 1 = failed (ERR set), 2 = dir is an existing repo
  if [ -d "$1" ] && [ ! -e "$1/.git" ]; then
    if [ -n "$(ls -A "$1" 2>/dev/null)" ]; then ERR="exists but is not a git repo: $1 (move or delete it, then re-run)"; return 1; fi
  elif [ -d "$1" ]; then return 2; fi
  gitq clone --depth=1 --branch "$3" "$2" "$1"
}
checkout_branch() { # $1=dir $2=url $3=branch  -> clone or refresh to the branch head (fixes stale detached shallow clones)
  ERR=""; fresh_clone "$1" "$2" "$3"; local rc=$?; [ $rc -ne 2 ] && return $rc
  rm -f "$1/.git/index.lock" 2>/dev/null
  gitq -C "$1" fetch --depth=1 origin "+refs/heads/$3:refs/remotes/origin/$3" || return 1
  git -C "$1" reset --hard >/dev/null 2>&1
  gitq -C "$1" checkout -f -B "$3" "origin/$3" || return 1
  gitq -C "$1" reset --hard "origin/$3"
}
checkout_tag() { # $1=dir $2=url $3=tag
  ERR=""; fresh_clone "$1" "$2" "$3"; local rc=$?; [ $rc -ne 2 ] && return $rc
  rm -f "$1/.git/index.lock" 2>/dev/null
  gitq -C "$1" fetch --depth=1 origin "+refs/tags/$3:refs/tags/$3" || return 1
  git -C "$1" reset --hard >/dev/null 2>&1
  gitq -C "$1" checkout -f "$3"
}

OK=0; FAILED=""; RECORDS=""
echo ""
while IFS=$'\t' read -r NAME URL TYPE REF WANT; do
  [ -n "$NAME" ] || continue
  if [ "$NAME" = "ERR" ]; then echo "FAILED $URL -- $TYPE"; FAILED="$FAILED $URL"; continue; fi
  DIR="$ROOT/$NAME"
  if [ "$TYPE" = "tag" ]; then checkout_tag "$DIR" "$URL" "$REF"; else checkout_branch "$DIR" "$URL" "$REF"; fi \
    || { echo "FAILED $NAME -- could not check out $REF${ERR:+ -- $ERR}"; FAILED="$FAILED $NAME"; continue; }
  if [ "$MODE" = "collections" ] && [ ! -f "$DIR/collection.json" ]; then echo "FAILED $NAME -- collection.json missing"; FAILED="$FAILED $NAME"; continue; fi
  VER=$(json_version "$DIR"); SHA=$(git -C "$DIR" rev-parse HEAD 2>/dev/null)
  if [ "$TYPE" = "branch_head" ] && { [ "$MODE" = "infra" ] || [ -n "$WANT" ]; } && { [ -z "$VER" ] || { [ -n "$WANT" ] && [ "$VER" != "$WANT" ]; }; }; then
    echo "FAILED $NAME -- ERROR: no release tag found and version mismatch (want=$WANT got=$VER) -- phantom (tagnofallback)"; FAILED="$FAILED $NAME"; continue
  fi
  case "$TYPE" in
    channel) LABEL="(channel)";;
    tag) LABEL=$([ "$MODE" = "collections" ] && echo "(collection, release tag from manifest version)" || echo "(release tag)");;
    *) if [ "$MODE" = "collections" ] && [ -z "$WANT" ]; then LABEL="(collection, default-branch head -- no version in manifest)"; else LABEL="(branch-HEAD distribution, no release tags)"; fi;;
  esac
  echo "OK    $NAME -- $REF@${SHA:0:7} $LABEL"; OK=$((OK+1))
  RECORDS="$RECORDS$NAME	$TYPE	$REF	$SHA	$VER"$'\n'
done <<< "$ROWS"

# Merge this run's decisions into the resolution record (infra and collections runs touch different repos).
mkdir -p "$ROOT/.agent-index"
python3 - "$ROOT/.agent-index/clone-resolution.json" "$CHANNEL" <<PYEOF
import json,sys,os,datetime
p,ch=sys.argv[1],sys.argv[2] or None
try: d=json.load(open(p,encoding='utf-8-sig'))
except Exception: d={"schema":"clone-resolution/1","repos":{}}
d["schema"]="clone-resolution/1"; d["channel"]=ch
d["resolved_at"]=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
for line in """$RECORDS""".splitlines():
    if not line.strip(): continue
    n,t,r,c,v=(line.split('\t')+['']*5)[:5]
    d.setdefault("repos",{})[n]={"ref_type":t,"ref":r,"commit":c,"version":v,"channel":ch}
tmp=p+".tmp"; json.dump(d,open(tmp,'w',encoding='utf-8'),indent=2); os.replace(tmp,p)
PYEOF

echo ""
FCOUNT=$(echo $FAILED | wc -w | tr -d ' ')
echo "clone summary: $OK ok, $FCOUNT failed${FAILED:+:$FAILED}  (record: .agent-index/clone-resolution.json)"

[ "$FCOUNT" -eq 0 ] || exit 1
exit 0
# AIFS:FILE-END
