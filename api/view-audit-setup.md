---
name: view-audit-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the view-audit task
target: view-audit
target_type: task
upgrade_compatible: true
---

## Setup Overview

`view-audit` is a runtime navigational helper with no setup-time configuration.

---

## Pre-Setup Checks

These run at task invocation, not setup:

- Remote filesystem is reachable (needed to resolve path → Drive file ID)

---

## Parameters

No member-configurable parameters.
---

## Setup Completion

1. Validate remote filesystem access.
2. Verify admin privileges (where applicable per the task's pre-flight checks).
3. Register entry in `member-index.json` with alias `@ai:view-audit`.
4. Confirm to member: "View Audit Trail is installed. Run `@ai:view-audit` when needed."

---

## Upgrade Behavior

### Preserved Responses
N/A — this task has no member-configurable parameters.

### Reset on Upgrade
N/A.

### Requires Member Attention
None.

### Migration Notes
- v1.0 (initial release): introduced as part of agent-index-core 3.1.0 (Access Control project Phase 1).
