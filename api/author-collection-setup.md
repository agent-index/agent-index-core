---
name: author-collection-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup interview for author-collection
target: author-collection
target_type: task
upgrade_compatible: true
---

## Setup Overview

This setup configures the collection authoring task. Most members can use default settings — the only decision is where new collections are written by default.

---

## Pre-Setup Checks

- Member has agent-index-core collection installed → proceed with org setup if not

---

## Parameters

### Member-Overridable Parameters [member-overridable]

**default_output_path** [member-overridable]
- Description: Default directory where new collections are created
- Default: A local working directory (the collection is authored locally, then uploaded to the remote filesystem by an org admin)
- Interview prompt: "New collections are created in a local working directory by default. Would you like to change the default output location?"
- Accepted values: Any valid directory path accessible to the member

---

## Setup Completion

1. Write all collected parameter values to `setup-responses.md`
2. Generate the personalized installed instance
3. Write the installed instance to `/members/{member_hash}/tasks/author-collection/`
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
