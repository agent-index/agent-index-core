---
name: pin-binary-version-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the pin-binary-version task
target: pin-binary-version
target_type: task
upgrade_compatible: true
---

## Setup Overview

Pin Binary Version lets an org admin set or clear the org-wide pinned version of a registered native binary tool. The pin is recorded in `org-config.json` → `binaries{}`, and members converge to it on their next `@ai:apply-updates`.

No member configuration is needed. The directory the task reads is already configured in `agent-index.json` → `infrastructure_directory_url`, and the admin list it checks against is already in `org-config.json` → `admins[]`.

---

## Pre-Setup Checks

None.

The task performs its own checks at run time rather than at install: it refuses a non-admin caller, validates the binary name against the infrastructure directory, and rejects any version below the directory's `min_required_version`.

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Register entry in `member-index.json` with alias `@ai:pin-binary-version`
2. Confirm to member: "Pin Binary Version is installed. Org admins can run '@ai:pin-binary-version' to set or clear the org's pinned version for a registered binary tool."

---

## Upgrade Behavior

### Preserved Responses
N/A — no parameters are collected at setup.

### Reset on Upgrade
N/A.

### Requires Member Attention
None. Existing pins in `org-config.json` → `binaries{}` are org state, not setup state, and are unaffected by upgrading this task.

### Migration Notes
- v1.0.0 → future versions: migration notes will be added here as new versions are published.

<!-- AIFS:FILE-END -->
