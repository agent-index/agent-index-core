---
name: publish-updates
type: task
version: 3.6.0
collection: agent-index-core
description: Generates update instructions from the current org state and publishes them to the remote filesystem so members can apply updates via '@ai:update'.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle
    description: Reads org state and writes update log entries to the remote filesystem via the on-demand executor (aifs-exec.bundle.js).
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

### Step 0a: Pull Upstream Updates (added in core 3.5.0; only when `--check-upstream` flag is passed)

If the admin invoked `@ai:publish-updates` **without** the `--check-upstream` flag, skip this step entirely and proceed to Step 0.

When `--check-upstream` is present, fetch the latest infrastructure source from GitHub before scanning local. This closes the manual `git pull` step from the admin's mental model — they say one verb and the task pulls upstream + syncs to remote + publishes.

1. Read `agent-index.json` → `infrastructure_directory_url`. HTTPS GET the JSON (30s timeout), **appending a cache-buster query param** — e.g. `{infrastructure_directory_url}?t={current unix epoch seconds}` (`&t=…` if it already has a query string). **Required:** the fetch layer caches `raw.githubusercontent.com` by exact URL and serves stale bytes long after a push, so without the buster this step reads pre-release versions, concludes "all infrastructure already at upstream," and silently fails to pull a release you just made (bug `20260601-8d20ea22-2`). Also append the same buster to each entry's `zip_url` GET in step 4 so the archive pull isn't served stale. Parse.
2. For each entry in `infrastructure[]` (currently: `agent-index-core`, `agent-index-marketplace`):
   - Read the local `<project_dir>/<entry-name>/collection.json` → `version` field. If the directory or file is missing locally, treat the local version as "absent."
   - Compare against the directory's `current_version`.
   - If `local_version == directory.current_version`: this entry is already at upstream; no fetch needed.
   - If `local_version` is absent OR `local_version < directory.current_version`: this entry is an upstream-fetch candidate.
3. Surface the candidates list (or surface "All infrastructure already at upstream — nothing to fetch." and proceed to Step 0):

   ```
   Upstream updates available:

     agent-index-core           3.4.0 → 3.5.0    https://github.com/.../main.zip
     agent-index-marketplace    2.2.0 → 2.3.0    https://github.com/.../main.zip

   Pull?  [a]ll  [s]elect each  [n]one
   ```

4. **Response handling:**
   - `[a]ll` (or `--all` flag passed at invocation, which auto-answers `a`): pull every candidate without further prompts. Per-entry: HTTPS GET the `zip_url`, save to `<project_dir>/.agent-index/staging/upstream-fetch-<timestamp>/`, extract, then **overwrite the local `<project_dir>/<entry-name>/` directory contents** with the extracted files. Preserve any `.git/` directory present locally. Apply LF normalization to all text-shaped files (`.sh`, `.js`, `.json`, `.md`, `.html`, `.yaml`, `.yml`, `.go`) before writing — same logic as Step 0 (closes bug `20260504-8d20ea22-7` in this code path too).
   - `[s]elect`: for each candidate, ask `Pull <name> <local_version> → <directory_version>? [Y/N]`. Y → pull as above. N → skip this entry.
   - `[n]one`: skip all upstream pulls. Halt with "No fetch performed. Re-run without --check-upstream to publish whatever is currently local, or run with --check-upstream again when ready to fetch upstream." (Don't proceed to Step 0 — admin clearly didn't want any of this.)

5. **Per-entry failure handling during fetch:**
   - **Allowlist-blocked signature** (added in core 3.7.4 to close section D of idea `allowlist-failure-mode-warnings-in-tasks`): HTTP 403 with empty body and no upstream-server headers, OR connection-refused, OR connection-timeout against `raw.githubusercontent.com`, `github.com`, or `codeload.github.com`. Surface the canonical Allowlist Failure Recognition message (see `agent-index-core/collection-authoring-guide.md` § "Allowlist failure recognition") naming the blocked host. Recommend `@ai:verify-network-allowlist` to test all required hosts at once. Halt (do not offer skip — the admin almost certainly wants all infrastructure pulled, and a half-pulled state is risky).
   - GitHub returns non-2xx (with body and upstream headers — i.e., a real GitHub error, not a proxy block): surface error + URL + status code, ask "skip this entry and continue with others? [Y/N]". On Y, skip; on N, halt.
   - Zip is corrupt or extract fails: same skip-or-halt prompt.
   - Local `.git/` accidentally clobbered (defensive check after extract): surface, halt — don't continue with a damaged source tree.

6. After Step 0a completes (or is skipped because `--check-upstream` wasn't passed), the local source tree reflects either the pre-existing state or the freshly-pulled upstream. Step 0 then proceeds with that as the basis.

Surface a one-line confirmation per entry pulled (`✓ pulled <name> <local> → <target>`).

---

### Step 0: Sync Local Infrastructure to Remote (added in core 3.4.0)

Before computing the diff, walk the admin's local `agent-index-core/` and `agent-index-marketplace/` directories and reconcile against what's at remote. The admin's typical flow is `git pull` to update their local source, then `@ai:publish-updates` to broadcast the change. Pre-3.4.0 publish-updates did not push the new local files to remote — admins had to do that manually before running this task. As of 3.4.0 this step does it for them.

**Source-tree skip-list (applied symmetrically to upload AND delete decisions; revised in core 3.6.0).** The following paths are filtered out of the diff entirely — neither uploaded nor proposed for deletion. Step 0 is a **source-tree** sync; non-source files are out of scope in both directions:

- `.git/`, `node_modules/`, `dist/` (Go build output for permission-helper-go)
- Any path containing `/.` (hidden files except for explicitly-shipped ones — `.claude/`, `.gitkeep`)
- Editor and temp files: `*.swp`, `*.swo`, `*.bak`, `*.tmp`
- Compiled binaries: `*.exe`, `*.dll`, `*.so`, `*.dylib` — these ship via the binaries registry, not via `aifs_write`
- OS metadata: `.DS_Store`, `Thumbs.db`
- Ephemeral scratch files: `test_*.{txt,md,json}`, `tmp_*` — these are common scratch/test artifacts; the friction is intentional. Authors who DO want to ship a file matching one of these patterns can rename it.

The principle: **Step 0 only manages files it would itself upload. If a file's path pattern means Step 0 wouldn't upload it, Step 0 won't delete it either.** Pre-3.6.0 the skip-list was applied only on the upload side, which produced spurious "delete this remote .exe?" prompts when leftover binaries lingered at remote. Post-3.6.0 the filter is symmetric — those files are filtered out of both walks.

For each of the two infrastructure roots (`agent-index-core/`, `agent-index-marketplace/`):

1. **Walk the local directory recursively.** For each file, compute the relative path from the directory root and the SHA-256 of the local file's content. Apply the skip-list above; filtered files are excluded entirely (they will not appear as `local_only`, `differs`, or `synced`).
2. **Read the corresponding remote file** via `aifs_read("/{collection_root}/{relative_path}")`. If the remote file exists, compute its SHA-256. If it does not exist (NOT_FOUND), treat as "missing remotely."
3. **Classify each local file:**
   - `local_only` — local exists, remote missing → upload
   - `differs` — local exists, remote exists, hashes differ → upload (overwrite)
   - `synced` — hashes match → no-op
4. **Detect remote files that no longer exist locally.** List the remote directory recursively via `aifs_list`. **Apply the skip-list above to the remote walk as well** — a remote file matching any skip-list pattern is filtered out (not flagged as `remote_only`, not proposed for deletion). For each remaining remote file with no local counterpart, mark `remote_only`. These are candidates for deletion (e.g., a file that was renamed or removed on a `git pull`).

Aggregate counts for both roots:

```
Source-to-remote sync summary:

  /agent-index-core/        upload: 47   delete: 1   synced: 132
  /agent-index-marketplace/ upload:  3   delete: 0   synced:  41

Files to upload:
  /agent-index-core/api/pin-binary-version.md         (new)
  /agent-index-core/api/pin-binary-version-manifest.json (new)
  /agent-index-core/CHANGELOG.md                      (modified)
  ...

Files to delete from remote:
  /agent-index-core/agent-index.json   (Phase 2 of template-disambiguation)

Proceed with sync? [Y/N]
```

On `N`: abort, no changes written. Surface "Sync cancelled. Re-run @ai:publish-updates when ready."

On `Y`:

1. **Upload all `local_only` and `differs` files** sequentially via `aifs_write`. Use the same LF-normalization as `apply-updates` Phase 1 step 6: read the local bytes, replace `\r\n` with `\n` and standalone `\r` with `\n` for all text file types (`.sh`, `.js`, `.json`, `.md`, `.html`, `.yaml`, `.yml`, `.go`, `.template.json`). Binary files are not currently in scope — they ship via the binaries registry. If a non-text non-shipped file is encountered, surface a warning and skip it.
2. **Delete `remote_only` files** sequentially via `aifs_delete`. Each deletion is logged so the admin sees what was removed.
3. **Surface a one-line confirmation** per file processed (`✓ upload {path}`, `✓ delete {path}`).
4. **On any individual file failure:** surface the error, continue with the rest of the batch (best-effort). At the end, report `N succeeded, M failed`. The admin can re-run to retry only the failures.

After sync completes, the remote `/agent-index-core/` and `/agent-index-marketplace/` directories match the admin's local copy. Proceed to Step 1.

**Idempotent re-runs:** If everything is already synced, the summary shows `upload: 0   delete: 0   synced: N` and asks "Nothing to sync. Continue to publish-updates diff phase? [Y/N]". On Y, proceed to Step 1; on N, halt.

**Optional `--no-sync` flag:** for power users or recovery scenarios where the admin wants to skip this step entirely (e.g., if files were already pushed via a script). When passed, Step 0 is skipped and the task starts at Step 1.

**Why limited to `agent-index-core/` and `agent-index-marketplace/`:** Marketplace collections (`projects`, `strategy`, etc.) are managed via `download-collection`/`install-collection`/`upgrade-collection` and have their own update flow. Adapter bundles ship via `edit-org` Step 2. Binary tools ship via the binaries registry (`apply-updates` Phase 1 step 7). Step 0 here only covers the two infrastructure collections that don't have any other shipping path.

---

### Step 0b: Detect Prerequisites Triggered by the Diff (added in core 3.5.0)

Step 0 produced a file-level diff (which files were uploaded, which were deleted, which were synced). Some of those changes have implications beyond just "files changed at remote": they may require the bootstrap zip to be regenerated, or specific CHANGELOG-entry types to be added. This step walks the diff and infers those implications so admins don't have to remember which file changes need which prereq tasks.

Walk the file paths from Step 0's `upload` + `delete` sets. For each path, apply the **prerequisite lookup table**:

| File path matches | Prereq triggered | CHANGELOG entry implication |
|---|---|---|
| `mcp-servers/filesystem/aifs-exec.bundle.js` | Bootstrap regen REQUIRED | `adapter-bundle-update` (from→target version from `mcp-servers/filesystem/adapter.json`) |
| `mcp-servers/filesystem/aifs-exec.sh` | Bootstrap regen REQUIRED | (folded into adapter-bundle-update if bundle.js also changed; otherwise standalone adapter-bundle-update) |
| `mcp-servers/filesystem/adapter.json` | (no prereq) | (folded into adapter-bundle-update if bundle.js also changed) |
| `CLAUDE.md` (root) | Bootstrap regen REQUIRED (canonical CLAUDE.md ships in bootstrap) | `claude-md-update` |
| `members-registry.json` (root) | Bootstrap regen REQUIRED (members-registry ships as bootstrap seed) | `members-registry-update` (new entry type as of 3.5.0 — `update-log.json` consumers must tolerate unknown entry types) |
| `org-config.json` → `remote_filesystem.connection.all_members_group` change | Bootstrap regen REQUIRED (controls bootstrap zip share recipients) | `org-config-update` with `changes: ["all_members_group"]` |
| `org-config.json` → `paths.bootstrap_zip_path` change | Bootstrap regen REQUIRED (location changed) | `org-config-update` |
| `org-config.json` → other fields (`org_name`, `admins[]`, `org_roles[]`, etc.) | NO bootstrap regen | `org-config-update` with the changed fields listed |
| `agent-index.json` change | NO bootstrap regen (Step 0 already synced it; bootstrap reads from local at next regen anyway) | (folded into `core-update` if version field changed) |
| `agent-index-core/collection.json` version field changed | NO bootstrap regen | `core-update` |
| `agent-index-marketplace/collection.json` version field changed | NO bootstrap regen | `marketplace-update` |
| Any other file under `agent-index-core/` | (folded into `core-update`) | n/a |
| Any other file under `agent-index-marketplace/` | (folded into `marketplace-update`) | n/a |

Aggregate the results:

- A `Set<prerequisite>` — for 3.5.0 this is just `{bootstrap_regen}` or empty.
- A `Map<entry_type, entry_payload>` — the set of CHANGELOG entries to be added.

Surface the aggregated picture to the admin:

```
Detected from your diff:

  Prerequisites:
    ✓ Bootstrap zip regeneration required
      Triggered by: mcp-servers/filesystem/aifs-exec.bundle.js (sha A → sha B)
      Triggered by: CLAUDE.md (sha C → sha D)

  CHANGELOG entries to be written:
    - core-update           3.4.0 → 3.5.0
    - adapter-bundle-update 2.2.1 → 2.2.2
    - claude-md-update      (refresh)

Run prerequisites and proceed to publish? [Y/N]
```

If no prereqs were detected and at least one CHANGELOG entry was inferred: surface only the entries section and the same Y/N prompt.

If neither prereqs nor entries were detected (Step 0 had no real changes): surface "Nothing has changed since the last publish." and halt cleanly.

On `N`: halt without running prereqs or writing CHANGELOG. Step 0's sync already happened; remote files reflect local state. Subsequent `@ai:publish-updates` re-runs will see no diff (idempotent) and report no-op.

On `Y`: proceed to Step 0c.

---

### Step 0c: Run Prerequisites (added in core 3.5.0)

For each prerequisite in the aggregated set:

**`bootstrap_regen`:** Follow the shared subroutine at `agent-index-core/templates/regenerate-bootstrap.md`. Pass parameters:

- `<project_dir>`: the agent-index install directory.
- `<source-trigger>`: a concise summary of the changes that triggered the regen, e.g. `"adapter bundle 2.2.1 → 2.2.2"` or `"CLAUDE.md and adapter bundle changed"`.
- `<allow-skip>`: `true` (publish-updates is OK with a no-op regen if the content hash hasn't actually changed — this happens when files moved through Step 0 but ended up with the same byte-for-byte content as what's already in the deployed bootstrap).

The subroutine handles assembling zip contents, LF normalization, zip creation, upload to `/shared/bootstrap/member-bootstrap.zip`, all-members re-share, and updating `published-state.json`'s `bootstrap_content_hash` field.

If the subroutine reports the bootstrap content was unchanged (the `<allow-skip>` no-op path): surface "Bootstrap content unchanged; existing zip retained." and continue. Don't fail; it's possible for `mcp-servers/filesystem/aifs-exec.bundle.js` to be byte-identical to what's already in the zip even though Step 0 saw it as `differs` (e.g., a checksum-only change in `adapter.json` without a content change in the bundle — unusual but valid).

If the subroutine fails: surface the error and halt. Files from Step 0 stay at remote (idempotent retry-friendly), but no CHANGELOG entry is written. Admin can fix the cause and re-run.

After all prerequisites complete, surface a one-line summary per prereq (`✓ Bootstrap regenerated and uploaded`) and proceed to Step 1.

---

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
> - **agent-index-core** updated from 3.0.0 to 3.1.0
> - **projects** collection updated from 3.0.4 to 4.0.0 (major — migration required)
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
      "target_version": "3.1.0",
      "from_version": "3.0.0"
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

**On success:** Proceed to Step 6.

---

### Step 6: Write Back to `org-config.json`

Added in core 3.7.1 (closed bug `20260512-8d20ea22-2`); clarified, fixed, and extended in core 3.7.4 (closes bug `20260522-8d20ea22-4`).

Pre-3.7.1 this writeback didn't exist. Pre-3.7.4 the spec described it but lived as a sub-section inside Step 5 alongside a Constraints contradiction (the old Constraints line forbade ALL `org-config.json` writes, including the documented one) — the agent correctly hit the contradiction and the writeback never ran. The 3.7.4 release corrects the constraint, promotes the writeback to its own clearly-named step, and extends it to cover the top-level `agent_index_version` field.

After Step 5's writes succeed, update `org-config.json` to reflect the just-published state. This keeps the org's record of "what's installed" in sync with what publish-updates has actually shipped.

#### 6a. Per-operation `installed_collections[]` writeback

Read `aifs_read("/org-config.json")`. For each operation in the new update-log entry:

- **`core-update`:** Find the `installed_collections[]` entry with `name: "agent-index-core"`. Update its `version` to the operation's `target_version`. Update its `upgraded_date` to today (`YYYY-MM-DD`). If the entry doesn't exist (corrupt or hand-edited org-config), surface a notice and skip.
- **`marketplace-update`:** Same for the `name: "agent-index-marketplace"` entry.
- **`collection-update`:** Find the `installed_collections[]` entry with `name: <operation.details.collection>`. Update `version` to `target_version`, `upgraded_date` to today.
- **`collection-install`:** Add a new entry to `installed_collections[]` if not present: `{ name, version, installed_date: today, repo_url: <from operation>, status: "installed" }`. If an entry exists but is marked `status: "removed"`, update its `version` + `upgraded_date` and flip `status` back to `"installed"`.
- **`collection-remove`:** Find the entry and set its `status` to `"removed"` (preserve historical record).
- **Other operation types** (`claude-md-update`, `adapter-bundle-update`, `binary-update`, `members-registry-update`, `org-config-update`): no `installed_collections[]` write.

#### 6b. Top-level `agent_index_version` writeback

Added in core 3.7.4 to close the `agent_index_version` portion of bug `20260522-8d20ea22-4`. Pre-3.7.4 this field drifted because nothing wrote it on a `core-update`; check-updates, session-start, and other tasks read it as "what agent-index version is the org at," producing stale data. On Bill's install at 3.7.4 publish time, the field was at `3.5.0` — multi-version drift; the one-time backfill in Step 6c handles this.

- If the new update-log entry contains a `core-update` operation, update `agent_index_version` (top-level field in `org-config.json`) to the `core-update`'s `target_version`. Otherwise leave `agent_index_version` unchanged.
- **Drift source for the Step 6c backfill comparison:** `published-state.json` does NOT have a top-level `agent_index_version` field. Its `infrastructure` object is shaped `{ "agent-index-core": "<version>", "agent-index-marketplace": "<version>" }`. The backfill comparison reads `published-state.infrastructure["agent-index-core"]` as the authoritative "what core version is the org at right now per the published record." The semantic intent of `org-config.agent_index_version` IS the core version, so this is the correct read; no schema bump on published-state is needed.

#### 6c. One-time backfill prompt on detected drift

Added in core 3.7.4. Before completing Step 6, compare the current `org-config.json` `installed_collections[]` and `agent_index_version` values against what `published-state.json` records:

- For each collection in `published-state.installed_collections[]`: compare `org-config.installed_collections[name].version` to `published-state.installed_collections[where name==name].version`. Mismatch in either direction (stale or ahead-of-published) is drift.
- For `agent_index_version`: compare `org-config.agent_index_version` to `published-state.infrastructure["agent-index-core"]`. Mismatch in either direction is drift.
- For each infrastructure collection in `published-state.infrastructure` (currently `agent-index-core` and `agent-index-marketplace`): compare `org-config.installed_collections[name].version` to `published-state.infrastructure[name]`. Mismatch is drift.

If any drift is detected, surface a prompt:

> *"Detected `org-config.json` drift between the org's record and what's actually been published. Affected:*
> *{for each drift entry:}*
> *- `installed_collections[{name}].version`: `{current}` → `{published}` ({reason: stale | ahead-of-published})*
> *{if agent_index_version drifts:}*
> *- `agent_index_version`: `{current}` → `{published}` ({reason})*
>
> *This typically results from pre-3.7.4 publish-updates runs that hit a spec contradiction and skipped the writeback. Reconcile now?"*

On admin **confirmation:** apply the backfill values together with the per-operation updates from 6a/6b. The single write to `/org-config.json` is atomic. Re-running publish-updates after a successful backfill is a no-op (no drift detected; nothing to prompt about).

On admin **decline:** skip the backfill but still apply the per-operation updates from 6a/6b for the current publish. The drift state persists; next publish-updates run will surface the same prompt.

#### Write semantics

Write the updated `org-config.json` back via `aifs_write("/org-config.json", ...)`. Idempotent: re-running publish-updates with the same target_version is a no-op for these fields. If the write fails after Step 5's writes succeeded, surface the failure but do NOT roll back the log entry (members can still apply the update; org-config drift is a bookkeeping issue, recoverable on the next publish).

---

### Step 7: Confirm to Admin

After both Step 5 and Step 6 succeed, surface confirmation:

> "Update instructions published (entry #{id}). Members will see these on their next session start and can apply them with '@ai:update'."
>
> **What members will experience:**
> - On next session start: a notice that updates are available
> - When they run '@ai:update': a guided update process that applies all pending changes
> {If adapter-bundle-update was included}: "Note: the adapter bundle update will require members to download the new bootstrap zip and restart their session. Consider sending them a heads-up."
> {If a MAJOR collection update was included}: "Note: the {collection} update is a major version change. Members may need to provide input during the upgrade for reset parameters."

---

## Directives

### Remote Filesystem Access

All `aifs_*` operations are invoked via the on-demand executor shell wrapper: `bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh <tool_name> '<json_args>'`. Each call runs a fresh Node process, executes one operation, and exits. There is no persistent server or bridge. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and suggest '@ai:member-bootstrap'. In Cowork, `<project_dir>` resolves to the mounted workspace directory containing `agent-index.json`.

### Behavior

This task is the admin's publishing step — the final action after making org-level changes. Treat it as consequential: always present the full draft and require confirmation before writing.

Keep the draft presentation clear and scannable. Admins should be able to verify in seconds that the correct changes are being published.

The summary annotation is valuable context for members who will see these updates weeks later. Encourage the admin to provide one, but don't block on it.

### Constraints

Only org admins may run this task. The admin check in Step 1 is mandatory.

Never invent operations that don't correspond to actual state changes. The diff in Step 3 is strictly mechanical — compare current state to previous state, generate operations for differences, nothing else.

Never modify collection directories or any file outside the documented write surfaces. The documented write surfaces are:

- `/shared/updates/update-log.json`
- `/shared/updates/latest.json`
- `/shared/updates/published-state.json`
- `/shared/bootstrap/member-bootstrap.zip` (when bootstrap regen fires per Step 0c's prerequisite subroutine)
- `/org-config.json` (ONLY for the `installed_collections[]` and `agent_index_version` writebacks documented in Step 6 — no other org-config fields are mutated)

The pre-3.7.4 Constraints section forbade ALL `org-config.json` writes, contradicting the Step 5 writeback added in 3.7.1 and effectively suppressing it. 3.7.4 corrects this with the precisely-scoped surface list above.

Never auto-publish. The admin must confirm every publish action. The `--dry-run` flag exists for admins who want to preview before committing.

### Edge Cases

If `published-state.json` exists but is malformed: surface the issue. Offer to rebuild from current state (treating everything as new), or halt for manual inspection. Do not silently overwrite a corrupted file without the admin's decision.

If the update log has entries but `published-state.json` is missing (file was deleted but log remains): the log is still valid. Reconstruct the baseline from the last log entry's operations (best-effort) or treat everything as new. Surface this to the admin.

If the admin runs `publish-updates` twice in rapid succession without making any org changes between runs: Step 3 produces no operations. Surface "Nothing has changed since the last publish" and halt. Do not create empty log entries.

If a collection on the remote filesystem has a `collection.json` that cannot be parsed: skip that collection in the diff, surface a notice to the admin, and continue with the remaining collections. Do not block the entire publish on one unreadable collection.

If the admin has made changes to the local project directory but hasn't pushed them to the remote filesystem (e.g., updated CLAUDE.md locally but not uploaded it): the diff will detect the CLAUDE.md hash change based on the local file. This is correct — the admin is responsible for ensuring the remote state is current before publishing. Surface a reminder: "The update instructions reflect your local state. Make sure all changes have been pushed to the remote filesystem before members apply updates."
