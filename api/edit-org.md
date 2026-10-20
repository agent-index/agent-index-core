---
name: edit-org
type: task
version: 3.5.3
collection: agent-index-core
description: Edit org configuration — update the admin list, manage marketplace subscriptions, set the org's distribution channel, or launch the marketplace to install or manage collections.
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

Read `org-config.json` by backend (runtime-reference.md § "Addressing: Owned Content and Sharing", finding 63): gdrive `aifs_read("id:{org_config_id}")` (`org_config_id` from the local `agent-index.json`), with the path `/org-config.json` as the fallback; OneDrive `/org-config.json` first, then `id:{drive_id}:{org_config_id}`. Treat it as missing only if every form returns not-found — an admin off the Shared Drive gets FILE_NOT_FOUND on the bare path, and create-org Step 1 hands exactly that admin to this task (bug `20261011-8d20ea22-183003-2dea`).

If `org-config.json` does not exist or cannot be read (authentication failure, connectivity issue): check `aifs_auth_status()`. If `authenticated: false` with `reason` `network_error`, `tls_or_proxy_error` or `credential_write_failed`, report the `detail` and halt (a connection or local-storage problem, not an expired sign-in). Otherwise, if `authenticated: false`, attempt automatic re-authentication via `aifs_authenticate` and retry the read. If re-auth succeeds and the file exists, proceed normally. If the file does not exist: surface "Your org configuration couldn't be loaded. This could mean the org hasn't been configured yet — say '@ai:create-org' to get started." Halt. If re-auth fails: surface "Your org configuration couldn't be loaded and I wasn't able to restore your remote connection. Try '@ai:member-bootstrap' to troubleshoot." Halt.

Compute the current member's hash: SHA256(lowercase email from session context), take the first 16 hex characters. Check whether this hash matches any entry in `admins[].member_hash` in org-config.json.

If not an admin: surface "Only org admins can edit org configuration. The current admins are: {admin list}. Contact one of them if you need changes made." Halt.

**Unfinished create-org (finding 53).** If the local `.agent-index/install-state.json` has `task: "create-org"`, a `status` other than `"completed"`, and `collected.org_id` equal to this org-config's `org_id`, the org was never finished (no bootstrap zip, collections or admin workspace yet, depending on where it stopped). Say: "This org's setup didn't finish (last step done: {phase3_step, or the last entry of completed_steps}). I'll continue it." and run `create-org`, which resumes from its install state (create-org Step 0). Don't edit a half-created org.

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
> Marketplaces: {enabled subscription display names, or "Agent Index Marketplace (default)" if `marketplaces[]` is absent}
> Distribution channel: {org-config `distribution_channel`, or "none — released code"}
>
> What would you like to do?
> 1. Add or remove an org admin
> 2. Add, edit, or remove org roles
> 3. Update adapter bundle and regenerate bootstrap zip
> 4. Open the marketplace
> 5. Publish updates for members
> 6. Manage marketplace subscriptions
> 7. Set the distribution channel (run unreleased code for testing, or go back to released code)

Route: 1 → Step 3 · 2 → Step 4 · 3 → Step 5 · 4 → Step 6 · 5 → Step 7 · 6 → Step 5.9 · 7 → Step 5.7. Natural language such as "put this org on dev-1" or "switch back to released code" also routes to Step 5.7.

---

### Step 3: Admin List Management

**Adding an admin:**
Ask for the new admin's display name and email address. Compute their member_hash: SHA256(lowercase email), first 16 hex characters. Confirm: "Add {display_name} ({email}) as an org admin?"

On confirmation:
- Add to `org-config.json` admins array with: `member_hash`, `display_name`, `email`, `granted_by` (current admin's hash), and `granted_date` (today YYYY-MM-DD).
- Add or update `members-registry.json` on the remote filesystem via `aifs_read({registry})` (read), modify, then `aifs_write({registry}, ...)` (write back) if the new admin is not already present.
- Write updated `org-config.json` back to remote via `aifs_write({org-config}, ...)` with `last_updated` set to today.

**Removing an admin:**
Present the current admin list by display name. Ask who to remove.

If removing self: warn "You're removing yourself as an org admin. You won't be able to make org-level changes after this. Are you sure?" Require explicit confirmation.

If this would leave zero admins: block the removal. "At least one org admin must remain. Add another admin before removing the last one."

On confirmation: write updated `org-config.json` to remote via `aifs_write({org-config}, ...)` with the admin removed and `last_updated` set to today.

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
7. Write updated `org-config.json` to remote via `aifs_write({org-config}, ...)` with `last_updated` set to today.

**Editing a role:**

1. Present existing roles for selection.
2. Allow changing: `display_name`, `description`, and `default_collections`.
3. Note: `role_id` cannot be changed (would require migration).
4. Confirm changes before writing.
5. Write updated `org-config.json` to remote via `aifs_write({org-config}, ...)` with `last_updated` set to today.

**Removing a role:**

1. Present existing roles for selection.
2. Warn: "Removing this role won't affect members who already have it assigned — their installed capabilities remain. But new members won't see this role as an option during setup."
3. Require explicit confirmation.
4. Remove from `org_roles` array in org-config.json.
5. Write updated `org-config.json` to remote via `aifs_write({org-config}, ...)` with `last_updated` set to today.

---

### Step 5: Update Adapter Bundle and Regenerate Bootstrap Zip

This step downloads the latest adapter bundle and regenerates the member bootstrap zip so new and existing members receive the updated executor bundle.

**1. Check current adapter version:**

Read the local `mcp-servers/filesystem/adapter.json`. Note the current `version` and `bundle_built_at`.

**2. Obtain the adapter bundle:**

**For a self-distributing org (M1/M3, C.1.3.4), prefer the admin's local adapter clone over a `zip_url` download.** The `infra-clone` script already cloned the adapter repo at its resolved ref (the release tag ("pinned tag" in older text), or on a channel org the `channel/<name>` head; see `.agent-index/clone-resolution.json`, written into `<ref>` below); that clone is the canonical source and avoids a stale `zip_url`/directory fetch (same source-of-truth rule as `publish-updates`). Take `dist/aifs-exec.bundle.js`, `dist/aifs-exec.sh`, and `adapter.json` from the clone at the target tag. Only fall back to the `filesystem-adapter-directory.json` → `zip_url` download if no local adapter clone is present (a non-self-distributing org). Whichever source: do NOT `WebSearch` for the adapter version. **Never on a channel org** (org-config `distribution_channel` set): a ZIP is the default branch and would silently revert the org; refresh the clone with the channel instead (core 3.32.0).

Verify bundle integrity: compute SHA-256 of `aifs-exec.bundle.js` and compare against `exec_bundle_checksum` in the downloaded `adapter.json`. If mismatch, report the error and halt.

Compare the downloaded `adapter.json` version against the local version (**compare `exec_bundle_checksum` instead when the org has a channel, or the last publish recorded a channel adapter** (published-state `commits.adapter.ref` starts with `channel/`). A channel candidate can carry the same version with a different build, and returning to released code can mean a lower version.). If the downloaded version is not newer (channel org: the checksum is unchanged): surface "Your adapter bundle is already up to date (version {version}, built {bundle_built_at})." and offer to regenerate the bootstrap zip anyway (the admin may want to regenerate for other reasons, e.g. updated CLAUDE.md or settings).

**3. Replace the local bundle:**

Overwrite the three deployed files in `mcp-servers/filesystem/`. **Source the text files (`aifs-exec.sh`, `adapter.json`) from the git blob, never a working-tree/zip copy (M3, `adapterdeploydoc`, C.1.3.4 — `admin-distribution.md` § "Release procedure (admin-side)", "Host-deploy byte-exact files via `git cat-file`/`git show`").** A Windows working-tree copy CRLF-converts the shell wrapper and corrupts the executor — observed live in the ms_install_10 publish, where the deployed `aifs-exec.sh` came up CRLF and broke `bash` until it was re-deployed from the blob. So:

- `aifs-exec.bundle.js` — copy **byte-exact** (it is checksum-gated against `exec_bundle_checksum`; preserve it exactly, do not normalize). If sourced from a clone, `git -C <adapter-clone> cat-file blob <ref>:dist/aifs-exec.bundle.js > mcp-servers/filesystem/aifs-exec.bundle.js` (`<ref>` = the adapter's resolved ref from `clone-resolution.json`).
- `aifs-exec.sh` and `adapter.json` — deploy from the git blob (`git -C <adapter-clone> show <ref>:dist/aifs-exec.sh` / `<ref>:adapter.json`), which is LF-correct on every platform, **not** a `Copy-Item`/`cp` from the working tree.

After deploying, **smoke-test the new executor** (an `aifs_auth_status` + a verified read) and confirm the wrapper is LF (no CRLF) before proceeding — catch a torn/CRLF deploy here, not after the bootstrap zip ships it to members.

**Sync `agent-index.json` (`editorgadapterversion`, core 4.0.0 live test finding 28).** Set the local `agent-index.json` `remote_filesystem.exec.adapter_version` to the new `adapter.json` `version` (shell-first write, read back and `JSON.parse`), the same sync apply-updates Phase 3 step 4 does for members. Do it before step 5: the bootstrap zip bakes in this `agent-index.json`, so a stale value would ship to every new member.

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

### Step 5.7: Distribution Channel (added in edit-org 3.5.0 / core 3.32.0)

See `admin-distribution.md` § "Distribution channels (core 3.32.0)". Show the current value and, if `.agent-index/clone-resolution.json` exists, each repo's resolved ref and short commit.

1. **Choose:** set or change the channel (a name such as `dev-1`, validated against `^[a-z0-9][a-z0-9-]{0,39}$`), or clear it (back to released code).
2. **Explain before writing:**
   - Every repo with a `channel/<name>` branch will come from that branch head; the rest stay on released code.
   - Members get it at their next update.
   - The org shows a channel banner until it's cleared.

   When clearing: the org returns to the latest release tags at the next refresh and publish.
3. **On explicit confirmation,** write org-config `distribution_channel` (safe org-config rewrite rule, revision-aware) and the local `agent-index.json` mirror.
4. **Offer to apply it now, in this order:**
   1. **Refresh clones:** emit the infra manifest and a collections manifest for every installed collection repo, both with the new `channel`, via the clone-manifest emitter. Surface the committed `clone-repos` invocation and wait for the admin to run it.
   2. **Collections:** run `@ai:upgrade-collection {name}` for each installed collection whose refreshed clone commit differs from its `source_commit`. upgrade-collection compares commits here, so a move back to a lower released version works.
   3. **Adapter:** run Step 5 (adapter update) if the adapter clone's bundle checksum differs from the deployed one.
   4. **Publish:** run `@ai:publish-updates`.

   publish-updates sees the channel change and treats every component whose backend identity changed as updated, so members move in either direction, including back to a lower released version.
5. **Never switch silently.** A channel is only ever set or cleared here or by create-org.

### Step 5.8: Capability Provider Management (added in 3.10.0)

If the admin asks to view, deregister, or re-order capability providers:

1. Read `org-config.json` via `aifs_read` → `capability_providers`. Present each capability type with its registered providers (collection, version, operations, registered date/by).
2. **Deregister:** on explicit request, confirm: "Deregistering `{collection}` as a `{capability}` provider means consumer collections that resolve this capability will fall back to their declared fallback behavior on their next run. Proceed?" On yes: remove the provider entry (revision-aware write, `if_revision`), append a `provider-deregister` op to the update log (`reason: "manual"`), and surface which installed collections declare `requires[]` for this capability so the admin knows what degrades.
3. **Re-registration** happens through `@ai:install-collection` (reconfigure) or `@ai:upgrade-collection` — do not hand-edit registry entries here beyond removal and ordering.

If the member asks about registering a provider, direct them to `@ai:install-collection {collection}` — registration is install/upgrade-time, admin-confirmed.

### Step 5.9: Manage Marketplace Subscriptions (added in 3.3.0 / core 3.30.0)

Normative model: `admin-distribution.md` § "Marketplaces: catalogs, subscriptions, provenance (normative — core 3.30.0; collision rules revised in 3.31.0)". Subscriptions are org policy — admin-only, verified in Step 1.

Read `org-config.json` → `marketplaces[]`. If absent, show the synthesised legacy subscription (`agent-index-public`) and note: "This will be recorded on your next publish." Present each subscription: display name, id, source kind + ref, namespace, enabled, `skip_if_unavailable`, and the count of `installed_collections[]` entries whose `marketplace_id` references it.

Actions:

1. **Subscribe to a catalog.**
   - Ask for the source. v1 accepts **`clone`** only for new subscriptions: the catalog repo's git URL. (`url` exists solely for the synthesised legacy entry; `backend` is reserved — refuse with "Backend-hosted catalogs aren't supported yet.")
   - If the repo is not already cloned under the install root, add it to the **infra clone manifest** (with the org's `channel`) and surface the committed `lib/clone/clone-repos` invocation per the `clone-manifest-emitter` subroutine (`templates/clone-script-generator.md`). **Never author a clone script and never run git from the sandbox** — the admin runs the committed script natively. Halt until the admin confirms it ran; then confirm the clone exists and its `origin` matches the git URL.
   - Read the clone's `marketplace-directory.json`. **Refuse** if it lacks `marketplace_id`, if that id is already subscribed, if any of its collection names is already offered by another subscribed catalog (unique names — core 3.31.0), if any of its names falls in a prefix another subscribed catalog reserves, if any *other* subscribed catalog offers a name in the prefix this catalog reserves, or if its reservation overlaps an existing one. Name the offending entries. A catalog may declare `namespace: null` (reserve nothing), and its own entries may use any names — namespaces only reserve, they do not restrict (3.31.0).
   - Show the admin what they are subscribing to — id, display name, namespace, entry count and names — and confirm.
   - Write the subscription (`source.ref` **relative to the install root**, never absolute — `appspathsandboxleak`; `trust_anchor.git_url`; `enabled: true`; `skip_if_unavailable: false`; `subscribed_date`/`subscribed_by`) via the **safe org-config rewrite rule** (see `create-org` Step 10: unique `mktemp` staging, identity assert, content assert that the new id is present, no glob/mtime re-select). Read back.
2. **Disable / re-enable** — flip `enabled`. Confirm first when disabling a catalog that installed collections reference: "{n} installed collections came from this catalog. They stay installed; update checks will report them as 'source disabled' until you re-enable it."
3. **Unsubscribe** — remove the entry. **Never modify `installed_collections[].marketplace_id`** — provenance survives unsubscription. Confirm with the same count warning, and refuse to unsubscribe or disable `agent-index-public` — `agent-index-core` and `agent-index-marketplace` are always tracked against it.
4. **Toggle `skip_if_unavailable`** — explain before enabling: "If this catalog can't be read, listings will continue without it and say so. Leave off unless the source is known to be flaky."
5. **Set a local display name** — only `display_name`; the `id` is the catalog's and never changes.

There is no priority or ordering setting, by design (`admin-distribution.md` § "Collisions"). If the admin asks for one, explain that names must be unique across subscribed catalogs, so a clash is always refused rather than resolved by ordering, and point to fork-and-rename for replacing a public collection.

No publish is needed after a subscription change: the write above is the record, and subscription changes produce no member update operations — members never read catalogs.

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

**Remote addressing (CI-019; `memberpathreads`, finding 63).** Every org-config, registry and `/shared` read **and write** in this task uses the per-backend form below, so it also works for an admin who is not a member of the org's Shared Drive (a bare path returns not found for them on Google Drive). Backend: local `agent-index.json` `remote_filesystem.backend`.

| Written in this task as | Google Drive | OneDrive |
|---|---|---|
| `{org-config}` | `id:{org_config_id}` (local `agent-index.json` → `remote_filesystem.connection.org_config_id`) | `/org-config.json` |
| `{registry}` | `id:{resource_ids.members_registry}` (from org-config) | `/members-registry.json` |
| `{shared}/...` | `id:{resource_ids.shared_root}/...` (from org-config) | `/shared/...` |

On Google Drive, if an id is missing (an org that predates `resource_ids`), halt and name it rather than falling back to a bare path; `publish-updates` Step 6f back-fills it.

### Behavior

Keep this task efficient. Org admins using it know what they want. Present the current state clearly and act on the request.

Admin list changes are consequential — always confirm before writing. Removing the last admin is blocked at the constraint level, not just warned about.

Org role changes are informational for existing members — they only affect the onboarding experience for new members. Surface this clearly when adding or removing roles.

### Constraints

Never allow the admin list to be emptied. Minimum one admin at all times.

Never allow `org_name`, `org_id`, or remote filesystem configuration to be changed through this task. Those are set at create-org time. Changes to those fields would require a migration process beyond the scope of this task.

Only org admins may execute changes. The admin's identity is verified in Step 1 against `org-config.json`'s `admins[]` (by `member_hash`) before any write; a non-admin invocation is refused there and nothing is modified.
