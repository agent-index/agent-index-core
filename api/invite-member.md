---
name: invite-member
type: task
version: 1.13.1
collection: agent-index-core
description: Admin-only task that onboards a new agent-index member. Computes the member hash, creates the member's private and shared-artifact directories, applies the member-directory grants through the core permission-changes procedure (admin confirms the exact changes in chat), verifies the member is in the all-members group (M365 group on onedrive, Google Group on gdrive), registers them in members-registry.json, and emails backend-neutral install instructions with a real bootstrap download link.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle (gdrive contract v2.0+)
    description: Reads use aifs_get_permissions and revision-aware aifs_write — both introduced in adapter contract v2.0. Permission writes (share, unshare, transfer_ownership) go only through the core permission-changes procedure (`/agent-index-core/internal/permission-changes.md`), never directly from this task. Will fail clearly if the installed adapter declares contract_version < 2.0.0.
  - name: All-members group
    description: "The org's all-members group whose membership is the authoritative agent-index member roster — a Google Group on gdrive, a Microsoft 365 group on onedrive. Address is read from org-config.json remote_filesystem.connection.all_members_group. New members are added to this group at the identity-provider level (out-of-band; agent-index does not hold Workspace/Entra admin credentials): gdrive → Google Workspace Admin Console → Groups; onedrive → Microsoft 365 admin center → Teams & groups (for a group-connected SharePoint site, this group's membership IS the site membership)."
reads_from: "/members-registry.json"
writes_to: "/members-registry.json,/members/,/shared/members/artifacts/"
---

## About This Task

`invite-member` is the admin-side onboarding flow for a new agent-index member. The admin runs this when they want to add someone to the org. The task is admin-only — non-admin members will be told to ask their admin.

The flow is intentionally narrow: agent-index manages team membership; the org's identity provider (Google Workspace / Microsoft Entra) manages identity. This task does **not** create an account, add the new member to the Workspace/tenant, or grant storage access at the identity-provider level. Those are out-of-scope. **In particular it does not require the admin to pre-stage the member as a SharePoint site member** — member access is provisioned by the direct per-member shares in step 2 (applied through the permission-changes procedure), so the realistic flow is "invite, the framework provisions access," not "remember to add them to the site first." What it does:

1. Compute the deterministic `member_hash` from the new member's email.
2. Create the member's shared-artifact directory (`/shared/members/artifacts/{hash}/`) and grant **admin + new member writer** on it, through the core permission-changes procedure — the admin sees the exact changes, confirms them in chat, and they are applied and verified under the admin's own credentials. The member's *private* space is NOT created here — it lives in the member's own My Drive / OneDrive, created at first bootstrap (see below); the legacy `/members/{hash}/` Shared-Drive directory was retired in 3.9.0.
3. Ensure the member is added to the **all-members group** — that membership is the access mechanism: it conveys their read + enumeration of `/shared`, the collection roots, and the org-readable files (the group's direct-on-folder grants on gdrive; site/library membership on OneDrive), confirmed by the ms-install-5 accessmodel test. This task adds **no** per-member reader shares; the member reaches its own space by ID anchor. The only per-member grant it applies is the artifact-directory writer in Step 2 (needed on gdrive, redundant-and-skipped on OneDrive).
4. Append the member's entry to `members-registry.json` using a revision-aware write (so two admins inviting members concurrently don't overwrite each other).
5. Email the new member their install instructions.

If the same email was previously invited and removed, the existing `/shared/members/artifacts/{hash}/` directory is **reused** (per access-control project decision); prior shared artifacts remain in place when the member returns. (The member's *private* space is in their own My Drive / OneDrive, owned by them and untouched by re-invite; the legacy `/members/{hash}/` Shared-Drive dir was retired in 3.9.0.)

### Inputs

- `email` — required. New member's email address (lowercased internally for hashing).
- `display_name` — required. How the member wants to be addressed.
- `confirm_reuse` — implicit. If `/shared/members/artifacts/{hash}/` already exists, the task asks before reusing.

### Outputs

- `/shared/members/artifacts/{hash}/` (created or reused; ACL set to admin + member writer). The member's private space is in their own My Drive / OneDrive (member-owned, created at bootstrap) — not created or granted here.
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

Check whether the email was previously a member: **a `members-registry.json` entry with this `member_hash` (or a registry record of their removal)** is what makes someone a previous member. Then check `aifs_exists("/shared/members/artifacts/{hash}/")`.

**An artifacts folder with no registry entry is not a previous membership** (`invitestalefolder`, 3.32.0 live test): it's left over from an invite that never finished. Don't ask the re-invite question. Reuse the folder in Step 5 and tell the admin in one line: *"An empty artifacts folder from an earlier unfinished invite exists; I'll reuse it."*

If previously a member (registry entry found):

> This email was previously a member. Their shared-artifacts directory (`/shared/members/artifacts/{hash}/`) still exists, and their private member space (if any) is in their own My Drive — outside org control, untouched by removal or re-invite.
>
> Re-add this email as a member (reusing the artifacts directory), or stop and let me know how to handle it differently?

If the admin says reuse: proceed to Step 5 (skip creation where things exist, refresh ACLs and registry).

If the admin says stop: surface "Stopped. Let me know how you'd like to proceed and we can retry." and exit cleanly.

### Step 5: Create or refresh the member's shared-artifacts directory (structural only)

This step creates the folder if it doesn't exist. It performs **no permission writes** — those go through the permission-changes procedure in Step 6.

- Check `aifs_exists("/shared/members/artifacts/{hash}/")`.
- If it does not exist: materialize it via `aifs_write("/shared/members/artifacts/{hash}/.placeholder", "")`.
- If it already exists (re-invite case): leave it untouched.
- **Capture the directory's Drive id (bug `groupshareapivisibility`).** After materializing (or on re-invite/reuse, against the existing dir), `aifs_stat("/shared/members/artifacts/{hash}/")` and record the resolved Drive id as `artifacts_dir_id`. This id is persisted on the registry entry in Step 8 so that `member-bootstrap` can write its onboarding handshake **by id** (`aifs_write("id:{artifacts_dir_id}/member-folder.json", …)`) — a member's by-path resolution into the artifacts namespace isn't reliable before group-share propagation, but writing to its own artifacts dir by id works pre-visit.

**The member's private space is NOT created here** (changed in core 3.9.0). It is a folder named `Agent-Index-Private` in the member's **own personal space** — their My Drive on gdrive, their OneDrive on onedrive — created by the member's own credentials during their first bootstrap (`member-bootstrap` ensure-my-drive-space subroutine) — member-owned so the member can apply sharing grants on it themselves (Shared-Drive folders can only be shared by drive Managers, which members deliberately are not; on onedrive the member owns their OneDrive items outright). On onedrive this requires the member to have a OneDrive-inclusive license and to have signed into office.com once (see memberlicense; create-org now surfaces this prerequisite to the admin). The bootstrap writes a handshake file to `/shared/members/artifacts/{hash}/member-folder.json`; the admin's next `@ai:publish-updates` reconciles it into the registry. Legacy `/members/{hash}/` directories on the Shared Drive are deprecated (migration handled by apply-updates 3.9.0 Migration 2; admin archives the old folders manually afterwards).

### Step 6: Apply the member-directory grants (permission-changes procedure)

The access grants go through the core permission-changes procedure as one table. The admin sees exactly what will change, confirms it in chat, and each grant is applied and verified under the admin's own credentials. This task never calls `aifs_share` itself.

**This task applies exactly ONE per-member grant: the member-directory writer.** The new member + admin each need **writer** on the member's shared-artifact directory `/shared/members/artifacts/{hash}/`, so the member can write its bootstrap handshake and shared outputs. On **gdrive** this is genuinely required — `create-org` Step 8 item 4.5 grants the all-members group `reader` on the three root files only, *not* write on the artifacts namespace — so without it the member cannot write its handshake. On **OneDrive** it is redundant (the all-members group is the site group, so members already hold library-wide writer); the procedure's no-op filter skips it there.

**Members get read + enumeration from group membership — this task adds NO per-member reader shares.** A member reads and enumerates `/shared`, the collection roots, and the org-readable root files through the all-members group's **direct-on-folder** grants (`create-org` Step 8 item 4.5 + `install-collection` cr01 on gdrive; site/library membership on OneDrive), and reaches its own member space by **ID anchor** (standards.md "Addressing"). So **adding the member to the all-members group is the access mechanism** — surface it as the required onboarding step (M365-admin-center / Google Admin).

(Historical note, do NOT re-implement: earlier versions also applied per-member *reader* shares on every org-readable root to work around an old enumeration bug where group **inheritance** returned 0 on `aifs_list`. That problem was solved by the direct-on-folder group grant + ID-anchoring; the per-member reader shares are obsolete and were removed. Re-creating them to fix a problem that no longer exists was the `catbredundant` bug.)

**OneDrive/SharePoint (Release B / B.1):** two onedrive-specific requirements, then the same procedure.

1. **Resolve the grantable identity FIRST (identitymap — bugs 20260617-8d20ea22-identitymap, 20260620-8d20ea22-identityperm).** Keep two identities distinct:
   - **Canonical identity** — `member_hash` is ALWAYS derived from the member's **roster email** (lowercase agent-index email). This never changes; it keys the member folder, registry entry, and all capability ownership, and keeps the member the *same person* across backends. Do not key identity off a tenant address.
   - **Grantable identity (`sharing_identity`)** — the address Microsoft Graph can actually grant to, resolved via `aifs_resolve_identity`, which returns `{ id, upn, mail }`. Use the returned **`upn` (falling back to `mail`)** — i.e. the **email-form** identity — as the share recipient, and **persist it on the registry entry as `sharing_identity`** (Step 8), so every later share/unshare/remove-member uses it, not the roster email. **Do NOT use the `id` (objectId) as the recipient** (`recipidform`): the permission-changes procedure requires an email-form recipient and rejects bare GUIDs. (The objectId is the most *stable* directory key, so keep it available in the resolution result, but the *grantable recipient* must be the UPN/mail.)

   **Which reference to resolve:**
   - **If the admin supplied an explicit grant identity** at invite (a tenant UPN or objectId — e.g. *"invite testproduction@agent-index.ai, grant identity testproduction@AgentIndex.onmicrosoft.com"*), resolve **that**. This is the normal path whenever the roster email's domain is **not a verified/aliased domain** in the tenant — which is the common case (and the likely customer-B case): the roster email then has no tenant record to look up, so it can't be auto-resolved. The roster email still sets `member_hash`; the supplied address only sets `sharing_identity`.
   - **Otherwise**, resolve the **roster email** directly (works when it's a verified tenant address or a registered proxy/alias).

   **Branch on the resolution outcome (identityperm — do NOT conflate these):**
   - **`ACCESS_DENIED` / permission error** → the Entra app lacks the `User.Read.All` Graph permission, so it can't read the directory. The member most likely EXISTS — do not report them as missing. Halt and tell the admin to add `User.Read.All` to the app registration, **grant admin consent**, then **re-authenticate** (the agent's token must be reissued to carry the new scope), and retry. (adapter 2.2.1 surfaces this distinctly; pre-2.2.1 it masqueraded as "no matching user".)
   - **`INVALID_SUBJECT` / genuine no-match** → the resolved address truly doesn't exist in the tenant. Halt and ask for the correct tenant UPN/objectId (or for the account to be created + OneDrive-licensed first). Never attempt the share with an unresolvable address (that produces the misleading generic `sharingFailed`).

   On gdrive, `aifs_resolve_identity` is a passthrough (the email IS the grantable identity), so `sharing_identity == email`, the explicit-mapping path is unused, and this whole step is effectively a no-op.

2. **Add the member to the all-members group — the required onboarding step.** This is what conveys read + enumeration of `/shared`, the collection roots, and the org-readable root files (see the framing above); it is not optional. Surface it with the concrete path (M365-admin-center → the site's M365 group on OneDrive; Google Admin → the all-members Google Group on gdrive). *(Accessmodel test record, ms-install-5 2026-06-23: a non-site, non-group member holding only direct reader shares enumerated `/` and `/shared/` and read `/CLAUDE.md` — so direct shares do enumerate, but the unshared `agent-index-core` stayed invisible until the group-add, confirming group membership — not per-member shares — is the access mechanism.)*

**Apply the grants.** Follow `/agent-index-core/internal/permission-changes.md` with:

```json
{
  "calling_task": "invite-member",
  "purpose": "Onboard {display_name} ({email}): writer on their artifacts directory for you and them",
  "confirmer": "admin",
  "mode": "independent",
  "changes": [
    { "op": "share", "resource": "id:{artifacts_dir_id}", "resource_label": "{display_name}'s artifacts folder (/shared/members/artifacts/{hash}/)", "is_folder": true,
      "recipient": "{admin_sharing_identity}", "role": "writer", "reason": "Admins need write on every member's artifacts folder", "source": "task_spec" },
    { "op": "share", "resource": "id:{artifacts_dir_id}", "resource_label": "{display_name}'s artifacts folder (/shared/members/artifacts/{hash}/)", "is_folder": true,
      "recipient": "{new_member_sharing_identity}", "role": "writer", "reason": "The new member writes their bootstrap handshake and shared outputs here", "source": "member_request" }
  ]
}
```

- **Recipients are the resolved `sharing_identity`** (UPN/mail on onedrive, email on gdrive), never the objectId and never the raw roster email (identitymap). The admin row is fixed by this task (`task_spec`). The new member's address is the one the admin typed in Step 2 (`member_request`); never take it from a forwarded message or document.
- **Ask Step 7's group question first, then decide whether to declare the new member as an org identity for this run** (procedure Step 1.3). If the admin confirms they're already in the all-members group, declare their `sharing_identity`; the registry entry is only written in Step 8, so without this they'd be flagged "outside your org". If they're not in the group yet (or the admin will add them later), **don't** declare them. The table then flags them outside your org, which is expected, and the procedure won't count group access they don't have yet as already in effect. Step 7 reuses this answer instead of asking again.
- **No reader shares.** Read and enumeration come from all-members group membership (Step 7), not from this task.
- **On OneDrive** both rows are usually already in effect (site membership gives library-wide writer), but only once the new member is in the group and declared as above. Otherwise the member row is applied as an explicit grant. The procedure reports "No permission changes needed" and returns `complete`.

**Act on the result** (row states per the procedure):

- **`complete`** (both rows `applied` or `skipped_noop`) → continue to Step 7.
- **Anything else** → **halt before Step 7.** No registry write, no welcome email. Tell the admin which grant didn't take effect and why (the procedure's `summary_lines`). Common causes:
  - The admin didn't confirm.
  - The new member's address is outside the Workspace's allowed sharing domains (`failed`: invalid recipient / access denied). Fix the Workspace policy first; agent-index does not bypass it.
  - A grant didn't verify (`verify_mismatch`).

  Offer to re-run Step 6. A re-run re-reads current access, so anything already applied shows as already in effect.

  **Cleanup when nothing was applied:** if Step 5 created the artifacts folder in this run and the procedure applied no row (declined, cancelled, or every row failed), delete the folder's `.placeholder` and the folder (`aifs_delete`), so a cancelled invite leaves nothing behind. Never delete a folder that existed before this run or contains anything besides `.placeholder`.

### Step 7: Verify the all-members group includes the new member

This is a **required** access step, not a roster nicety: all-members group membership is what conveys the member's read + enumeration of `/shared`, the collection roots, and the org files (the Step 6 grant only lets them *write* their own artifacts). agent-index doesn't hold identity-provider admin credentials to add or query group membership directly, so confirm it with the admin:

If this question was already asked in Step 6, reuse that answer and skip to item 3.

1. Read `org-config.json remote_filesystem.connection.all_members_group` and the org's `remote_filesystem.backend`.
2. Surface to the admin (backend-aware wording):
   > Has `{new_member_email}` been added to the all-members group `{all_members_group}`?
   >
   > This membership is what gives them read access to the org's shared files and collections. Without it they can write their own artifacts but cannot read `/shared` or run any capability. On OneDrive/SharePoint the group is the site group (membership = library access); on gdrive it's the all-members Google Group.
   >
   > **Yes, they're in the group** — continue.
   > **No, not yet** — add them before their first session or they'll have no read access. **gdrive** → Google Workspace Admin Console → Groups; **onedrive** → Microsoft 365 admin center → Teams & groups → the site's group → Members. Allow a couple minutes for propagation.
   > **Add them later** — same as no; flag that the member can't function until it's done.

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
  "sharing_identity": "{resolved id/UPN from aifs_resolve_identity, or = email on gdrive}",
  "org_role": "{default-role-from-org-config-or-prompt}",
  "joined_date": "{today YYYY-MM-DD}",
  "member_folder_id": null,
  "artifacts_dir_id": "{artifacts_dir_id captured in Step 5}"
}
```

`artifacts_dir_id` (bug `groupshareapivisibility`) is the Drive id of `/shared/members/artifacts/{hash}/` captured by the Step 5 `aifs_stat`. `member-bootstrap` reads it from this entry to write its onboarding handshake **by id** (`id:{artifacts_dir_id}/member-folder.json`), which succeeds for a not-yet-propagated member where a by-path write would not. On re-invite it is refreshed from the stat of the reused directory.

`sharing_identity` (new in 1.8.0 — identitymap) is the backend-grantable identity resolved in Step 6: the member's UPN (or mail) on onedrive — never the objectId — and the email on gdrive. It is the canonical recipient for every later share/unshare/remove-member targeting this member — tasks read it from the registry rather than re-resolving or using the roster `email` (which often isn't grantable on M365). `member_hash` stays the canonical agent-index identity for everything else (ownership, capabilities).

`member_folder_id` is `null` at invite time (changed in 1.6.0): the member's private space is created in their own My Drive during their first bootstrap, which writes a handshake file to `/shared/members/artifacts/{hash}/member-folder.json`; the admin's next `@ai:publish-updates` reconcile copies the ID into this registry entry. The registry remains the authoritative org-side record once reconciled (standards.md § "Addressing").

Write back with the captured revision:

```
aifs_write("/members-registry.json", new_content, if_revision=revision)
```

If `REVISION_CONFLICT`: re-read, re-apply, retry. Cap at 5 retries before surfacing an error to the admin (another concurrent registry write would be unusual but not impossible).

### Step 9: Send welcome email

**First, resolve a real clickable download link for the bootstrap zip (`bootstraplink`, ms-install-9).** `{bootstrap_zip_download_link}` MUST be an actual URL the member can click — NOT a bare path like `/shared/bootstrap/member-bootstrap.zip` (the member cannot navigate the backend by path), and never "ask me for a link." Resolve it backend-appropriately:
- **onedrive:** `aifs_stat("/shared/bootstrap/member-bootstrap.zip")` → use the returned **`web_url`** field (adapter 2.4.0+ returns it from Graph `webUrl`; opens the item in SharePoint where a tenant member can download it). On adapters older than 2.4.0, `web_url` is absent — see the fallback below; do NOT assume a `createLink` op exists (the adapter exposes none — this was the `bootstraplinkunavailable` gap, ms_install_10).
- **gdrive:** `aifs_stat(...)` → the returned **`web_url`** (adapter 2.7.0+, from `webViewLink`).
- **Fallback when `web_url` is absent (older adapter / null):** do NOT emit a bare backend path and do NOT say "ask me for a link." Instead give the admin an explicit one-liner to fetch the link themselves and paste it: "open the SharePoint library, right-click `member-bootstrap.zip` under `/shared/bootstrap/` → Copy link, and paste it here," then use what they provide. The member must receive a clickable link.

Then compose and offer to send an email to `{email}`:

```
Subject: Welcome to {org_name} on agent-index

Hi {display_name},

You've been invited to {org_name}'s agent-index workspace. To get started:

1. Download the bootstrap kit: {bootstrap_zip_download_link}
2. Unpack it to a folder of your choice — that folder becomes your local agent-index workspace.
3. Open Claude (Cowork or Claude Desktop) with that folder selected and say "set up my agent-index member workspace." Claude walks you through the rest, including signing in to {backend_display_name} as yourself.

If your first session reports "access denied" on the org files, wait a couple of minutes and retry — group membership can take a moment to propagate.

Questions? Reply to this email. — {admin_display_name}
```

**Keep the email backend-neutral and accurate (`welcomeemail`, ms-install-9).** Do NOT include Google-Drive-specific access boilerplate (e.g. "your account isn't a member of the org's Shared Drive," "you can't see the Shared Drive in your sidebar") — it is inaccurate and confusing on OneDrive/SharePoint (and unnecessary detail on gdrive). The access model is conveyed by group membership; the member does not need an essay about it. Keep step 3 simple; member-bootstrap handles the sign-in details when they run it.

Use the existing email-send capability (or surface the draft for the admin to send themselves if no email integration is available). The backend "share" send-notification flag is intentionally NOT used — this welcome email replaces it.

### Step 10: Confirm and log

Surface to the admin:

> Done. `{display_name}` ({email}) is now a member.
> - Artifacts dir: `/shared/members/artifacts/{hash}/` (admin + member writer)
> - Private space: created in THEIR My Drive at first bootstrap (`Agent-Index-Private ({org_id})`); registry gets the folder ID via your next `@ai:publish-updates` reconcile
> - Registry: appended at revision {new_revision} (member_folder_id pending bootstrap)
> - Welcome email: {sent | drafted | skipped}
>
> The grants were confirmed by you and verified on the storage backend. A record of exactly what you approved is in your `members/{admin_hash}/state/permission-changes.jsonl`.

Append an activity event to a local audit hint file (no remote audit log — that comes from Drive Activity directly). The admin can run `view-audit /shared/members/artifacts/{hash}/` afterwards to see the share events natively.

---

## Directives

### Behavior

- This task is admin-only. The pre-flight check rejects non-admins early.
- All ACL changes execute under the calling admin's OAuth identity. The new member's identity is never assumed.
- Permission writes go only through the core permission-changes procedure: the exact changes are shown, the admin confirms them in a fresh turn, and they are applied and verified under the admin's own credentials.
- Re-invite handling reuses the existing `/shared/members/artifacts/{hash}/` directory by default. The returning member's private My Drive space is theirs — re-running bootstrap finds or recreates it; the org never touches it. The admin can choose to halt instead, but **never** overwrite, archive, or wipe without explicit confirmation.
- Group membership is verified through admin attestation, not API query. agent-index has no Workspace admin credentials.

### Constraints

- Never invite an admin to add themselves as a member of their own org. The pre-flight check rejects the case where `email` matches an existing entry in `org-config.json admins[].email` (admin is implicitly already a member).
- Never create `/members/{hash}/` on the Shared Drive (retired in 3.9.0 — legacy directories are archived by the admin after members migrate). Never read, write, or attempt permission changes on a member's My Drive space — the org has no access, by design.
- **Never call `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` outside the permission-changes procedure.** Required by `agent-index-core/standards.md` § "Permission changes: list, confirm, apply, verify"; preflight flags direct calls.
- Never write to `members-registry.json` until the procedure returns `complete` for the Step 6 grants (the verified-outcome gate). The registry-after-shares ordering protects against the partial state where a registry entry exists but the new member can't actually access anything.

### Edge Cases

- **The all-members group doesn't exist yet.** Step 7 surfaces this and gives admin the option to continue or stop. If continuing, the new member's first session may fail until the group is set up — the welcome email warns about this.
- **The new member's email is in a different domain than the Workspace.** Drive sharing across Workspaces depends on the Workspace's external-sharing policy. The procedure reports the affected row as `failed` (invalid recipient or access denied). Step 6 halts the task in this case rather than proceeding to registry update — agent-index does not bypass Workspace policy.
- **Concurrent admin invites.** Two admins running invite-member simultaneously are protected by revision-aware writes on members-registry.json. The retry-on-conflict loop in Step 8 handles the race transparently. The grants themselves have no contention concern — sharing the same grant twice is a no-op.
- **Re-invite of a member whose old data was archived/deleted manually.** If the directory was removed but the registry still contains the old entry (unusual state), the task detects the registry entry, asks the admin to confirm, and re-creates the directory.
- **Admin answers the table with a question or a different request.** The procedure cancels that run (nothing applied). Answer them, then re-run Step 6. It re-reads current access, so anything an earlier run applied shows as already in effect.
