# Agent-Index Core — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

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
