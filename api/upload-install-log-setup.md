---
name: upload-install-log-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the upload-install-log task
target: upload-install-log
target_type: task
upgrade_compatible: true
---

## Setup Overview

Upload Install Log sends diagnostic data to the agent-index log collector for analysis. No member configuration is needed. The endpoint URL is configured in `agent-index.json`.

---

## Pre-Setup Checks

None.

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Register entry in `member-index.json` with alias `@ai:upload-install-log`
2. Confirm to member: "Upload Install Log is installed. Run '@ai:upload-install-log' to send diagnostic logs to the agent-index development team."

---

## Upgrade Behavior

### Preserved Responses
N/A.

### Reset on Upgrade
N/A.

### Requires Member Attention
None.

### Migration Notes
- v1.0 → future versions: migration notes will be added here as new versions are published.
