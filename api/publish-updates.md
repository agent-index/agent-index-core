---
name: publish-updates
type: task
version: 2.0.0
collection: agent-index-core
description: Generates update instructions from the current org state and publishes them to the remote filesystem so members can apply updates via '@ai:update'.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem MCP server
    description: Reads org state and writes update log entries to the remote filesystem via the agent-index-filesystem MCP server (aifs_* tools).
reads_from: null
writes_to: "/shared/updates/"
---

## About This Task

After an admin installs collections, upgrades infrastructure, updates CLAUDE.md, refreshes the adapter bundle, or makes any other org-level change, this task captures what changed and publishes structured update instructions to the remote filesystem. Members then consume these instructions by saying `@ai:update`.

This task bridges the gap between admin-side changes and member-side awareness. Without it, members have no way to know what changed or what actions to take — they only see version-mismatch notices with no prescribed resolution path.

The task is designed to be run explicitly by an admin after completing a batch of org changes. It is not triggered automatically. The admin decides when their changes are ready for members to consume.

### Inputs

None required. The task infers what changed by comparing the current org state against the last published snapshot.

Optionally, the admin can provide:
- A summary annotation — a human-readable note about what these updates are for (e.g., "Q2 collection rollout" or "Security patch for adapter bundle")
- `--dry-run` — show what would be published without writing anything

### Outputs

- `/shared/updates/update-log.json` — appended with a new entry (created if it doesn't exist)
- `/shared/updates/published-state.json` — overwritten with the current org state snapshot

---

## Workflow

### Step 1: Verify Admin and Read Current Org State

Read `org-config.json` from the remote filesystem via `aifs_read("/org-config.json")`.

Compute the current member's hash: SHA256(lowercase email from session context), first 16 hex characters. Check whether this hash matches any entry in `admins[].member_hash` in org-config.json.

If not an admin: surface "Only org admins can publish updates. The current admins are: {admin list}. Contact one of them if updates need to be published." Halt.

Read and assemble the current org state — this is the "truth" that members should converge to:

1. **Infrastructure versions:** Read `agent-index-core/collection.json` and `agent-index-marketplace/collection.json` from the remote filesystem via `aifs_read`. Extract `version` from each.

2. **Installed collections:** Read `installed_collections` from `org-config.json`. For each, also read the collection's `collection.json` from the remote filesystem via `aifs_read("/{collection}/collection.json")` to get the current `version` and `api` array.

3. **CLAUDE.md hash:** Read `CLAUDE.md` from the local project directory. Compute SHA-256 hash of its content. This is used to detect changes without storing the full file.

4. **Adapter bundle version:** Read the local `mcp-servers/filesystem/adapter.json`. Extract `version` and `bundle_built_at`.

5. **Org config metadata:** Record `org_roles` array (role IDs and their `default_collections`) and `last_updated` timestamp from org-config.

Assemble this into a structured state object:

```json
{
  "snapshot_date": "{ISO timestamp}",
  "infrastructure": {
    "agent-index-core": "{version}",
    "agent-index-marketplace": "{version}"
  },
  "installed_collections": [
    {
      "name": "{collection-name}",
      "version": "{version}",
      "api_members": ["{skill-or-task-name}", ...]
    }
  ],
  "claude_md_hash": "{SHA-256 hex}",
  "adapter_bundle": {
    "version": "{version}",
    "bundle_built_at": "{ISO timestamp}"
  },
  "org_roles": [
    {
      "role_id": "{role-id}",
      "default_collections": ["{collection-name}", ...]
    }
  ]
}
```

**On success:** Proceed to Step 2.

---

### Step 2: Read Last Published State

Read `/shared/updates/published-state.json` from the remote filesystem via `aifs_read("/shared/updates/published-state.json")`.

If the file does not exist (first time publishing): treat every element of the current state as new. All installed collections will generate `collection-install` operations. Infrastructure versions, CLAUDE.md, and the adapter bundle will all be included. Proceed to Step 3 with `previous_state = null`.

If the file exists: parse it. This is the state snapshot from the last time `publish-updates` was run. Proceed to Step 3 with `previous_state` populated.

**On success:** Proceed to Step 3.

---

### Step 3: Compute the Diff

Compare the current state (from Step 1) against `previous_state` (from Step 2) to determine what changed. Generate a list of operations.

**Infrastructure changes:**

For each infrastructure component (`agent-index-core`, `agent-index-marketplace`):
- If current version > previous version: generate a `core-update` or `marketplace-update` operation with `from_version` and `target_version`
- If versions are equal: no operation

**Collection changes:**

For each collection in the current `installed_collections`:
- If the collection exists in previous state and the version increased: generate a `collection-update` operation with `collection`, `from_version`, `target_version`, and `has_migration` (true if the MAJOR version changed — check whether `aifs_exists("/{collection}/upgrade/{from_major}.x-to-{target_major}.x")` or equivalent upgrade scripts exist)
- If the collection exists in previous state and the API member list changed (new members added, members removed): note the changes in the operation's `api_changes` field
- If the collection does not exist in previous state: generate a `collection-install` operation with `collection`, `version`, and `category` (from the collection's `collection.json`)
- If a collection existed in previous state but is absent from current state: generate a `collection-remove` operation with `collection` and `last_version`

**CLAUDE.md changes:**

- If `claude_md_hash` differs from previous state (or previous state is null): generate a `claude-md-update` operation

**Adapter bundle changes:**

- If `adapter_bundle.version` differs from previous state (or previous state is null): generate an `adapter-bundle-update` operation with `from_version` and `target_version`

**Org config changes:**

Compare `org_roles` arrays. If roles were added, removed, or had their `default_collections` modified: generate an `org-config-update` operation with a `changes` summary listing what shifted.

If no operations were generated (nothing changed since last publish): surface "Nothing has changed since the last publish on {previous snapshot_date}. No update instructions to generate." Halt.

**On success:** Proceed to Step 4.

---

### Step 4: Present Draft and Confirm

Present the computed operations to the admin:

> **Update Instructions Draft**
>
> The following changes will be published for members to apply:
>
> {For each operation, a one-line summary:}
> - **agent-index-core** updated from 2.0.0 to 2.1.0
> - **projects** collection updated from 2.0.0 to 3.0.0 (major — migration required)
> - **email-triage** collection newly installed (v1.0.0)
> - **CLAUDE.md** updated
> - **Adapter bundle** updated from 1.0.0 to 1.1.0
> - **Org roles** changed: added "sales-rep" role
>
> {If `--dry-run`}: "This is a dry run — nothing will be written."
> {Otherwise}: "Ready to publish? Members will see these updates next time they run '@ai:update'."

If `--dry-run`: display the draft and halt. No writes.

Ask the admin if they want to add a summary annotation (a brief human-readable note about the purpose of this update batch). This is optional — if skipped, the `summary` field will be auto-generated from the operations list.

On confirmation: proceed to Step 5.

---

### Step 5: Write Update Log Entry and State Snapshot

**Read or initialize the update log:**

Read `/shared/updates/update-log.json` from the remote filesystem via `aifs_read("/shared/updates/update-log.json")`.

If the file does not exist: initialize it as:

```json
{
  "version": "1.0.0",
  "entries": []
}
```

**Determine the next entry ID:**

If the entries array is empty: the next ID is `"001"`.
Otherwise: take the last entry's `id`, parse as integer, increment by 1, zero-pad to 3 digits. If the log has grown past 999 entries, use 4-digit zero-padding (this is unlikely but handle it).

**Assemble the entry:**

```json
{
  "id": "{next_id}",
  "published": "{ISO timestamp}",
  "published_by": "{admin member_hash}",
  "summary": "{admin-provided annotation or auto-generated summary}",
  "operations": [
    {
      "type": "core-update",
      "target_version": "2.1.0",
      "from_version": "2.0.0"
    },
    {
      "type": "collection-update",
      "collection": "projects",
      "target_version": "3.0.0",
      "from_version": "2.0.0",
      "has_migration": true,
      "api_changes": {
        "added": ["project-pulse"],
        "removed": []
      }
    },
    {
      "type": "collection-install",
      "collection": "email-triage",
      "version": "1.0.0",
      "category": "communication"
    },
    {
      "type": "collection-remove",
      "collection": "legacy-reports",
      "last_version": "1.2.0"
    },
    {
      "type": "claude-md-update",
      "hash": "{new SHA-256 hash}"
    },
    {
      "type": "adapter-bundle-update",
      "target_version": "1.1.0",
      "from_version": "1.0.0"
    },
    {
      "type": "org-config-update",
      "changes": ["added role 'sales-rep'", "updated 'engineer' default_collections"]
    }
  ]
}
```

Only include the operation types that were actually generated in Step 3. The example above shows all possible types for reference.

**Write the update log:**

Append the new entry to `entries` array. Write the full `update-log.json` back via `aifs_write("/shared/updates/update-log.json", ...)`.

**Write the state snapshot:**

Write the current state object (assembled in Step 1) to `/shared/updates/published-state.json` via `aifs_write("/shared/updates/published-state.json", ...)`. This becomes the baseline for the next `publish-updates` run.

**Write the latest ID file:**

Write a lightweight pointer file at `/shared/updates/latest.json` via `aifs_write`:

```json
{
  "latest_id": "{next_id}",
  "published": "{ISO timestamp}"
}
```

This file exists so that lightweight checks (session-start) can read a single small file to determine whether updates are pending, rather than reading the full update log.

**On success:** Surface confirmation:

> "Update instructions published (entry #{id}). Members will see these on their next session start and can apply them with '@ai:update'."
>
> **What members will experience:**
> - On next session start: a notice that updates are available
> - When they run '@ai:update': a guided update process that applies all pending changes
> {If adapter-bundle-update was included}: "Note: the adapter bundle update will require members to download the new bootstrap zip and restart their session. Consider sending them a heads-up."
> {If a MAJOR collection update was included}: "Note: the {collection} update is a major version change. Members may need to provide input during the upgrade for reset parameters."

---

## Directives

### MCP Tool Usage

This task uses `aifs_*` MCP tools on the `agent-index-filesystem` server for remote filesystem access. These are MCP tool calls — invoke them through the MCP tool interface when available. If `aifs_*` tools are not found in the tool list, the MCP server did not start. In Cowork, first attempt recovery using the aifs-bridge fallback: check `curl -s --max-time 2 http://127.0.0.1:7819/health` and if not running, start it with `bash agent-index-core/tools/aifs-bridge/aifs-call.sh --start`. If the bridge starts, use it for all `aifs_*` calls via `curl -s -X POST http://127.0.0.1:7819/call -d '{"tool":"TOOL_NAME","args":ARGS_JSON}'`. If the bridge also fails, guide the admin to install the plugin and restart. In Claude Code CLI, check `.claude/settings.json` and restart the session.

### Behavior

This task is the admin's publishing step — the final action after making org-level changes. Treat it as consequential: always present the full draft and require confirmation before writing.

Keep the draft presentation clear and scannable. Admins should be able to verify in seconds that the correct changes are being published.

The summary annotation is valuable context for members who will see these updates weeks later. Encourage the admin to provide one, but don't block on it.

### Constraints

Only org admins may run this task. The admin check in Step 1 is mandatory.

Never invent operations that don't correspond to actual state changes. The diff in Step 3 is strictly mechanical — compare current state to previous state, generate operations for differences, nothing else.

Never modify `org-config.json`, collection directories, or any file outside `/shared/updates/`. This task writes only to the update log, the published state snapshot, and the latest pointer file.

Never auto-publish. The admin must confirm every publish action. The `--dry-run` flag exists for admins who want to preview before committing.

### Edge Cases

If `published-state.json` exists but is malformed: surface the issue. Offer to rebuild from current state (treating everything as new), or halt for manual inspection. Do not silently overwrite a corrupted file without the admin's decision.

If the update log has entries but `published-state.json` is missing (file was deleted but log remains): the log is still valid. Reconstruct the baseline from the last log entry's operations (best-effort) or treat everything as new. Surface this to the admin.

If the admin runs `publish-updates` twice in rapid succession without making any org changes between runs: Step 3 produces no operations. Surface "Nothing has changed since the last publish" and halt. Do not create empty log entries.

If a collection on the remote filesystem has a `collection.json` that cannot be parsed: skip that collection in the diff, surface a notice to the admin, and continue with the remaining collections. Do not block the entire publish on one unreadable collection.

If the admin has made changes to the local project directory but hasn't pushed them to the remote filesystem (e.g., updated CLAUDE.md locally but not uploaded it): the diff will detect the CLAUDE.md hash change based on the local file. This is correct — the admin is responsible for ensuring the remote state is current before publishing. Surface a reminder: "The update instructions reflect your local state. Make sure all changes have been pushed to the remote filesystem before members apply updates."
