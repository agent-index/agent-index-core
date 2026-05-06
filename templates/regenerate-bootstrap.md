# Bootstrap Zip Regeneration Subroutine

This is a **shared procedure** used by multiple admin tasks to regenerate the member bootstrap zip. It is not itself a task or skill — it has no entry in `collection.json` → `api[]` and no manifest. It's a reusable text snippet that callers reference by path.

Callers as of core 3.5.0:

- `edit-org` Step 5 (formerly Step 5's "Regenerate and redistribute bootstrap zip" sub-section). When the admin updates the adapter bundle or makes other org-config edits that ship in bootstrap.
- `publish-updates` Step 0c (added in 3.5.0). When the admin's local diff includes any file that ships in the bootstrap zip — automatically detected by Step 0b.
- Future admin tasks that change bootstrap content should call this subroutine rather than re-implementing the procedure.

## Input parameters

The caller passes these as natural-language directive parameters to the executing agent before reading this template:

| Parameter | Type | Description |
|---|---|---|
| `<project_dir>` | absolute path | The agent-index install directory (where `agent-index.json` lives at the root). |
| `<source-trigger>` | free-text | Why this regen is happening. Used in the staging directory name and surfaced to the admin. e.g. `"gdrive bundle changed"`, `"admin edited all_members_group"`, `"CLAUDE.md refreshed"`. |
| `<allow-skip>` | boolean (default false) | If true and the resulting zip is byte-identical to the existing remote zip, skip the upload and surface a no-op confirmation. Used by `publish-updates` to avoid unnecessary churn. |

## Procedure

### Step 1: Compute the zip's expected contents from current local state

The zip is a deterministic function of these local files:

- `<project_dir>/agent-index.json` (workspace marker — copied verbatim into the zip's root, not the local install root)
- `<project_dir>/CLAUDE.md`
- `<project_dir>/.claude/settings.json`
- `<project_dir>/mcp-servers/filesystem/aifs-exec.bundle.js`
- `<project_dir>/mcp-servers/filesystem/aifs-exec.sh`
- `<project_dir>/mcp-servers/filesystem/adapter.json`
- `<project_dir>/agent-index-core/.claude/hooks/session-bootstrap.sh`
- `<project_dir>/agent-index-core/cowork-plugin/` (built into a `.plugin` archive — see Step 3)

Selected fields from `<project_dir>/org-config.json` are NOT in the zip directly — `org-config.json` is read from remote at runtime by member tasks. The zip is the bootstrap envelope; org config is the runtime state.

If any required input file is missing locally, surface the error with the missing path and halt. Do not produce a zip with missing files.

### Step 2: Create staging directory

Create `<project_dir>/.agent-index/staging/bootstrap-<ISO-timestamp>-<source-trigger-slug>/` where `source-trigger-slug` is the trigger string lowercased with non-alphanumeric replaced by hyphens. e.g. `bootstrap-2026-05-05T14-30-00-gdrive-bundle-changed/`.

The staging directory is gitignored and will be cleaned up at the end of this procedure on success. On failure, leave it in place for debugging.

Inside staging, create the layout that will be zipped:

```
<staging>/agent-index/
├── agent-index.json
├── .claude/
│   └── settings.json
├── mcp-servers/
│   └── filesystem/
│       ├── aifs-exec.bundle.js
│       ├── aifs-exec.sh
│       └── adapter.json
├── agent-index-core/
│   └── .claude/
│       └── hooks/
│           └── session-bootstrap.sh
├── agent-index-filesystem.plugin    (built in Step 3)
└── CLAUDE.md
```

Copy each input file into its destination. **Apply LF line-ending normalization** to every text-shaped file (`.sh`, `.js`, `.json`, `.md`, `.html`, `.yaml`, `.yml`) before writing it into staging — read the bytes, replace `\r\n` with `\n` and standalone `\r` with `\n`, then write. This is identical to the LF-normalization that ships in `apply-updates` Phase 1 step 6 and closes bug `20260504-8d20ea22-7`.

### Step 3: Build the Cowork plugin archive

The `agent-index-filesystem.plugin` is a zip of `<project_dir>/agent-index-core/cowork-plugin/`'s contents:

```bash
cd <project_dir>/agent-index-core/cowork-plugin && \
  zip -r <staging>/agent-index/agent-index-filesystem.plugin \
    .claude-plugin/ .mcp.json scripts/ README.md
```

This plugin is consumed by Cowork at member-install time for filesystem validation. Members not using Cowork ignore it harmlessly.

### Step 4: Verify staging contents

Sanity-check the staging directory before zipping:

- All expected files present
- `agent-index.json` parses as JSON, has `remote_filesystem.backend` set
- `aifs-exec.bundle.js` is non-empty (avoid the empty-stub case from prior bugs)
- `aifs-exec.sh` is non-empty AND has LF line endings (no `\r` characters)
- SHA-256 of `aifs-exec.bundle.js` matches `mcp-servers/filesystem/adapter.json`'s `exec_bundle_checksum` field

If any check fails, surface the specific issue and halt. Do not produce an invalid zip.

### Step 5: Compute deterministic content hash (for skip-if-unchanged)

If `<allow-skip>` is true:

1. List staging files in sorted order (deterministic).
2. Concatenate each file's SHA-256 into a manifest string.
3. Compute SHA-256 of the manifest. This is the "content hash" of the zip's logical contents.
4. Read the current remote `published-state.json` → `bootstrap_content_hash`. If equal to the new content hash, skip Step 6 and Step 7. Surface "Bootstrap content unchanged; existing zip retained." and return.

### Step 6: Create the zip and upload

```bash
cd <staging> && zip -r member-bootstrap.zip agent-index/
```

Read the zip as binary, upload via:

```
aifs_write("/shared/bootstrap/member-bootstrap.zip", "base64:<base64-encoded-zip-bytes>")
```

### Step 7: Re-share with all-members group

The bootstrap zip must remain accessible to the org's all-members Google Group (or equivalent in non-Drive backends). The share is preserved automatically when overwriting an existing file in most backends, but verify post-upload:

```
aifs_get_permissions("/shared/bootstrap/member-bootstrap.zip")
```

If `<org-config>.remote_filesystem.connection.all_members_group` is NOT in the recipients list with `reader` role:

- For backends that support it via API (gdrive): build a single-op spec for the permission-change-helper:
  ```json
  {
    "operations": [{
      "op": "share",
      "resource": "/shared/bootstrap/member-bootstrap.zip",
      "recipient": "<all_members_group>",
      "role": "reader"
    }],
    "context": {
      "requestor": "<admin-member-hash>",
      "calling_task": "regenerate-bootstrap",
      "purpose": "Restore reader access to the bootstrap zip after regeneration"
    }
  }
  ```
  Pass to permission-change-helper as a sub-step. Wait for the helper's outcome. On success, continue. On reject/timeout, surface to the admin: "Bootstrap zip uploaded but the all-members share was not restored. Re-run @ai:edit-org or apply the share manually."
- For backends without programmatic share APIs: surface the share state and ask the admin to verify via the backend's UI. Continue without halting.

### Step 8: Update published-state.json bootstrap hash and clean up

If the procedure reached this step (zip was uploaded):

1. Read `/shared/updates/published-state.json` from remote (if it exists).
2. Update `bootstrap_content_hash` to the value computed in Step 5 (or compute now if Step 5 was skipped because `<allow-skip>` was false).
3. Update `bootstrap_uploaded_at` to the current ISO timestamp.
4. Write back via `aifs_write`.
5. Delete the staging directory `<project_dir>/.agent-index/staging/bootstrap-<...>` (it served its purpose).

Surface to the admin:

```
✓ Bootstrap zip regenerated and uploaded
  Triggered by: <source-trigger>
  Content hash: <12-char-prefix>...
  Uploaded to:  /shared/bootstrap/member-bootstrap.zip
  Members will receive the new zip on their next bootstrap (new joins)
  or via apply-updates' adapter-bundle-update entry (existing members)
```

## Failure modes

| Failure | Recovery |
|---|---|
| Required input file missing locally | Halt with the specific missing path. Admin must restore the file (often via `git pull` or rerunning a prior task). |
| Bundle SHA mismatch (Step 4) | Halt. The local bundle's content doesn't match `adapter.json`'s declared checksum. Re-run the relevant build/install task. |
| Cowork plugin archive fails | Surface, ask "skip the plugin archive and continue? [Y/N]". On Y: write the zip without the plugin. Note that Cowork-using members will lack the validation tool until the next regen. |
| Zip creation fails | Halt. Check disk space, file permissions in the staging dir. |
| `aifs_write` fails | Halt. Local zip is still in staging — admin can retry without re-staging. |
| Permission re-share fails | Surface the issue; do not halt. Bootstrap zip is uploaded but may not be readable by all members until the share is fixed. |

## What this does NOT do

- **Does not modify `org-config.json`.** Callers that need to update org-config (e.g. `edit-org` updating `all_members_group`) do that themselves before calling this subroutine.
- **Does not write a CHANGELOG entry.** That's `publish-updates`' job. This subroutine just produces the zip.
- **Does not redistribute to existing members directly.** Members pick up the new zip via `apply-updates`'s `adapter-bundle-update` flow (when the adapter version changed) or by re-running the bootstrap (less common). The zip's existence at remote is sufficient.
- **Does not handle credentials or auth.** All file operations use the caller's existing OAuth context. If auth is missing, the relevant `aifs_*` calls will fail and this subroutine surfaces them for the caller to handle.

## History

- core 3.5.0: Extracted into a shared subroutine. Previously inlined in `edit-org` Step 5 and referenced (without details) from `create-org` Step 12.
