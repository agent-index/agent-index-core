---
name: publish-updates-setup
type: setup
version: 2.0.0
collection: agent-index-core
description: Setup for the publish-updates task
target: publish-updates
target_type: task
upgrade_compatible: true
---

## Setup Overview

Publish Updates is an admin-only task that generates update instructions from the current org state and publishes them to the remote filesystem. This task requires remote filesystem connectivity and org admin privileges.

---

## Pre-Setup Checks

- Remote filesystem is accessible (test with `aifs_auth_status()`) → if not: "Please check your remote filesystem connection or run '@ai:member-bootstrap'."
- Member has admin privileges (verify via `org-config.json` admin list) → if not: "Only org admins can publish updates."

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Validate remote filesystem access
2. Verify admin privileges
3. Register entry in `member-index.json` with alias `@ai:publish-updates`
4. Confirm to member: "Publish Updates is installed. Run '@ai:publish-updates' to generate and publish org updates."

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
