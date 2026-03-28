---
name: edit-org-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the edit-org task
target: edit-org
target_type: task
upgrade_compatible: true
---

## Setup Overview

This installs the Edit Org task, which allows org admins to manage the admin list and launch the marketplace.

---

## Pre-Setup Checks

- `org-config.json` is readable from the remote filesystem via `aifs_read` → if not: "Your org hasn't been configured yet. Run 'create org' first."

---

## Parameters

No pre-install parameters.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/tasks/edit-org/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:edit-org`
5. Confirm to member: "Edit Org is installed. Say '@ai:edit-org' or 'edit org' to manage your org configuration."

---

## Upgrade Behavior

### Preserved Responses
N/A.

### Reset on Upgrade
N/A.

### Requires Member Attention
None.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
