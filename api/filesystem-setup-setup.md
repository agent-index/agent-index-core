---
name: filesystem-setup-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: "[DEPRECATED in v2.0.0 — replaced by member-bootstrap] Setup for the filesystem-setup skill"
target: filesystem-setup
target_type: skill
upgrade_compatible: true
deprecated: true
replaced_by: member-bootstrap
---

> **⚠️ DEPRECATED:** This setup was replaced by the member-bootstrap workflow in agent-index-core v2.0.0. See `member-bootstrap.md` for the current setup process.

## Setup Overview

This installs the Filesystem Setup skill, which connects your Cowork environment to the org's shared filesystem. It takes about one minute and is typically the first thing a new member does.

---

## Pre-Setup Checks

None — this skill is bootstrapped before any filesystem verification is possible.

---

## Parameters

No member-configurable parameters. The skill detects filesystem paths automatically at runtime.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/skills/filesystem-setup/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:fs-setup`
5. Confirm to member: "Filesystem Setup is installed. Say '@ai:fs-setup' to connect to your org's shared filesystem."

---

## Upgrade Behavior

### Preserved Responses
N/A — no parameters to preserve.

### Reset on Upgrade
N/A.

### Requires Member Attention
None unless new configuration options are introduced in a future version.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
