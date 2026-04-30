---
name: view-permissions-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the view-permissions task
target: view-permissions
target_type: task
upgrade_compatible: true
---

## Setup Overview

`view-permissions` is a runtime read-only task with no setup-time configuration. The path it operates on is supplied at invocation or inferred from conversation context.

---

## Pre-Setup Checks

These run at task invocation, not setup:

- Local adapter declares `contract_version: "2.0.0"` or higher (gdrive adapter v2.2.0+; needed for `aifs_get_permissions`)
- Remote filesystem is reachable

---

## Parameters

No member-configurable parameters.
---

## Setup Completion

1. Validate remote filesystem access.
2. Verify admin privileges (where applicable per the task's pre-flight checks).
3. Register entry in `member-index.json` with alias `@ai:view-permissions`.
4. Confirm to member: "View Permissions is installed. Run `@ai:view-permissions` when needed."

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
