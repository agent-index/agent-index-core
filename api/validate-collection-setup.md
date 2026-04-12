---
name: validate-collection-setup
type: setup
version: 2.1.0
collection: agent-index-core
description: Setup interview for validate-collection
target: validate-collection
target_type: task
upgrade_compatible: true
---

## Setup Overview

This setup configures the collection validation task. The task works with sensible defaults and requires no member configuration. This setup step confirms installation.

---

## Pre-Setup Checks

- Member has agent-index-core collection installed → proceed with org setup if not

---

## Parameters

### Member-Overridable Parameters [member-overridable]

**default_validation_level** [member-overridable]
- Description: Whether validation defaults to marketplace-level (stricter) or org-level (more lenient) checks
- Default: marketplace
- Interview prompt: "Validation can run at marketplace level (stricter, suitable for public submission) or org level (more lenient, suitable for internal collections). Which default do you prefer?"
- Accepted values: `marketplace`, `org`

---

## Setup Completion

1. Write all collected parameter values to `setup-responses.md`
2. Generate the personalized installed instance
3. Write the installed instance to `/members/{member_hash}/tasks/validate-collection/`
4. Write manifest.json
5. Register entry in `member-index.json`
6. Confirm completion to member

---

## Upgrade Behavior

### Preserved Responses
All parameters preserved at v1.0.0.

### Reset on Upgrade
None at v1.0.0.

### Requires Member Attention
None at v1.0.0.

### Migration Notes
None at v1.0.0.
