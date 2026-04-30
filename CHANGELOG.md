# Agent-Index Core — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

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
