---
name: invite-member
type: task
version: 1.11.1
collection: agent-index-core
description: Admin-only task that onboards a new agent-index member. Computes the member hash, creates the member's private and shared-artifact directories, delegates ACL changes to the permission-change-helper for member-confirmed application, verifies the member is in the all-members group (M365 group on onedrive, Google Group on gdrive), registers them in members-registry.json, and emails backend-neutral install instructions with a real bootstrap download link.
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
2. Create the member's shared-artifact directory (`/shared/members/artifacts/{hash}/`) and grant **admin + new member writer** on it, by handing a permission-change spec to the `permission-change-helper` skill — the admin reviews and Accepts, then the helper's apply-script applies the shares with the admin's existing OAuth token. The member's *private* space is NOT created here — it lives in the member's own My Drive / OneDrive, created at first bootstrap (see below); the legacy `/members/{hash}/` Shared-Drive directory was retired in 3.9.0.
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

**This task applies exactly ONE per-member grant: the member-directory writer.** The new member + admin each need **writer** on the member's shared-artifact directory `/shared/members/artifacts/{hash}/`, so the member can write its bootstrap handshake and shared outputs. On **gdrive** this is genuinely required — `create-org` Step 4.5 grants the all-members group `reader` on the three root files only, *not* write on the artifacts namespace — so without it the member cannot write its handshake. On **OneDrive** it is redundant (the all-members group is the site group, so members already hold library-wide writer); the no-op filter in step 2 skips it there.

**Members get read + enumeration from group membership — this task adds NO per-member reader shares.** A member reads and enumerates `/shared`, the collection roots, and the org-readable root files through the all-members group's **direct-on-folder** grants (`create-org` Step 4.5 + `install-collection` cr01 on gdrive; site/library membership on OneDrive), and reaches its own member space by **ID anchor** (standards.md "Addressing"). So **adding the member to the all-members group is the access mechanism** — surface it as the required onboarding step (M365-admin-center / Google Admin).

(Historical note, do NOT re-implement: earlier versions also applied per-member *reader* shares on every org-readable root to work around an old enumeration bug where group **inheritance** returned 0 on `aifs_list`. That problem was solved by the direct-on-folder group grant + ID-anchoring; the per-member reader shares are obsolete and were removed. Re-creating them to fix a problem that no longer exists was the `catbredundant` bug.)

**OneDrive/SharePoint (Release B / B.1):** two onedrive-specific requirements, then the same helper flow.

1. **Resolve the grantable identity FIRST (identitymap — bugs 20260617-8d20ea22-identitymap, 20260620-8d20ea22-identityperm).** Keep two identities distinct:
   - **Canonical identity** — `member_hash` is ALWAYS derived from the member's **roster email** (lowercase agent-index email). This never changes; it keys the member folder, registry entry, and all capability ownership, and keeps the member the *same person* across backends. Do not key identity off a tenant address.
   - **Grantable identity (`sharing_identity`)** — the address Microsoft Graph can actually grant to, resolved via `aifs_resolve_identity`, which returns `{ id, upn, mail }`. Use the returned **`upn` (falling back to `mail`)** — i.e. the **email-form** identity — as the share recipient, and **persist it on the registry entry as `sharing_identity`** (Step 8), so every later share/unshare/remove-member uses it, not the roster email. **Do NOT use the `id` (objectId) as the recipient** (`recipidform`): the permission-helper validates recipients as email addresses and rejects bare GUIDs, so an objectId recipient fails spec validation. (The objectId is the most *stable* directory key, so keep it available in the resolution result, but the *grantable recipient* must be the UPN/mail.)

   **Which reference to resolve:**
   - **If the admin supplied an explicit grant identity** at invite (a tenant UPN or objectId — e.g. *"invite testproduction@agent-index.ai, grant identity testproduction@AgentIndex.onmicrosoft.com"*), resolve **that**. This is the normal path whenever the roster email's domain is **not a verified/aliased domain** in the tenant — which is the common case (and the likely customer-B case): the roster email then has no tenant record to look up, so it can't be auto-resolved. The roster email still sets `member_hash`; the supplied address only sets `sharing_identity`.
   - **Otherwise**, resolve the **roster email** directly (works when it's a verified tenant address or a registered proxy/alias).

   **Branch on the resolution outcome (identityperm — do NOT conflate these):**
   - **`ACCESS_DENIED` / permission error** → the Entra app lacks the `User.Read.All` Graph permission, so it can't read the directory. The member most likely EXISTS — do not report them as missing. Halt and tell the admin to add `User.Read.All` to the app registration, **grant admin consent**, then **re-authenticate** (the agent's token must be reissued to carry the new scope), and retry. (adapter 2.2.1 surfaces this distinctly; pre-2.2.1 it masqueraded as "no matching user".)
   - **`INVALID_SUBJECT` / genuine no-match** → the resolved address truly doesn't exist in the tenant. Halt and ask for the correct tenant UPN/objectId (or for the account to be created + OneDrive-licensed first). Never attempt the share with an unresolvable address (that produces the misleading generic `sharingFailed`).

   On gdrive, `aifs_resolve_identity` is a passthrough (the email IS the grantable identity), so `sharing_identity == email`, the explicit-mapping path is unused, and this whole step is effectively a no-op.

2. **Add the member to the all-members group — the required onboarding step.** This is what conveys read + enumeration of `/shared`, the collection roots, and the org-readable root files (see the framing above); it is not optional. Surface it with the concrete path (M365-admin-center → the site's M365 group on OneDrive; Google Admin → the all-members Google Group on gdrive). *(Accessmodel test record, ms-install-5 2026-06-23: a non-site, non-group member holding only direct reader shares enumerated `/` and `/shared/` and read `/CLAUDE.md` — so direct shares do enumerate, but the unshared `agent-index-core` stayed invisible until the group-add, confirming group membership — not per-member shares — is the access mechanism.)*

The helper spec below therefore contains only the **Category A** member-directory writer grant. It is applied via `aifs_share` through the permission-change-helper — the agent emits the `agent-index://apply?spec=…` link, the admin Accepts on their host, and this task reads the outcome (link→Accept→verify). **Never call `aifs_share` directly from this task, even when the helper can't be driven from a sandbox** (helperbypass, bug `20260617-8d20ea22-helperbypass`): the helper flow works from Cowork, and there is no direct-apply fallback.

**Build the spec:**

1. Read pre-state for the member's artifact directory (used as the `before` field for diff visualization, and to skip the grant if it is already held):

   ```
   artifacts_pre = aifs_get_permissions("/shared/members/artifacts/{hash}/")
   ```

   Note: `aifs_get_permissions` is read-only and agent-callable directly — only *write* ops go through the helper.

2. Build the operations list. **The recipient is the resolved `sharing_identity`** (the **UPN/mail — email-form** — from `aifs_resolve_identity`, never the objectId; the helper rejects bare GUIDs, see `recipidform`) on onedrive, the member email on gdrive — NOT the raw roster email (identitymap). The admin's recipient is the admin's resolved identity.

   **The grant set is just the member-directory writer:** `{/shared/members/artifacts/{hash}/} × {admin_identity, new_member_identity} × {writer}` — two `share` ops. Omit either if the recipient already holds writer on that path (`artifacts_pre`), including via the all-members group. On **OneDrive** site membership already conveys library-wide writer, so both are typically no-ops and the spec is **empty**; on **gdrive** the group has no write on the artifacts namespace, so both ops apply. **No reader shares are emitted** — read and enumeration come from group membership (see step 2 above), not from this task.

3. Compose the spec. The example below is the whole spec — the two member-directory writer ops. There is nothing per-collection to adapt (no reader shares).

   ```json
   {
     "version": "1.0",
     "operations": [
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
       }
     ],
     "context": {
       "requestor": "{admin_member_hash}",
       "calling_task": "invite-member",
       "purpose": "Onboarding {display_name} ({new_member_email}) under {org_name}: granting the new member + admin writer on the member's artifact directory /shared/members/artifacts/{hash}/ so the member can write its bootstrap handshake. Read/enumeration access is conveyed by all-members group membership, not by this spec."
     }
   }
   ```

   (Filter out any operations the pre-state read marked as no-ops before submitting.)

4. If the filtered operations list is empty (all required grants already in place — uncommon but possible on a re-invite of a member whose ACLs were never cleaned up): skip Step 6 entirely. Surface to the admin: "All required ACLs are already in place; no permission changes needed."

**Invoke the helper:**

Call the `permission-change-helper` skill with the spec. The helper validates, opens a review page in the admin's browser (or its `--cli` fallback), waits for the admin's deliberate Accept, then runs the apply-script which calls the actual `aifs_share` ops. The apply-script's per-op verification reads back the post-state and includes it in the helper's structured outcome.

Surface to the admin before invoking, in the chat:

> I'm opening a review page in your browser. It'll show {N} share operation(s) on `/shared/members/artifacts/{hash}/` (writer for you and the new member). Click Accept to apply them with your own credentials.

**Branch on the helper's outcome:**

- **`applied`** — All requested shares succeeded. The helper returns `verified_post_state` with the post-share recipients lists. Continue to Step 7.

- **`rejected`** — The admin clicked Reject. No shares were applied. Surface to the admin: "Invite cancelled. No permissions were modified, no registry entry was written." Halt the task; return without applying any further side effects (registry untouched, no welcome email).

- **`timed_out`** or **`page_closed`** — The admin opened the review page but didn't decide within the helper's idle timeout, or closed the page without deciding. Surface: "The review window closed without your decision. The invite is on hold; nothing has been applied. Want to retry?" If yes, return to the start of Step 6. If no, halt cleanly.

- **`partial_failure`** — Some shares applied, some failed. The helper returns `applied_operations` and `failed_operations`. Surface a per-failure summary using the helper's `error_detail` and the typed error codes from the apply-script (e.g., `INVALID_RECIPIENT` if the email is malformed or in a different Workspace; `ACCESS_DENIED` if the admin's OAuth doesn't permit the share). Offer to retry the failed operations only, or halt. **Do not** continue to Step 7 (registry update) until either both artifact-directory shares are applied or the admin has explicitly accepted the partial state and confirmed they want to proceed anyway. The default should be halt — partial state is typical of cross-Workspace cases where the recipient's email is in a domain the org's external-sharing policy doesn't allow, and the right answer is to fix the Workspace policy first.

- **`apply_error`** or **`verification_failed`** — Hard failure (the apply-script crashed or post-state verification revealed a discrepancy). Surface the error verbatim, halt the task, do not write to the registry.

- **`binary_not_found`** — The helper's Go binary is missing at `mcp-servers/permission-helper-go/agent-index-show-plan{.exe}`. Indicates the install is incomplete or predates 3.4.0. Surface: "The permission helper Go binary isn't installed. Run `@ai:update` to install or upgrade it, or `@ai:member-bootstrap` if the install appears broken." Halt.

The helper's verification step replaces the eventual-consistency polling loop the pre-1.1.0 task did manually after each share. Drive's API is still eventually consistent, but the apply-script handles the polling internally; by the time the helper returns `applied`, the post-state has been verified.

### Step 7: Verify the all-members group includes the new member

This is a **required** access step, not a roster nicety: all-members group membership is what conveys the member's read + enumeration of `/shared`, the collection roots, and the org files (the Step 6 grant only lets them *write* their own artifacts). agent-index doesn't hold identity-provider admin credentials to add or query group membership directly, so confirm it with the admin:

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
  "member_folder_id": null
}
```

`sharing_identity` (new in 1.8.0 — identitymap) is the backend-grantable identity resolved in Step 6: the member's objectId/UPN on onedrive, the email on gdrive. It is the canonical recipient for every later share/unshare/remove-member targeting this member — tasks read it from the registry rather than re-resolving or using the roster `email` (which often isn't grantable on M365). `member_hash` stays the canonical agent-index identity for everything else (ownership, capabilities).

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
> - Private space: created in THEIR My Drive at first bootstrap (`Agent-Index-Private`); registry gets the folder ID via your next `@ai:publish-updates` reconcile
> - Registry: appended at revision {new_revision} (member_folder_id pending bootstrap)
> - Welcome email: {sent | drafted | skipped}
>
> The shares were applied via the permission-change-helper; you can review the plan that was applied at `outputs/permission-plan-{timestamp}.json` if you want a record of exactly what was approved.

Append an activity event to a local audit hint file (no remote audit log — that comes from Drive Activity directly). The admin can run `view-audit /shared/members/artifacts/{hash}/` afterwards to see the share events natively.

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
