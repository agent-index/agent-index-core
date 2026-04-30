---
name: view-audit
type: task
version: 1.0.0
collection: agent-index-core
description: Surface the audit trail for a resource — who shared with whom, when, what changed. v1.0 navigates the caller to the backend's native activity UI (Drive Activity for gdrive); v2 will wrap the Drive Activity API directly once the OAuth scope is expanded.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Backend's native activity service (Drive Activity for gdrive)
    description: Drive Activity is the canonical audit trail for share/unshare/create/delete events. v1.0 of this task points the admin at the relevant Drive UI; v2.0 will read the Activity API directly.
reads_from: null
writes_to: null
---

## About This Task

`view-audit` surfaces the audit trail for a resource. By design, agent-index does NOT maintain its own audit log — the backend's native activity service (Drive Activity for gdrive, OneDrive Activity for OneDrive, S3 CloudTrail for S3) is the canonical record. This is a deliberate property: the audit trail is admin-only at the backend layer, tamper-evident because we never touch it, and survives independent of agent-index's own state.

For v1.0, the task is a **navigational helper** rather than an API wrapper. It:

1. Resolves the resource path to a Drive file ID (using the existing path cache).
2. Constructs the Drive Activity URL for that file ID.
3. Surfaces it to the admin with guidance on what to look for.

A future v2.0 of this task will use the Drive Activity API directly (https://developers.google.com/drive/activity), which requires expanding the OAuth scope to `https://www.googleapis.com/auth/drive.activity.readonly`. That expansion forces every member to re-authenticate, which we deferred for v1.0 — re-auth deserves its own coordinated rollout, not a side-effect of an admin task.

### Inputs

- `path` — the resource to audit. Optional; can be inferred from conversation context (e.g., the project, idea, or member directory currently being discussed).
- `mode` — `curated` (default) or `full`. Curated means "show what an admin reviewing for security would care about: share/unshare, create/delete, ownership transfer." Full means everything Drive Activity records (reads, edits, comments, etc.). For v1.0 (navigational), this only changes the guidance text shown.

### Outputs

- A Drive Activity URL for the resource.
- Guidance on which event types to filter for in Drive's UI.

### Cadence & Triggers

On demand, when an admin (or member, scoped to their own resources) wants to see who did what to a resource and when.

---

## Workflow

### Step 1: Determine the path

Same logic as `view-permissions`: explicit arg if supplied, conversation context if implied, ask if ambiguous.

### Step 2: Resolve to a Drive file ID

Use the path cache (or `aifs_search` if not cached) to map the path to a Drive file ID:

```
file_id = lookup_in_path_cache(path) OR aifs_search(scope=parent, name_contains=basename) -> first result
```

If the path cannot be resolved: surface "I can't find a Drive file for `{path}`. Either it doesn't exist or you don't have read access to discover it." and stop.

### Step 3: Construct the Drive Activity URL

```
url = `https://drive.google.com/drive/activity/?fileId={file_id}`
```

If the org is on a Shared Drive, also surface the drive-level activity URL:

```
drive_url = `https://drive.google.com/drive/activity/?driveId={shared_drive_id}`
```

### Step 4: Surface to the admin

```
Audit trail for `{path}` (Drive file ID `{file_id}`):

  → {url}

Open this in your browser. Drive Activity will show the chronological event stream for this resource — share/unshare events, edits, ownership changes, deletions, etc.

For a security review, filter to:
  • Permission changes (share, unshare, role updates)
  • Ownership transfers
  • Create/delete events
  • Move events (if folders changed parent)

For everything (forensic mode), use the unfiltered view.

{if Shared Drive:}
You can also see drive-level activity at:
  → {drive_url}

Note: agent-index does not maintain its own audit log. Drive Activity is the canonical record and is admin-tamper-evident. A future v2.0 of this task will surface filtered activity directly here without you needing to leave the conversation.
```

If the caller is not an admin and the resource isn't theirs, Drive will gate access at the API layer when v2.0 reads activity, but for v1.0 the URL works for anyone who has read access to the resource (Drive Activity for an item you can read is visible to you).

---

## Directives

### Behavior

- v1.0 is a navigational helper, not an API wrapper. This is intentional — adding the Drive Activity API scope requires a coordinated re-auth rollout, deferred to v2.0.
- The task reflects the design principle "audit comes from the backend, not from us." By pointing admins at Drive directly, we reinforce that Drive is the source of truth.
- Available to both admins and members. Members can run it on their own resources or any resource they can read.

### Constraints

- Never construct or serve our own audit log. The backend's record is authoritative.
- Don't try to summarize Drive Activity from scraped pages or anything similar — it's not safe and not stable.
- v2.0 must propose the OAuth scope expansion as its own decision, with member-facing migration notes.

### Edge Cases

- **Resource doesn't exist or caller lacks access.** Surface clearly, offer to run `aifs_exists` to verify the path.
- **Resource is a folder.** Drive Activity supports folder-level activity views via the same URL pattern. Works without modification.
- **Shared Drive.** Both file-level and drive-level activity URLs are surfaced.
- **Member running on a resource they own but not an admin.** Their Drive Activity view is scoped to what they can see — fewer events than an admin would see, which is correct.
