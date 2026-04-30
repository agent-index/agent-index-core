---
name: verify-workspace-policy-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the verify-workspace-policy task
target: verify-workspace-policy
target_type: task
upgrade_compatible: true
---

## Setup Overview

`verify-workspace-policy` is a runtime read-only diagnostic with no setup-time configuration.

---

## Pre-Setup Checks

These run at task invocation, not setup:

- Calling member is an org admin
- Remote filesystem is reachable
- Local adapter has access to `aifs_get_permissions` (gdrive contract v2.0+)

---

## Parameters

No member-configurable parameters.
---

## Setup Completion

1. Validate remote filesystem access.
2. Verify admin privileges (where applicable per the task's pre-flight checks).
3. Register entry in `member-index.json` with alias `@ai:verify-workspace-policy`.
4. Confirm to member: "Verify Workspace Policy is installed. Run `@ai:verify-workspace-policy` when needed."

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
