---
name: remove-member-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the remove-member task
target: remove-member
target_type: task
upgrade_compatible: true
---

## Setup Overview

`remove-member` is an admin-only runtime task with no setup-time configuration. The task collects the email of the departing member at invocation.

This setup file exists to satisfy the standards.md requirement that every task have a corresponding `-setup.md` file.

---

## Pre-Setup Checks

These run at task invocation, not setup:

- Calling member is an org admin
- Remote filesystem is reachable

---

## Parameters

No member-configurable parameters.
---

## Setup Completion

1. Validate remote filesystem access.
2. Verify admin privileges (where applicable per the task's pre-flight checks).
3. Register entry in `member-index.json` with alias `@ai:remove-member`.
4. Confirm to member: "Remove Member is installed. Run `@ai:remove-member` when needed."

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
