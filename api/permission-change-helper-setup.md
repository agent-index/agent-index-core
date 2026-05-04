---
name: permission-change-helper-setup
type: setup
version: 1.0.0
collection: agent-index-core
description: Setup for the permission-change-helper skill
target: permission-change-helper
target_type: skill
upgrade_compatible: true
---

## Setup Overview

The Permission-Change Helper is plumbing called by other tasks (typically v3.1.0+ admin tasks like `invite-member`); it has no member-facing configuration of its own. Setup verifies that the helper's external dependency — the pre-built binary at `mcp-servers/permission-helper/show-plan.sh` — is present and executable.

---

## Pre-Setup Checks

- The pre-built binary exists at `<project_dir>/mcp-servers/permission-helper/show-plan.sh` → if not: "The permission helper binary isn't installed at the expected path. This usually means the agent-index-core install is incomplete. Run '@ai:update' to install or repair core, or '@ai:member-bootstrap' if the install appears broken."
- The binary is executable (`chmod +x` was applied) → if not, surface and instruct member to chmod or re-run install.
- Node.js is available on PATH (the binary is a Node script invoked through a shell wrapper that resolves Node) → if not: surface a setup error pointing at the project's Node requirement.

---

## Parameters

No member-configurable parameters. The skill's behavior is entirely driven by the spec the calling task hands it.

---

## Setup Completion

On successful setup:
- Write `setup-responses.md` with empty parameters block (for consistency with other skills' setup outputs).
- Write `manifest.json` to the member's installed instance.

---

## Upgrade Behavior

### Preserved Responses

None — there are no parameters to preserve.

### Reset on Upgrade

None.

### Requires Member Attention

If a future helper version changes the spec format incompatibly, the upgrade flow surfaces a notice: "The permission helper's spec format has changed in v{N.M.O}. Calling tasks may need to be updated to use the new shape. Run preflight on any task workflow that calls this skill to confirm compatibility."

### Migration Notes

The skill itself has no state to migrate. Upgrade is a definition-replacement.
