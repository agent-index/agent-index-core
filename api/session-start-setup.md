---
name: session-start-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the session-start task — installs the automatic session initialization task into the member's workspace
target: session-start
target_type: task
upgrade_compatible: true
---

## Setup Overview

This installs the Session Start task, which runs automatically at the beginning of every Cowork session. No configuration is needed — it reads your preferences and member index automatically.

---

## Pre-Setup Checks

- `member-index.json` exists at the member's local workspace path → if not: "Your member workspace doesn't appear to be initialized yet. Let's set up your workspace first." Invoke member-bootstrap before proceeding.

---

## Parameters

No member-configurable parameters. The Session Start task reads all configuration it needs from `member-index.json` and `preferences.md` at runtime.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/tasks/session-start/`
2. Write `manifest.json`
3. Write empty `setup-responses.md` (no responses to record)
4. Register entry in `member-index.json` with alias `@ai:session-start`
5. Confirm to member: "Session Start is installed. It will run automatically every time you open a Cowork session."

---

## Upgrade Behavior

### Preserved Responses
N/A — no parameters to preserve.

### Reset on Upgrade
N/A.

### Requires Member Attention
None unless new runtime parameters are introduced in a future version.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
