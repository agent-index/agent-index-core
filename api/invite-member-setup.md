---
name: invite-member-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the invite-member task
target: invite-member
target_type: task
upgrade_compatible: true
---

## Setup Overview

`invite-member` is an admin-only runtime task with no setup-time configuration. The task collects all parameters at invocation time (new member's email and display name).

This setup file exists to satisfy the standards.md requirement that every task have a corresponding `-setup.md` file. There is nothing for the admin to configure ahead of time.

---

## Pre-Setup Checks

These run at task invocation, not setup:

- Calling member is an org admin (verified against `org-config.json` admins list)
- Local adapter declares `contract_version: "2.0.0"` or higher (gdrive adapter v2.2.0+)
- `org-config.json remote_filesystem.connection.all_members_group` is configured
- Remote filesystem is reachable

---

## Parameters

No member-configurable parameters. All inputs are collected at runtime.
---

## Setup Completion

1. Validate remote filesystem access.
2. Verify admin privileges (where applicable per the task's pre-flight checks).
3. Register entry in `member-index.json` with alias `@ai:invite-member`.
4. Confirm to member: "Invite Member is installed. Run `@ai:invite-member` when needed."

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
