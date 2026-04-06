---
name: apply-updates-setup
type: setup
version: 2.0.0
collection: agent-index-core
description: Setup for the apply-updates task
target: apply-updates
target_type: task
upgrade_compatible: true
---

## Setup Overview

Apply Updates reads pending update instructions from the remote filesystem and applies them to bring your installation current. This task requires remote filesystem connectivity to read update instructions.

---

## Pre-Setup Checks

- Remote filesystem is accessible (test with `aifs_auth_status()`) → if not: "Please check your remote filesystem connection or run '@ai:member-bootstrap'."

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Validate remote filesystem access
2. Register entry in `member-index.json` with alias `@ai:update`
3. Confirm to member: "Apply Updates is installed. Run '@ai:update' to apply pending updates to your installation."

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
