---
name: agent-index-core-collection-setup
type: collection-setup
version: 2.1.0
collection: agent-index-core
description: Org-admin setup for agent-index-core — run automatically as part of create-org
upgrade_compatible: true
---

## Collection Setup Overview

Agent-index-core setup is handled entirely by the `create-org` task. This file exists to satisfy the marketplace standard requiring a `collection-setup.md` for every collection. There are no org-level parameters to configure for core — all configuration is collected interactively by `create-org`.

---

## Prerequisites

- Git installed
- Shared filesystem mounted and accessible
- `agent-index.json` readable at the filesystem root

---

## Org-Level Parameters

Agent-index-core has no org-level parameters requiring admin configuration. All runtime behavior is determined by `agent-index.json` (filesystem paths) and `org-config.json` (org identity and admin list), both of which are managed by `create-org` and `edit-org`.

---

## Setup Completion

Agent-index-core setup is considered complete when `org-config.json` exists on the remote filesystem (readable via `aifs_read`) with valid content. This is written by `create-org`.

---

## Upgrade Behavior

### Preserved Responses
N/A — no org-level parameters.

### Reset on Upgrade
N/A.

### Requires Admin Attention
Any structural changes to `agent-index.json` or `org-config.json` schemas in a new version will be documented here with migration instructions.

### Requires Member Attention
None for PATCH/MINOR upgrades. MAJOR version upgrades will document required member actions here.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
