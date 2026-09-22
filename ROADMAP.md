# Agent-Index Core — Roadmap

Current version: 3.29.0
Last updated: 2026-09-22

---

## Current State

Core is at **3.29.0** (2026-09-22). The collection provides session initialization, member onboarding, org and capability management, and collection publishing/update distribution, over a hybrid local/remote filesystem model: member-specific data stays local, org and shared data lives on a remote storage backend reached through the on-demand executor (`aifs_*`). Google Drive and OneDrive are both in production use. No S3 implementation work has shipped.

Four things have changed the shape of the system since v3.1.0:

**Backend-first distribution (Release C, 3.18.0, 2026-06-25).** Members never fetch from GitHub. The admin publishes to the org backend at `/shared/dist/`, SHA-gated, and members read from there. C.1 (3.19.0) completed GitHub-free install orchestration and added signed cross-platform helper builds; C.1.4.0 (3.23.0) added the full os×arch build matrix and publish-side re-render of the org's `/CLAUDE.md`.

**ID-anchored addressing (3.8.0, 2026-06-03; bootstrap-critical resources in C.1.4.3, 3.25.0).** Absolute paths address enumerable locations; `id:{folderId}/...` anchors address granted-but-non-enumerable ones. Bootstrap entry points are id-anchored because a non-Drive-member cannot enumerate the Shared Drive root, which makes root-level paths unresolvable for them.

**Member-owned private spaces (3.9.0, 2026-06-04).** Member spaces moved to each member's own My Drive — owner-sovereign sharing, with a pointer-index convention for discovery and soft-delete semantics in place of trashing.

**Helper-gated permission model.** Permission-modifying operations (`aifs_share`, `aifs_unshare`, `aifs_transfer_ownership`) are never called by collections directly; they route through `permission-change-helper` and apply under the member's own OAuth token after a deliberate Accept. The Go binary has been the only implementation since 3.7.4. The one sanctioned exception is `create-org`'s install-time bootstrap, which may apply directly and falls back to the helper if it does not.

The **capability provider system** runtime V1 shipped in 3.10.0 (single-provider auto-bind; multi-provider bindings remain post-V1).

**Bundled-script materialization (3.29.0, 2026-09-22).** Collections that ship an `apps/` directory now have it copied to `members/{member_hash}/installed/{collection}/apps/` at install, kept current by `apply-updates`, and addressed through the core-injected `apps_path`. Before 3.29.0 nothing put `apps/` on a member's machine at all, so every `{apps_path}` invocation in every collection failed silently. This also introduced the **core-injected parameter** concept — values core computes and supplies that collections consume but must not declare.

**Access Control (v3.1.0) is partially delivered.** The extended adapter contract and the five admin tasks shipped in 3.1.0. The later work — consumer collection upgrades, search-replaces-manifests, path-B cutover, per-idea ACLs — is outstanding, though some of it has been absorbed piecemeal by later releases. The project's own action-item register is the authority on phase status.

Upgrade paths from v1 to v2.0.x are deprecated; new deployments start at v3. The remote filesystem is required for v2+.

### Known Limitations

- **Capability binding is setup-time only.** Bindings are resolved during `org-setup` and written to `capability-bindings.json`. There is no runtime rebinding mechanism if a provider becomes unavailable. If a provider collection is uninstalled, consumer collections that depend on it will have stale bindings and will fail at runtime. A future version should support graceful degradation or re-binding prompts.

- **Update log does not support partial retries.** When a member applies updates, all pending instructions are merged into a single net plan and executed together. If a single operation fails mid-flight (e.g., a collection upgrade script times out), there is no rollback or restart mechanism. The member must manually investigate and potentially re-run `@ai:update` to retry. For minor updates this is acceptable; for major multi-collection upgrades it can be fragile.

- **Shared artifact validation is syntactic only.** `validate-collection` checks that a skill declares `produces_shared_artifacts: true` and has corresponding `writes_to` entries, but does not validate that the paths are actually used in the workflow or that the format (JSON, CSV, etc.) matches across consumers. Path and format mismatches between producer and consumer are caught at runtime, not at validation time.

- **Bootstrap zip is static and point-in-time.** The zip is generated once by `create-org` and distributed to members. If org config or the adapter bundle changes, members must re-download the zip or manually update their local copy. There is no mechanism for detecting or prompting refresh of an outdated bootstrap zip.

- **Auth failure recovery is inline and synchronous.** When `session-start` detects an auth failure, it invokes `member-bootstrap` re-auth inline, blocking session start. On slow or unreliable networks, this can cause sessions to hang or time out. A background re-auth or opt-in async pattern would be more robust for members with flaky connectivity.

- **No cross-org member migration.** Members who need to switch orgs (e.g., joining a different org or moving to a different deployment) have no built-in way to do so. They must manually delete their local workspace and bootstrap into the new org.

- **Bundled-script dependencies are not installed** (3.29.0). Core materializes a collection's `apps/` directory onto the member's machine, `requirements.txt` included, but does not create an environment or run `pip`. A script importing a third-party package is present and still fails on first run. Today this affects `email-triage` alone (three Google API packages); `bug-reports` and `cx-studio` are standard-library only. The authoring guide requires collections with third-party dependencies to document their own install step, and `org-setup` Phase 5 surfaces the requirement — but that is a notice, not a solution. A real answer means either a sanctioned per-collection environment or an explicit "this collection needs these packages, install them now?" step at setup. Deferred from 3.29.0 because copying files and managing environments are different problems.

### Known Bugs

Known bugs are tracked in the `bug-reports` collection, not here. Open items against
`agent-index-core` are visible via `@ai:view-bugs` filtered on that collection.

---

## Wishlist

### v2.2 — Quality of Life

- **Capability provider runtime fallback.** When a consumer skill tries to invoke a capability at runtime and the bound provider is unavailable, attempt automatic fallback to an alternative registered provider (if available) or surface a clear error with recovery steps.
- **Incremental update recovery.** Track update operation results and provide a `@ai:retry-update` command that re-runs only failed operations from the last update run, rather than re-processing the entire log.
- **Bootstrap zip auto-update detection.** Store a version timestamp in the local workspace and check it against remote during session start. If the bootstrap zip on remote is newer, surface a notice to the member that they should re-download it.
- **Extend core-injected parameters to `project_dir` and `member_workspace`.** 3.29.0 introduced the concept with `apps_path` as its only member. Both of these are values core knows and collections currently declare ad hoc — the same latent drift `apps_path` had, where four collections declared one value four different ways. Held out of 3.29.0 to keep that release reviewable: `apps_path` touches four collections, `project_dir` touches most of them.

### v2.3 — Deeper Integration

- **Capability binding validation at collection validation time.** `validate-collection` should check that consumer collections reference known capability types (from `capability-types/`) and that all required capabilities are documented. Emit warnings if a consumer references a capability type that has no registered provider in the org.
- **Cross-org onboarding.** A `@ai:switch-org` task that safely migrates a member's local preferences, aliases, and shared artifacts from one org's remote filesystem to another, handling name collisions and inconsistencies.
- **Shared artifact format registry.** Optional `produces_format` and `consumes_format` fields in manifests to declare format contracts (JSON schema, CSV columns, etc.). Validate format compatibility at install time and surface mismatches to admins and authors.

### v3.0 — Structural Changes (breaking)

- **Update log replay and audit trail.** Replace the current "last_applied_update" pointer model with a full replay log: members maintain an immutable record of every update they've applied, including operation results and any rollbacks. Supports member-local audit trails and enables recovery workflows.
- **Capability provider versioning.** Support multiple versions of a capability type coexisting (e.g., `communications@1.0` vs `communications@2.0`). Consumers declare a version requirement; bindings resolve based on available versions. Enables collections to upgrade capability contracts without forcing all dependents to update simultaneously.
- **Org role-based capability access.** Extend org-setup's role system to support role-based capability assignment. A role can declare which capabilities it grants, and a member inherits those capabilities based on their role(s) rather than opting in during setup. Reduces onboarding friction for members with predictable role assignments.

---

## Design Notes

- **Capability providers are opt-in, not implicit.** A collection does not automatically become a provider just because it has features that could be reused. It must explicitly declare `provides` in `collection.json` and write a binding setup template. This prevents accidental coupling and forces authors to think deliberately about reusable contracts.

- **Remote filesystem is non-negotiable for v2+.** The local-only filesystem model of v1 did not scale past small teams and created merge conflicts when multiple members tried to update shared files. v2 moved org/shared data to remote storage exclusively. This is a hard boundary and not optional.

- **Session start auth checks are fail-fast.** If `aifs_auth_status()` returns `authenticated: false`, session-start invokes re-auth immediately rather than continuing and failing later. This is intentional: it's better to know immediately that auth is broken and fix it than to silently fail mid-workflow.

- **The update system separates publication from application.** `publish-updates` is admin-only and runs once when the org changes. `apply-updates` is member-facing and can be run multiple times. This asymmetry is intentional: it ensures a single source of truth for what the org state is, while letting members apply updates at their own pace. Members cannot accidentally publish inconsistent state.

- **Capability bindings are not queryable at runtime.** Collections cannot ask "who provides X capability" during execution. Instead, bindings are resolved at install time and written to a config file. This forces consumers to be resilient to binding resolution failures (e.g., provider unavailable) rather than deferring decisions to runtime.
