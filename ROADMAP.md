# Agent-Index Core — Roadmap

Current version: 3.1.0
Last updated: 2026-04-30

---

## Current State

v3.0.0 is the foundation of agent-index: session initialization, member onboarding, org and capability management, and collection publishing/update distribution. The collection runs on a hybrid local/remote filesystem model where member-specific data stays local and org/shared data lives on a remote storage backend (Google Drive, OneDrive, or S3) accessed via the on-demand executor (`aifs_*` tools invoked through the exec shell wrapper).

v3.0.0 introduces the **capability provider system**, allowing collections to declare abstract capability requirements and register as providers of those capabilities. This enables loose coupling between collections: instead of hard-coding dependencies on specific collections, a consumer collection can declare "I need messaging capability" and bind to whichever provider has registered one.

**v3.1.0 (2026-04-30) — Native Filesystem Permissions.** The Access Control project shipped: extended adapter contract (v2.0.0) adding `aifs_share`, `aifs_unshare`, `aifs_get_permissions`, `aifs_transfer_ownership`, `aifs_search`, plus `if_revision` on `aifs_write` for safe concurrent edits. Five new admin tasks (`invite-member`, `remove-member`, `view-permissions`, `view-audit`, `verify-workspace-policy`) operationalize the model. New `all_members_group` field in `org-config.json` references a Workspace-maintained Google Group for the all-members canonical recipient. The `apply-updates` flow now has a Phase 0 prerequisite that prompts admin for the group address during the 3.0.x → 3.1.0 upgrade. The gdrive adapter ships v2.0.0 contract; OneDrive and S3 adapters retain v1.0.0 contract until their own implementations land. Phase 0 of the access-control work is complete; Phase 1 (admin tasks) is complete; Phases 2-5 (consumer collection upgrades, search-replaces-manifests, path-B cutover, per-idea ACLs) are upcoming.

Upgrade paths from v1 to v2.0.x are deprecated; new deployments should start at v3.0.0. The remote filesystem (via the on-demand executor) is required for v2+.

### Known Limitations

- **Capability binding is setup-time only.** Bindings are resolved during `org-setup` and written to `capability-bindings.json`. There is no runtime rebinding mechanism if a provider becomes unavailable. If a provider collection is uninstalled, consumer collections that depend on it will have stale bindings and will fail at runtime. A future version should support graceful degradation or re-binding prompts.

- **Update log does not support partial retries.** When a member applies updates, all pending instructions are merged into a single net plan and executed together. If a single operation fails mid-flight (e.g., a collection upgrade script times out), there is no rollback or restart mechanism. The member must manually investigate and potentially re-run `@ai:update` to retry. For minor updates this is acceptable; for major multi-collection upgrades it can be fragile.

- **Shared artifact validation is syntactic only.** `validate-collection` checks that a skill declares `produces_shared_artifacts: true` and has corresponding `writes_to` entries, but does not validate that the paths are actually used in the workflow or that the format (JSON, CSV, etc.) matches across consumers. Path and format mismatches between producer and consumer are caught at runtime, not at validation time.

- **Bootstrap zip is static and point-in-time.** The zip is generated once by `create-org` and distributed to members. If org config or the adapter bundle changes, members must re-download the zip or manually update their local copy. There is no mechanism for detecting or prompting refresh of an outdated bootstrap zip.

- **Auth failure recovery is inline and synchronous.** When `session-start` detects an auth failure, it invokes `member-bootstrap` re-auth inline, blocking session start. On slow or unreliable networks, this can cause sessions to hang or time out. A background re-auth or opt-in async pattern would be more robust for members with flaky connectivity.

- **No cross-org member migration.** Members who need to switch orgs (e.g., joining a different org or moving to a different deployment) have no built-in way to do so. They must manually delete their local workspace and bootstrap into the new org.

### Known Bugs

None currently tracked.

---

## Wishlist

### v2.2 — Quality of Life

- **Capability provider runtime fallback.** When a consumer skill tries to invoke a capability at runtime and the bound provider is unavailable, attempt automatic fallback to an alternative registered provider (if available) or surface a clear error with recovery steps.
- **Incremental update recovery.** Track update operation results and provide a `@ai:retry-update` command that re-runs only failed operations from the last update run, rather than re-processing the entire log.
- **Bootstrap zip auto-update detection.** Store a version timestamp in the local workspace and check it against remote during session start. If the bootstrap zip on remote is newer, surface a notice to the member that they should re-download it.

### v2.3 — Deeper Integration

- **Capability binding validation at collection validation time.** `validate-collection` should check that consumer collections reference known capability types (from `capability-types/`) and that all required capabilities are documented. Emit warnings if a consumer references a capability type that has no registered provider in the org.
- **Cross-org onboarding.** A `@ai:switch-org` task that safely migrates a member's local preferences, aliases, and shared artifacts from one org's remote filesystem to another, handling name collisions and inconsistencies.
- **Shared artifact format registry.** Optional `produces_format` and `consumes_format` fields in manifests to declare format contracts (JSON schema, CSV columns, etc.). Validate format compatibility at install time and surface mismatches to admins and authors.

### v3.0 — Structural Changes (breaking)

- **Update log replay and audit trail.** Replace the current "last_applied_update" pointer model with a full replay log: members maintain an immutable record of every update they've applied, including operation results and any rollbacks. Supports member-local audit trails and enables recovery workflows.
- **Capability provider versioning.** Support multiple versions of a capability type coexisting (e.g., `communications@1.0` vs `communications@2.0`). Consumers declare a version requirement; bindins resolve based on available versions. Enables collections to upgrade capability contracts without forcing all dependents to update simultaneously.
- **Org role-based capability access.** Extend org-setup's role system to support role-based capability assignment. A role can declare which capabilities it grants, and a member inherits those capabilities based on their role(s) rather than opting in during setup. Reduces onboarding friction for members with predictable role assignments.

---

## Design Notes

- **Capability providers are opt-in, not implicit.** A collection does not automatically become a provider just because it has features that could be reused. It must explicitly declare `provides` in `collection.json` and write a binding setup template. This prevents accidental coupling and forces authors to think deliberately about reusable contracts.

- **Remote filesystem is non-negotiable for v2+.** The local-only filesystem model of v1 did not scale past small teams and created merge conflicts when multiple members tried to update shared files. v2 moved org/shared data to remote storage exclusively. This is a hard boundary and not optional.

- **Session start auth checks are fail-fast.** If `aifs_auth_status()` returns `authenticated: false`, session-start invokes re-auth immediately rather than continuing and failing later. This is intentional: it's better to know immediately that auth is broken and fix it than to silently fail mid-workflow.

- **The update system separates publication from application.** `publish-updates` is admin-only and runs once when the org changes. `apply-updates` is member-facing and can be run multiple times. This asymmetry is intentional: it ensures a single source of truth for what the org state is, while letting members apply updates at their own pace. Members cannot accidentally publish inconsistent state.

- **Capability bindings are not queryable at runtime.** Collections cannot ask "who provides X capability" during execution. Instead, bindings are resolved at install time and written to a config file. This forces consumers to be resilient to binding resolution failures (e.g., provider unavailable) rather than deferring decisions to runtime.
