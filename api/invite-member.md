---
name: invite-member
type: task
version: 1.0.0
collection: agent-index-core
description: Admin-only task that onboards a new agent-index member. Computes the member hash, creates the member's private and shared-artifact directories with appropriate permissions, verifies the member is in the all-members Google Group, registers them in members-registry.json, and emails install instructions.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle (gdrive contract v2.0+)
    description: Uses aifs_share, aifs_get_permissions, and revision-aware aifs_write — all introduced in adapter contract v2.0. Will fail clearly if the installed adapter declares contract_version < 2.0.0.
  - name: All-members Google Group
    description: Workspace-maintained Google Group whose membership is the authoritative agent-index member roster. Address is read from org-config.json remote_filesystem.connection.all_members_group. New members must be added to this group at the Workspace level (out-of-band; agent-index does not have Workspace admin credentials).
reads_from: "/members-registry.json"
writes_to: "/members-registry.json,/members/,/shared/members/artifacts/"
---

## About This Task

`invite-member` is the admin-side onboarding flow for a new agent-index member. The admin runs this when they want to add someone to the org. The task is admin-only — non-admin members will be told to ask their admin.

The flow is intentionally narrow: agent-index manages team membership; Workspace IT manages identity. This task does **not** create a Google account, add the new member to the Workspace, or grant Drive access at the workspace level. Those are out-of-scope. What it does:

1. Compute the deterministic `member_hash` from the new member's email.
2. Create the member's private directory (`/members/{hash}/`) and shared-artifact directory (`/shared/members/artifacts/{hash}/`) with explicit shares to admin + the new member only.
3. Share the org-readable infrastructure files (CLAUDE.md, org-config.json, members-registry.json, bootstrap zip) with the new member. In v3.1.0+ orgs configured with an `all_members_group`, the member receives this access automatically by being added to the group; the task verifies group membership and prompts the admin to fix it if missing.
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

Confirm the hash to the admin: "I'll create `/members/{hash}/` for `{email}`. Continue?"

### Step 4: Re-invite detection

Check whether `/members/{hash}/` already exists on the remote:

```
aifs_exists("/members/{hash}/")
```

If it does:

> This email was previously a member. The directory `/members/{hash}/` already exists with the prior member's content (any captures, ideas, or artifacts they kept).
>
> Reuse the existing directory and re-add this email as a member, or stop and let me know how to handle it differently?

If the admin says reuse: proceed to Step 5, but note the directory already exists (skip creation, only update ACLs and registry).

If the admin says stop: surface "Stopped. Let me know how you'd like to proceed and we can retry." and exit cleanly.

### Step 5: Create or refresh `/members/{hash}/`

If the directory does not exist:
1. Create it: `aifs_write("/members/{hash}/.placeholder", "")` (writing a placeholder is the simplest way to materialize a folder; alternatively use a single create-folder call if the adapter exposes one — Drive's API folds folder creation into the parent-creation chain on write).
2. Apply ACLs:
   - `aifs_share("/members/{hash}/", "{admin_email}", "writer")`
   - `aifs_share("/members/{hash}/", "{new_member_email}", "writer")`
   - For the path-B model (member is not a Shared Drive member), the explicit share is what makes the folder visible to them under "Shared with me".
3. After both shares, poll `aifs_get_permissions("/members/{hash}/")` until both subjects appear (Drive's permission API is eventually consistent; up to ~5s of backoff is reasonable).

If the directory already exists (re-invite case):
1. Skip creation.
2. `aifs_get_permissions("/members/{hash}/")` to inspect current ACLs.
3. If `{new_member_email}` already has writer access: skip. Otherwise: `aifs_share("/members/{hash}/", "{new_member_email}", "writer")`.
4. Confirm admin still has writer; re-share if not.

### Step 6: Create or refresh `/shared/members/artifacts/{hash}/`

Same shape as Step 5 but for `/shared/members/artifacts/{hash}/`. Admin + member, both writer.

### Step 7: Verify the all-members group includes the new member

This is a soft check — agent-index doesn't have Workspace admin credentials to query group membership directly. Instead:

1. Read `org-config.json remote_filesystem.connection.all_members_group` (e.g., `agent-index-all@brainly.com`).
2. Surface to the admin:
   > Has `{new_member_email}` been added to the Workspace group `{all_members_group}`?
   >
   > This is what makes the org-readable infrastructure files (CLAUDE.md, members-registry.json, bootstrap zip, etc.) visible to them. Without it, their first session will fail to read these.
   >
   > **Yes, they're in the group** — continue.
   > **No, not yet** — I'll continue, but the welcome email will tell them to wait two minutes for group propagation before their first session. If they have access issues, the admin needs to add them to `{all_members_group}` via Workspace Admin Console.
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
  "joined_date": "{today YYYY-MM-DD}"
}
```

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

If your first session reports "access denied" reading the org infrastructure files, wait two minutes and retry — Workspace group membership propagation can lag a couple of minutes.

Questions? Reply to this email. — {admin_display_name}
```

Use the existing email-send capability (or surface the draft for the admin to send themselves if no email integration is available). Drive's "share" sendNotificationEmail flag is intentionally NOT used — this welcome email replaces it.

### Step 10: Confirm and log

Surface to the admin:

> Done. `{display_name}` ({email}) is now a member.
> - Member dir: `/members/{hash}/` (admin + member writer)
> - Artifacts dir: `/shared/members/artifacts/{hash}/` (admin + member writer)
> - Registry: appended at revision {new_revision}
> - Welcome email: {sent | drafted | skipped}
>
> Drive's permission API can take seconds to fully propagate. If the new member's first session fails on org-config or registry reads, they should wait two minutes and retry.

Append an activity event to a local audit hint file (no remote audit log — that comes from Drive Activity directly). The admin can run `view-audit /members/{hash}/` afterwards to see the share events natively.

---

## Directives

### Behavior

- This task is admin-only. The pre-flight check rejects non-admins early.
- All ACL changes execute under the calling admin's OAuth identity. The new member's identity is never assumed.
- Re-invite handling reuses the existing `/members/{hash}/` directory by default. The admin can choose to halt instead, but **never** overwrite, archive, or wipe without explicit confirmation.
- Group membership is verified through admin attestation, not API query. agent-index has no Workspace admin credentials.

### Constraints

- Never invite an admin to add themselves as a member of their own org. The pre-flight check rejects the case where `email` matches an existing entry in `org-config.json admins[].email` (admin is implicitly already a member).
- Never write to `/members/{hash}/` outside of this task and `member-bootstrap`.
- Drive permissions API is eventually consistent — always poll with backoff after a share rather than assuming immediate effect.

### Edge Cases

- **The all-members group doesn't exist yet.** Step 7 surfaces this and gives admin the option to continue or stop. If continuing, the new member's first session may fail until the group is set up — the welcome email warns about this.
- **The new member's email is in a different domain than the Workspace.** Drive sharing across Workspaces depends on the Workspace's external-sharing policy. If the share fails with `INVALID_RECIPIENT` or `ACCESS_DENIED`, surface clearly and stop — agent-index does not bypass Workspace policy.
- **Concurrent admin invites.** Two admins running invite-member simultaneously are protected by revision-aware writes on members-registry.json. The retry-on-conflict loop handles the race transparently.
- **Re-invite of a member whose old data was archived/deleted manually.** If the directory was removed but the registry still contains the old entry (unusual state), the task detects the registry entry, asks the admin to confirm, and re-creates the directory.
