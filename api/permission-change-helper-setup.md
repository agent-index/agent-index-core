---
name: permission-change-helper-setup
type: setup
version: 1.1.0
collection: agent-index-core
description: Setup for the permission-change-helper skill
target: permission-change-helper
target_type: skill
upgrade_compatible: true
---

## Setup Overview

The Permission-Change Helper is plumbing called by other tasks (typically v3.1.0+ admin tasks like `invite-member`); it has no member-facing configuration of its own. Setup verifies that the helper's external dependency — the pre-built Go binary at `mcp-servers/permission-helper-go/agent-index-show-plan` — is present and executable.

(Pre-3.7.4 setup also checked for a Node-helper fallback at `mcp-servers/permission-helper/show-plan.sh`. The Node helper was removed in 3.7.4 — closes idea `remove-node-permission-helper-fallback` — so the setup check is now Go-binary-only.)

---

## Pre-Setup Checks

- The pre-built Go binary exists at `<project_dir>/mcp-servers/permission-helper-go/agent-index-show-plan{.exe}` → if not: "The permission helper Go binary isn't installed at the expected path. This usually means the agent-index-core install is incomplete or predates 3.4.0. Run '@ai:update' to install the binary, or '@ai:member-bootstrap' if the install appears broken."
- The binary is executable (`chmod +x` was applied on Unix-like systems; no-op on Windows) → if not, surface and instruct member to chmod or re-run install.
- The URL-scheme handler (`agent-index://`) is registered with the OS (the binary's `post_install_command` does this automatically when installed via `apply-updates` Phase 1 step 7) → if not registered, surface that the binary is installed but the URL handler isn't, and direct the member to re-run `@ai:update` or to manually invoke the binary's registration command.

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
