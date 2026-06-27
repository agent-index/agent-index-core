---
name: apply-updates
type: task
version: 3.12.0
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

If no pending plan exists: proceed to Step 1.5.

---

### Step 1.5: Member-State Self-Heal (standing migrations)

These checks run on EVERY `@ai:update` invocation — even when no entries are pending and even if the member's cursor is current. They are idempotent and exist because schema additions to member-local files otherwise never reach existing members (ensure-cached logic in org-setup/member-bootstrap only runs for new members).

**Migration 1 — `member_folder_id` re-cache (3.8.0, reworked 3.9.0):**

Precedence rule: **the member's own handshake file outranks the registry** — the handshake is written by the owner about a folder they own; the registry is an admin-side mirror that may lag until the next publish-updates reconcile (6d).

1. Read local `members/{member_hash}/member-index.json`, the member's handshake file `/shared/members/artifacts/{member_hash}/member-folder.json` (if any), and the member's entry in `/members-registry.json`.
2. **If a handshake exists:** its `member_folder_id` is authoritative. If local differs, write the handshake value into `member-index.json` ("✓ Refreshed your member folder ID."). Ignore the registry here — never overwrite local with a registry value that contradicts the handshake (the registry is stale until reconcile).
3. **If no handshake exists** (pre-3.9.0 state): a registry value that differs from local may be cached locally as a stopgap, but Migration 2 below will run anyway (no handshake → ensure-my-drive-space) and supersede it in the same invocation.
4. If all three lack it: proceed — Migration 2 handles creation.

**Migration 2 — My Drive member space (introduced core 3.9.0):**

If local `member-index.json` has no `member_folder_id`, OR the handshake file `/shared/members/artifacts/{member_hash}/member-folder.json` does not exist (pre-3.9.0 member whose space is still on the org Shared Drive):

Run the **ensure-my-drive-space subroutine** (canonical definition: `member-bootstrap.md` Step 5): create `Agent-Index-Private` in the member's own My Drive via `id:root/...`, stat for the resolved Drive ID, **migrate any content from the old Shared-Drive space** (per-file `aifs_copy`, read+write fallback; never delete the old space), write the handshake file, update local `member-index.json`. Surface: "✓ Your private member space is now in your own My Drive ({n} files migrated)."

This is the migration path for existing members: the 3.9.0 update entry triggers every member's `@ai:update`, which runs this step — no admin action per member. The admin's next `@ai:publish-updates` reconciles handshakes into the registry. Idempotent; must not block the update on failure (surface and continue).

**Migration 3 — raw-URL normalization (introduced core 3.9.1, closes finding F7 / bug `20260604-8d20ea22-144009-20c2`):**

The fetch layer strips query params on `refs/heads/main` raw.githubusercontent URLs and serves long-stale cached bytes (observed: a weeks-old directory served despite the cache-buster — which silently breaks pin validation and binary sha verification). The `/main/` short-form is cache-correct.

1. Read local `agent-index.json`. For each of the known URL fields (`marketplace_directory_url`, `filesystem_adapter_directory_url`, `infrastructure_directory_url`, `core_version_url`, `marketplace_version_url`), if the value contains `raw.githubusercontent.com` AND `/refs/heads/main/`, rewrite that segment to `/main/`.
2. If any field changed: write `agent-index.json` back and surface one line: "✓ Normalized {n} directory URL(s) (one-time migration)." Otherwise silent.
3. Never touch non-raw URLs (`*_repo_url`, `log_collector_url`, zip URLs in directories).

**Migration 4 — collection-access backfill (introduced core 3.10.1; ADMIN-GATED self-heal; closes bugs cr01 `20260608-8d20ea22-160001-cr01` and the discovery half of cr02 `20260608-8d20ea22-160002-cr02`):**

Post-3.9.0, non-admin members are not Drive members and reach a collection's code dir only if it is (a) directly shared with them (all@ reader) and (b) addressable by a stored `folder_id`. Collections installed before 3.10.1 have neither captured. This migration backfills both. It requires Manager/owner rights, so it runs **only when the member applying updates is an org admin** (check `org-config.json` `admins[]` for the local `member_hash`); non-admins skip it silently (they benefit once an admin has run it).

1. If the local member is NOT in `org-config.json` `admins[]`: skip Migration 4 entirely (silent).
2. Read `org-config.json` → `installed_collections[]` (status `installed`). For each collection `C`:
   - **folder_id capture:** if `C.folder_id` is absent/empty, `aifs_stat("/{C.name}")` to resolve its Drive ID. If resolved, stage `C.folder_id = <id>` for a single revision-aware `org-config.json` write at the end. If `/{C.name}` can't be stat'd (not yet on remote / ambiguous), note and skip that collection's capture.
   - **reader-grant check:** `aifs_get_permissions("/{C.name}")`. If `all@{domain}` lacks `reader` (and isn't already covered by a broader grant), add a `share` op (recipient `all@{members_group}`, role `reader`, resource `id:{C.folder_id}` if captured this run, else `/{C.name}`) to a single batched permission-change-helper spec.
3. **Apply:** if any folder_id was staged, write `org-config.json` once (revision-aware, `if_revision`). If any reader grants are needed, invoke `permission-change-helper` ONCE with the batched spec — the admin reviews and Accepts all missing grants in one page (verified-outcome HARD GATE; idempotent — skip if the grant already exists). Do not write a pointer/scope; these are infrastructure grants.
4. Surface a one-line summary: "✓ Backfilled collection access: {n} folder_id(s) captured, {m} read grant(s) provisioned." Idempotent: on a fully-backfilled org this migration is a no-op (every collection has folder_id and the grant).
5. Never block the update on a backfill failure — surface what couldn't be done and continue; the next admin update retries.

Future member-local schema migrations append here as numbered entries; each must be idempotent and must not block the update on failure.

---

### Step 1.6: Binary Pin Sync (standing — runs on EVERY invocation)

Moved out of Phase 1 in 3.9.0 (closes finding F11): binary pins are changed by `@ai:pin-binary-version`, which writes **no update entry** — so a sync that only runs inside Phase 1 (infra batches) never fires for pin-only changes, and members never converge. Verified live: a collection-update-only batch skipped Phase 1 entirely and left a member on a binary below the org pin.

This step is **self-contained** — it does not depend on any cache produced by other steps:

1. Read `infrastructure-directory.json` from **`/shared/dist/directories/` on the org backend** (Release C — backend-first; standards.md § "Distribution: backend-first"), after reading `/shared/dist/manifest.json` (the org's version authority); verify the directory's SHA against the manifest. **Members never fetch this from GitHub.** *(Deprecated fallback only — a not-yet-migrated org with no `/shared/dist/`: use the SHA-pinned GitHub Distribution fetch protocol and emit the deprecation warning; a fallback-sourced result must not conclude a pinned binary is current.)*
2. Read `org-config.json` → `binaries{}` (remote). For each pinned binary, reconcile against the manifest: if the member's `version_file` (`version.txt`) ≠ the published version, **`aifs_read` the binary from `/shared/dist/binaries/`** (NOT a GitHub release), SHA-verify against the manifest entry, place it on the host-mounted `install_destination` (**shell-first + read-back verify** — large file, mount-truncation risk), write `version.txt`, and surface the member **`--register`** one-liner (host-side; the agent can't register the URL scheme). On first bootstrap the binary comes from the unpacked bootstrap zip instead, so this reconcile is then a no-op.
3. If local matches the pin: silent (or one summary line). If no binaries are pinned: silent.

Phase 1 step 7 remains in place for infra batches but is now just an invocation of this standing step (do not run it twice in one update).

Proceed to Step 2.

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
4. Update the local `agent-index.json` version field. Also migrate any new top-level fields that are present in the canonical workspace template (read from remote) but missing locally. The canonical template lives at `agent-index-core/templates/agent-index.template.json` (introduced in core 3.4.0; the legacy collection-root path `agent-index-core/agent-index.json` was retired in core 3.6.0). Read via `aifs_read("/agent-index-core/templates/agent-index.template.json")`. Specifically as of 3.1.1: if `infrastructure_directory_url` is missing locally, copy it from the canonical template — without it, `check-updates` cannot determine the latest core or marketplace version. Field migrations are non-destructive: never overwrite a field the member has already set, only add fields that are absent.
5. **Clean up deprecated v2 artifacts:** If `agent-index-core/tools/aifs-bridge/` exists locally, delete the entire directory (it contains `aifs-bridge.mjs` and `aifs-call.sh` which reference the removed `server.bundle.js`). Also delete `mcp-servers/filesystem/server.bundle.js` if present. These are pre-v3 artifacts that cause errors if Claude discovers and tries to use them.

   **Strip stale `remote_filesystem.mcp_server` and `remote_filesystem.exec` blocks from `org-config.json`** (the `mcp_server` strip added in core 3.3.1, the `exec` strip added in core 3.6.0; together they close bug `20260502-8d20ea22-3`): read `org-config.json` from the remote filesystem via `aifs_read("/org-config.json")`. Then:

   a. **`mcp_server` strip (3.3.1):** If `remote_filesystem.mcp_server` exists AND its `bundle_path` field references the v2 default `mcp-servers/filesystem/server.bundle.js`, delete the entire `mcp_server` block from `remote_filesystem`. Migration is non-destructive: only strips the block if the `bundle_path` is the v2 default; if an admin has manually edited the block, leave it alone and surface a notice.

   b. **`exec` strip (3.6.0):** If `remote_filesystem.exec` exists in `org-config.json`, delete the entire `exec` block from `remote_filesystem`. The v3 design puts the adapter exec config (`bundle_path`, `shell_wrapper`, `adapter_version`) in `agent-index.json → remote_filesystem.exec`, NOT in `org-config.json`. Pre-3.6.0 the `create-org` template incorrectly wrote an `exec` block to both files; the duplicate in `org-config.json` was unread at runtime (the v3 wrapper finds its bundle by walking outward from its own directory) but persists as a footgun for any future task or human who reads `org-config.json` for adapter info. Migration is non-destructive in the same sense: only strips the block; if an admin has hand-rolled a different shape, leave it alone and surface a notice.

   Write the updated `org-config.json` back via `aifs_write` if either strip ran. Rationale (both strips): in v3 the bundle path moved to `agent-index.json → remote_filesystem.exec.bundle_path` exclusively. Both `mcp_server` (v2 leftover) and `exec` (3.6.0 fix to create-org template) in `org-config.json` are obsolete. Each strip step runs at most once per install — subsequent runs are no-ops because the blocks are already gone.
6. **Remove the orphaned Node-helper directory** (added in core 3.7.4; replaces the Node-helper install that lived here pre-3.7.4):
   - The Node permission-helper at `<project_dir>/mcp-servers/permission-helper/` was the canonical helper implementation through core 3.3.0–3.7.3. It was removed in 3.7.4 — the Go binary at `mcp-servers/permission-helper-go/` (installed by Phase 1 step 7) is now the only implementation. The local `mcp-servers/permission-helper/` directory becomes orphaned on pre-3.7.4 installs.
   - Check whether `<project_dir>/mcp-servers/permission-helper/` exists locally. If not, skip this step.
   - Recursively delete the directory and all its contents.
   - Surface a one-line confirmation: "Removed orphaned mcp-servers/permission-helper/ directory (pre-3.7.4 Node helper; replaced by permission-helper-go binary)."
   - Idempotent: on a second `apply-updates` run after 3.7.4 has landed, the directory is already gone and the step is a no-op.
   - Failure handling: if the deletion fails (filesystem permissions, in-use file, etc.), surface a notice but do NOT block the rest of `apply-updates`. The orphaned directory is dead code; harmless if it persists.
7. **Sync registered binary tools** (added in core 3.4.0; standing since 3.9.0): this is the same logic as Step 1.6 — if Step 1.6 already ran this invocation (it always does), skip here. For each entry in `infrastructure-directory.json` → `binaries[]`, reconcile the locally-installed binary against the org's pinned version. This is the download/install path for native tools (currently: `permission-helper-go`). The flow:

   1. Fetch `infrastructure-directory.json` from the URL in `agent-index.json` → `infrastructure_directory_url` (cache-busted, `/main/` short-form — NOT a local cache; pre-3.9.0 this said "cached during this run", which doesn't exist in non-infra batches).
   2. Read `org-config.json` → `binaries{}` from remote. For each binary listed in the directory:
      - **Backend-match filter (Release B / core 3.13.0):** if a directory binary declares a `backend` field, process it ONLY when it equals this org's `remote_filesystem.backend`; otherwise skip silently. Several binaries can share the same `install_destination` as per-backend variants (e.g. `permission-helper-go` for gdrive and `permission-helper-go-onedrive` for onedrive both install to `mcp-servers/permission-helper-go/agent-index-show-plan{ext}`) — the backend filter is what picks the right one, so the helper skill, invite-member, etc. find the correct backend's binary at the unchanged path. Binaries with no `backend` field are backend-agnostic and always considered. **Pin note:** an org's `binaries{}` pin keyed on `permission-helper-go` also satisfies its onedrive variant `permission-helper-go-onedrive` (same logical tool, per-backend build); if only the variant is declared, honor that. Do not install two binaries to the same destination.
      - **If the binary is not declared in `org-config.binaries`:** skip it (the org has not opted in). Surface a one-line note: "Available but not pinned: `<name>` (admin can run `@ai:pin-binary-version <name>` to enable)."
      - **If declared:** continue.
   3. Resolve target version per the org's policy:
      - `policy: "pinned"` → use `version` exactly.
      - `policy: "min"` → use max of `version` and the current local version (if any).
      - `policy: "latest"` → use directory's `current_version`.
      - Reject if target version < directory's `min_required_version` (security floor). Surface: "org pin `<version>` is below required floor `<min>`; admin must update the pin before this binary can be installed."
   4. Read local version from the `version_file` path declared in the directory (e.g. `mcp-servers/permission-helper-go/version.txt`). If file missing, treat as "not installed."
   5. **If local == target:** no-op. Move on.
   6. **If local != target (or not installed):**
      - Detect host platform: `os` (`windows` / `darwin` / `linux`) and `arch` (`amd64` / `arm64`).
      - Look up the matching `platforms[]` entry. If none matches, surface "no binary published for `<os>/<arch>`; ask admin to upload one to <release_url>" and skip.
      - Substitute `{version}` and `{filename}` into `release_url_template` to form the download URL.
      - **Prompt the user** with the upgrade summary: source URL, target version, SHA256 (truncated to 12 hex chars), local version (or "not installed"), install destination. Wait for explicit Y/N confirmation in chat. (Per the trust contract: binary downloads always require user approval. This is the one place that approval happens.)
      - **If Y:** download the file, compute its SHA256, compare against the directory's published SHA256. If mismatch, abort and surface "SHA256 mismatch — the published checksum is `<expected>` but downloaded file hashes to `<actual>`; this is a security failure, not retrying. Report to admin." Refuse to install the file.
      - **Signing state comes from the directory binary entry's `signing` field.** If `signing` is `"trusted"`: the assets are code-signed (Windows Authenticode; macOS Developer ID + notarized) and the `sha256` pins the signed bytes — an OS block ("unverified publisher" / Smart App Control) is then a release/signing **defect** (bug `20260626-8d20ea22-2`), do not work around it, report it. If `signing` is `"unsigned-bypass"`: the binary is **intentionally unsigned** while certs are pending — an OS block is **expected**; surface the Smart App Control **Evaluation-mode** workaround from `lib/permission-helper-go/SIGNING.md` (and right-click→Open for an unsigned macOS `.app`), not a defect. Never silently ship around a `trusted`-mode block.
      - On match: write atomically to the `install_destination` path (substituting `{ext}` to `.exe` on Windows, empty otherwise). On Unix, `chmod +x`. Write the version string to the `version_file` path. **On darwin the registerable artifact is the notarized `Agent-Index Helper.app` bundle, not the bare binary** — install via the shipped macOS installer / `.app` (the directory's darwin platform entry points at it), not a loose executable.
      - **Run the per-platform `post_install`** (the directory's `post_install` is now per-platform — E6 schema). Windows/Linux → `{binary} --register` (registry / `.desktop`+`xdg-mime`). **darwin → run the `.app` installer** (`installer/darwin/install.sh` or expand the shipped `.app`/`.pkg`), which places `Agent-Index Helper.app` in `~/Applications/` and registers via `lsregister`. **Never run `--register` against a bare file on darwin** — macOS registers bundles, not loose executables, so it always fails (bug `20260626-8d20ea22` `macosregister`).
      - **On the binary's NATIVE platform, a registration failure is a HARD error** — surface an actionable message and treat the binary as not usable until registered; do NOT swallow the non-zero exit (the pre-C.1 silent-swallow is exactly what let `macosregister` ship). After registering on the native host, **verify**: darwin → `lsregister -dump | grep agent-index:` (or `{binary} --isregistered`); Windows → the HKCU `agent-index` scheme key exists; Linux → `xdg-mime query default x-scheme-handler/agent-index`.
      - **Cowork caveat (hostregister, bug `20260617-8d20ea22-hostregister`):** when running in a Cowork session the agent is in a Linux sandbox and the binary is host-native, so `post_install`/`--register`/the macOS installer **cannot execute here** (and a Linux-sandbox registration of a Windows/Mac binary is NOT host registration). Do NOT report it as auto-registered or "registers on first use." Surface the exact host step as required: Windows PowerShell → `& "{install_path}" --register`; Linux host → `"{install_path}" --register`; **macOS host → run the bundled `.app` installer** (not `--register` on the bare file). The binary is installed; the OS handler wiring is pending until the user runs it on the host.
      - **If N:** skip, surface "skipped — re-run `@ai:apply-updates` anytime to install."
   7. After all binaries reconciled, surface a concise summary: "Binary tools: `<n>` updated, `<m>` skipped, `<k>` already current."

   This step runs on every apply-updates pass. Members who opted out at step 6.7 get re-prompted next time, which is the desired behavior — they may want it later.

   Implementation note: download is via standard HTTPS GET. No auth needed (releases are public on the binaries repo). 30-second timeout per platform-binary download. Transient failure → surface error and skip; subsequent runs retry naturally.

8. **Merge triggers into routing.json.** After updating core files, check the updated `agent-index-core/collection.json` for trigger arrays. If present and `routing.json` exists (or was created by a previous phase in this update), merge new triggers using the same logic as Phase 4 step 4. Core capabilities (org-setup, preferences-management, system-tutorial, apply-updates, author-collection, validate-collection) have triggers that should appear in routing.json alongside member-installed collection triggers.
9. Surface: "agent-index-core updated to {target_version}."

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
3. **Sync `agent-index.json`'s `remote_filesystem.exec.adapter_version`** (added in core 3.7.2; closes idea `bundle-vs-config-adapter-drift`). After step 2 writes the new `adapter.json`, parse the freshly-installed `mcp-servers/filesystem/adapter.json` and read its `version` field. If `agent-index.json`'s `remote_filesystem.exec.adapter_version` differs from this value, rewrite `agent-index.json` to bring them into agreement. The `adapter.json` `version` is the authoritative source — it ships with the bundle and is what the bundle implementation actually exposes; `agent-index.json`'s field is denormalized metadata that historically wasn't kept in sync. Idempotent: same-value no-op. Without this step, the two files can drift indefinitely (the bundle gets updated by this phase but the config field stays at install-time value), which breaks downstream code that reads `agent-index.json` to gate behavior on the adapter version.
4. Write a pending plan file at `.agent-index/install-state/pending-update-plan.json` containing the remaining operations (collection upgrades, installs, etc.) and the `target_cursor`
5. Surface: "Adapter bundle updated to {target_version}. The new executor bundle is ready to use immediately. Say '@ai:update' and I'll continue with the remaining updates."
6. Continue to Phase 4 in this session.

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

3.5. **Sync local capability files for this specific upgraded collection** (added in core 3.6.0; revised in core 3.6.1 to delegate the actual sync mechanics to the standalone subroutine described below). After step 3 above runs (which handles reset-parameter prompts and `member-index.json` upgraded_date stamps), invoke the **manifest-sync subroutine** (defined at the end of this section) for this collection at its target version. The subroutine handles the file reads, LF-normalization, local writes, manifest field synchronization, and `manifest_sync[<collection>]` bookkeeping. In 3.6.0 the mechanics lived inline here, but that placement made step 3.5 unreachable when an apply-updates batch contained no collection-update operations (so the manifest_sync backfill described in the original spec never ran on the very upgrade that introduced the feature — closes bug `20260511-8d20ea22` filed against 3.6.0). In 3.6.1 the mechanics moved to a standalone subroutine called from both here AND from a new Phase 4.5 that runs unconditionally — see below.

4. **Merge new triggers into routing.json.** After upgrading all capabilities from a collection, read the updated `collection.json` from remote and check whether it contains trigger arrays (object-format `api` entries with a `triggers` field). If it does:
   - Read the member's existing `routing.json` from `members/{member_hash}/profile/routing.json`. If it does not exist, initialize it with an empty `mappings` array (version `"1.0.0"`, member_hash, timestamp).
   - For each trigger in the updated collection: check if a mapping with the same `phrase` already exists in `routing.json`. If not, add it with `source: "collection-default"`, `active: true`. If a mapping with the same phrase exists from a different collection, present the collision to the member and let them choose. If a mapping with the same phrase exists from the same collection, leave the existing one (it may have been customized).
   - Write the updated `routing.json`.
   - Surface: "Natural language triggers updated for {collection}."
   
   If the updated collection has no trigger arrays: skip this sub-step.
5. Surface: "{collection} capabilities upgraded to {target_version}."

If a capability's upgrade requires member input (reset parameters or new required parameters): pause, gather input, then continue. The member is not asked about preserved parameters — those carry forward silently.

**Phase 4.5 — manifest_sync drift sweep (added in core 3.6.1, sentinel-trigger added in core 3.7.1)**

This phase runs **unconditionally** on every `apply-updates` invocation that reaches Phase 4 (i.e. any run with at least one operation in the merged plan, regardless of operation type — `core-update`, `marketplace-update`, `collection-update`, `adapter-bundle-update`, or `binary-update`). It detects drift between the member's locally-synced capability files and the org's currently-installed collection versions, and re-runs the manifest-sync subroutine for any collection that's out of sync. This is the structural fix for the 3.6.0 spec bug where step 3.5's drift-detection prose described a one-time backfill that was never reachable because it lived inside Phase 4's per-collection-update loop.

**Subroutine revision constant.** The manifest-sync subroutine (defined below) has a `CURRENT_SUBROUTINE_REVISION` constant that bumps whenever a step is added or its data-shape semantics change. As of core 3.10.1 this constant is **`4`** (revision 4 added step 1.5 — id-anchored read base via the collection's stored `folder_id`, falling back to the legacy `/{collection}` path; this forces a one-time re-sync per collection so reads migrate to id-anchored addressing wherever a `folder_id` is present). Prior: as of core 3.7.6 this constant was **`3`** (revision 1 was the 3.6.1 release with steps 1–6 and step 8; revision 2 added step 7 in 3.7.0, which reconciles `member-index.installed[].version` with the `.md` frontmatter version; revision 3 added step 9 in 3.7.6, which reconciles setup-responses org-mandated values against `collection-setup-responses.md` at the corrected path — closes the data half of bug `20260527-8d20ea22-4`). Phase 4.5 uses this constant alongside `manifest_sync[C]` to decide when to re-run the subroutine — this protects against the structural bug `20260512-8d20ea22` where a 3.7.0 install with already-populated `manifest_sync` (from a 3.6.1+ backfill) had the new step 7 silently skipped.

1. Read `member-index.json`'s `manifest_sync` object (default to `{}` if the field is absent — pre-3.6.1 installs won't have it). Also read `manifest_sync_subroutine_revision` (default to `{}` if absent — pre-3.7.1 installs won't have it; effectively all entries default to revision 0).
2. Build the org's collection-version map: read `aifs_read("/org-config.json")` and extract `installed_collections[]`. For each entry `{ name, version, status }` with `status: "installed"`, record `orgCollectionVersions[name] = version`. (Skip entries that are removed/deprecated.)
3. Build the member's effective collection set: union of the collections appearing in `member-index.installed.skills[].collection` and `member-index.installed.tasks[].collection`. (Members may have a subset of the org's installed collections.)
4. For each collection `C` in the effective set:
   - Let `orgVersion = orgCollectionVersions[C]` (the version the org has installed). If absent (collection is in member's installs but not in org-config — this is an inconsistency; surface a notice and skip).
   - Let `syncedVersion = manifest_sync[C]` (may be undefined).
   - Let `syncedRevision = manifest_sync_subroutine_revision[C]` (may be undefined; treat as 0).
   - Let `canonicalAnchorsMissing` = result of the filesystem-existence sub-check for `C` (see step 4.1 below). Added in core 3.7.3 to close bug `20260519-8d20ea22-2` Layer 1.
   - **This collection is drifted if ANY of:**
     - `syncedVersion` is undefined (never synced), OR
     - `syncedVersion !== orgVersion` (collection version advanced since last sync), OR
     - `syncedRevision < CURRENT_SUBROUTINE_REVISION` (subroutine logic has new steps that haven't run on this collection yet), OR
     - `canonicalAnchorsMissing` (filesystem state doesn't match bookkeeping — added in core 3.7.3).
   - If drifted via `canonicalAnchorsMissing` (regardless of other criteria): surface the filesystem-drift notice (see step 4.2 below) before invoking the subroutine.
   - If drifted: invoke the manifest-sync subroutine for `(C, orgVersion)`.
   - If not drifted: skip.

   **4.1. Filesystem-existence sub-check for collection C** (added in core 3.7.3). Verifies on-disk presence of the canonical install layout, not just the `manifest_sync` bookkeeping field. Catches two known drift classes: (a) pre-3.6.x installs whose capability files exist only at the legacy path (`members/{member_hash}/{type}/{name}/`) and were never backfilled to the canonical path (`members/{member_hash}/installed/{type}/{name}/`) because dual-write only fires on install/upgrade; (b) any flow that advances `manifest_sync` without writing local files (bookkeeping-without-files state).

   1. Read `member-index.json`'s `installed.skills[]` and `installed.tasks[]`, filter to entries with `collection === C`. This gives the list of `{type, name}` pairs to check.
   2. For each `{type, name}`: stat the canonical anchor file at `members/{member_hash}/installed/{type}/{name}/{name}.md` via `aifs_stat`. The anchor file is authoritative — other files (manifest.json, setup.md) can be re-derived from the subroutine if missing; the `.md` file is the capability definition.
   3. Issue the stats in parallel across all capabilities for this collection. Implementations that cannot parallelize fall back to sequential — the result is the same, only the latency differs. For a typical 7-collection install, parallel completes in 1–2 seconds; sequential ~10–20 seconds.
   4. `canonicalAnchorsMissing` is **true** if ANY stat returns "not found." Errors other than not-found (permission denied, network timeout) are treated as "unknown": skip the filesystem check for this collection this run, do NOT set `canonicalAnchorsMissing`, and let the other drift criteria apply. A transient failure should not cause spurious notices.

   **4.2. Notice format on filesystem-drift detection** (added in core 3.7.3). When `canonicalAnchorsMissing` is what triggers the drift classification, surface this line in the apply-updates progress narration immediately before invoking the subroutine:

   > "Detected filesystem drift on collection `{C}`: {N} of {M} installed capabilities are missing from the canonical install layout (`installed/{type}/{name}/`). Re-syncing now."

   Where `{N}` is the count of capabilities with missing anchor files, `{M}` is the total installed capability count for the collection. The notice is informational; the subroutine then runs and (per its current step 5) dual-writes to both legacy and canonical paths, populating the missing canonical anchors.

5. After the loop, both `manifest_sync` and `manifest_sync_subroutine_revision` fields reflect the current synced state and the subroutine revision that last completed for every collection the member has installed.

**First-run sweep behavior on pre-3.6.1 installs.** On the very first 3.6.1 apply-updates run, no collection has a `manifest_sync` entry, so every installed collection is detected as drifted. The subroutine runs for each — for a typical 7-collection / 45-capability install that's ~135 `aifs_read` calls plus writes. Bounded, acceptable, and idempotent (subsequent runs only sweep collections that actually changed). This is the same backfill behavior promised in the 3.6.0 CHANGELOG but couldn't deliver due to the spec bug; the 3.6.1 placement actually delivers it.

**Partial-failure recovery.** If the subroutine fails partway through a collection (e.g. one `aifs_read` errors), `manifest_sync[C]` is left at its prior value (NOT advanced). The next apply-updates run detects the same drift and retries. More robust than a one-shot boolean gate.

**Cost on a no-op run.** If everything is already synced, Phase 4.5 reads `org-config.json` (one remote read) plus N parallel `aifs_stat` calls — one per installed capability, ~45 for a typical install — to power step 4.1's filesystem-existence sub-check. Parallelized, the stat batch completes in 1–2 seconds against the gdrive backend. No file reads, no file writes. Cheap enough to run every invocation. (Pre-3.7.3 the cost was just the single `org-config.json` read; the N stats were added to close bug `20260519-8d20ea22-2`.)

**First-run sweep on pre-3.7.3 installs with legacy-layout-only state.** On the very first 3.7.3 apply-updates run for any install whose canonical install layout (`installed/{type}/{name}/`) is empty for one or more collections — typical of pre-3.6.x installs that never had a collection upgrade trigger the dual-write — step 4.1's filesystem check classifies every such collection as drifted. The subroutine runs for each and dual-writes to both paths via its existing step 5, populating the missing canonical anchors. For an install with all 7 user collections in legacy-only state (~41 capabilities missing canonical anchors), that's ~123 `aifs_read` calls + ~123 `aifs_write` calls, parallelizable per-capability within each collection. Bounded; ~30–60 seconds added latency on first 3.7.3 update; surfaced in the per-cap progress narration. Subsequent runs are clean.

---

**Subroutine: sync local capability files for a collection at a target version** (called from Phase 4 step 3.5 and from Phase 4.5)

Given `(collection, targetVersion)`:

1. **Identify the capabilities to sync.** Read `member-index.json`'s `installed.skills[]` and `installed.tasks[]`, filter to entries with `collection === <collection>`. Each entry has `name` and (implicit by which array) `type`.

1.5. **Resolve the read base (added in core 3.10.1 — Option B id-anchored addressing).** Read `org-config.json` → `installed_collections[]`, find the entry for `<collection>`. If it has a non-empty `folder_id`, set `base = "id:{folder_id}"`. Otherwise set `base = "/{collection}"` (legacy path read — kept for backward compatibility with installs the admin hasn't backfilled yet; behaves exactly as pre-3.10.1). All reads in steps 2–3 use `{base}/...`. **Rationale:** non-admin members are not Drive members and cannot reliably resolve a root-relative collection path (`aifs_list("/")` is unavailable to them; same-named folders are ambiguous — bug 20260606-62a14c43-230135-db13). Addressing by the collection's stored Drive ID makes the read deterministic and immune to name collisions. The `folder_id` is captured admin-side at install (marketplace download/install-collection) and backfilled by Step 1.5 Migration 4.

2. **Read the three canonical files from remote** for each capability (these can be issued in parallel per capability):
   - `def_md = aifs_read("{base}/api/{name}.md")`
   - `setup_md = aifs_read("{base}/api/{name}-setup.md")` — if the file exists; some capabilities have no setup template, in which case `setup_md` is null.
   - `manifest_json = aifs_read("{base}/api/{name}-manifest.json")`

3. **Read the collection.json once** for this collection: `coll = aifs_read("{base}/collection.json")`. Use `coll.version` as the authoritative collection version for the manifest field sync below. (This is the value the org has on remote, which equals `targetVersion` in steady state.)

4. **LF-normalize text content** (added in core 3.6.1; mechanic inlined here in core 3.7.4 — previously cross-referenced Phase 1 step 6's Node-helper-install normalization, which was removed in 3.7.4 when the Node helper was removed). Read the remote file's bytes; replace any `\r\n` sequence with `\n`; replace any standalone `\r` with `\n`; then write. Apply to all `.md` and `.json` content. When the install runs on a Windows host the file-write APIs default to applying CRLF; this normalization step makes the writes deterministic regardless of host OS (closes the data-shape side of bug `20260504-8d20ea22-7` for this code path).

5. **Write each file to the member-local install path(s).** The current install layout is `members/{member_hash}/installed/{type}/{name}/`. While the legacy layout `members/{member_hash}/{type}/{name}/` still exists on a given install, write to **both** paths to keep them in sync (the migration to single-layout is tracked separately and is not in scope here). Specifically write:
   - `{install_dir}/{name}.md` (from `def_md`)
   - `{install_dir}/{name}-setup.md` (from `setup_md`, if read)
   - `{install_dir}/manifest.json` (from `manifest_json`)

6. **Synchronize manifest.json fields** that are mechanically derivable from authoritative sources elsewhere:
   - `manifest.json` `version` ← the value of `version` in the freshly-written `{name}.md` frontmatter (parsed from the `.md` file just written).
   - `manifest.json` `collection_version` ← `coll.version` from step 3.
   - Idempotent: read current values, write only if different. No-op if both already match.

7. **Synchronize `member-index.json` `installed[].version` for this capability** (added in core 3.7.0). Locate the member-index entry for `{type: <type>, name: <name>}` and set its `version` field to the value of `version` in the `.md` frontmatter (the same value just written to `manifest.json` in step 6). This is the data-repair counterpart to the spec clarification in `org-setup` Phase 4 step 11 and Upgrading flow step 9 (also added in 3.7.0): both flows record the `.md` frontmatter version, not the collection version. Pre-3.7.0 installs frequently recorded the collection version here, producing spurious "local ahead of remote" rows in `check-updates`. The Phase 4.5 first-run sweep on a 3.6.x install will reconcile every capability's recorded version with its frontmatter. Idempotent: write only if different from the current value. If the member-index entry is missing (the capability was uninstalled out-of-band): skip the write and surface a notice that the local install directory exists for a capability not in member-index.

8. **After all capabilities for this collection have been resynced successfully**, set `manifest_sync[<collection>] = coll.version` AND `manifest_sync_subroutine_revision[<collection>] = CURRENT_SUBROUTINE_REVISION` (currently 4) in `member-index.json` and write the file. Both fields advance together; if any capability failed in steps 2–7 or step 9, do NOT advance either field; the failure leaves them at their prior values, and the next apply-updates run retries.

9. **Reconcile setup-responses org-mandated values** (added in core 3.7.6 to close the data half of bug `20260527-8d20ea22-4`). For each capability that was just resynced in steps 2–7, check whether its local `setup-responses.md` org-mandated values match the org's authoritative `collection-setup-responses.md` (read via `aifs_read("/{collection}/setup/collection-setup-responses.md")` — note the corrected path; the pre-3.7.6 `org-setup` spec had this wrong, which is why this reconciliation is needed on every existing install). If drifted: re-inject the org-mandated values into the local setup-responses, preserving member-defined and role-suggested values.

   **Detection mechanics:**
   - Read `/{collection}/setup/collection-setup-responses.md` once per subroutine invocation (cache for the loop over this collection's capabilities).
   - Parse the canonical file's org-mandated parameter values. The conventional format written by `org-setup` is a `## Parameters` markdown section containing one `### {param_name}` block per parameter, each with a `- **Value:** {value}` line. Some collections instead use flat top-level YAML (no `## Parameters` section) or pure prose — those formats carry no structured org-mandated parameters that this step can reconcile, and the step is a safe no-op for them. Result on the structured format: a map of `param_name → org_mandated_value`.
   - For each installed capability in this collection (the same set already iterated in steps 2–7):
     - Read the capability's local `members/{member_hash}/installed/{type}/{name}/setup-responses.md`.
     - Parse its `## Org-Mandated Parameters` markdown section (the literal heading written by `org-setup` Phase 4 step 8 is typically `## Org-Mandated Parameters (from collection setup)` — match by the `## Org-Mandated Parameters` prefix, ignoring trailing parenthetical text). Same `### {param_name}` + `- **Value:** {value}` shape as the canonical. If the section is absent — e.g., a placeholder `setup-responses.md` (`"Installed with org defaults."`) produced by an `org-setup` run that couldn't read the canonical at the wrong path; the very bug this step closes — treat the local map as empty: every canonical entry then counts as a missing key (drift).
     - Compare keys + values. Differences (mismatched values OR canonical-only keys) indicate drift.
   - If drift detected: re-inject the canonical org-mandated values into the local file.
     - If the local `## Org-Mandated Parameters` section exists, overwrite its body with the canonical entries (one `### {param_name}` block with `- **Value:** {value}` per canonical key).
     - If it doesn't exist, insert a new `## Org-Mandated Parameters (from collection setup)` section directly after the YAML frontmatter — or after the document title `# {capability} — Setup Responses` if there's no frontmatter — populated with the same per-canonical-key blocks. Add a single blank line before and after.
     - Preserve all other sections (member-defined, role-suggested, setup_status flags, comments, frontmatter) untouched.
     - Idempotent: if no drift, no-op (zero writes for this capability).

   **Failure handling:** if `/{collection}/setup/collection-setup-responses.md` cannot be read (`PATH_NOT_FOUND`, permission denied, malformed YAML), skip this step for the collection with a notice (`"setup-responses reconciliation skipped for {collection}: {error}"`). Subsequent apply-updates runs retry. Does NOT block the overall apply-updates flow; does NOT prevent steps 1–8 from completing.

   **Idempotency contract:** the step is safe to re-run on the same install. If org-mandated values haven't changed at remote, no local writes happen. If they have changed (e.g., admin edited `collection-setup-responses.md` post-install), every member's local install picks up the new values on their next apply-updates run.

   **First-run behavior on existing installs.** Pre-3.7.6 installs have `manifest_sync_subroutine_revision[*] ≤ 2`. The CURRENT_SUBROUTINE_REVISION bump from 2 to 3 in this release means Phase 4.5 classifies every installed collection as drifted on first 3.7.6 apply-updates run. The subroutine runs for each. Steps 1–7 are no-ops (already synced); step 8 advances the revision to 3; step 9 reads `collection-setup-responses.md` and re-injects org-mandated values for every capability with drift. For a 7-collection / 45-capability install with full drift, that's ~7 collection-setup-responses reads + up to ~45 local setup-responses re-injects. Bounded; ~10–20 seconds added latency on first 3.7.6 apply-updates; subsequent runs are no-op.

**Setup-responses: org-mandated values reconciled; member-defined and role-suggested values preserved** (3.7.6+). Pre-3.7.6, this subroutine did NOT touch setup-responses at all. As of 3.7.6 step 9, the subroutine reconciles the `org_mandated:` block of each capability's local setup-responses against the org's authoritative `/{collection}/setup/collection-setup-responses.md` — closing the data half of bug `20260527-8d20ea22-4`. Member-defined and role-suggested values, as well as `setup_status` flags and comments, are preserved untouched. The `org-setup` upgrade flow (called from Phase 4 step 3) remains the one place that mutates the non-org-mandated portions of setup state, with the appropriate carry-forward / reset-parameter logic.

---

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
3. If the member accepts: install capabilities by reading definitions from the **org remote copy** (the admin already placed the collection there via install-collection) — NEVER by re-downloading from GitHub/marketplace, and NEVER by writing collection files to the org remote. Specifically:
   - **Resolve the read base (core 3.10.1, Option B).** Read `org-config.json` → `installed_collections[]` for this collection. If it has a `folder_id`, `base = "id:{folder_id}"`; else `base = "/{collection}"` (legacy fallback). Read `coll = aifs_read("{base}/collection.json")`.
   - **If `{base}` is unreadable** (e.g. `folder_id` absent AND the path won't resolve because the member lacks the all@ reader grant — bug cr01): surface "‘{display_name}’ isn't readable on the org remote yet — ask your admin to (re-)publish it or grant access (`@ai:publish-updates` / re-run `@ai:install-collection {collection}`)." Then SKIP this collection. Do **not** download-and-install, do **not** write any collection files to the org remote. (This is the cr02 safeguard: a non-admin member never performs an org-level collection install.)
   - Present available capabilities from `coll.api[]`; let the member select which to install.
   - For each selected capability, read its definition from `{base}/api/{name}.md` (+ `-setup.md`, `-manifest.json`), run the setup interview, and write the capability into the member's LOCAL workspace (same read+LF-normalize+local-write mechanics as the manifest-sync subroutine; reuse it). Local writes only.
   - Write to `member-index.json`; set `manifest_sync[<collection>]` and `manifest_sync_subroutine_revision[<collection>]` so the new install is recorded as synced. Merge the collection's triggers into `routing.json`.
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

Never advance the cursor without completing or explicitly declining all operations in the merged plan. If the session must end mid-plan (adapter restart, interruption), write `pending-update-plan.json` with the remaining operations (Step 1's resume path) and leave the cursor unmoved — the cursor advances only when the plan is fully resolved.

<!-- RECONSTRUCTED 2026-06-10: final-sentence completion of a tail lost to truncation (bug 20260608-8d20ea22-003039-trunc); reviewed and approved by Bill. -->

<!-- AIFS:FILE-END -->
