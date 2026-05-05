# Agent-Index Core — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

---

## [3.3.1] — 2026-05-04

### Added

- **`invite-member` rewritten** to delegate ACL grants through the `permission-change-helper` skill. Pre-1.1.0 invite-member made up to 4 direct `aifs_share` calls in Steps 5 and 6, which the agent's safety boundary now categorically refuses. Post-rewrite: a single batched permission-change spec covers admin + new-member shares across `/members/{hash}/` and `/shared/members/artifacts/{hash}/`; the admin reviews all on one page and clicks Accept once; the helper's apply-script applies them with the admin's existing OAuth token. Pre-state is read via `aifs_get_permissions` to filter no-op shares (re-invite cases). Outcome branching covers all 7 helper terminal states (`applied`, `rejected`, `timed_out`, `page_closed`, `partial_failure`, `apply_error`, `verification_failed`, `binary_not_found`) with concrete recovery paths. Registry write moved to after-shares so a rejection or partial-failure leaves no orphan registry entry. Closes the consumer-rewrite half of bug `20260502-8d20ea22-4`. Per the `admin-tasks-use-permission-plan-pattern` idea — invite-member is the pilot consumer; remove-member and verify-workspace-policy are already correctly designed (no permission writes; constraint sections updated to forbid future direct `aifs_share` calls).

### Fixed

- **`apply-updates` Phase 1 step 6 LF normalization** for shipped shell scripts in `mcp-servers/permission-helper/`. Pre-3.3.1 the install logic on Windows hosts wrote files with the host-native CRLF line endings, which broke `bash mcp-servers/permission-helper/show-plan.sh` because `bash` cannot parse `\r` characters. Closes bug `20260504-8d20ea22-7`. Surfaced during the 2026-05-04 helper smoke testing on dev_install.

- **`apply-updates` Phase 1 step 5 strips stale `remote_filesystem.mcp_server` block** from `org-config.json`. Pre-3.3.1 installs created on 3.0.x carried this v2 leftover field whose `bundle_path` referenced a v3-deleted file (`mcp-servers/filesystem/server.bundle.js`). The block is purely cosmetic today (no runtime reads it) but is a footgun for any future task or human who naively reads `org-config.json` for a bundle path. Migration is non-destructive — only strips the block if `bundle_path` matches the v2 default. Closes bug `20260502-8d20ea22-3`.

- **`edit-org` Step 5 bootstrap regen LF-normalizes** all text-shaped files (shell scripts, JS, HTML, JSON, markdown) before adding them to the bootstrap zip, regardless of host OS. Same fix as the apply-updates change above but at the new-member install path; without it, new members from a Windows-host-published bootstrap would have the same CRLF problem.

### Changed

- `apply-updates` task v3.2.0 → v3.2.1 (LF normalization + mcp_server cleanup; behavior fixes).
- `edit-org` task v3.0.0 → v3.0.1 (LF normalization in bootstrap regen).
- `invite-member` task v1.0.0 → v1.1.0 (helper-mediated ACL grants; behavior change but input/output contract unchanged from admin's perspective).
- `remove-member` task v1.0.0 → v1.0.1 (constraint clarification; no behavior change).
- `verify-workspace-policy` task v1.0.0 → v1.0.1 (constraint clarification; no behavior change).
- `collection.json` description rewritten to lead with v3.3.1 changes.
- All 18 API-member manifests bumped to `collection_version: 3.3.1`.

### Notes

- **Verification status:** Tests 1, 3, and the helper-via-node tests are green on dev_install post-3.3.0. The full y-confirm round-trip (Test 2 + Test 4 with Accept) requires admin authorization and is gated on the gdrive 2.2.1 bundle being live. Once 2.2.1 ships, end-to-end smoke test should run cleanly.
- **`agent-index-filesystem-gdrive` 2.2.1** is a separate release that delivers the runtime-implementation half of the v2.0 contract ops. Both 3.3.1 and gdrive 2.2.1 should be applied together for the full `invite-member` flow to work end-to-end.

---

## [3.3.0] — 2026-05-04

### Added

- **`permission-change-helper` skill** (new in `agent-index-core/api/`). The canonical agent-callable surface for any task or skill that needs to modify access controls (`aifs_share` / `aifs_unshare` / `aifs_transfer_ownership`). Tasks invoke the skill with a structured spec; the skill validates, invokes the pre-built `agent-index-show-plan` binary, branches on the binary's terminal outcome, verifies post-state via `aifs_get_permissions`, and surfaces narration. Tasks must never call the underlying permission-modifying ops directly — the new section in `standards.md` codifies this. Closes the agent-side half of the architectural answer to bug `20260502-8d20ea22-4`.
- **Helper binary + page template + apply-script** (new in `agent-index-core/lib/permission-helper/`). Pre-built Node infrastructure that ships with core. The `agent-index-show-plan` binary picks a random localhost port, generates a one-time session token, renders an HTML review page in the member's default browser, listens for the member's deliberate Accept click, and runs an apply-script that uses the **member's existing OAuth token** (via `aifs-exec.sh`) to make the actual permission change. Listener has full lifecycle handling for accept / reject / page-close-via-heartbeat-absence / 10-min idle timeout / SIGTERM / apply-failure with retry. Includes a `--cli` fallback for headless contexts. Zero npm runtime dependencies (Node stdlib only). Detailed in the access-control project's tech design at `/shared/projects/access-control/artifacts/permission-change-helper-tech-design.md`.
- **`apply-updates` Phase 1 step 6** (new step): on a `core-update`, the task now installs or refreshes `mcp-servers/permission-helper/` from `agent-index-core/lib/permission-helper/` on remote. Recursive listing so future helper additions are picked up automatically; `chmod +x` for the executable scripts; idempotent on re-runs. Without this install path, the new skill's invocation of `bash mcp-servers/permission-helper/show-plan.sh` would fail.
- **`standards.md` § "Permission-Modifying Operations"** new section codifying the rule: tasks call `permission-change-helper`, never `aifs_share` / `aifs_unshare` / `aifs_transfer_ownership` directly. Lays out the required pattern for collections, what the helper is and isn't, and the future-adapter contract (call into core's helper as a peer; do not implement adapter-specific helpers).

### Fixed

- **`org-setup` "Upgrading an Installed Capability" — local file content was not being rewritten on per-capability bump (closes bug `20260502-8d20ea22-5`).** Pre-3.3.0 prose for the MINOR/PATCH branch said "apply the new definition directly, carry all existing setup responses forward unchanged, update the version in `member-index.json`." The "apply the new definition directly" phrasing was loose enough that agents interpreted it as "just bump the bookkeeping," skipping the actual file-content rewrite. The result was bookkeeping (member-index.json) saying one version while the on-disk installed file frontmatter remained at the pre-update version. Surfaced during the dev_install verification of 3.2.0 + developer 1.2.2: preflight reported "local install is stale at 1.1.0" while member-index recorded `preflight 1.2.2`. The fix makes the file-rewrite step explicit and unambiguous in both the upgrade-script and the no-upgrade-script branches: read the new content from remote (.md, -setup.md, -manifest.json), write each to the corresponding local installed path, then update member-index.json. The "no upgrade script" branch is *not* a bookkeeping-only operation.

### Changed

- `org-setup` skill v3.2.0 → v3.2.1 (upgrade-flow prose tightened; behavior fix only — no new functionality).
- `apply-updates` task v3.1.0 → v3.2.0 (new Phase 1 step 6 install plumbing; behavior addition).
- `collection.json` description rewritten to lead with the v3.3.0 changes.
- `collection.json` `api` array adds `permission-change-helper` (new entry, no triggers — plumbing skill is invoked by other tasks, never by members directly).
- All API-member manifests bumped to `collection_version: 3.3.0`.

### Implementation notes

- The helper ships dormant in 3.3.0 — no consumer task in this release calls it. The v3.1.0+ admin task family (`invite-member`, `remove-member`, etc.) gets rewritten in a follow-up release to delegate permission-modifying steps through the helper. Tracking idea: `admin-tasks-use-permission-plan-pattern` in `core-improvements`.
- End-to-end functionality of the helper's apply-script depends on bug `20260502-8d20ea22-2` (gdrive 2.2.0 ships a manifest declaring contract 2.0 + new ops, but the bundle is byte-identical to 2.1.3 and contains none of them). Until that bug is fixed, every `aifs_share` call from the apply-script will return `AIFS_EXEC_FAILED`. The helper itself works structurally; the underlying bundle is the gap.
- The `--cli` fallback is the recommended workaround for any environment where browser-launch is not viable; it accepts the same spec format and produces the same JSON status report on stdout.

---

## [3.2.0] — 2026-05-02

### Fixed

- **`org-setup` management dashboard "Needs Attention" — upgrade-available criterion was incorrect.** Pre-3.2.0 prose described the upgrade signal as "the collection version in the member index differs from the current collection version." Two errors in one sentence: (1) loose-equality (`differs from`) instead of strict less-than, and (2) the wrong field — `member-index.json` records the capability's `.md` frontmatter version (set by the install/upgrade flow that reads `aifs_read("/{collection}/api/{name}.md")`), not the collection-level `collection.json` `version`. Capabilities version independently of their parent collection, so a collection-level bump (trigger arrays, README polish, dependency manifest tweaks) does not imply any installed capability is out of date. The corrected criterion compares the per-capability `.md` frontmatter `version` against the member-index per-capability `version` using strict less-than semver. Local-ahead-of-remote is surfaced as an informational note rather than as an upgrade. Closes core-improvements idea `org-setup-capability-version-comparison-mismatch`. Same conceptual fix as marketplace 2.1.2 Step 4 (bug `20260430-8d20ea22`); the two surfaces now use identical comparison logic.

### Added

- **`org-setup` management dashboard — new "Removed from Collection" section.** During the dashboard scan, every member-index entry is now checked against `aifs_exists("/{collection}/api/{name}.md")`. Entries whose collection is reachable but whose capability file no longer exists are flagged as orphaned (the capability was removed in a later collection version) and listed in a new "Removed from Collection" dashboard section, separated from the *Installed* section. Each row offers a member-confirmed **Remove** action that triggers the existing "Removing an Installed Capability" flow — never auto-remove. Pairs with marketplace 2.1.2 Step 4's "capability removed from collection" classification: that fix produces the signal, this section consumes it. Closes core-improvements idea `org-setup-suggest-orphan-cleanup`.

### Changed

- `org-setup` skill v3.0.0 → v3.2.0 (dashboard scan and rendering changes; both fixes live in this single skill).
- `collection.json` description rewritten to lead with the v3.2.0 changes.
- All API-member manifests bumped to `collection_version: 3.2.0`.

### Drift cleanup (surfaced by the new developer 1.2.2 preflight check)

- **`member-bootstrap.md` frontmatter `version` corrected from 3.0.0 to 3.0.1.** This is pre-existing drift, not a 3.2.0 regression: commit `45544d6` ("OAuth flow fix 3.0.1," 2026-04-15) rewrote the member-bootstrap content for sandboxed environments and bumped `member-bootstrap-manifest.json` to `version: 3.0.1`, but the corresponding `.md` frontmatter was missed and stayed at `3.0.0`. The manifest was correct (it matched what was actually shipped); the `.md` frontmatter was the stale half. Self-running the new developer 1.2.2 preflight check against `agent-index-core` 3.2.0 surfaced this drift on the first run — exactly the case the new check is designed to catch. Bundled into this release rather than punted forward so the new check ships against a clean collection. No behavior change for installed members (the install/upgrade flow read frontmatter at install time, so existing dev_install entries record `member-bootstrap version: 3.0.0`; after `@ai:update` lands 3.2.0, the new "Needs Attention" upgrade-available comparison will see installed `3.0.0` < frontmatter `3.0.1` and flag a member-bootstrap upgrade — apply it as a normal upgrade).

---

## [3.1.1] — 2026-04-30

### Added

- **`infrastructure_directory_url` field** in `agent-index.json` template, pointing to the new `infrastructure-directory.json` in `agent-index-resource-listings`. Together with the `marketplace_directory_url` and `filesystem_adapter_directory_url` fields, this gives `check-updates` a single public, reachable place to discover infrastructure (core + marketplace) versions. Closes the gap left by `core_version_url` 404ing because the agent-index-core repo is private.
- **`apply-updates` Phase 1 step 4 extended** to migrate new top-level fields onto existing local `agent-index.json` files during a `core-update`. Non-destructive: never overwrites a field the member has set, only adds fields absent locally that exist in the canonical template. As of 3.1.1, this auto-migration adds `infrastructure_directory_url` for installs upgrading from 3.1.0 or earlier.

### Changed

- `apply-updates` task v3.0.0 → v3.1.0 (the migration logic is a meaningful addition).

---

## [3.1.0] — 2026-04-30

### Added

- **Extended adapter contract (v2.0).** The `aifs_*` family gains five new operations: `aifs_share`, `aifs_unshare`, `aifs_get_permissions`, `aifs_transfer_ownership` (optional per backend), and `aifs_search`. Plus an optional `if_revision` parameter on `aifs_write` for safe concurrent edits to shared state files. All operations execute under the calling member's OAuth identity — adapters never elevate privilege. Documented in `agent-index-filesystem/SPEC.md` v2.0; cross-referenced from `agent-index-core/standards.md` Two-Tier Filesystem section. Implements the Access Control project's Phase 0.
- **`all_members_group` field in `org-config.json`** under `remote_filesystem.connection`. Address of the Workspace-maintained Google Group whose membership is the authoritative agent-index member roster. Admin-published infrastructure files (`/CLAUDE.md`, `/org-config.json`, `/members-registry.json`, `/shared/bootstrap/`, `/shared/updates/`, `/shared/marketplace-cache/`) share with this address. Required for invite-member and other admin tasks that share content with all members. Optional but warned-if-missing.
- **Apply-updates Phase 0 prerequisite check.** When upgrading to 3.1.0+, `apply-updates` halts before applying any operations if `org-config.json remote_filesystem.connection.all_members_group` is missing. Prompts admin to provide a group address (validated and persisted) or defer the upgrade.
- **Six new typed errors** in `agent-index-filesystem/errors.js`: `RevisionConflictError`, `InvalidSubjectError`, `InvalidRoleError`, `InvalidRecipientError`, `InvalidScopeError`, `NotImplementedError`.

### Changed

- `agent-index-filesystem` package bumped to v2.0.0 (contract v2.0).
- `agent-index-filesystem-gdrive` adapter bumped to v2.2.0; declares `contract_version: "2.0.0"` (full v2.0). All five new ops implemented. `transferOwnership` returns `NOT_IMPLEMENTED` on Shared Drive (semantically correct — Shared Drive ownership belongs to the drive, not individual users).
- `org-config-schema.json` example bumped to v3.1.0; documents the new `all_members_group` field.

### Notes for OneDrive and S3 adapters

The contract change applies to all backends, but the v2.2.0 release ships the new ops in the gdrive adapter only. OneDrive and S3 adapters retain their v1.0.0 contract declaration until their own implementations land. Consumer collections that need access-control operations should require a gdrive-backed install for v3.1.0; multi-backend support follows in a subsequent release.

---

## [3.0.5] — 2026-04-19

### Added
- **Natural language triggers as first-class collection contract.** Collections now declare trigger phrases directly in `collection.json` API entries using the object format `{ "name": "...", "triggers": [...] }`. Each trigger maps a conversational phrase to a capability with a description. Plain string API entries remain valid for backward compatibility.
- **`routing.json` per-member routing file.** Each member gets a `profile/routing.json` file containing their personalized natural language routing mappings. Mappings have `source: "collection-default"` or `"member-custom"` to distinguish defaults from customizations.
- **Session-start Step 3: Load Natural Language Routing.** New step reads `routing.json` at session start and loads mappings into session context. Falls back to CLAUDE.md default table for pre-Phase 2 members.
- **Org-setup trigger customization (Phase 4, Step 13).** When installing collections, org-setup extracts default triggers from `collection.json`, writes them to `routing.json`, handles cross-collection collisions interactively, and presents the routing table for member review.
- **Preferences-management routing operations.** New "Natural Language Routing Management" section with view, add, edit, delete, and reset-to-defaults operations for routing mappings.
- **Validate-collection Step 5: Trigger Validation.** Five checks — coverage (≥2 phrases per capability), format (required fields), reserved phrase check, cross-collection collision check, placeholder consistency.
- **Author-collection Step 4: Design Natural Language Triggers.** New step in the authoring workflow for designing trigger phrases per API member, with best practices and author review.
- **Triggers added to all 9 installed collections.** ~160 trigger phrases across 51 capabilities covering agent-index-core, agent-index-marketplace, projects, bug-reports, email-triage, slack-triage, capture, strategy, and developer.

### Changed
- `standards.md` (v2.2.0): Added API Entry Format section (mixed string/object api entries) and Natural Language Triggers section (trigger format, collision policy, reserved phrases).
- `collection-authoring-guide.md` (v1.6.0): Added "Designing Natural Language Triggers" section with writing guidelines, design patterns, collision avoidance, and examples.
- CLAUDE.md template: Natural language mapping table now references `routing.json` as primary source with static table as fallback. Added `routing.json` to Key Files. Fixed `manage-decisions` → `project-decide` and `run-briefing` collection `email-triage` → `strategy`.
- `author-collection.md` (v3.1.0): 10-step workflow (was 9). Trigger design step, collection.json object format in generation step, trigger validation checks.
- `validate-collection.md`: 8-step workflow (was 7). Trigger validation step with 5 sub-checks.
- `session-start.md` (v3.0.0): 9-step workflow (was 8). Routing load step.

---

## [3.0.4] — 2026-04-17

### Added
- **"Agent-Index First" priority section in CLAUDE.md.** Positioned as the first behavioral instruction, before Bootstrap Protocol. Establishes that all project, strategy, task, triage, and work-management requests must route through agent-index capabilities before reaching for built-in connectors or external tools (Jira, Asana, Slack search, etc.). Includes three explicit fallback conditions: member names the external tool, a task definition calls for external data, or the request is clearly outside agent-index scope. Fixes the bug where Claude defaulted to Jira/Asana MCP connectors for requests that agent-index handles.
- **Natural language → capability mapping table in CLAUDE.md.** 18-row table covering all shipped collections (projects, bug-reports, email-triage, slack-triage, capture, strategy). Maps real conversational phrases ("what's on my plate", "how's X going", "triage my email") to specific agent-index capabilities. Members no longer need to know `@ai:` syntax — natural language is the primary interface.
- **Routing priority instruction in CLAUDE.md.** Explicit 4-step priority order: natural language mappings → `@ai:` alias tables → catch-all resolution → external tools. Signals that natural language is the primary routing mechanism.

### Changed
- CLAUDE.md section order: "Agent-Index First" now appears before Bootstrap Protocol. Natural language routing now appears before explicit `@ai:` alias tables. The `@ai:` tables are positioned as the explicit fallback, not the primary interface.
- "How to execute a skill or task" section expanded: step 3 now covers installed collection capabilities with the `/{collection}/api/{name}.md` pattern (previously only covered core and marketplace).
- Important Constraints section: added "Always route through agent-index first" as a closing constraint.

---

## [3.0.3] — 2026-04-16

### Added
- **"How to execute a skill or task" section in CLAUDE.md.** Gives Claude the exact path pattern (`/{collection}/api/{name}.md`) and the exact `aifs_read` command to use when executing a routed alias. Includes an explicit "do not `ls` or `aifs_list` to search for them — the path is deterministic" instruction. Eliminates the 18-23 command filesystem exploration that was happening before every `@ai:` invocation.
- **Deprecated v2 bridge warning in CLAUDE.md.** Calls out `agent-index-core/tools/aifs-bridge/` as obsolete v2 infrastructure that must not be used — prevents Claude from discovering the old bridge scripts and trying to start them.
- **Available tools list in CLAUDE.md.** Enumerates all `aifs_*` tools so Claude doesn't have to guess or explore (`aifs_list_files` was tried in one transcript — doesn't exist).

### Changed
- `apply-updates.md` Phase 1: core-update step now deletes `agent-index-core/tools/aifs-bridge/` and `mcp-servers/filesystem/server.bundle.js` if present during upgrade.
- `upgrade/2-to-3.md` Step 3a: expanded to include `agent-index-core/tools/aifs-bridge/` directory in the cleanup list.
- CLAUDE.md Two-Tier Filesystem section: rewritten to emphasize the exec-only invocation pattern and list available tools inline.

---

## [3.0.2] — 2026-04-15

### Added
- **Canonical `CLAUDE.md` template** at `agent-index-core/.claude/CLAUDE.md.template`. `create-org` now reads this file and substitutes `{org_name}` instead of generating the routing table freehand each time. Eliminates per-org drift in the routing table.

### Changed
- **Routing table now lists marketplace aliases explicitly.** Previously the table only documented core aliases (`@ai:setup`, `@ai:update`, `@ai:tutorial`, etc.) and relied on a vague "Any installed skill/task alias" catch-all to cover marketplace-provided commands like `@ai:refresh-marketplace-cache`, `@ai:marketplace`, `@ai:check-updates`. In practice Claude treated unlisted `@ai:` invocations as unknown and went hunting through the filesystem instead of executing them. The table now has dedicated Core / Marketplace sections covering all standard aliases.
- **Catch-all converted from passive listing to active resolution procedure.** The new "Catch-all: any other `@ai:{name}` alias" section spells out the exact resolution sequence — check `member-index.json` first, then scan `org-config.json` `installed_collections` for `/{collection}/api/{name}.md`, only declare unknown after both fail. Explicitly states that the routing table is a fast-path index, not an allowlist.
- `create-org` task bumped to v3.0.1 — references the new template instead of "generate it from the sections above".

### Fixed
- Members invoking marketplace tasks via `@ai:` aliases no longer hit a "I don't recognize this alias" detour while Claude searches the filesystem.

---

## [3.0.1] — 2026-04-15

### Changed
- `member-bootstrap` skill rewritten to document **paste-URL-back as the primary OAuth flow** for sandboxed environments (Cowork containers, CI). Previously the skill assumed a loopback callback server on `localhost:3939` would always be reachable — it isn't when the browser runs on the host and the OAuth flow runs inside a container. The flow now detects sandbox environments via `AIFS_SANDBOXED` / `COWORK` / `CI` env vars and instructs the member to paste the post-redirect URL back into chat.

---

## [3.0.0] — 2026-04-14

### Changed
- **Architecture: exec-only filesystem access.** Remote filesystem operations now use `aifs_*` tools invoked via an on-demand executor (`aifs-exec.sh` shell wrapper) instead of a persistent MCP server process. Each call spawns a fresh Node process, executes one operation, and exits. This eliminates server termination failures and removes the bridge daemon workaround.
- `agent-index.json` config: `remote_filesystem.mcp_server` key replaced by `remote_filesystem.exec` with `bundle_path` and `shell_wrapper` fields
- Bootstrap zip now contains `aifs-exec.bundle.js` and `aifs-exec.sh` instead of `server.bundle.js`
- Cowork plugin updated: validates exec bundle at session start instead of starting a server process
- Documentation updated throughout to reflect exec-only approach
- The `aifs_*` tool interface is unchanged — same tool names, arguments, return types, and error codes. Collections and member workflows require no modifications.

### Migration
- Members must remove old `server.bundle.js` and `aifs-bridge.mjs`, install new exec bundle and shell wrapper, and update `agent-index.json` config. See `upgrade/2-to-3.md` for full instructions.
- Existing authentication credentials are preserved — no re-authentication required.

---

## [2.1.0] — 2026-04-02

### Added
- **Capability provider system** — collections can now declare abstract capability requirements and register as providers of those capabilities, enabling loose coupling between collections
  - `capability-provider-spec.md` — full design specification covering provider/consumer declarations, multi-provider registries, capability bindings, runtime resolution, install-time validation, and migration guidance
  - `capability-types/communications.json` — well-known capability type for messaging and channel operations (send-notification required; create-channel, archive-channel, restore-channel, read-channel-history, invite-to-channel optional)
  - `capability-types/notifications.json` — lightweight well-known capability type for one-way alert delivery (send-notification only). Fully independent from communications — no implicit inheritance
  - `templates/resolve-capability.md` — copy-and-customize internal helper template for consumer collections implementing capability resolution
  - `standards.md` updated (v2.1.0) — new optional `provides` and `requires` fields for `collection.json`, `capability-bindings.json` file specification, Capability Provider Requirements section, `provider-register` and `provider-deregister` update log operation types
  - `collection-authoring-guide.md` updated (v1.5.0) — new "Designing for Capability Providers" section covering when to consume vs. provide, writing binding setup templates, resolution helper patterns, fallback design, and common mistakes

---

## [2.0.5] — 2026-04-02

### Added
- **Update instruction system** — new publish-apply model for distributing org changes to members
  - `publish-updates` task — admin task that diffs current org state against the last published snapshot and writes structured update instructions to `/shared/updates/update-log.json` on the remote filesystem
  - `apply-updates` task — member task that reads pending update instructions, merges overlapping entries into a single net update plan, and executes all needed steps (infrastructure updates, CLAUDE.md sync, adapter bundle updates, collection upgrades, new collection installs). Delegates capability-level operations to `org-setup`
  - Update instructions specification added to `standards.md` — defines `update-log.json` format, seven operation types (`core-update`, `marketplace-update`, `collection-update`, `collection-install`, `collection-remove`, `claude-md-update`, `adapter-bundle-update`, `org-config-update`), member cursor (`last_applied_update`), merge semantics, and remote filesystem layout
  - `session-start` Step 5 updated — primary check now reads `/shared/updates/latest.json` for a single lightweight comparison; existing version checks retained as fallback for orgs that haven't adopted publish-updates yet
  - `check-updates` updated — now reads update instruction status and references `@ai:update` in its "What to do" recommendations alongside diagnostic output
  - `edit-org` updated — new option 5 ("Publish updates for members") invokes `publish-updates`; About section now reminds admins to publish after making org changes
  - `collection.json` API list updated with `publish-updates` and `apply-updates`

---

## [2.0.4] — 2026-04-01

### Changed
- `collection-authoring-guide.md` (v1.2.0): Added "The bare Read anti-pattern" subsection to "Specifying Storage Access in Workflows" — documents the bug where writing `Read \`file.json\`` without specifying `aifs_read` causes agents to default to local file tools, missing remote data. Added checklist item for explicit tool qualifiers on all shared-data reads/writes.

---

## [2.0.3] — 2026-04-01

### Added
- `edit-org` now supports "Update adapter bundle and regenerate bootstrap zip" — admins can download the latest adapter bundle, update their local install, and regenerate the bootstrap zip for member distribution
- `session-start` Step 5 now checks whether the local adapter bundle is outdated and surfaces an admin-only notice when an update is available

---

## [2.0.2] — 2026-03-31

### Added
- New section in `collection-authoring-guide.md` (v1.1.0): "Specifying Storage Access in Workflows" — guidance on explicitly naming tool families (native Read/Write vs. `aifs_*`) alongside storage paths, local-first design defaults, and common patterns. Motivated by a bug in the Capture collection where ambiguous paths caused agents to store local data on the remote filesystem.

---

## [2.0.1] — 2026-03-31

### Changed
- Auth failures now trigger automatic re-authentication instead of prompting users to say `@ai:member-bootstrap`. Session-start invokes the member-bootstrap re-auth flow inline when `aifs_auth_status()` returns `authenticated: false`. Manual `@ai:member-bootstrap` is now a fallback only.
- Updated `standards.md` guidance so new collections follow the auto-re-auth pattern
- Updated `create-org.md` CLAUDE.md template to describe auto-re-auth behavior
- Updated `edit-org.md` and `preferences-management.md` error handling to attempt auto-re-auth before suggesting manual intervention

---

## [2.0.0] — 2026-03-24

### Changed
- **Architecture: remote filesystem model.** Org/shared files now live on a remote storage backend (Google Drive, OneDrive, or S3) accessed via an MCP server (`@agent-index/filesystem-gdrive` etc.). Member files remain local only. This replaces the v1 model that required all members to mount the same shared drive locally.
- `filesystem-setup` skill replaced by `member-bootstrap` skill — handles remote authentication, connectivity verification, local workspace creation, and remote member registration
- `session-start` task updated for hybrid local/remote reads — checks `aifs_auth_status()` instead of local filesystem mount
- `create-org` task rewritten — now uploads org files to remote, generates bootstrap zip for member distribution
- `org-setup` skill updated — reads collection catalog from remote via `aifs_read`/`aifs_list`
- `agent-index.json` updated with `remote_filesystem` section and `local.members_root`
- `org-config-schema.json` updated with `remote_filesystem` and `paths` sections
- All setup templates and manifests updated to reference `member-bootstrap` instead of `filesystem-setup`
- `collection.json` version bumped to 2.0.0

### Added
- `member-bootstrap` skill — new member onboarding with remote auth flow
- Two-tier filesystem documentation in README
- Bootstrap zip distribution model for new members
- Shared artifact consistency validation in `validate-collection` (checks `produces_shared_artifacts` vs `writes_to` alignment)
- Two-tier filesystem and MCP server coverage in `system-tutorial` guided tour
- Remote filesystem awareness in `author-collection` (shared artifact path design, `aifs_*` tool guidance for collection authors)
- Deprecation headers on legacy `filesystem-setup.md` and `filesystem-setup-setup.md`

### Removed
- `filesystem-setup` skill (deprecated, replaced by `member-bootstrap`)

---

## [1.0.0] — 2026-03-17

### Added
- Initial release
- `session-start` task — automatic session initialization
- `filesystem-setup` skill — shared filesystem connection and verification
- `org-setup` skill — member onboarding and capability management
- `preferences-management` skill — session preferences and alias management
- `system-tutorial` skill — system explanation and guided tour
- `create-org` task — first-time org configuration
- `edit-org` task — org admin list management and marketplace launch
- `agent-index.json` — root registry with filesystem paths and marketplace configuration
- `org-config-schema.json` — reference schema for org-config.json
- `standards.md` — open marketplace collection specification
- Setup templates and manifests for all skills and tasks
