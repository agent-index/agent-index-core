---
name: verify-network-allowlist-setup
type: setup
version: 1.0.1
collection: agent-index-core
description: Setup for the verify-network-allowlist task
target: verify-network-allowlist
target_type: task
upgrade_compatible: true
---

## Setup Overview

This task has no setup parameters. It reads the canonical allowlist from `agent-index-core/templates/network-allowlist.template.json` and inspects `agent-index.json` for the configured backend and telemetry URL — no per-org configuration is needed.

No `collection-setup-responses.md` entry is produced.

---

## Pre-Setup Checks

None at setup time. The task checks reachability at invocation.

---

## Parameters

No member-configurable parameters.

---

## Setup Completion

1. Register entry in `member-index.json` with alias `@ai:verify-network-allowlist`.
2. Confirm to member: "Verify Network Allowlist is installed. Run `@ai:verify-network-allowlist` when you want to check that your network allows everything agent-index needs."

---

## Upgrade Behavior

### Preserved Responses
N/A — this task has no member-configurable parameters.

### Reset on Upgrade
N/A.

### Requires Member Attention
None.

### Migration Notes
- v1.0.1 (core 3.32.0): added the standard setup frontmatter and Upgrade Behavior section (preflight structural fix); no behaviour change.
