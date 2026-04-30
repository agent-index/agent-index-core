---
name: system-tutorial-setup
type: setup
version: 3.0.0
collection: agent-index-core
description: Setup for the system-tutorial skill
target: system-tutorial
target_type: skill
upgrade_compatible: true
---

## Setup Overview

This installs the System Tutorial skill. Say '@ai:tutorial' at any time to get a guided walkthrough of how agent-index works or to ask specific questions about the system.

---

## Pre-Setup Checks

None.

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Write the installed instance to `/members/{member_hash}/skills/system-tutorial/`
2. Write `manifest.json`
3. Write empty `setup-responses.md`
4. Register entry in `member-index.json` with alias `@ai:tutorial`
5. Confirm to member: "System Tutorial is installed. Say '@ai:tutorial' anytime to learn how the system works."

---

## Upgrade Behavior

### Preserved Responses
N/A.

### Reset on Upgrade
N/A.

### Requires Member Attention
None. The tutorial content updates automatically with the collection — no member action needed.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
