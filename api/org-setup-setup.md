---
name: org-setup-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the org-setup skill — installs the primary member onboarding and capability management skill
target: org-setup
target_type: skill
upgrade_compatible: true
---

## Setup Overview

This installs the Org Setup skill — the main entry point for installing skills and tasks from your org's collections. During onboarding this skill orchestrates your full member setup. After onboarding it remains available for installing new capabilities and managing upgrades.

---

## Pre-Setup Checks

- `member-bootstrap` has been completed (local `member-index.json` exists and remote filesystem is authenticated via `aifs_auth_status()`) → if not: run member-bootstrap first
- `preferences-management` is installed in member index → if not: install it first
- `org-config.json` is readable from the remote filesystem via `aifs_read("/org-config.json")` → if not: "Your org hasn't been configured yet. An org admin needs to run 'create org' before members can complete setup."

---

## Parameters

No member-configurable parameters. The skill reads org configuration from `org-config.json` and collection catalogs at runtime.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/skills/org-setup/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:setup`
5. Confirm to member: "Org Setup is installed. Say '@ai:setup' to install your org's skills and tasks."

---

## Upgrade Behavior

### Preserved Responses
N/A — no parameters to preserve.

### Reset on Upgrade
N/A.

### Requires Member Attention
None unless the org-setup skill's onboarding flow changes significantly in a future version — in which case members may be prompted to re-run setup for specific capabilities.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
