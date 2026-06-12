---
name: verify-workspace-policy
type: task
version: 1.0.1
collection: agent-index-core
description: Admin diagnostic task. Verifies the Workspace-level policies that the access-control model depends on (per-folder ACLs allowed, per-file sharing with non-drive-members allowed, all-members Google Group exists and is reachable, drive base role is sane). Reports findings; does not modify policy.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle (gdrive contract v2.0+)
    description: Uses aifs_get_permissions and aifs_search to probe Workspace policy state.
reads_from: "/org-config.json"
writes_to: null
---

## About This Task

`verify-workspace-policy` is the admin's diagnostic for confirming that the org's Workspace-level configuration supports agent-index's native-permissions model. It does what it can from inside the calling admin's OAuth session — and tells the admin honestly what it can't check.

**What this task can directly verify:**
- `all_members_group` is configured in `org-config.json`.
- The all-members group address is a syntactically valid email and is reachable as a Drive permission subject (probed by attempting `aifs_get_permissions` on the org root and checking whether the group appears, falling back to a non-destructive existence test).
- `agent-index-filesystem-gdrive`'s `contract_version` is at v2.0.0.
- The org's shared drive (if applicable) is reachable and the calling admin has access.
- An ad-hoc sharing test against a sentinel resource succeeds (validates that per-folder sharing with non-drive-members works in this Workspace).

**What this task cannot directly verify** (Workspace admin queries require Admin SDK credentials agent-index does not have):
- Whether "Allow people who aren't shared drive members to access files" is enabled at the Workspace level.
- Whether content managers can share folders.
- The Workspace's external-sharing policy.
- The drive base role currently assigned to each non-admin member.

For the second list, the task surfaces a checklist with direct links to the relevant Admin Console pages so the admin can confirm visually.

### Inputs

- None (the task reads `org-config.json` for context).

### Outputs

- A diagnostic report surfaced to the admin.
- No file writes.

### Cadence & Triggers

- On demand, by admins who want to confirm their org is properly configured.
- Silently at session-start for admin sessions (a future integration; v1.0 ships as on-demand only).

---

## Workflow

### Step 1: Confirm caller is an admin

Read `org-config.json`. Verify the calling member is in the `admins` array. If not: surface "verify-workspace-policy is admin-only — its results would be uninformative for non-admins anyway, since some checks require admin-level Drive access." Stop.

### Step 2: Check `all_members_group` field is set

Read `org-config.json remote_filesystem.connection.all_members_group`. Record presence and the address.

If absent or empty: WARN. The 3.1.0 upgrade prerequisite hasn't been completed. Surface remediation: "Run `@ai:update` to complete the 3.1.0 upgrade prerequisite, then re-run."

If present but not a syntactically valid email (no `@`): WARN. Recorded value is malformed.

### Step 3: Verify adapter contract version

Read local `mcp-servers/filesystem/adapter.json` (or the equivalent for the active backend). Check `contract_version`.

If `< 2.0.0`: WARN. The local adapter is older than the access-control model requires. Run `@ai:update`.

If `2.0.0-partial`: WARN. The active adapter only implements some of the v2.0 ops. Note which ones are missing (read `supported_operations_pending`).

### Step 4: Probe the all-members group's reachability

Pick a resource the admin owns and the all-members group should have access to — `/CLAUDE.md` is canonical (admin-published, all-members-readable).

```
permissions = aifs_get_permissions("/CLAUDE.md", include_inherited=true)
```

Look for an entry whose `subject` equals the configured `all_members_group` address.

- **Found:** OK. Group is configured and Drive recognizes it as a permission subject. Record the role (should be reader).
- **Not found:** WARN. The group address is set in org-config but Drive doesn't show a corresponding share on `/CLAUDE.md`. Either (a) the group hasn't been added as a reader on the file, or (b) the group address is wrong. Surface remediation: "Verify the group exists in Workspace Admin Console (admin.google.com → Apps → Google Workspace → Groups for Business). Then ensure /CLAUDE.md and the other org-readable infrastructure files are shared with the group at reader role."

### Step 5: Probe Shared Drive accessibility (if applicable)

If `org-config.json remote_filesystem.connection.drive_id` is set:

```
aifs_search(scope="/", type="folder", max_results=1)
```

If this returns results: drive is reachable. OK.

If it returns `ACCESS_DENIED` or `INVALID_SCOPE`: WARN. The admin doesn't have Shared Drive access in their current OAuth session, which means even Workspace-level admin actions wouldn't be able to fix things from this session.

### Step 6: Surface the findings + manual-check checklist

```
Workspace Policy Verification Report — {org_name}

Direct checks:
  ✓ all_members_group configured: {value}
  ✓ Adapter contract version: {value}
  ✓ All-members group has access to /CLAUDE.md: {Yes / No / Not found}
  ✓ Shared Drive reachable: {Yes / N/A — personal Drive / No}

Manual checks (Workspace admin needs to confirm in admin.google.com):
  □ "Allow people who aren't shared drive members to access files" enabled
    Apps → Google Workspace → Drive and Docs → Manage shared drives → {your-drive} → Settings
  □ Content managers can share folders (same panel)
  □ External sharing policy matches your org's intent
    Apps → Google Workspace → Drive and Docs → Sharing settings
  □ All-members Google Group ({all_members_group}) exists and contains every current agent-index member
    Apps → Google Workspace → Groups for Business → {group}
  □ Non-admin members' drive base role is the lowest possible (path-B target state)
    Apps → Google Workspace → Drive and Docs → Manage shared drives → {your-drive} → Members

Issues found: {summary count}

Run `@ai:verify-workspace-policy` again after making changes to confirm.
```

If any direct check failed: surface specific remediation steps for each.

---

## Directives

### Behavior

- Admin-only diagnostic. Never modifies policy or writes anywhere.
- Honest about its limitations: clearly distinguishes what it can verify from what the admin needs to confirm visually.
- The manual-check checklist gives direct paths into the Workspace Admin Console.

### Constraints

- Never attempt to read Workspace admin APIs. agent-index doesn't have those credentials and shouldn't pretend to.
- The probe of all-members-group reachability uses an existing org-readable resource (`/CLAUDE.md`), not a sentinel write — the task should be safe to run any number of times without side effects.
- **This task is read-only and must remain so.** All probes use `aifs_get_permissions` and `aifs_search` (the read-only ops in the v2.0 adapter contract). If a future enhancement requires a permission-modifying remediation step (e.g., auto-fixing a misconfigured share), the change MUST go through the `permission-change-helper` skill per `agent-index-core/standards.md` § "Permission-Modifying Operations" — never call `aifs_share` / `aifs_unshare` / `aifs_transfer_ownership` directly.
- v1.0 is on-demand only. Session-start integration is a separate change that reads this task's findings and surfaces non-fatal warnings to admin sessions.

### Edge Cases

- **Brand-new install, /CLAUDE.md not yet published.** Step 4 falls back to `/org-config.json` (always present) instead.
- **Admin runs this from an account that's not a Google Workspace admin** (an org-config admin without Workspace Admin Console rights): the automated probes still run — they need only agent-index-level read access — but the manual-check checklist items that require the Admin Console must be delegated to Workspace IT; mark those items "needs delegation" in the report rather than failed.

<!-- RECONSTRUCTED 2026-06-10: original tail lost to truncation (bug 20260608-8d20ea22-003039-trunc); completion reviewed and approved by Bill. -->

<!-- AIFS:FILE-END -->