# Agent-Index Collection Standards
## Marketplace Eligibility Specification

**Version:** 2.0.0
**Maintained by:** agent-index
**Last Updated:** 2026-03-24

---

## Overview

This document defines the requirements a collection must meet to be eligible for the agent-index marketplace. These standards exist to ensure that any collection an org installs behaves predictably, is maintainable over time, and integrates cleanly with agent-index-core infrastructure.

The standards are open. Any individual, team, or vendor may build and submit a marketplace-eligible collection.

---

## Required File Structure

Every marketplace-eligible collection must have the following files at its root:

```
/{collection-name}/
  collection.json              ← required
  README.md                    ← required
  CHANGELOG.md                 ← required
  ROADMAP.md                   ← recommended (known bugs, wishlist, future direction)
  /api/                        ← required (may be empty only if collection provides roles only)
  /setup/
    collection-setup.md        ← required
    collection-setup-responses.md  ← written at install time, not authored
  /upgrade/                    ← required directory (may be empty at v1.0.0)
```

---

## `collection.json` Required Fields

All fields listed below are required. No field may be omitted.

| Field | Type | Description |
|---|---|---|
| `name` | string | Kebab-case identifier. Must match the collection directory name. Must be unique in the marketplace. |
| `display_name` | string | Human-readable name |
| `version` | string | Semantic version (MAJOR.MINOR.PATCH) |
| `description` | string | One sentence, plain language |
| `author` | string | Author or organization name |
| `license` | string | License type (`open`, `commercial`, `proprietary`, or SPDX identifier) |
| `category` | string | Functional category (see Category Registry below) |
| `agent_index_min_version` | string | Minimum agent-index-core version required |
| `api` | array | List of public skill/task names. Empty array if none. |
| `dependencies` | array | Names of other collections this collection depends on. Empty array if none. |
| `external_dependencies` | array | External systems required. Empty array if none. |
| `eol_date` | string or null | ISO date string or null |
| `marketplace_url` | string | URL of the collection's Git repository |
| `support_url` | string | URL for support or documentation |

---

## API Member Requirements

Every name listed in `collection.json` `api` array must have a corresponding `.md` file in `/api/`. Each API member file must:

- Have valid YAML frontmatter with all required fields for its type (skill or task)
- Have a `name` field in frontmatter that matches the filename (without `.md`)
- Have a `collection` field that matches the collection name
- Have a corresponding `-setup.md` file in `/api/`
- Have a corresponding `-manifest.json` file in `/api/`

---

## Skill and Task File Requirements

All skill and task definition files (in both `/api/` and `/internal/`) must conform to the agent-index file format standards defined in `agent-index-core/file-format-standards.md`.

Required frontmatter fields for skills:

| Field | Required |
|---|---|
| `name` | Yes |
| `type` | Yes — must be `skill` |
| `version` | Yes |
| `collection` | Yes |
| `description` | Yes |
| `stateful` | Yes |
| `always_on_eligible` | Yes |
| `dependencies` | Yes |
| `external_dependencies` | Yes |

Required frontmatter fields for tasks:

| Field | Required |
|---|---|
| `name` | Yes |
| `type` | Yes — must be `task` |
| `version` | Yes |
| `collection` | Yes |
| `description` | Yes |
| `stateful` | Yes |
| `produces_artifacts` | Yes |
| `produces_shared_artifacts` | Yes |
| `dependencies` | Yes |
| `external_dependencies` | Yes |
| `reads_from` | Yes — null if not aggregating |
| `writes_to` | Yes — null if not aggregating |

---

## Setup Template Requirements

Every skill and task in `/api/` must have a corresponding `-setup.md` file. Setup templates must:

- Have valid YAML frontmatter with `name`, `type: setup`, `version`, `collection`, `description`, `target`, `target_type`, and `upgrade_compatible`
- Declare every parameter with an explicit level annotation (`[org-mandated]`, `[role-suggested]`, `[member-overridable]`, or `[member-defined]`)
- Include a `Setup Completion` section listing all writes
- Include an `Upgrade Behavior` section with `Preserved Responses`, `Reset on Upgrade`, `Requires Member Attention`, and `Migration Notes` subsections

---

## Collection Setup Template Requirements

`collection-setup.md` must:

- Have valid YAML frontmatter with `name`, `type: collection-setup`, `version`, `collection`, `description`, and `upgrade_compatible`
- Cover all org-level parameters that flow into member-level setup interviews as `[org-mandated]`
- Include a `Setup Completion` section
- Include an `Upgrade Behavior` section

---

## Versioning Requirements

- All collections must use semantic versioning: `MAJOR.MINOR.PATCH`
- MAJOR version bumps are required for: breaking changes to setup interfaces, breaking changes to parameter schemas, breaking changes to API member interfaces, removal of API members
- MINOR version bumps are required for: new API members, new optional parameters, non-breaking additions
- PATCH version bumps are used for: bug fixes, clarifications, non-behavioral changes
- API members must maintain a stable interface across MINOR versions
- Upgrade scripts are required in `/upgrade/` for every MAJOR version boundary after v1.0.0

---

## EOL Policy Requirements

- When a new MAJOR version is published, an `eol_date` must be set on the prior MAJOR version
- Minimum EOL window: 90 days from the new MAJOR version publish date
- `eol_date` must be set in `collection.json` of the version being deprecated

---

## CHANGELOG Requirements

`CHANGELOG.md` must:

- Document every version in reverse chronological order (newest first)
- Use the format: `## [MAJOR.MINOR.PATCH] — YYYY-MM-DD`
- List changes under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` headings as applicable
- For MAJOR versions: include a migration summary and link to the upgrade script

---

## README Requirements

`README.md` must include:

- A plain-language description of what the collection does
- A list of included skills and tasks with one-line descriptions
- Any prerequisites (external systems, other collections)
- The lifecycle or workflow the collection supports, if applicable
- A version history reference pointing to CHANGELOG.md

---

## Category Registry

Collections must declare one of the following categories. New categories may be proposed via the agent-index GitHub repository.

| Category | Description |
|---|---|
| `infrastructure` | Core system components (reserved for agent-index-core and agent-index-marketplace) |
| `project-management` | Project tracking, planning, and coordination |
| `hris` | Human resources information systems |
| `ats` | Applicant tracking and recruiting |
| `crm` | Customer relationship management |
| `finance` | Finance, accounting, and expense management |
| `communication` | Email, messaging, and notification workflows |
| `document-management` | Document creation, storage, and lifecycle |
| `reporting` | Analytics, dashboards, and reporting workflows |
| `developer-tools` | Engineering and development workflows |
| `sales` | Sales process and pipeline management |
| `marketing` | Marketing workflows and content management |
| `customer-success` | Customer support and success workflows |
| `productivity` | General productivity and personal workflow tools |
| `strategy` | Strategy development, competitive intelligence, and opportunity tracking |
| `personal-productivity` | Personal capture, task management, and individual workflow tools |

---

## Naming Conventions

- Collection names: kebab-case, lowercase, no special characters except hyphens
- Collection names must not start with `agent-index-` (reserved for official agent-index collections)
- Collection names must be globally unique within the marketplace
- Collection directory name must match the `name` field in `collection.json`
- Skill and task names within a collection: kebab-case, globally unique within the collection

---

## Identity Resolution

Agent-index uses hash-based member identity. Member directories are named using a truncated SHA256 hash of the member's lowercase email address, providing privacy while maintaining deterministic resolution. Hashes are used for both local workspace directory names and remote registry lookups.

### Configuration

Identity resolution is configured in `agent-index.json`:

```json
"identity_resolution": {
  "method": "sha256-email",
  "hash_length": 16,
  "registry_path": "/members-registry.json"
}
```

| Field | Type | Description |
|---|---|---|
| `method` | string | Always `sha256-email` in v2.0 |
| `hash_length` | integer | Number of hex characters to use from the SHA256 hash. Default: 16 |
| `registry_path` | string | Path to the members registry file on the remote filesystem |

### Members Registry

The members registry maps hashes to display identities. Located at `/members-registry.json` on the remote filesystem (accessed via `aifs_read`/`aifs_write`):

```json
{
  "version": "1.0.0",
  "last_updated": "2026-03-19",
  "members": [
    {
      "member_hash": "a7f3b2c1d4e5f698",
      "display_name": "Bill Salak",
      "email": "bill@example.com",
      "org_role": "engineer",
      "joined_date": "2026-03-19"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `member_hash` | string | First N hex characters of SHA256(lowercase email), where N = `hash_length` |
| `display_name` | string | Human-readable name |
| `email` | string | The email address used to compute the hash |
| `org_role` | string or null | The `role_id` of the member's selected org role, or null |
| `joined_date` | string | ISO date when the member workspace was created |

### Hash Computation

1. Take the member's email address
2. Convert to lowercase
3. Compute SHA256 hash
4. Take the first `hash_length` hexadecimal characters

Example: `bill@example.com` → SHA256 → `a7f3b2c1d4e5f698...` → `a7f3b2c1d4e5f698`

---

## Member Resolution in Collection Workflows

Any collection whose skills or tasks reference people — project owners, team members, assignees, reviewers, approvers, or similar — must resolve those references against the members registry rather than storing bare name strings. This ensures that people referenced in shared data are linked to their actual org identities when possible.

### Required Behavior

When a workflow collects a person reference (e.g., "Who is the project owner?" or "Add Sarah as a reviewer"):

1. **Search the registry.** Read `/members-registry.json` from the remote filesystem via `aifs_read("/members-registry.json")` and search by `display_name` using case-insensitive partial matching (e.g., "Bill" matches "Bill Smith").

2. **Single match → confirm.** If exactly one member matches, confirm with the user: "That's {display_name} ({email}), correct?" On confirmation, record the person as a **registered member** with their `member_hash`, `display_name`, and `email`.

3. **Multiple matches → disambiguate.** If more than one member matches, present all matches and ask the user to select the correct person.

4. **No match → record as unregistered.** If no member matches, record the person using the provided name with `member_hash: null` and `email: null`. Inform the user: "{name} isn't in the org's member registry yet. I'll add them by name for now — once they're set up in agent-index, you can link their full identity later."

5. **Self-references.** If the user says "me", "I am", or similar, use the running member's identity (already resolved at session start from their `member_hash`).

### Schema for Person Fields

Wherever a person is stored in a collection's data files (`project.md`, task records, etc.), use a structured object rather than a bare string:

```yaml
owner:
  display_name: "Bill Smith"
  member_hash: "8d20ea22b9df1b13"    # or null if unregistered
  email: "bill@example.com"           # or null if unregistered
```

```yaml
members:
  - display_name: "Sarah Kim"
    member_hash: "a1b2c3d4e5f6a7b8"
    email: "sarah@example.com"
    role: Contributor
  - display_name: "Alex"
    member_hash: null
    email: null
    role: Reviewer
```

This format allows downstream tasks and reports to distinguish registered members (who can be looked up, notified, or referenced in other workflows) from placeholder names that need to be linked once the person joins the org.

### Linking Unregistered Members

Collections that support editing (like `edit-project`) should provide a way to retroactively link an unregistered member to their registry entry once they've joined the org. This is done by searching the registry by display name, confirming the match, and updating the record with their `member_hash` and `email`.

---

## Update Instructions

Agent-index uses a publish-apply update model. Org admins publish structured update instructions to the remote filesystem after making org-level changes. Members consume those instructions on demand to bring their local installations current. This decouples the admin's change-making workflow from the member's update-applying workflow and ensures members always have a prescribed path to the current org state.

### Update Log

The update log is an append-only ordered list of update entries stored at `/shared/updates/update-log.json` on the remote filesystem. Each entry records a batch of org-level changes published by an admin.

```json
{
  "version": "1.0.0",
  "entries": [
    {
      "id": "001",
      "published": "2026-03-15T14:30:00Z",
      "published_by": "a7f3b2c1d4e5f698",
      "summary": "Initial collection rollout",
      "operations": [ ... ]
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `version` | string | Schema version for the update log format |
| `entries` | array | Ordered list of update entries, oldest first |

Each entry:

| Field | Type | Description |
|---|---|---|
| `id` | string | Zero-padded sequential identifier (e.g., `"001"`, `"002"`). Used as the member's update cursor. |
| `published` | string | ISO 8601 timestamp of when the entry was published |
| `published_by` | string | `member_hash` of the admin who published |
| `summary` | string | Human-readable annotation describing the purpose of this update batch |
| `operations` | array | List of typed operations describing what changed |

### Operation Types

Each operation in an entry has a `type` field and type-specific fields:

**`core-update`** — agent-index-core was updated.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"core-update"` |
| `target_version` | string | The new core version |
| `from_version` | string | The core version at time of publish (informational — members use their own installed version) |

**`marketplace-update`** — agent-index-marketplace was updated. Same schema as `core-update`.

**`collection-update`** — An installed collection was upgraded.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"collection-update"` |
| `collection` | string | Collection name |
| `target_version` | string | The new collection version |
| `from_version` | string | The collection version at time of publish |
| `has_migration` | boolean | True if the update crosses a MAJOR version boundary |
| `api_changes` | object or null | `{"added": [...], "removed": [...]}` if API members changed |

**`collection-install`** — A new collection was added to the org.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"collection-install"` |
| `collection` | string | Collection name |
| `version` | string | The installed version |
| `category` | string | Collection category |

**`collection-remove`** — A collection was removed from the org.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"collection-remove"` |
| `collection` | string | Collection name |
| `last_version` | string | The last installed version before removal |

**`claude-md-update`** — CLAUDE.md was regenerated.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"claude-md-update"` |
| `hash` | string | SHA-256 hex hash of the new CLAUDE.md content |

**`adapter-bundle-update`** — The MCP server adapter bundle was updated.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"adapter-bundle-update"` |
| `target_version` | string | The new adapter version |
| `from_version` | string | The adapter version at time of publish |

**`org-config-update`** — Org configuration was changed (roles, admin list, etc.).

| Field | Type | Description |
|---|---|---|
| `type` | string | `"org-config-update"` |
| `changes` | array | Array of human-readable change descriptions |

### Member Update Cursor

Each member's `member-index.json` includes a `last_applied_update` field that tracks the ID of the last update entry the member successfully processed:

```json
{
  "member_hash": "a7f3b2c1d4e5f698",
  "last_applied_update": "004",
  "installed": { ... }
}
```

When `last_applied_update` is null or absent, the member has never applied an update. All entries in the update log are considered pending.

### Published State Snapshot

After publishing, the admin's current org state is captured in `/shared/updates/published-state.json`. This snapshot is the baseline for the next `publish-updates` run — the task diffs current state against this snapshot to determine what changed.

### Latest Pointer

A lightweight file at `/shared/updates/latest.json` contains only the latest entry ID and publish timestamp. This allows session-start to check for pending updates with a single small file read instead of loading the full update log.

```json
{
  "latest_id": "006",
  "published": "2026-04-01T14:30:00Z"
}
```

### Merge Semantics

When a member has multiple pending entries, they are merged into a single net update plan before execution. The merge rules:

- For singleton targets (core, marketplace, CLAUDE.md, adapter bundle): the latest operation supersedes all earlier ones
- For collections: later operations supersede earlier ones for the same collection. Install-then-remove cancels out. Install-then-update becomes install-at-latest. Update-then-remove becomes remove.
- The `from_version` in merged operations is always recalculated from the member's actual current installed version, not from the operation's original `from_version`
- The cursor advances to the last processed entry ID regardless of which individual operations were applied or declined

### Remote Filesystem Layout for Updates

```
/shared/updates/
  update-log.json            ← append-only log of all published entries
  published-state.json       ← snapshot of org state at last publish
  latest.json                ← lightweight pointer to latest entry ID
```

---

## Two-Tier Filesystem

Agent-index uses a two-tier filesystem model. Member-specific files live on the member's local machine. Org-wide shared files live on a remote storage backend (Google Drive, OneDrive, or S3) accessed through the agent-index-filesystem MCP server.

### Local Files (native Read/Write/Edit)

Files under the member's local workspace — `members/{member_hash}/` — are accessed using Claude's native file tools. This includes:

- `member-index.json` — the member's installed capabilities registry
- `skills/` — installed skill definitions and state
- `tasks/` — installed task definitions and state
- `profile/` — preferences, role config, onboarding state

Local files are private to the member. No other member can access them.

### Remote Files (aifs_* MCP tools)

Files on the org's remote storage are accessed through the `aifs_*` tool family provided by the agent-index-filesystem MCP server. This includes:

- `org-config.json` — org configuration
- `members-registry.json` — member hash-to-identity mapping
- Collection directories (`/{collection}/`) — skill and task definitions, setup templates, manifests
- `/shared/` — shared artifacts, marketplace cache, bootstrap zip, update instructions

**Collections must use `aifs_read` and `aifs_write` for all remote file access.** Never use native file tools (Read/Write/Edit) for paths under the remote filesystem root.

### Remote Access Failure Handling

Remote connectivity may be unavailable (expired credentials, MCP server not running, network issues). Collections should handle this gracefully:

- If the capability only needs local data: proceed normally
- If the capability needs remote data and `aifs_auth_status()` returns `authenticated: false`: attempt automatic re-authentication by invoking the `aifs_authenticate` flow inline. If re-authentication succeeds, proceed normally. If it fails, surface a clear notice that remote connectivity is required and suggest `@ai:member-bootstrap` as a manual fallback
- Never halt silently — always inform the member what failed and why

---

## Shared Artifacts and Data

Collections that produce data visible to other members or that aggregate data across the org use the shared artifact system. The shared filesystem root is `/shared/` on the remote filesystem.

### The `produces_shared_artifacts` Flag

Set `produces_shared_artifacts: true` in a task's frontmatter if the task writes files to the remote `/shared/` namespace. This flag signals to the system (and to collection reviewers) that the task has write access requirements beyond the member's local workspace.

### Writing Shared Artifacts

Tasks that produce shared artifacts must write them to the remote filesystem using `aifs_write`. The write path depends on the artifact type:

**Per-member artifacts** (files attributed to a specific member, like reports or submitted work): write to `/shared/members/artifacts/{member_hash}/{filename}`. The `member_hash` namespace prevents filename collisions between members. The member's hash is available from session context. Example:

```
aifs_write("/shared/members/artifacts/a7f3b2c1d4e5f698/weekly-report-2026-03-24.md", content)
```

**Collection-scoped shared data** (files that belong to the collection, not a specific member, like project definitions or shared configs): write to `/shared/{collection-defined-path}/`. Each collection defines its own path structure under `/shared/`. Example:

```
aifs_write("/shared/projects/project-alpha/project.md", content)
```

### The `reads_from` and `writes_to` Fields

Frontmatter fields `reads_from` and `writes_to` declare which shared paths a task accesses. Set them to `null` if the task doesn't read from or write to shared paths.

```yaml
reads_from: "/shared/projects/"
writes_to: "/shared/projects/"
```

These fields serve as documentation and as input for future access-control or audit systems. They do not currently enforce permissions, but collections should declare them accurately.

### Reading Shared Data (Aggregation)

Tasks that aggregate data from the remote shared filesystem (reporting dashboards, cross-project summaries, etc.) read using `aifs_read` and `aifs_list`. Common patterns:

- **List then read:** `aifs_list("/shared/projects/")` to discover entries, then `aifs_read` each one
- **Known path read:** `aifs_read("/shared/members/artifacts/{hash}/report.md")` for a specific artifact
- **Existence check:** `aifs_exists("/shared/projects/project-alpha/project.md")` before reading

### Remote Write Constraints

- Never write to collection directories (`/{collection}/`) from a member session — those are managed by org admins via `create-org` and marketplace install
- Never write to `org-config.json` or `members-registry.json` except through the specific admin workflows (`edit-org`, `create-org`, `member-bootstrap`, `org-setup`)
- Always confirm destructive shared writes (overwrite, delete) with the member before executing
- Use `aifs_delete` with caution — shared deletions affect all members

---

## Org Roles

Org roles are defined at the org level in `org-config.json` and determine which collections new members are prompted to install during onboarding. They are complementary to per-collection roles:

- **Org roles** (in `org-config.json`) → determine WHICH collections a member is prompted to install
- **Per-collection roles** (in `/{collection}/roles/`) → determine which skills/tasks WITHIN those collections are recommended and what parameter defaults to use

### Schema

Org roles are stored in the `org_roles` array in `org-config.json`:

```json
"org_roles": [
  {
    "role_id": "engineer",
    "display_name": "Engineer",
    "description": "Software engineers and developers",
    "default_collections": ["projects", "developer-tools"],
    "created_date": "2026-03-19",
    "created_by": "a7f3b2c1d4e5f698"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `role_id` | string | Kebab-case identifier generated from display name |
| `display_name` | string | Human-readable role name |
| `description` | string | Brief description of the role's function |
| `default_collections` | array | Collection names that members with this role are prompted to install |
| `created_date` | string | ISO date when the role was created |
| `created_by` | string | `member_hash` of the admin who created the role |

### Lifecycle

- Created during `create-org` (optional) or via `edit-org` at any time
- Editable by org admins via `edit-org`
- Removing a role does not affect existing members — their installed capabilities remain
- Adding a collection to a role's defaults triggers a session-start notice for existing members with that role who haven't installed it

---

## Submission Process

To submit a collection to the marketplace:

1. Ensure the collection meets all requirements in this document
2. Host the collection in a publicly accessible Git repository
3. Open an issue in the agent-index resource listings repository at `https://github.com/agent-index/agent-index-resource-listings` with the collection name, repository URL, and a brief description
4. The agent-index team will review for standards compliance and add the collection to `directory.json` upon approval

---

*These standards are versioned alongside agent-index-core. Breaking changes to the standards require a MAJOR version bump in agent-index-core and a migration path for existing collections.*
