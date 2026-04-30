#!/usr/bin/env bash
# agent-index session bootstrap hook (v3.0.0)
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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
AGENT_INDEX_JSON="$PROJECT_DIR/agent-index.json"

# In v2.0.0, agent-index.json lives at the project root (from the bootstrap zip),
# not inside agent-index-core/. Fall back to the old location for compatibility.
if [ ! -f "$AGENT_INDEX_JSON" ]; then
  AGENT_INDEX_JSON="$PROJECT_DIR/agent-index-core/agent-index.json"
fi

# Verify agent-index.json exists
if [ ! -f "$AGENT_INDEX_JSON" ]; then
  echo "AGENT_INDEX_BOOTSTRAP: NO_CONFIG"
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

if [ -n "$MEMBER_EMAIL" ]; then
  # Compute member hash from email
  MEMBER_EMAIL_LOWER=$(echo -n "$MEMBER_EMAIL" | tr '[:upper:]' '[:lower:]')
  MEMBER_HASH=$(echo -n "$MEMBER_EMAIL_LOWER" | sha256sum | cut -c1-"$HASH_LENGTH")
  MEMBER_INDEX="$MEMBERS_ROOT/$MEMBER_HASH/member-index.json"

  if [ -f "$MEMBER_INDEX" ]; then
    echo "AGENT_INDEX_BOOTSTRAP: RETURNING_MEMBER"
    echo "member_hash=$MEMBER_HASH"
    echo "member_index=$MEMBER_INDEX"
    echo "Run the agent-index session-start task for this member."
  else
    echo "AGENT_INDEX_BOOTSTRAP: NEW_MEMBER"
    echo "member_hash=$MEMBER_HASH"
    echo "member_email=$MEMBER_EMAIL"
    echo "No local member workspace found. Prompt the member to say: 'set up my agent-index member workspace'"
  fi
else
  # Email not available in environment — ask Claude to resolve from session context
  echo "AGENT_INDEX_BOOTSTRAP: IDENTITY_PENDING"
  echo "members_root=$MEMBERS_ROOT"
  echo "hash_length=$HASH_LENGTH"
  echo "Member email not available in environment. Claude should compute SHA256 of the member's lowercase email from session context, take the first $HASH_LENGTH hex characters, and check for members/{hash}/member-index.json locally. If found: run session-start. If not found: prompt member to say 'set up my agent-index member workspace'."
fi
