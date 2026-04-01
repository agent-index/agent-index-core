# Agent-Index Core — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

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
