---
name: member-bootstrap-setup
type: setup
version: 2.1.0
collection: agent-index-core
description: Setup for the member-bootstrap skill
target: member-bootstrap
target_type: skill
upgrade_compatible: true
---

## Setup Overview

Member Bootstrap guides you through authenticating to your org's remote filesystem, verifying connectivity, creating your local member workspace, and registering with the org. This skill requires remote filesystem connectivity. The MCP server must be running (started by `.claude/settings.json` in CLI or the agent-index-filesystem plugin in Cowork). This setup validates your runtime environment.

---

## Pre-Setup Checks

- MCP server tools (`aifs_*`) are available in the tool list → if not: "The agent-index-filesystem MCP server is not running. In Cowork, install the agent-index-filesystem plugin. In Claude Code CLI, verify `.claude/settings.json` includes the server configuration."

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/skills/member-bootstrap/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:member-bootstrap`
5. Confirm to member: "Member Bootstrap is installed. Run '@ai:member-bootstrap' to authenticate to your org's remote filesystem and complete initial setup."

---

## Upgrade Behavior

### Preserved Responses
N/A.

### Reset on Upgrade
N/A.

### Requires Member Attention
None.

### Migration Notes
- v2.0 → future versions: migration notes will be added here as new versions are published.
