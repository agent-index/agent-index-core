---
name: apply-updates
type: task
version: 3.0.0
collection: agent-index-core
description: Reads pending update instructions from the org remote, merges them into a cohesive update plan, and executes all steps needed to bring the member's local agent-index installation current — including capability upgrades, new collection installs, CLAUDE.md sync, and adapter bundle updates.
stateful: true
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills:
    - org-setup
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle
    description: Reads update instructions and collection definitions from the remote filesystem via the on-demand executor (aifs-exec.bundle.js).
reads_from: "/shared/updates/"
writes_to: null
---

## About This Task

This is the member-facing half of the update system. When a member says `@ai:update`, this task reads the update log from the remote filesystem, determines what the member hasn't applied yet, merges overlapping instructions into one cohesive plan, and walks the member through applying everything needed to bring their local installation current.

The task handles the full spectrum of update types: infrastructure changes, collection upgrades and installs, CLAUDE.md refreshes, adapter bundle updates, and org config changes. For updates that require member input (like collection upgrades with reset parameters or new collection installs with setup interviews), the task pauses to gather that input before continuing.

Members can be in widely different states of un-updated. One member may be one publish behind; another may have missed six months of publishes. The merge algorithm handles both cases identically — it collapses all pending instructions into the net desired state and builds a single plan to get there.

### Inputs

None required. The task reads the member's update cursor from `member-index.json` and the update log from the remote filesystem to determine what is pending.

Optionally:
- `--dry-run` — show the merged update plan without applying anything
- `--skip-optional` — auto-decline optional items (new collection installs) and only apply required updates (upgrades to already-installed capabilities, CLAUDE.md, adapter)

### Outputs

- Local `member-index.json` — updated with new versions, new entries, and advanced update cursor
- Local installed capability files — upgraded or newly installed definitions, setup responses, manifests
- Local `CLAUDE.md` — replaced if updated
- Local `mcp-servers/filesystem/` — replaced if adapter bundle updated (requires session restart)
- Local `pending-update-plan.json` — written if the plan is interrupted (adapter restart or session end)

---

## Workflow

### Step 1: Check for Interrupted Update

Before anything else, check for a local `pending-update-plan.json` in `.agent-index/install-state/`. If it exists:

1. Read the file. It contains a partially completed update plan from a previous session that was interrupted (typically by an adapter bundle update requiring restart).
2. Surface to the member: "You have a pending update that was interrupted last session. Want to pick up where you left off?"
3. On confirmation: skip to Step 5 with the remaining operations from the pending plan. The merge has already been done — just execute what's left.
4. If the member declines: delete the pending plan file and proceed with Step 2 to compute a fresh plan from the update log. This handles the case where the admin has published new updates since the interruption — the fresh plan will incorporate everything.

If no pending plan exists: proceed to Step 2.

---

### Step 2: Read Update Log and Determine Pending Entries

Read the member's `member-index.json` from the local filesystem. Extract `last_applied_update`. This is the cursor — a string ID (e.g., `"004"`) representing the last update entry the member successfully applied. If `last_applied_update` is null or absent, the member has never applied an update.

Read `/shared/updates/update-log.json` from the remote filesystem via `aifs_read("/shared/updates/update-log.json")`.

If the file does not exist: surface "No update instructions have been published for your org yet. Your admin can publish updates by running '@ai:publish-updates'." Halt.

If the file exists: parse the `entries` array. Filter to entries whose `id` is greater than `last_applied_update` (using string comparison on zero-padded IDs, which preserves numeric ordering). If `last_applied_update` is null, all entries are pending.

If no entries are pending (the member's cursor matches or exceeds the latest entry): surface "You're up to date. No pending updates." Halt.

Collect all pending entries in chronological order (by `id`). Proceed to Step 3.

**On success:** Proceed to Step 3.

---

### Step 3: Merge Pending Entries into a Net Update Plan

The merge algorithm collapses all pending update entries into a single set of operations representing the net desired end state. Members should never replay intermediate states — they jump directly from their current state to the target state.

**Initialize an empty merged plan** with these target buckets:

- `core_update` — null or a single operation
- `marketplace_update` — null or a single operation
- `claude_md_update` — null or a single operation
- `adapter_bundle_update` — null or a single operation
- `collection_updates` — map of collection name → single operation
- `collection_installs` — map of collection name → single operation
- `collection_removes` — map of collection name → single operation
- `org_config_updates` — array of change descriptions (accumulated, not deduplicated — org config changes don't supersede each other cleanly)

**Walk each pending entry chronologically** and apply its operations to the merged plan:

For each operation in the entry:

**`core-update`:** Replace the existing `core_update` with this operation. If a previous `core-update` existed in the merged plan, the new one supersedes it (the latest `target_version` is the only one that matters). Set `from_version` to the member's currently installed core version (from local `agent-index.json`), not from the operation's `from_version` field.

**`marketplace-update`:** Same logic as `core-update` — latest supersedes.

**`collection-update`:** If the collection already has an entry in `collection_updates`, replace it — latest version wins. Always set `from_version` to the member's currently installed version of that collection (from `member-index.json` capability entries), not from the operation's `from_version`. If the collection also appears in `collection_installs` (it was newly installed in an earlier pending entry and then upgraded in a later one), merge: update the install operation's `version` to the latest and drop the update operation.

**`collection-install`:** Add to `collection_installs`. If a later entry has a `collection-remove` for the same collection, both cancel out — remove from both maps. If a later entry has a `collection-update` for the same collection, update the install's version to the latest.

**`collection-remove`:** Add to `collection_removes`. If the collection exists in `collection_installs` (installed and then removed within the pending window), both cancel out. If the collection exists in `collection_updates`, drop the update — a removal supersedes an upgrade.

**`claude-md-update`:** Replace the existing `claude_md_update`. Multiple CLAUDE.md changes collapse to a single "pull the current version" operation.

**`adapter-bundle-update`:** Replace the existing `adapter_bundle_update`. Latest version wins. Set `from_version` to the member's currently installed adapter version (from local `adapter.json`).

**`org-config-update`:** Append the `changes` array entries to `org_config_updates`. These are informational and don't need deduplication — the member benefits from seeing the full history of what changed.

**After processing all entries:** the merged plan represents the minimum set of operations to bring the member from their current state to the org's current desired state.

Record the `target_cursor` — the `id` of the last pending entry. This is what `last_applied_update` will be set to after successful completion.

**On success:** Proceed to Step 4.

---

### Step 4: Present the Update Plan

Present the merged plan to the member. Group operations by category with clear descriptions:

> **Updates Available**
> Published between {first pending entry date} and {last pending entry date}
> {admin summary from last entry, if present}
>
> **Required updates** (applied automatically):
> {core-update, if present}: agent-index-core will be updated from {from} to {target}
> {marketplace-update, if present}: agent-index-marketplace will be updated from {from} to {target}
> {claude-md-update, if present}: CLAUDE.md will be refreshed with current org directives
> {adapter-bundle-update, if present}: Adapter bundle will be updated from {from} to {target} (requires session restart)
> {collection-updates, for collections the member has capabilities installed from}: {collection} will be upgraded from {from} to {target} {if has_migration: "(may require your input during setup)"}
>
> **Optional — new collections available:**
> {collection-installs}: {collection display name} ({category}) — {description from collection.json}. You can choose to install capabilities from this collection.
>
> **Informational:**
> {collection-removes}: {collection} has been removed from the org. Your installed capabilities will continue to work but won't receive future updates.
> {org-config-updates}: Org configuration changes: {change descriptions}
>
> Proceed with updates?

If `--dry-run`: display the plan and halt.

If `--skip-optional`: note that optional items will be skipped.

On confirmation: proceed to Step 5.

---

### Step 5: Execute the Update Plan

Execute operations in dependency order. Each category is a phase — complete one phase before starting the next.

**Phase 0 — Prerequisite checks**

If the update plan includes a `core-update` with target version ≥ 3.1.0, run these prerequisite checks before any operations are applied. If a check fails, halt the update with a clear message — the member must resolve the prerequisite and re-run `@ai:update`.

**Prerequisite: all_members_group must be configured.**

The 3.1.0 release introduces native filesystem permissions, which depend on a Workspace-maintained Google Group whose membership is the authoritative agent-index member roster. Admin-published infrastructure files (CLAUDE.md, org-config.json, members-registry.json, bootstrap zip, marketplace cache) are shared with this address.

1. Read the local `org-config.json` and check `remote_filesystem.connection.all_members_group`.
2. If the field is present and non-empty: the prerequisite is satisfied. Continue to Phase 1.
3. If the field is missing or empty:
   - Surface to the admin:
     > **Prerequisite needed before applying agent-index-core 3.1.0:**
     >
     > 3.1.0 ships native filesystem permissions, which require a Workspace-level Google Group whose membership is the authoritative agent-index member roster. Admin-published files (CLAUDE.md, org-config, registry, bootstrap zip, marketplace cache) are shared with this group.
     >
     > Two things to confirm before continuing:
     > 1. Does a group exist at the Workspace level with all current agent-index members in it? (e.g., `agent-index-all@{your-domain}`.) If not, create it via Google Workspace Admin Console or your IT team. The group must be configured to allow members of your domain to view content shared with it.
     > 2. Once it exists, paste the full group address here and I'll write it to `org-config.json` and continue the upgrade.
     >
     > **Or, defer this upgrade.** Reply "later" and I'll exit cleanly. Re-run `@ai:update` once the group is in place.
   - If the admin replies with an email address: validate that it is a syntactically valid email (contains `@` and a `.` after the `@`). Write the address to `org-config.json` at `remote_filesystem.connection.all_members_group`. Confirm: "Saved `{group_address}` to org-config.json. Continuing the upgrade." Proceed to Phase 1.
   - If the admin replies "later" / "skip" / "defer": surface "Upgrade deferred. Your install remains at v{current}. Re-run `@ai:update` once the all-members group is configured." Exit cleanly without writing anything to local state.
   - If the admin asks how to create the group: provide instructions — admin.google.com → Apps → Google Workspace → Groups for Business → create a new group with the address `agent-index-all@{your-domain}`, set "Who can view conversations" and "Who can view members" to "Members of organization", add all agent-index members. Then return to the prompt.

This prerequisite check is gated on target version ≥ 3.1.0. Updates that do not include a `core-update` to 3.1.0+ skip this phase entirely.

**Phase 1 — Infrastructure updates**

If `core-update` is present:
1. Read the updated `agent-index-core/collection.json` from the remote filesystem via `aifs_read`
2. Read each updated core API member from remote via `aifs_read("/{collection}/api/{name}.md")`
3. Overwrite the local core files with the updated versions
4. Update the local `agent-index.json` version field
5. **Clean up deprecated v2 artifacts:** If `agent-index-core/tools/aifs-bridge/` exists locally, delete the entire directory (it contains `aifs-bridge.mjs` and `aifs-call.sh` which reference the removed `server.bundle.js`). Also delete `mcp-servers/filesystem/server.bundle.js` if present. These are pre-v3 artifacts that cause errors if Claude discovers and tries to use them.
6. **Merge triggers into routing.json.** After updating core files, check the updated `agent-index-core/collection.json` for trigger arrays. If present and `routing.json` exists (or was created by a previous phase in this update), merge new triggers using the same logic as Phase 4 step 4. Core capabilities (org-setup, preferences-management, system-tutorial, apply-updates, author-collection, validate-collection) have triggers that should appear in routing.json alongside member-installed collection triggers.
7. Surface: "agent-index-core updated to {target_version}."

If `marketplace-update` is present:
1. Same pattern — read updated marketplace files from remote, overwrite local
2. **Merge triggers into routing.json.** Same as core-update step 6 — check the updated `agent-index-marketplace/collection.json` for trigger arrays and merge into routing.json if present.
3. Surface: "agent-index-marketplace updated to {target_version}."

**Phase 2 — CLAUDE.md**

If `claude-md-update` is present:
1. Read `CLAUDE.md` from the remote filesystem via `aifs_read("/CLAUDE.md")`
2. Overwrite the local `CLAUDE.md` with the remote version
3. Surface: "CLAUDE.md updated with current org directives."

**Phase 3 — Adapter bundle**

If `adapter-bundle-update` is present:
1. Read `/shared/bootstrap/member-bootstrap.zip` from the remote filesystem (or the adapter bundle files directly if the admin has published them to a known location)
2. Extract and overwrite `mcp-servers/filesystem/aifs-exec.bundle.js` and `aifs-exec.sh` and `adapter.json`
3. Write a pending plan file at `.agent-index/install-state/pending-update-plan.json` containing the remaining operations (collection upgrades, installs, etc.) and the `target_cursor`
4. Surface: "Adapter bundle updated to {target_version}. The new executor bundle is ready to use immediately. Say '@ai:update' and I'll continue with the remaining updates."
5. Continue to Phase 4 in this session.

**Phase 4 — Collection upgrades (already-installed collections)**

For each `collection-update` where the member has capabilities installed from that collection (check `member-index.json`):

1. Determine the member's current installed version and the target version
2. Determine the upgrade path — check for upgrade scripts on the remote filesystem:
   - For same-MAJOR upgrades (e.g., 2.0.0 → 2.3.0): no upgrade script needed, carry responses forward
   - For cross-MAJOR upgrades (e.g., 2.0.0 → 3.0.0): read upgrade script via `aifs_read("/{collection}/upgrade/{from_major}-to-{target_major}.md")`
   - For multi-MAJOR jumps (e.g., 1.0.0 → 3.0.0): chain upgrade scripts — read 1-to-2, then 2-to-3. Apply in sequence.
3. For each of the member's installed capabilities from this collection:
   - Delegate to the org-setup skill's upgrade flow (Phase 4 steps 1–9 of org-setup's "Upgrading an Installed Capability" section)
   - This handles: reading the new definition from remote, reading the existing setup responses, running the upgrade script's migration, presenting reset parameters to the member for input, writing updated files, updating `member-index.json`
4. **Merge new triggers into routing.json.** After upgrading all capabilities from a collection, read the updated `collection.json` from remote and check whether it contains trigger arrays (object-format `api` entries with a `triggers` field). If it does:
   - Read the member's existing `routing.json` from `members/{member_hash}/profile/routing.json`. If it does not exist, initialize it with an empty `mappings` array (version `"1.0.0"`, member_hash, timestamp).
   - For each trigger in the updated collection: check if a mapping with the same `phrase` already exists in `routing.json`. If not, add it with `source: "collection-default"`, `active: true`. If a mapping with the same phrase exists from a different collection, present the collision to the member and let them choose. If a mapping with the same phrase exists from the same collection, leave the existing one (it may have been customized).
   - Write the updated `routing.json`.
   - Surface: "Natural language triggers updated for {collection}."
   
   If the updated collection has no trigger arrays: skip this sub-step.
5. Surface: "{collection} capabilities upgraded to {target_version}."

If a capability's upgrade requires member input (reset parameters or new required parameters): pause, gather input, then continue. The member is not asked about preserved parameters — those carry forward silently.

**Phase 5 — Natural language routing initialization**

If the update plan includes a `core-update` with target version ≥ 3.0.5, and the member's `routing.json` file does not yet exist at `members/{member_hash}/profile/routing.json`:

1. Build the list of collections to scan for triggers. Start with `agent-index-core` and `agent-index-marketplace` (these are infrastructure collections whose triggers are always relevant but are not listed in `member-index.json`). Then add every unique collection name from the member's `member-index.json` installed capabilities. For each collection in this combined list, read the collection's `collection.json` from the remote filesystem via `aifs_read("/{collection}/collection.json")`.
2. Extract trigger entries from each collection's `api` array — entries using the object format with a `triggers` array.
3. Build the initial `routing.json`:
   ```json
   {
     "version": "1.0.0",
     "member_hash": "{member_hash}",
     "last_updated": "{ISO timestamp}",
     "mappings": [
       {
         "phrase": "{trigger phrase}",
         "capability": "{capability name}",
         "collection": "{collection name}",
         "description": "{trigger description}",
         "source": "collection-default",
         "active": true
       }
     ]
   }
   ```
4. Check for cross-collection phrase collisions (two collections claiming the same phrase). If any exist, present the collision to the member and let them choose which collection handles it. Mark the unchosen mapping as `active: false`.
5. Present the complete routing table to the member:
   > "Natural language routing has been set up for your installed collections. Here are the phrases that will route to your capabilities:"
   Show the table organized by collection. Note that the member can customize these anytime via `@ai:preferences` (or "edit my routing").
6. Write `routing.json` to `members/{member_hash}/profile/routing.json`.

If zero triggers are found across all installed collections (all collections are still on pre-trigger versions): **do not write routing.json**. Skip this phase silently. The file's absence signals that routing initialization has not yet completed — Phase 4's trigger merge sub-step will create the file when collections are upgraded to trigger-supporting versions in a future update. This handles the case where the admin upgrades core to 3.0.5 before upgrading the collections.

If `routing.json` already exists (member has already been through this process, or Phase 4's trigger merge created it during collection upgrades earlier in this same update): skip this phase entirely. Existing routing customizations are never overwritten by apply-updates.

If the core-update target version is < 3.0.5: skip this phase — routing.json is a 3.0.5+ feature.

**Phase 6 — New collection installs (optional)**

For each `collection-install` (unless `--skip-optional`):

1. Present the collection to the member: "{display_name} ({category}) is newly available in your org. {description}. Would you like to install capabilities from it?"
2. If the member declines: skip. Record the decision — the member won't be asked again for this specific collection-install entry (tracked by noting the entry ID in the cursor advancement).
3. If the member accepts: delegate to the org-setup skill's install flow:
   - Present available capabilities from the collection
   - Let the member select which to install
   - Run the setup interview for each selected capability
   - Write to `member-index.json`
4. After installation (or skip): surface result and continue.

**Phase 7 — Collection removals (informational)**

For each `collection-remove`:

1. Check whether the member has capabilities installed from this collection
2. If yes: surface "{collection} has been removed from your org. Your installed capabilities ({list}) will continue to work with their current versions, but they won't receive future updates. You can keep using them or say '@ai:setup' to remove them."
3. If no: skip silently — the member never had anything from this collection.

**Phase 8 — Org config changes (informational)**

If `org_config_updates` is non-empty: surface a brief summary of what changed:
> "Your org's configuration has been updated: {change descriptions}."
> {If role changes affect the member's current role}: "Your role ({role name}) has updated default collections. Say '@ai:setup' to review what's newly available."

---

### Step 6: Advance the Cursor and Confirm

After all phases complete (or after the member has declined all optional items):

1. Update `member-index.json` with `"last_applied_update": "{target_cursor}"` — the ID of the last entry in the pending batch
2. Delete `pending-update-plan.json` if it exists (cleanup from a previous interrupted run)
3. Surface the completion summary:

> "Updates applied successfully.
> {Summary of what was done: N capabilities upgraded, N new capabilities installed, CLAUDE.md refreshed, etc.}
> {Any items skipped or deferred}
> You're now current through update #{target_cursor} (published {date})."

---

## Directives

### Remote Filesystem Access

All `aifs_*` operations are invoked via the on-demand executor shell wrapper: `bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh <tool_name> '<json_args>'`. Each call runs a fresh Node process, executes one operation, and exits. There is no persistent server or bridge. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and suggest '@ai:member-bootstrap'. In Cowork, `<project_dir>` resolves to the mounted workspace directory containing `agent-index.json`.

### Behavior

This task is the member's primary update mechanism. It should feel reliable and predictable. Members should trust that running `@ai:update` will bring them current without breaking anything.

Present the plan clearly before executing. Members should always know what is about to change before it changes. The plan presentation in Step 4 is not optional.

For collection upgrades that require member input: explain what changed and why input is needed. Reference the upgrade script's migration notes when available. Don't just dump parameter questions without context.

For new collection installs: present them as opportunities, not obligations. The member decides whether to install. Use the collection's description and category to help them decide — don't oversell.

Keep progress visible throughout. For multi-capability upgrades, announce each one as it's processed so the member has a sense of progress.

### Delegation to org-setup

This task delegates capability-level operations (upgrades and installs) to the org-setup skill's existing flows. It does not re-implement setup interviews, upgrade script processing, alias collision handling, or dependency resolution. Those are org-setup's domain.

The division of responsibility:
- `apply-updates` owns: reading the update log, merging entries, building the plan, orchestrating the execution order, managing the cursor, handling adapter and CLAUDE.md updates
- `org-setup` owns: capability installation, setup interviews, upgrade scripts, dependency trees, alias collisions, manifest and setup-responses writes

When delegating to org-setup, pass the necessary context: which collection, which capabilities, the target version, and whether this is an upgrade or a fresh install. Org-setup handles the rest.

### Merge Correctness

The merge algorithm in Step 3 must produce a correct net plan regardless of how many entries are pending or how they overlap. The key invariants:

- For any given target (collection, infrastructure component, CLAUDE.md, adapter), only one operation should exist in the merged plan
- The `from_version` in merged operations must reflect the member's *actual current state*, not the operation's original `from_version` (which reflected the org state at the time of that publish)
- Install-then-remove cancels out. Install-then-update becomes install-at-latest. Update-then-remove becomes remove.
- The cursor advances to the last entry ID regardless of which individual operations were applied, skipped, or declined — the cursor tracks what was *processed*, not what was *accepted*

### Constraints

Never modify any file on the remote filesystem. This task reads from remote — it writes only to the member's local workspace.

Never skip the plan presentation (Step 4) unless resuming from a pending plan (Step 1), where the plan was already presented in the previous session.

Never advance the cursor without completing or explicitly declining all operations in the plan. If the task is interrupted (adapter restart, session end), write the pending plan file with the remaining operations — the cursor stays at its pre-update value until everything is processed.

Never force-install a new collection. Collection installs from `collection-install` operations are always optional. The member chooses whether to install capabilities from newly available collections.

Never modify `org-config.json`, `members-registry.json`, or any remote file. The only remote reads are the update log and collection definitions.

### Edge Cases

If the update log exists but is empty (no entries): surface "No update instructions have been published yet." Halt.

If the member's `last_applied_update` points to an entry ID that doesn't exist in the log (log was truncated or rebuilt): treat the cursor as stale. Surface: "Your update history doesn't match the org's update log. I'll check all available updates and build a plan based on your current installed state." Process all entries in the log, using the member's actual installed versions (from `member-index.json`) as the `from_version` for all operations.

If a collection-update references a collection the member has no capabilities from: skip it silently. The upgrade only matters for members who have installed capabilities from that collection.

If a collection-install references a collection the member has already independently installed capabilities from (they ran `@ai:setup` manually between publishes): skip the install and note: "{collection} capabilities are already installed. Checking if they're current..." Then treat it as a collection-update if the versions differ.

If the adapter bundle update file cannot be downloaded from the bootstrap zip location: surface the error and skip the adapter update. Continue with remaining operations. The adapter update is important but not blocking — the member can update it manually later via `@ai:member-bootstrap`.

If a single capability upgrade fails (setup-responses migration error, missing upgrade script): log the failure, skip that capability, continue with the rest. Surface a summary of failures at the end with remediation: "1 capability could not be upgraded: {name}. Say '@ai:setup' to attempt a manual upgrade."

If the member has capabilities from a collection that was both updated and then removed within the pending window: the merge collapses this to a `collection-remove`. Do not upgrade capabilities from a collection that is being removed — just surface the removal notice.

### State File Format

The pending update plan file at `.agent-index/install-state/pending-update-plan.json`:

```json
{
  "status": "interrupted",
  "interrupted_at": "{ISO timestamp}",
  "target_cursor": "{entry ID}",
  "completed_phases": ["infrastructure", "claude-md", "adapter-bundle", "routing-init"],
  "remaining_operations": {
    "collection_updates": { ... },
    "collection_installs": { ... },
    "collection_removes": { ... },
    "org_config_updates": [ ... ]
  }
}
```

This file is written when the task is interrupted (typically by an adapter bundle restart) and read on the next invocation to resume from where it left off. It is deleted after successful completion.

