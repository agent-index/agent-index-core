---
name: member-bootstrap-setup
type: setup
version: 3.0.0
collection: agent-index-core
description: Setup for the member-bootstrap skill
target: member-bootstrap
target_type: skill
upgrade_compatible: true
---

## Setup Overview

Member Bootstrap guides you through authenticating to your org's remote filesystem, verifying connectivity, creating your local member workspace, and registering with the org. This skill requires remote filesystem connectivity. The on-demand executor bundle must be present in `mcp-servers/filesystem/` (included in the bootstrap zip). This setup validates your runtime environment.

---

## Pre-Setup Checks

- The exec shell wrapper exists at `mpc-servers/filesystem/aifs-exec.sh` and responds to `aifs_auth_status` → if not: "The remote filesystem exec bundle is missing from your bootstrap zip. Contact your org admin for a new bootstrap zip."

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
