#!/usr/bin/env bash
# agent-index session bootstrap hook (v4.2.0: ready | needs_auth | needs_setup)
# Runs automatically at the start of every Cowork session.
#
# This script performs LOCAL checks only — no remote calls.
# Remote filesystem access uses the on-demand executor (aifs-exec.sh),
# not this script. Remote connectivity and auth checks happen in session-start.
#
# This script detects the current member and tells Claude how to initialize
# the session. It handles two cases:
#   1. Returning member: local member-index.json exists → run session-start
#   2. New member: no local member-index.json → prompt for first-time setup
#
# Identity resolution uses SHA256 of the member's lowercase email address,
# truncated to the first 16 hex characters, as defined in agent-index.json.

set -euo pipefail

# CLAUDE_PROJECT_DIR is not guaranteed to be set (measured unset in Cowork, bug
# `20260822-8d20ea22-143450-b7e2`). Derive the project dir from this script's own location
# before falling back to '.'. The hook ships at <project>/agent-index-core/.claude/hooks/,
# so ../.. is agent-index-core and its parent is the project root; take whichever holds
# agent-index.json (project root first).
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  SCRIPT_ROOT=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd || true)
  if [ -n "$SCRIPT_ROOT" ] && [ -f "$SCRIPT_ROOT/../agent-index.json" ]; then
    PROJECT_DIR=$(cd "$SCRIPT_ROOT/.." && pwd)
  elif [ -n "$SCRIPT_ROOT" ] && [ -f "$SCRIPT_ROOT/agent-index.json" ]; then
    PROJECT_DIR="$SCRIPT_ROOT"
  else
    PROJECT_DIR="."
  fi
fi
AGENT_INDEX_JSON="$PROJECT_DIR/agent-index.json"

# In v2.0.0, agent-index.json lives at the project root (from the bootstrap zip),
# not inside agent-index-core/. Fall back to the old location for compatibility.
if [ ! -f "$AGENT_INDEX_JSON" ]; then
  AGENT_INDEX_JSON="$PROJECT_DIR/agent-index-core/agent-index.json"
fi

# Verify agent-index.json exists
if [ ! -f "$AGENT_INDEX_JSON" ]; then
  echo "AGENT_INDEX_BOOTSTRAP: needs_setup"
  echo "reason=no_agent_index_json"
  echo "agent-index.json not found. This directory may not be an agent-index install."
  echo "If you downloaded a bootstrap zip, make sure it was unpacked correctly."
  exit 0
fi

# Read identity resolution config
HASH_LENGTH=$(python3 -c "
import json, sys
try:
    with open('$AGENT_INDEX_JSON') as f:
        config = json.load(f)
    print(config.get('identity_resolution', {}).get('hash_length', 16))
except:
    print(16)
" 2>/dev/null || echo "16")

# Member workspaces are LOCAL in v2.0.0
MEMBERS_ROOT="$PROJECT_DIR/members"

# Attempt to resolve member identity from environment
# Cowork may expose the member's email as an environment variable.
# If not available, we signal Claude to resolve identity from session context.
MEMBER_EMAIL="${CLAUDE_USER_EMAIL:-}"

# core 4.2.0 (CI-025): when the environment doesn't carry the email, use the
# identity the filesystem adapter saved at sign-in ({credential_store}/identity.json,
# adapter gdrive 2.12.0 / onedrive 2.8.0). No network call.
if [ -z "$MEMBER_EMAIL" ]; then
  # The path goes in as an argument (not spliced into the source) so quotes or
  # spaces in it can't break the script; "~" in credential_store is expanded.
  MEMBER_EMAIL=$(python3 - "$AGENT_INDEX_JSON" 2>/dev/null <<'PY' || echo ""
import json, os, sys
try:
    cfg_path = sys.argv[1]
    cfg = json.load(open(cfg_path, encoding='utf-8-sig'))
    store = (cfg.get('remote_filesystem', {}).get('auth', {}) or {}).get('credential_store') or '.agent-index/credentials/'
    store = os.path.expanduser(store)
    if not os.path.isabs(store):
        store = os.path.join(os.path.dirname(os.path.abspath(cfg_path)), store)
    print(json.load(open(os.path.join(store, 'identity.json'), encoding='utf-8')).get('email', ''))
except Exception:
    print('')
PY
)
fi

if [ -n "$MEMBER_EMAIL" ]; then
  # Compute member hash from email
  MEMBER_EMAIL_LOWER=$(echo -n "$MEMBER_EMAIL" | tr '[:upper:]' '[:lower:]')
  MEMBER_HASH=$(echo -n "$MEMBER_EMAIL_LOWER" | sha256sum | cut -c1-"$HASH_LENGTH")
  MEMBER_INDEX="$MEMBERS_ROOT/$MEMBER_HASH/member-index.json"

  if [ -f "$MEMBER_INDEX" ]; then
    echo "AGENT_INDEX_BOOTSTRAP: ready"
    echo "member_hash=$MEMBER_HASH"
    echo "member_index=$MEMBER_INDEX"
    echo "Run the agent-index session-start task for this member."
  else
    echo "AGENT_INDEX_BOOTSTRAP: needs_setup"
    echo "reason=no_member_workspace"
    echo "member_hash=$MEMBER_HASH"
    echo "member_email=$MEMBER_EMAIL"
    echo "No local member workspace found. Prompt the member to say: 'set up my agent-index member workspace'"
  fi
else
  # Email not available in environment — ask Claude to resolve from session context
  # No identity known locally (never signed in on this install, or an adapter
  # older than 2.12.0): the first aifs call settles it.
  echo "AGENT_INDEX_BOOTSTRAP: needs_auth"
  echo "reason=identity_unknown"
  echo "No signed-in identity is recorded on this install. Call aifs_auth_status and act on its bootstrap field (ready: run session-start; needs_auth: sign in; needs_setup: member-bootstrap)."
fi
