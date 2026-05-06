---
name: edit-org
type: task
version: 3.0.1
collection: agent-index-core
description: Edit org configuration — update the admin list or launch the marketplace to install or manage collections.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle
    description: Reads and writes org-config.json and members-registry.json on the remote filesystem via the on-demand executor (aifs-exec.bundle.js).
reads_from: null
writes_to: null
---

## About This Task

Edit-org is the ongoing management interface for org-level configuration. It handles three things: managing the org admin list, managing org roles, and launching the marketplace flow to install or manage collections.

After making org-level changes through this task (or through the marketplace), admins should run `@ai:publish-updates` to generate update instructions that members can apply via `@ai:update`. Without publishing, members will see version-mismatch notices but won't have a prescribed resolution path.

Only org admins can run this task effectively — non-admins can invoke it but will be informed they lack the authority to make changes.

### Inputs

The org admin describes what they want to change, or invokes the marketplace flow.

### Outputs

- `org-config.json` — updated in place if admin list changes

---

## Workflow

### Step 1: Read Org Configuration and Verify Admin

Read `org-config.json` from the remote filesystem via `aifs_read("/org-config.json")`.

If `org-config.json` does not exist or cannot be read (authentication failure, connectivity issue): check `aifs_auth_status()`. If `authenticated: false`, attempt automatic re-authentication via `aifs_authenticate` and retry the read. If re-auth succeeds and the file exists, proceed normally. If the file does not exist: surface "Your org configuration couldn't be loaded. This could mean the org hasn't been configured yet — say '@ai:create-org' to get started." Halt. If re-auth fails: surface "Your org configuration couldn't be loaded and I wasn't able to restore your remote connection. Try '@ai:member-bootstrap' to troubleshoot." Halt.

Compute the current member's hash: SHA256(lowercase email from session context), take the first 16 hex characters. Check whether this hash matches any entry in `admins[].member_hash` in org-config.json.

If not an admin: surface "Only org admins can edit org configuration. The current admins are: {admin list}. Contact one of them if you need changes made." Halt.

**On success:** Proceed to Step 2.

---

### Step 2: Determine What to Edit

If the member specified what they want in their invocation: proceed directly to the relevant step.

If the member invoked generally: present the management options:

> **Org Configuration — {org_name}**
> Org ID: {org_id}
> Admins: {admin display names}
> Org roles: {role count, or "none defined"}
> Installed collections: {count} — say 'open marketplace' to manage
>
> What would you like to do?
> 1. Add or remove an org admin
> 2. Add, edit, or remove org roles
> 3. Update adapter bundle and regenerate bootstrap zip
> 4. Open the marketplace
> 5. Publish updates for members

---

### Step 3: Admin List Management

**Adding an admin:**
Ask for the new admin's display name and email address. Compute their member_hash: SHA256(lowercase email), first 16 hex characters. Confirm: "Add {display_name} ({email}) as an org admin?"

On confirmation:
- Add to `org-config.json` admins array with: `member_hash`, `display_name`, `email`, `granted_by` (current admin's hash), and `granted_date` (today YYYY-MM-DD).
- Add or update `members-registry.json` on the remote filesystem via `aifs_read("/members-registry.json")` (read), modify, then `aifs_write("/members-registry.json", ...)` (write back) if the new admin is not already present.
- Write updated `org-config.json` back to remote via `aifs_write("/org-config.json", ...)` with `last_updated` set to today.

**Removing an admin:**
Present the current admin list by display name. Ask who to remove.

If removing self: warn "You're removing yourself as an org admin. You won't be able to make org-level changes after this. Are you sure?" Require explicit confirmation.

If this would leave zero admins: block the removal. "At least one org admin must remain. Add another admin before removing the last one."

On confirmation: write updated `org-config.json` to remote via `aifs_write("/org-config.json", ...)` with the admin removed and `last_updated` set to today.

---

### Step 4: Org Roles Management

**Viewing roles:**
Present the current `org_roles` list with `display_name`, `description`, and `default_collections` for each.

**Adding a role:**

1. Ask for role display name and brief description.
2. Generate `role_id`: convert display name to lowercase, replace spaces with hyphens, collapse consecutive hyphens.
3. Check for ID collision with existing roles. If collision: inform the admin and ask for a different display name.
4. Present the list of installed collections (excluding agent-index-core and agent-index-marketplace). Ask which should be defaults for this role (multiple selection).
5. Confirm: "Create role '{display_name}' with default collections: {list}?"
6. On confirmation: write to `org_roles` array in org-config.json:
```json
{
  "role_id": "{role-id}",
  "display_name": "{display name}",
  "description": "{description}",
  "default_collections": ["{collection-name}", ...],
  "created_date": "{today YYYY-MM-DD}",
  "created_by": "{current_admin_hash}"
}
```
7. Write updated `org-config.json` to remote via `aifs_write("/org-config.json", ...)` with `last_updated` set to today.

**Editing a role:**

1. Present existing roles for selection.
2. Allow changing: `display_name`, `description`, and `default_collections`.
3. Note: `role_id` cannot be changed (would require migration).
4. Confirm changes before writing.
5. Write updated `org-config.json` to remote via `aifs_write("/org-config.json", ...)` with `last_updated` set to today.

**Removing a role:**

1. Present existing roles for selection.
2. Warn: "Removing this role won't affect members who already have it assigned — their installed capabilities remain. But new members won't see this role as an option during setup."
3. Require explicit confirmation.
4. Remove from `org_roles` array in org-config.json.
5. Write updated `org-config.json` to remote via `aifs_write("/org-config.json", ...)` with `last_updated` set to today.

---

### Step 5: Update Adapter Bundle and Regenerate Bootstrap Zip

This step downloads the latest adapter bundle and regenerates the member bootstrap zip so new and existing members receive the updated executor bundle.

**1. Check current adapter version:**

Read the local `mcp-servers/filesystem/adapter.json`. Note the current `version` and `bundle_built_at`.

**2. Download the latest adapter bundle:**

Read `filesystem-adapter-directory.json` (fetch from `filesystem_adapter_directory_url` in `agent-index.json` if not cached). Find the entry matching the org's configured backend (`remote_filesystem.backend` in `agent-index.json`). Download the adapter repo via its `zip_url`. Extract `dist/aifs-exec.bundle.js`, `dist/aifs-exec.sh`, and `adapter.json` from the downloaded zip.

Verify bundle integrity: compute SHA-256 of `aifs-exec.bundle.js` and compare against `exec_bundle_checksum` in the downloaded `adapter.json`. If mismatch, report the error and halt.

Compare the downloaded `adapter.json` version against the local version. If the downloaded version is not newer: surface "Your adapter bundle is already up to date (version {version}, built {bundle_built_at})." and offer to regenerate the bootstrap zip anyway (the admin may want to regenerate for other reasons, e.g. updated CLAUDE.md or settings).

**3. Replace the local bundle:**

Overwrite `mcp-servers/filesystem/aifs-exec.bundle.js`, `mcp-servers/filesystem/aifs-exec.sh`, and `mcp-servers/filesystem/adapter.json` with the downloaded files.

Surface: "Adapter bundle updated from version {old_version} (built {old_date}) to version {new_version} (built {new_date})."

**4. Halt for session restart:**

The new executor bundle is ready to use immediately in this session.

Surface:

> "The adapter bundle has been updated locally and is ready to use immediately. I'll now regenerate and redistribute the bootstrap zip."

Proceed immediately to regenerate the bootstrap zip.

**5. Regenerate and redistribute bootstrap zip:**

Follow the shared subroutine at `agent-index-core/templates/regenerate-bootstrap.md`. Pass these parameters:

- `<project_dir>`: the agent-index install directory (the directory containing `agent-index.json` at root).
- `<source-trigger>`: `"adapter bundle updated to <new_version>"` (or, if the regen was forced without an actual bundle change, `"admin-requested regen"`).
- `<allow-skip>`: `false` (always regenerate when triggered from edit-org — admins are running this deliberately).

The subroutine handles assembling zip contents, LF normalization (closes bug `20260504-8d20ea22-7`), zip creation, upload, the all-members re-share, and updating `published-state.json`.

After the subroutine completes, surface the member distribution instructions:

> "The bootstrap zip has been regenerated with the updated adapter bundle and uploaded to your remote filesystem."
>
> **For existing members:** They need to download the new bootstrap zip and replace their local `mcp-servers/filesystem/` directory with the updated files. Send them:
>
> "An updated filesystem adapter is available. Download the latest bootstrap zip from {download location} and replace the files in `mcp-servers/filesystem/` in your `~/agent-index/` directory (`aifs-exec.bundle.js`, `aifs-exec.sh`, and `adapter.json`)."
>
> **For new members:** The bootstrap zip at the download location is already updated — no action needed.

---

### Step 6: Marketplace Launch

If the member chooses to open the marketplace: invoke `run agent-index-marketplace task list-marketplace-collections`. The marketplace flow takes over.

---

### Step 7: Publish Updates for Members

If the member chooses to publish updates: invoke `run agent-index-core task publish-updates`. The publish-updates task takes over — it will diff the current org state against the last published state, present the draft, and publish update instructions for members.

After the marketplace flow completes (if the admin installed or upgraded collections), suggest: "Would you like to publish these changes so members can apply them? Say '@ai:publish-updates' or choose option 5."

---

## Directives

### Remote Filesystem Access

All `aifs_*` operations are invoked via the on-demand executor shell wrapper: `bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh <tool_name> '<json_args>'`. Each call runs a fresh Node process, executes one operation, and exits. There is no persistent server or bridge. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and suggest '@ai:member-bootstrap'. In Cowork, `<project_dir>` resolves to the mounted workspace directory containing `agent-index.json`.

### Behavior

Keep this task efficient. Org admins using it know what they want. Present the current state clearly and act on the request.

Admin list changes are consequential — always confirm before writing. Removing the last admin is blocked at the constraint level, not just warned about.

Org role changes are informational for existing members — they only affect the onboarding experience for new members. Surface this clearly when adding or removing roles.

### Constraints

Never allow the admin list to be emptied. Minimum one admin at all times.

Never allow `org_name`, `org_id`, or remote filesystem configuration to be changed through this task. Those are set at create-org time. Changes to those fields would require a migration process beyond the scope of this task.

Only org admins may execute changes. The ad