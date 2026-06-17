---
name: invite-member
type: task
version: 1.7.0
collection: agent-index-core
description: Admin-only task that onboards a new agent-index member. Computes the member hash, creates the member's private and shared-artifact directories, delegates ACL changes to the permission-change-helper for member-confirmed application, verifies the member is in the all-members Google Group, registers them in members-registry.json, and emails install instructions.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills:
    - permission-change-helper
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle (gdrive contract v2.0+)
    description: Reads use aifs_get_permissions and revision-aware aifs_write — both introduced in adapter contract v2.0. Permission writes (share, unshare, transfer_ownership) go through the permission-change-helper skill rather than being called directly from this task. Will fail clearly if the installed adapter declares contract_version < 2.0.0.
  - name: permission-change-helper Go binary
    description: The pre-built Go binary `agent-index-show-plan` at `mcp-servers/permission-helper-go/agent-index-show-plan{.exe}`, installed by core 3.4.0+ via `apply-updates` Phase 1 step 7. The helper renders a review page for the admin and applies the ACLs after a member-confirmed Accept. If not present, the helper skill's setup check surfaces the install issue. (Pre-3.7.4 also shipped a Node fallback; removed in 3.7.4 — closes idea `remove-node-permission-helper-fallback`.)
  - name: All-members group
    description: The org's all-members group whose membership is the authoritative agent-index member roster — a Google Group on gdrive, a Microsoft 365 group on onedrive. Address is read from org-config.json remote_filesystem.connection.all_members_group. New members are added to this group at the identity-provider level (out-of-band; agent-index does not hold Workspace/Entra admin credentials): gdrive → Google Workspace Admin Console → Groups; onedrive → Microsoft 365 admin center → Teams & groups (for a group-connected SharePoint site, this group's membership IS the site membership).
reads_from: "/members-registry.json"
writes_to: "/members-registry.json,/members/,/shared/members/artifacts/"
---

## About This Task

`invite-member` is the admin-side onboarding flow for a new agent-index member. The admin runs this when they want to add someone to the org. The task is admin-only — non-admin members will be told to ask their admin.

The flow is intentionally narrow: agent-index manages team membership; the org's identity provider (Google Workspace / Microsoft Entra) manages identity. This task does **not** create an account, add the new member to the Workspace/tenant, or grant storage access at the identity-provider level. Those are out-of-scope. **In particular it does not require the admin to pre-stage the member as a SharePoint site member** — member access is provisioned by the direct per-member shares in step 3 (applied via the permission-change-helper), so the realistic flow is "invite, the framework provisions access," not "remember to add them to the site first." What it does:

1. Compute the deterministic `member_hash` from the new member's email.
2. Create the member's private directory (`/members/{hash}/`) and shared-artifact directory (`/shared/members/artifacts/{hash}/`). Apply explicit ACLs (admin + new member as writers on both) by handing a batched permission-change spec to the `permission-change-helper` skill — the admin reviews and confirms all shares on a single page, then the helper's apply-script applies them with the admin's existing OAuth token.
3. Share the org-readable infrastructure files (CLAUDE.md, org-config.json, members-registry.json, bootstrap zip) + collection roots with the new member, as **direct per-member shares** applied through the permission-change-helper. Direct shares (not group inheritance) are what make `aifs_list` enumeration work for a non-member — established empirically on gdrive (see Category B) and assumed to hold on OneDrive/SharePoint (the onedrive analog is confirmed by the 2-account M365 test). The `all_members_group` add is a parallel out-of-band roster step (verified by admin attestation), but the direct shares are what actually grant working access — so a member is functional even before group propagation, and no site pre-staging is needed.
4. Append the member's entry to `members-registry.json` using a revision-aware write (so two admins inviting members concurrently don't overwrite each other).
5. Email the new member their install instructions.

If the same email was previously invited and removed, the existing `/members/{hash}/` directory is **reused** (per access-control project decision). Old captures and ideas remain in place when the member returns.

### Inputs

- `email` — required. New member's email address (lowercased internally for hashing).
- `display_name` — required. How the member wants to be addressed.
- `confirm_reuse` — implicit. If `/members/{hash}/` already exists, the task asks before reusing.

### Outputs

- `/members/{hash}/` (created or reused; ACL set to admin + member writer)
- `/shared/members/artifacts/{hash}/` (created or reused; same ACL)
- `members-registry.json` (member entry appended; revision-aware write)
- Welcome email to the new member with bootstrap zip link and first-run instructions

### Cadence & Triggers

On demand, when an admin wants to add a new member.

---

## Workflow

### Step 1: Pre-flight checks

1. **Confirm caller is an admin.** Read `org-config.json` from the remote filesystem. Verify the calling member's `member_hash` appears in the `admins` array. If not: surface "Only org admins can invite new members. Ask one of: {list admin display_names from org-config}." and stop.

2. **Confirm the gdrive adapter is at contract v2.0+.** Read the local `mcp-servers/filesystem/adapter.json`. Check `contract_version`. If absent or `< 2.0.0`, the install hasn't completed the v3.1.0 upgrade. Surface: "This task requires the v3.1.0 adapter (contract v2.0). Run `@ai:update` first." and stop.

3. **Confirm `remote_filesystem.connection.all_members_group` is configured.** If absent or empty, the v3.1.0 upgrade prerequisite wasn't fully completed. Surface: "The all-members Google Group address is missing from org-config.json. Run `@ai:update` to complete the v3.1.0 setup, then retry." and stop. (Defense-in-depth — apply-updates Phase 0 should have caught this, but invite-member doesn't depend on that having run successfully.)

### Step 2: Collect inputs

Ask the admin for:
- New member's email address.
- Display name for the new member.

If the admin provided either inline (e.g., "invite jeff@agent-index.ai as Jeff Rohwer"), accept it and confirm.

### Step 3: Compute member hash

```
member_hash = sha256(email.toLowerCase()).hex.slice(0, 16)
```

Use Node's built-in `crypto`:

```javascript
import { createHash } from 'node:crypto';
const member_hash = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
```

Confirm the hash to the admin: "I'll provision org access for `{email}` (hash `{hash}`). Continue?"

### Step 4: Re-invite detection

Check whether the email was previously a member: look for a `members-registry.json` entry with this `member_hash`, and check `aifs_exists("/shared/members/artifacts/{hash}/")`.

If previously a member:

> This email was previously a member. Their shared-artifacts directory (`/shared/members/artifacts/{hash}/`) still exists, and their private member space (if any) is in their own My Drive — outside org control, untouched by removal or re-invite.
>
> Re-add this email as a member (reusing the artifacts directory), or stop and let me know how to handle it differently?

If the admin says reuse: proceed to Step 5 (skip creation where things exist, refresh ACLs and registry).

If the admin says stop: surface "Stopped. Let me know how you'd like to proceed and we can retry." and exit cleanly.

### Step 5: Create or refresh the member's shared-artifacts directory (structural only)

This step creates the folder if it doesn't exist. It performs **no permission writes** — those go through the helper in Step 6.

- Check `aifs_exists("/shared/members/artifacts/{hash}/")`.
- If it does not exist: materialize it via `aifs_write("/shared/members/artifacts/{hash}/.placeholder", "")`.
- If it already exists (re-invite case): leave it untouched.

**The member's private space is NOT created here** (changed in core 3.9.0). It is a folder named `Agent-Index-Private` in the member's **own personal space** — their My Drive on gdrive, their OneDrive on onedrive — created by the member's own credentials during their first bootstrap (`member-bootstrap` ensure-my-drive-space subroutine) — member-owned so the member can apply sharing grants on it themselves (Shared-Drive folders can only be shared by drive Managers, which members deliberately are not; on onedrive the member owns their OneDrive items outright). On onedrive this requires the member to have a OneDrive-inclusive license and to have signed into office.com once (see memberlicense; create-org now surfaces this prerequisite to the admin). The bootstrap writes a handshake file to `/shared/members/artifacts/{hash}/member-folder.json`; the admin's next `@ai:publish-updates` reconciles it into the registry. Legacy `/members/{hash}/` directories on the Shared Drive are deprecated (migration handled by apply-updates 3.9.0 Migration 2; admin archives the old folders manually afterwards).

### Step 6: Apply ACLs via permission-change-helper

The access grants are batched into a single helper invocation. The admin reviews and confirms all shares on one page; the helper's apply-script applies them with the admin's existing OAuth token. This task never calls `aifs_share` directly — that's prohibited by the agent-side safety boundary the helper exists to navigate.

**Two share-set categories** (extended in core 3.7.4 to close bug `20260522-8d20ea22` properly):

**Category A — Member-directory writer grants (narrowed in 1.6.0):** the new member + admin both need writer on the member's shared-artifact directory (`/shared/members/artifacts/{hash}/`) only. The private member space is in the member's own My Drive (member-owned; the org holds no grant on it and needs none).

**Category B — Direct reader shares on org-readable roots (new in 1.3.0):** non-member access to org folders works through DIRECT shares, not group-mediated inheritance. On **gdrive** this is established empirically: the Drive API returns 0 results when a non-Drive-member tries to enumerate children of a folder they have access to only via group inheritance — even with full read rights on the contents — so direct shares are required for `aifs_list` to surface entries (verified with two-account testing during the 3.7.4 cycle; see `agent-index-filesystem-gdrive` 2.4.1 CHANGELOG; this share set is what bug `20260522-8d20ea22` originally missed).

**OneDrive/SharePoint (Release B):** the same direct-share approach is used — the new member gets direct reader shares on the org-readable roots + collection roots via `aifs_share` (onedrive 2.1.0) through the helper, rather than relying on SharePoint site membership being pre-staged. **Assumption (gdrive parity): a SharePoint/OneDrive non-site-member with a direct per-item share gets both read AND list on that item.** This is the one M365 behavior not yet empirically confirmed — the 2-account ms-install-4 invite test verifies it. If it turns out a non-site-member CANNOT enumerate via direct shares (i.e. SharePoint requires site membership for list, unlike the per-item direct-share model), the fallback is to make the `all_members_group` add (= site membership for a group-connected site) the required access step and prompt the admin for it before the member's first session — record the finding and switch the model. Until contradicted, direct shares are the mechanism on both backends.

The Category B set covers every top-level path a non-admin member needs to walk:
- `/shared/` — folder; enables listing all org-shared subtrees (projects, marketplace-cache, updates, bug-reports, members artifacts, installed-collection-specific subfolders)
- For each `installed_collections[]` entry in `org-config.json` with `status: "installed"`, EXCEPT `agent-index-core` and `agent-index-marketplace` (which are infrastructure-only — collection.json read via global name search by ID): `/{name}/` → reader. Enables listing `api/`, reading `collection.json`, and walking into the collection's tree.
- **Root-level org-readable files** (added in invite-member 1.4.0 as defense-in-depth backing the `create-org` install-time grants — closes the per-invite half of bug `20260527-8d20ea22-3`):
  - `/CLAUDE.md` → reader
  - `/org-config.json` → reader
  - `/members-registry.json` → reader

  These three files are normally readable to non-admins via the all-members group grants `create-org` 3.1.1+ establishes at install time. The per-member direct shares here are belt-and-suspenders: if the create-org grants somehow get removed (admin manually edits ACLs, group membership semantics change, drift from any other cause), the per-invite direct grants pick up the slack. If the group grants are intact, the per-invite grants are no-ops (the pre-state filter at item 1 below excludes them from the spec).

**Build the spec:**

1. Read pre-state for ALL target paths (Category A + B) to capture current ACLs (used as the `before` field for diff visualization, and to filter shares that would be no-ops):

   ```
   artifacts_pre = aifs_get_permissions("/shared/members/artifacts/{hash}/")
   shared_pre    = aifs_get_permissions("/shared/")
   # Root-level org-readable files (added in 1.4.0):
   claude_pre    = aifs_get_permissions("/CLAUDE.md")
   orgconfig_pre = aifs_get_permissions("/org-config.json")
   registry_pre  = aifs_get_permissions("/members-registry.json")
   # For each installed user-facing collection {coll_name}:
   coll_pre[{coll_name}] = aifs_get_permissions("/{coll_name}/")
   ```

   Note: `aifs_get_permissions` is read-only and agent-callable directly — only *write* ops go through the helper.

2. Build the operations list:

   **Category A (2 entries, narrowed in 1.6.0):** `{/shared/members/artifacts/{hash}/} × {admin_email, new_member_email} × {writer}`.

   **Category B (4 + N entries):** for each path in `{/shared/, /CLAUDE.md, /org-config.json, /members-registry.json} ∪ {/{coll_name}/ for each installed user-facing collection}`, add a single share `{path, new_member_email, reader}`. Admin already has access (organizer or explicit) so no admin-side share needed here.

   For each tuple, look up the recipient in the corresponding pre-state. If the recipient already has the requested role on the path (via direct grant OR group inheritance through all@): **omit** this operation (no-op). Otherwise: include it.

   For a fresh invite to an org with 8 installed user-facing collections + intact `create-org` 3.1.1+ all@ grants on root-level files, the spec contains: 4 (Category A) + 1 (`/shared/`) + 3 (root-level, all no-ops because of intact group grants) + 8 (collection roots) = 13 effective operations. If the `create-org` grants are missing for any root-level file, those become effective ops (defense-in-depth at work). For a re-invite where the admin already has access on the Category A folders and only the member needs to be re-added, the spec is correspondingly smaller.

3. Compose the spec. The example below shows the shape for a fresh invite on an org with 2 installed user-facing collections (`projects`, `client-intelligence`). Adapt the Category B `share` operations to whatever set of `installed_collections[]` entries with `status: "installed"` the org actually has, excluding `agent-index-core` and `agent-index-marketplace`.

   ```json
   {
     "version": "1.0",
     "operations": [
       {
         "op": "share",
         "resource": "/members/{hash}/",
         "recipient": "{admin_email}",
         "role": "writer",
         "before": { "recipients": <members_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/members/{hash}/",
         "recipient": "{new_member_email}",
         "role": "writer",
         "before": { "recipients": <members_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/shared/members/artifacts/{hash}/",
         "recipient": "{admin_email}",
         "role": "writer",
         "before": { "recipients": <artifacts_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/shared/members/artifacts/{hash}/",
         "recipient": "{new_member_email}",
         "role": "writer",
         "before": { "recipients": <artifacts_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/shared/",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <shared_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/projects/",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <coll_pre[projects].permissions> }
       },
       {
         "op": "share",
         "resource": "/client-intelligence/",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <coll_pre[client-intelligence].permissions> }
       },
       {
         "op": "share",
         "resource": "/CLAUDE.md",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <claude_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/org-config.json",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <orgconfig_pre.permissions> }
       },
       {
         "op": "share",
         "resource": "/members-registry.json",
         "recipient": "{new_member_email}",
         "role": "reader",
         "before": { "recipients": <registry_pre.permissions> }
       }
     ],
     "context": {
       "requestor": "{admin_member_hash}",
       "calling_task": "invite-member",
       "purpose": "Onboarding {display_name} ({new_member_email}) under {org_name}: writer on their member directories + reader on org-readable roots so path-walking works (the access-control Phase 4 model relies on direct shares, not group inheritance, for list-visibility — see gdrive 2.4.1 CHANGELOG)."
     }
   }
   ```

   (Filter out any operations the pre-state read marked as no-ops before submitting.)

4. If the filtered operations list is empty (all required grants already in place — uncommon but possible on a re-invite of a member whose ACLs were never cleaned up): skip Step 6 entirely. Surface to the admin: "All required ACLs are already in place; no permission changes needed."

**Invoke the helper:**

Call the `permission-change-helper` skill with the spec. The helper validates, opens a review page in the admin's browser (or its `--cli` fallback), waits for the admin's deliberate Accept, then runs the apply-script which calls the actual `aifs_share` ops. The apply-script's per-op verification reads back the post-state and includes it in the helper's structured outcome.

Surface to the admin before invoking, in the chat:

> I'm opening a review page in your browser. It'll show {N} share operations across `/members/{hash}/` and `/shared/members/artifacts/{hash}/`. Click Accept to apply them with your own credentials.

**Branch on the helper's outcome:**

- **`applied`** — All requested shares succeeded. The helper returns `verified_post_state` with the post-share recipients lists. Continue to Step 7.

- **`rejected`** — The admin clicked Reject. No shares were applied. Surface to the admin: "Invite cancelled. No permissions were modified, no registry entry was written." Halt the task; return without applying any further side effects (registry untouched, no welcome email).

- **`timed_out`** or **`page_closed`** — The admin opened the review page but didn't decide within the helper's idle timeout, or closed the page without deciding. Surface: "The review window closed without your decision. The invite is on hold; nothing has been applied. Want to retry?" If yes, return to the start of Step 6. If no, halt cleanly.

- **`partial_failure`** — Some shares applied, some failed. The helper returns `applied_operations` and `failed_operations`. Surface a per-failure summary using the helper's `error_detail` and the typed error codes from the apply-script (e.g., `INVALID_RECIPIENT` if the email is malformed or in a different Workspace; `ACCESS_DENIED` if the admin's OAuth doesn't permit the share). Offer to retry the failed operations only, or halt. **Do not** continue to Step 7 (registry update) until either all 4 shares are applied or the admin has explicitly accepted the partial state and confirmed they want to proceed anyway. The default should be halt — partial state is typical of cross-Workspace cases where the recipient's email is in a domain the org's external-sharing policy doesn't allow, and the right answer is to fix the Workspace policy first.

- **`apply_error`** or **`verification_failed`** — Hard failure (the apply-script crashed or post-state verification revealed a discrepancy). Surface the error verbatim, halt the task, do not write to the registry.

- **`binary_not_found`** — The helper's Go binary is missing at `mcp-servers/permission-helper-go/agent-index-show-plan{.exe}`. Indicates the install is incomplete or predates 3.4.0. Surface: "The permission helper Go binary isn't installed. Run `@ai:update` to install or upgrade it, or `@ai:member-bootstrap` if the install appears broken." Halt.

The helper's verification step replaces the eventual-consistency polling loop the pre-1.1.0 task did manually after each share. Drive's API is still eventually consistent, but the apply-script handles the polling internally; by the time the helper returns `applied`, the post-state has been verified.

### Step 7: Verify the all-members group includes the new member

This is a soft check — agent-index doesn't hold identity-provider admin credentials to query group membership directly. The direct per-member shares from Step 6 are what actually grant working access; the group is the roster (and, on a group-connected SharePoint site, the site-membership signal). Instead:

1. Read `org-config.json remote_filesystem.connection.all_members_group` and the org's `remote_filesystem.backend`.
2. Surface to the admin (backend-aware wording):
   > Has `{new_member_email}` been added to the all-members group `{all_members_group}`?
   >
   > They already have working access via the direct shares I just applied — this group add is the roster step (and on OneDrive/SharePoint, group membership of a group-connected site is what keeps their access durable as the org evolves).
   >
   > **Yes, they're in the group** — continue.
   > **No, not yet** — I'll continue (their direct shares already work). To add them: **gdrive** → Google Workspace Admin Console → Groups; **onedrive** → Microsoft 365 admin center → Teams & groups → the site's group → Members. Allow a couple minutes for propagation.
   > **Add them later** — same as no.

3. Record the admin's response in the activity (does not block).

### Step 8: Append to `members-registry.json` (revision-aware)

Read the current registry with revision:

```
{ content, revision } = aifs_read("/members-registry.json")
```

(Note: `aifs_read` returns content as a string; the revision can be obtained via a parallel `aifs_stat("/members-registry.json")` call which returns `{ revision, ... }` in v2.0.)

Parse, append the new member entry:

```json
{
  "member_hash": "{hash}",
  "display_name": "{display_name}",
  "email": "{email}",
  "org_role": "{default-role-from-org-config-or-prompt}",
  "joined_date": "{today YYYY-MM-DD}",
  "member_folder_id": null
}
```

`member_folder_id` is `null` at invite time (changed in 1.6.0): the member's private space is created in their own My Drive during their first bootstrap, which writes a handshake file to `/shared/members/artifacts/{hash}/member-folder.json`; the admin's next `@ai:publish-updates` reconcile copies the ID into this registry entry. The registry remains the authoritative org-side record once reconciled (standards.md § "Addressing").

Write back with the captured revision:

```
aifs_write("/members-registry.json", new_content, if_revision=revision)
```

If `REVISION_CONFLICT`: re-read, re-apply, retry. Cap at 5 retries before surfacing an error to the admin (another concurrent registry write would be unusual but not impossible).

### Step 9: Send welcome email

Compose and offer to send an email to `{email}`:

```
Subject: Welcome to {org_name} on agent-index

Hi {display_name},

You've been invited to {org_name}'s agent-index install. Here's what you need to get started:

1. Download the bootstrap kit: {bootstrap_zip_share_link}
2. Unpack it to a folder of your choice (this becomes your local agent-index workspace).
3. Open Claude (Cowork or Claude Desktop with the folder selected). On first run, Claude will guide you through authenticating to {backend_display_name} as yourself.

A note on access: your account isn't a member of the org's Shared Drive itself — that's by design. Instead, you have reader access to org-readable files (CLAUDE.md, org-config.json, the marketplace cache, etc.) via the all-members group, plus writer access on your own member directory via an explicit per-file share. Practically: everything you need works; you'll just notice you can't see the Shared Drive in your Drive UI's left sidebar, which is correct. If you have questions about the access model, ask your admin.

If your first session reports "access denied" reading the org infrastructure files, wait two minutes and retry — Workspace group membership propagation can lag a couple of minutes.

Questions? Reply to this email. — {admin_display_name}
```

Use the existing email-send capability (or surface the draft for the admin to send themselves if no email integration is available). Drive's "share" sendNotificationEmail flag is intentionally NOT used (and the helper's apply-script also leaves it false) — this welcome email replaces it.

### Step 10: Confirm and log

Surface to the admin:

> Done. `{display_name}` ({email}) is now a member.
> - Artifacts dir: `/shared/members/artifacts/{hash}/` (admin + member writer)
> - Private space: created in THEIR My Drive at first bootstrap (`Agent-Index-Private`); registry gets the folder ID via your next `@ai:publish-updates` reconcile
> - Registry: appended at revision {new_revision} (member_folder_id pending bootstrap)
> - Welcome email: {sent | drafted | skipped}
>
> The shares were applied via the permission-change-helper; you can review the plan that was applied at `outputs/permission-plan-{timestamp}.json` if you want a record of exactly what was approved.

Append an activity event to a local audit hint file (no remote audit log — that comes from Drive Activity directly). The admin can run `view-audit /members/{hash}/` afterwards to see the share events natively.

---

## Directives

### Behavior

- This task is admin-only. The pre-flight check rejects non-admins early.
- All ACL changes execute under the calling admin's OAuth identity. The new member's identity is never assumed.
- Permission writes go through the `permission-change-helper` skill, never directly. The helper renders a review page, the admin clicks Accept, and the apply-script applies the changes with the admin's existing credentials. This task is upstream of the privileged action; the admin's deliberate click is what executes it.
- Re-invite handling reuses the existing `/shared/members/artifacts/{hash}/` directory by default. The returning member's private My Drive space is theirs — re-running bootstrap finds or recreates it; the org never touches it. The admin can choose to halt instead, but **never** overwrite, archive, or wipe without explicit confirmation.
- Group membership is verified through admin attestation, not API query. agent-index has no Workspace admin credentials.

### Constraints

- Never invite an admin to add themselves as a member of their own org. The pre-flight check rejects the case where `email` matches an existing entry in `org-config.json admins[].email` (admin is implicitly already a member).
- Never create `/members/{hash}/` on the Shared Drive (retired in 3.9.0 — legacy directories are archived by the admin after members migrate). Never read, write, or attempt permission changes on a member's My Drive space — the org has no access, by design.
- **Never call `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` directly from this task.** All permission writes go through the `permission-change-helper` skill. This is enforced by `agent-index-core/standards.md` § "Permission-Modifying Operations." Direct calls would be both an authoring error (caught by future preflight) and a runtime failure (the agent's safety boundary refuses them).
- Never write to `members-registry.json` until the helper has confirmed the share batch applied successfully (or the admin has explicitly accepted a partial-state outcome). The registry-after-shares ordering protects against the partial state where a registry entry exists but the new member can't actually access anything.

### Edge Cases

- **The all-members group doesn't exist yet.** Step 7 surfaces this and gives admin the option to continue or stop. If continuing, the new member's first session may fail until the group is set up — the welcome email warns about this.
- **The new member's email is in a different domain than the Workspace.** Drive sharing across Workspaces depends on the Workspace's external-sharing policy. The helper surfaces the failure mode through `partial_failure` outcome with `INVALID_RECIPIENT` or `ACCESS_DENIED` per-op errors. The Step 6 branch logic halts the task in this case rather than proceeding to registry update — agent-index does not bypass Workspace policy.
- **Concurrent admin invites.** Two admins running invite-member simultaneously are protected by revision-aware writes on members-registry.json. The retry-on-conflict loop in Step 8 handles the race transparently. The helper invocation itself doesn't have a contention concern — each admin's helper session opens its own listener on its own port.
- **Re-invite of a member whose old data was archived/deleted manually.** If the directory was removed but the registry still contains the old entry (unusual state), the task detects the registry entry, asks the admin to confirm, and re-creates the directory.
- **Helper times out or admin closes review page mid-decision.** Step 6's `timed_out` and `page_closed` branches handle this — the task asks whether to retry, and on retry it re-reads pre-state (a partial earlier helper run may have applied some shares; the second pre-state read reflects the up-to-date state and the spec is rebuilt accordingly).
