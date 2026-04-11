---
name: preferences-management-setup
type: setup
version: 2.1.0
collection: agent-index-core
description: Setup for the preferences-management skill
target: preferences-management
target_type: skill
upgrade_compatible: true
---

## Setup Overview

This installs the Preferences Management skill. During onboarding this skill runs your initial preferences interview — establishing how your sessions behave before any other skills or tasks are installed.

---

## Pre-Setup Checks

- `member-index.json` is readable at the member's local workspace path → if not: invoke member-bootstrap first.

---

## Parameters

No pre-install parameters. All preferences are collected during the initial setup interview, which this skill conducts at onboarding time.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/skills/preferences-management/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:prefs`
5. Confirm to member: "Preferences Management is installed. Say '@ai:prefs' anytime to view or update your preferences."

---

## Upgrade Behavior

### Preserved Responses
N/A — preferences are stored in `preferences.md`, not in this skill's setup-responses.

### Reset on Upgrade
N/A.

### Requires Member Attention
None unless the preferences schema changes in a future version.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
