---
name: view-permissions
type: task
version: 1.0.0
collection: agent-index-core
description: Show who has access to a resource on the remote filesystem. Calls aifs_get_permissions and formats the result conversationally. Member-facing — any member can run it on any path they have read access to.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle (gdrive contract v2.0+)
    description: Uses aifs_get_permissions, introduced in adapter contract v2.0.
reads_from: null
writes_to: null
---

## About This Task

`view-permissions` answers "who can see this?" for any path on the remote filesystem. It calls `aifs_get_permissions` against the path and formats the response in a conversational way.

The task is member-facing — a member can run it on any resource they themselves can read. They cannot use this task to inspect resources they don't have access to (Drive's permissions API enforces this; the call returns ACCESS_DENIED, which surfaces clearly).

For resources outside agent-index's normal directory shape (e.g., a member running this on the org root), the task surfaces the result the same way; it doesn't gate by path category.

### Inputs

- `path` — optional. If absent, the task asks for it or infers from conversation context (a project, idea, or member directory the conversation is currently focused on).

### Outputs

- Formatted permission listing surfaced to the caller.
- No file writes.

### Cadence & Triggers

On demand, whenever a member wants to see who has access to a resource.

---

## Workflow

### Step 1: Determine the path

If a path was supplied as an argument: use it directly.

Otherwise, infer from conversation context. Common patterns:
- The member just shared an idea, asked who can see it → use that idea's folder path.
- The member is in a project context → use the project folder.
- The member is looking at their own resources → use `/members/{their_hash}/`.

If the context is ambiguous, ask:

> Which resource do you want me to check? You can give me a path like `/shared/projects/pricing-refresh/` or just describe what you're asking about.

Resolve a friendly description (e.g., "the pricing-refresh project") to a path via `aifs_search` if needed.

### Step 2: Call aifs_get_permissions

```
result = aifs_get_permissions(path=<path>, include_inherited=true)
```

Default `include_inherited` to `true` so the member sees the full picture (explicit + inherited grants). They can ask to filter to explicit-only ("show me just the explicit grants") and the task re-runs with `include_inherited: false`.

### Step 3: Resolve subjects to display names where possible

The response has `subject` fields that are emails (or group addresses). For each email:

1. If it matches an entry in `members-registry.json`, attach the display name.
2. If it matches `org-config.json admins[].email`, append "(admin)".
3. If it matches `org-config.json remote_filesystem.connection.all_members_group`, label it "(all-members group)".
4. Otherwise, leave as the bare email.

For group addresses that aren't the all-members group: leave as bare and append "(group)" so the member knows it's not an individual.

### Step 4: Format and present

```
Permissions on `{path}`:

  • Bill (bill@agent-index.ai) — writer (explicit) (admin)
  • Jeff Rohwer (jrohwer@gmail.com) — writer (explicit)
  • agent-index-all@brainly.com — reader (inherited from `/`) (all-members group)

3 entries. Use `view-audit {path}` to see when these were granted.
```

Order:
1. Explicit grants first, sorted by role (writer → commenter → reader).
2. Inherited grants second, with the inheritance source path shown.
3. Group addresses after individual emails within each tier.

If the result has 0 permissions: surface "No explicit or inherited permissions found on `{path}`. The path may not exist, or you may have read access without explicit grants (uncommon). Try `aifs_exists` to confirm the path."

If the call returns `ACCESS_DENIED`: surface "I can't see permissions on `{path}` — your access doesn't include permission inspection. Ask whoever owns this resource."

If the call returns `PATH_NOT_FOUND`: surface "No resource exists at `{path}`. Did you mean a different path?"

---

## Directives

### Behavior

- Member-facing. Any member can run this on any path they can read.
- Default to including inherited permissions — members usually want the full picture, not just the local override.
- Resolve emails to display names from `members-registry.json` for readability. Bare email is a fallback, not the primary surface.

### Constraints

- Read-only. Never modify ACLs from this task. Pair with `share-resource` (TBD) or task-specific share flows for changes.
- Do not store or cache permission results. Drive's permission state is the source of truth and can change between sessions.

### Edge Cases

- **Permissions list is paginated.** `aifs_get_permissions` handles pagination internally — the result the task receives is the full list.
- **An email isn't in the members registry.** Could be an external collaborator, a removed member with stale grants, or a typo. Show the bare email; member can investigate.
- **Inherited grants when called on the root path `/`.** The root has no parent; all grants are explicit by definition. Still works — `inherited_from: null` for everything.
- **The path is outside agent-index's normal shape.** Works fine — the task isn't gated by category. If a member runs it on a random Drive folder they happen to have access to, it still answers correctly.
