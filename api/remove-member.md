---
name: remove-member
type: task
version: 1.2.0
collection: agent-index-core
description: Admin-only task that removes a member from the agent-index roster. Removes their entry from members-registry.json and surfaces an IT checklist for Workspace-level offboarding. Intentionally narrow — agent-index does not touch Drive ACLs; Workspace IT handles identity offboarding.
stateful: false
produces_artifacts: false
produces_shared_artifacts: true
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle
    description: Reads and writes members-registry.json via the on-demand executor.
reads_from: "/members-registry.json"
writes_to: "/members-registry.json"
---

## About This Task

`remove-member` is the admin-side offboarding flow when someone leaves a team or org. The flow is intentionally narrow per the access-control project design:

1. agent-index removes the member's entry from `members-registry.json`.
2. agent-index surfaces a checklist for IT to handle Workspace-level offboarding (which auto-revokes Drive shares and prompts ownership transfer).

agent-index does **not** touch Drive ACLs in this flow. The reasons:

- Workspace IT already has tooling for this (Workspace offboarding flow).
- agent-index's per-resource ACL graph would be expensive to walk and revoke piecewise.
- A single source of truth for offboarding is better than two (us + Workspace) trying to cooperate.
- If the person is leaving the team but staying in the org, Workspace offboarding may not happen at all — admin can re-share specific resources later.

Stale references in existing artifacts (`idea.md` mentions, `action-items.json` assignees, `project.md` members lists) are handled at the task layer — they render as historical names with no live profile link, the same way email shows replies from departed colleagues.

### Inputs

- `email` — the email of the member to remove.

### Outputs

- `members-registry.json` (entry removed; revision-aware write)
- An IT checklist surfaced to the admin (informational; not written anywhere)

### Cadence & Triggers

On demand, when a member leaves the team or org.

---

## Workflow

### Step 1: Pre-flight

1. **Confirm caller is an admin.** Read `org-config.json`. Verify the calling member's `member_hash` is in the `admins` array. If not: surface "Only org admins can remove members." and stop.

2. **Refuse self-removal of the sole admin.** If the email being removed is in the `admins` array AND it's the only admin, surface "Cannot remove the only admin. Add another admin first via `@ai:edit-org`, then retry." and stop.

3. **Refuse removal of admins via this task.** If the email being removed appears in `org-config.json admins[]`, surface "This email is an org admin. Remove them as an admin first via `@ai:edit-org` admin management, then retry remove-member to take them out of the member registry." and stop. (Defense-in-depth: prevents accidentally orphaning an admin's entries or breaking the admin checks.)

### Step 2: Find the member

Compute `member_hash = sha256(email.toLowerCase()).hex.slice(0, 16)`. Read `members-registry.json` and locate the entry with this hash. If absent: surface "No member with email `{email}` is in the registry. Are you sure that's the right email?" and stop.

Confirm to the admin:

> Removing `{display_name}` ({email}) from the member registry.
>
> Their private member space lives in THEIR own My Drive (`Agent-Index-Private`) — it is not org property, agent-index has no access to it, and this task will not (and cannot) touch it or any sharing grants they made on it. Workspace IT (or Drive admin) handles Drive-level offboarding when the person leaves the org.
>
> Continue?

### Step 2.4: Departure acknowledgment for owner-shared content (added in v1.2.0 — MANDATORY)

Before any removal, enumerate the discovery indexes (`/shared/strategies-index/`, and any future `/shared/{collection}-index/`) for pointers with `owner_hash == {member_hash}` and a live scope (not `revoked`). If any exist, present them and require explicit acknowledgment:

> `{display_name}` owns {N} shared item(s) that live in their personal My Drive:
> {for each: - "{title}" ({slug}) — scope: {readers/collaborators/org_read}}
>
> **These shares survive removal** — they are Drive permissions on content the member owns. Recipients keep access. What the org loses is governance: after removal, nobody in agent-index can revoke, extend, audit, or repair these grants.
>
> If the org wants custody of any of these, a **current recipient** can adopt it now: copy the contents into their own member space and re-share from there (no owner cooperation needed — readers can copy what they can read). Optionally, ask `{display_name}` to revoke their original shares after adoption.
>
> Acknowledge to proceed with removal (this annotates the pointers but changes no permissions).

On acknowledgment: **overwrite** each such pointer adding `"owner_departed": true` and `"departed_date": "{today}"` — scope UNCHANGED (access still works; the pointer must reflect "live but no longer governed by agent-index"). Never set `revoked` here, and never touch the member's My Drive.

If no live pointers exist: skip silently.

### Step 2.5: Revoke the explicit member-directory grants (added in v1.1.0; narrowed in v1.2.0)

Before removing the registry entry, revoke the writer grant that `invite-member` explicitly granted at member creation. This is symmetric with `invite-member` 1.6.0 (which creates exactly this grant via the permission-helper). Closes bug `20260513-8d20ea22-3`.

**Bounded scope.** This step revokes ONLY the specific grant this collection's `invite-member` task is known to have applied:

- `/shared/members/artifacts/{member_hash}/` — writer for the departing member
- *(legacy)* `/members/{member_hash}/` — writer for the departing member, **if** such a pre-3.9.0 Shared-Drive directory exists and carries the grant (members invited before the My Drive model)

It does NOT walk the broader ACL graph looking for orphan grants on project resources, idea folders, shared artifacts, or anywhere else. Those remain Workspace IT's responsibility per Step 4's checklist; the broader cleanup is too expensive to do here and competes with Workspace's standard offboarding flow.

**Skip conditions.** Two cases where this step is a no-op:

1. **Grant doesn't exist.** Read `aifs_get_permissions(path)` for each of the two paths. If the departing member doesn't appear in the result (e.g., they were invited before v1.1.0 and a manual one-shot revoked the grants, or they never had explicit grants because the invite was a partial run), skip that path silently.
2. **Departing member is also being offboarded from Workspace this session.** This is a hint, not a hard signal — if the admin has already confirmed they're deleting the Google account, surface a notice that Workspace deletion will revoke ALL grants org-wide and ask whether to skip the per-resource revoke. On confirm: skip. On default: proceed with the per-resource revoke as a belt-and-suspenders.

**Procedure:**

1. **Read pre-state** for both paths via `aifs_get_permissions`. Filter to entries where the recipient subject matches the departing member's email.
2. **Build a permission-change spec** with one `unshare` op per existing grant (zero, one, or two ops total). Same JSON shape as `invite-member`'s spec.
3. **Hand the spec to the `permission-change-helper` skill.** Surface the `agent-index://apply?spec={path}` URL in chat per the canonical pattern in `agent-index-core/standards.md` § "Permission-Modifying Operations". Admin reviews and accepts in the browser review page.
4. **Verify post-state.** Re-read `aifs_get_permissions` for both paths and confirm the departing member is no longer present (either as explicit subject or via the removed permission_id).
5. **On verification success:** proceed to Step 3.
6. **On verification failure or admin cancellation:** halt before Step 3. The member-index entry is NOT removed; their grants are in an indeterminate state. Surface what's still in place and the next steps. Re-running `@ai:remove-member` is safe (the unshare ops are idempotent — the second run skips paths where the grant is already gone, per the skip condition above).

**Why this is bounded vs. unbounded ACL cleanup.** Walking every resource on the org's Drive to find any grant featuring the departing member is an expensive operation (potentially thousands of file lookups) and competes with Workspace IT's standard offboarding flow (which already revokes all grants on Google account deletion). The narrow scope of this step — only the two paths agent-index's own `invite-member` is known to have granted — is the symmetric counterpart of what we created, no more.

### Step 3: Remove the entry (revision-aware)

```
{ content, revision } = aifs_read("/members-registry.json"), aifs_stat("/members-registry.json")
```

Parse, remove the entry whose `member_hash` matches, write back with the captured revision:

```
aifs_write("/members-registry.json", new_content, if_revision=revision)
```

On `REVISION_CONFLICT`: re-read, re-apply the removal, retry. Cap at 5 retries.

### Step 4: Surface the IT checklist

After the registry write succeeds, surface to the admin:

> ✓ Removed `{display_name}` from the agent-index member registry.
>
> **IT / Workspace admin checklist** — what agent-index does NOT do (these belong to your Workspace flow):
>
> 1. **Offboard `{email}` from your Google Workspace** if they have left the org. This is what revokes their access to all the per-folder shares agent-index has granted them, and prompts ownership transfer for any files they own. (For Shared Drive installs, file ownership is the org's, so transfer doesn't apply — only share revocation.)
> 2. **Remove `{email}` from the all-members Google Group** (`{all_members_group}`) so they lose read access to org infrastructure files (CLAUDE.md, members-registry, bootstrap zip, etc.).
> 3. **If they are leaving the team but staying in the org** (e.g., moving to a different project), you can skip steps 1 and 2 and instead use `@ai:edit-project` on each project to remove them as a member. Their access to specific resources will be revoked at the project level.
>
> Stale references in existing project artifacts (action items they were assigned, ideas they collaborated on) will render as `{display_name}` (former member) and won't link to a live profile. This is intentional — historical attribution is preserved.

### Step 5: Optional — view the audit trail

Offer the admin: "Want to see what's still shared with `{email}` across the org? Run `view-audit` filtered to permissions events for that email." Don't run it automatically; admin can decide.

---

## Directives

### Behavior

- This task is admin-only. Admin self-removal-as-sole-admin is refused.
- **Drive-side cleanup is bounded to the grants `invite-member` explicitly created** (the two writer grants on `/members/{hash}/` and `/shared/members/artifacts/{hash}/`) — see Step 2.5. The broader ACL cleanup (project resources, idea folders, etc.) remains Workspace IT's job per Step 4's checklist.
- The members-registry write is revision-aware to handle the unlikely-but-possible concurrent removal case.

### Constraints

- Never write to `members-registry.json` outside this task, `invite-member`, and `member-bootstrap`.
- **MAY revoke the two specific ACLs `invite-member` explicitly created** (writer on `/members/{hash}/` and `/shared/members/artifacts/{hash}/`) per Step 2.5. These two grants are bounded, known, and symmetric with their creation; revoking them here closes a real correctness gap where a member who's been removed from the registry retains agent-index-issued Drive access until Workspace IT runs full account offboarding (which may never happen, e.g., for contractors).
- **MUST NOT walk the broader ACL graph** looking for orphan grants the departing member may have accumulated through project membership, idea collaboration, shared-artifact creation, etc. Those remain Workspace IT's responsibility — either through full Workspace offboarding (which auto-revokes everything) or through project-scoped removal via `@ai:edit-project`.
- **MUST go through the `permission-change-helper` skill** for the Step 2.5 unshare ops per `agent-index-core/standards.md` § "Permission-Modifying Operations". Never call `aifs_share` / `aifs_unshare` / `aifs_transfer_ownership` directly from this task.
- Stale references render at the task layer as historical names. Never rewrite or scrub historical data.

### Edge Cases

- **Email is not in the registry.** Surface clearly and stop. Don't attempt fuzzy matching — the admin should re-check the email.
- **Member is mid-task.** Removal does not interrupt any task the departing member is currently running in their own session. Their next session-start will fail at the registry-membership check and surface the standard "You're not registered with this org" path. (This is correct behavior — they've been removed.)
- **Two admins removing the same member concurrently.** Revision-aware wri