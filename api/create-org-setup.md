---
name: create-org-setup
type: setup
version: 3.0.0
collection: agent-index-core
description: Setup for the create-org task
target: create-org
target_type: task
upgrade_compatible: true
---

## Setup Overview

This installs the Create Org task. This task is run once to establish your org's agent-index configuration. It is typically the first thing an org admin does after cloning agent-index-core.

---

## Pre-Setup Checks

- `member-bootstrap` has been completed (local `member-index.json` exists and remote filesystem is authenticated) → if not: run member-bootstrap first.

---

## Parameters

No pre-install parameters. All configuration is collected when the task is run.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/tasks/create-org/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:create-org`
5. Confirm to member: "Create Org is installed. Say '@ai:create-org' or 'create org' to configure your organization."

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
