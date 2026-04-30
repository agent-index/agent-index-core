---
name: remove-member
type: task
version: 1.0.0
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
> Their `/members/{hash}/` directory will remain on the remote filesystem with its current ACLs. Workspace IT (or Drive admin) handles Drive-level offboarding when the person leaves the org — that's what auto-revokes their Drive shares and triggers any ownership transfer.
>
> Continue?

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
- Drive-side cleanup is explicitly NOT this task's job. The IT checklist tells the admin what to do at the Workspace level.
- The members-registry write is revision-aware to handle the unlikely-but-possible concurrent removal case.

### Constraints

- Never write to `members-registry.json` outside this task, `invite-member`, and `member-bootstrap`.
- Never touch Drive ACLs from this flow — even if it would be technically straightforward. Crossing that line creates a parallel offboarding flow that competes with Workspace IT's and gets out of sync.
- Stale references render at the task layer as historical names. Never rewrite or scrub historical data.

### Edge Cases

- **Email is not in the registry.** Surface clearly and stop. Don't attempt fuzzy matching — the admin should re-check the email.
- **Member is mid-task.** Removal does not interrupt any task the departing member is currently running in their own session. Their next session-start will fail at the registry-membership check and surface the standard "You're not registered with this org" path. (This is correct behavior — they've been removed.)
- **Two admins removing the same member concurrently.** Revision-aware write handles it. Whichever lands second sees REVISION_CONFLICT, re-reads, finds the entry already gone, and surfaces "{email} was already removed from the registry."
- **Re-invite later.** If this email is later re-invited via `invite-member`, the task detects the existing `/members/{hash}/` directory and asks whether to reuse (per access-control project decision).
