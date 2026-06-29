# Agent-Index Collection Standards
## Marketplace Eligibility Specification

**Version:** 2.1.0
**Maintained by:** agent-index
**Last Updated:** 2026-04-02

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

### `collection.json` Optional Fields

The following fields are optional. If omitted, the collection is assumed to neither provide nor require any capability types.

| Field | Type | Description |
|---|---|---|
| `provides` | array | Capability types this collection implements. Each entry declares a capability type, version, and operation-to-skill mapping. Empty array or absent if none. See Capability Provider Requirements below. |
| `requires` | array | Capability types this collection needs from other providers. Each entry declares a capability type, required version range, operations needed, and fallback behavior. Empty array or absent if none. See Capability Provider Requirements below. |

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

All skill and task definition files (in both `/api/` and `/internal/`) must conform to the agent-index file format standards defined in `agent-index-meta-docs/agent-index-file-format-standards.md`.

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

## Distribution: backend-first (Release C — the current model)

**Members never fetch from github.com.** Each org's own backend is its distribution layer: the admin (the only GitHub touchpoint, over the **git protocol** — clone/pull, which is not subject to the raw/REST rate cap) publishes everything members need — collections, the directories, and the helper binary — to `/shared/dist/` on the org backend. Members read directories + binary from `/shared/dist/` and **SHA-verify them against `/shared/dist/manifest.json`** (the org's version authority), and read collection capability files from each collection's **id-anchored canonical base** (`id:{folder_id}`), gated on the manifest's collection versions. See the `backend-distribution` and `clone-script-generator` subroutines (`templates/`). This eliminates both root causes that recurred across Jeff / ms-install-5 / ms-install-6 — GitHub rate limiting (members make zero GitHub calls) and stale-cache (members read the backend, the admin's deterministic tag-pinned publish, not GitHub's cache-fronted raw layer).

- **Member runtime path:** backend-first, always. `check-updates` answers "is this member current?" against `/shared/dist/manifest.json`; `apply-updates`/`member-bootstrap` fetch directories + binary from `/shared/dist/` and SHA-verify. **The SHA gate is real and mandatory (C.1.3):** both tasks compute the artifact SHA per the **Canonical SHA-256 rule** (`backend-distribution.md` — hash the stored `size` bytes, never `aifs_read` stdout) and refuse a mismatch. Pre-C.1.3 these tasks read the manifest for version numbers but never hashed the artifacts (`shagateunimplemented`), and a manifest computed from stdout-with-newline (`412094b4…`) didn't match the stored bytes (`e1d549e4…`) (`manifestsha`) — both fixed by computing identically on the publish and member sides.
- **One read path for collection files:** `id:{folder_id}` only. The legacy root-relative `/{collection}` read was **removed** as a default in C.1.3 (`memberapplynotdistaware` — Option A); a pre-backfill org with no `folder_id` is skipped with an explicit logged notice (re-publish backfills it), not silently read from `/{collection}`.
- **`publish-updates` republishes `/shared/dist/` on every publish (C.1.3, `publishdistgap`)** — manifest + directories + binary — so the member-facing authority never goes stale after an in-place update, with a publish-time round-trip SHA self-check.
- **Admin path:** local clones (tag-pinned) → publish to the backend. "Is the org current with upstream?" is an admin-only **git** check (`git fetch` + compare tags), not a raw fetch.
- **The SHA-pinned GitHub fetch protocol below is now the ADMIN-only path and the DEPRECATED member fallback** (used only by a not-yet-migrated org, with a deprecation warning; removal targeted for the release after C). New installs always have `/shared/dist/` and never use it.

### Reads go through aifs only (C.1.3 — `wrongconnectorfallback`)
All remote agent-index content — org config, the registry, `/shared/...`, collection files, and **content shared to a member by another member** — is read through the `aifs_*` executor, never through an external file connector (a Microsoft 365 / Google Drive / Dropbox connector that happens to be connected in the session). When an `aifs_read` returns `PATH_NOT_FOUND` for an item a member can see in their own cloud portal, the correct response is to **diagnose it within the aifs model** (most often a cross-drive reference — see id-anchor addressing and the cross-drive read contract) and surface that, **not** to improvise by reaching for whatever connector is present (which silently bypasses the trust model, may target the wrong backend entirely, and gives non-reproducible results). A connector being connected is never a license to route agent-index reads around aifs.

## Release procedure (admin-side)

Publishing a new version of any artifact (a collection, an adapter, or core/marketplace) follows a fixed, gated procedure. The canonical, ordered gate list is the **release-checklist** in the developer collection (`release-checklist.md`); the `release` task there **generates** the push script that encodes it. Do not hand-author release scripts — generate them, so the invariants below are never left to memory.

- **Preflight is a hard gate.** Every collection in the release passes `@ai:preflight` (or `lib/preflight-cli.sh`) with zero errors before anything is pushed. The push script runs this and aborts on error (the `release-script-runs-preflight` contract).
- **Push in dependency order, `agent-index-resource-listings` LAST.** The broadcast layer must never reference a version whose code or binary isn't live yet (else `check-updates`/adapter-update flows resolve to a 404). Order: adapter → core → marketplace → collections → resource-listings.
- **Tag every repo `v<version>` after a successful push.** The `clone-script-generator` and `/shared/dist/manifest.json` pin to these exact tags — tags are the contract between a release and the distribution layer. **Never move or delete a published tag** (cut a new one if a re-cut is truly needed); never pin distribution to a branch.
- **The agent never pushes or tags.** `git push`/`git tag` run natively on the admin's host, where credentials and a clean working tree are. Agent-side git over a synced/mounted filesystem produces torn commits (FCI-1).
- **Agent-side git is read-only via `git show` (`gitwritelock`).** When the agent needs git content from the sandbox (e.g. the git-blob LF bytes of a file for a canonical SHA), use `git show <ref>:<path>` — a read that touches neither the working tree nor `index.lock`. Never `git checkout`/`git switch`/`git stash`/`git add` from the sandbox: those take the index lock and write torn files back through the mount (FCI-1), and can collide with the user's native git session. Read with `git show`; let all mutating git run natively on the host.
- **Repos carry a `.gitattributes` to defeat autocrlf (`crlfcheckout`, C.1.3.2).** Every agent-index repo commits `.gitattributes` (`* text=auto eol=lf`, `*.exe binary`, and explicitly `dist/aifs-exec.bundle.js text eol=lf` + `*.sh text eol=lf`). Without it, a Windows checkout (`core.autocrlf=true`) rewrites line endings, so the working tree differs from the LF-committed blobs — which both **blocks `git checkout <tag>`** in the clone scripts ("local changes would be overwritten" / a perpetually "dirty" tree) and **corrupts byte-exact artifacts** (the adapter bundle hand-copied from the working tree got a CRLF SHA that failed integrity checks — bit ms_install_9's rollout twice). With `.gitattributes` committed, every checkout is byte-identical to the commit on every platform.
- **Host-deploy byte-exact files via `git cat-file`/`git show`, never a working-tree copy (`adapterdeploydoc`).** When an admin must place a byte-exact file on the host (e.g. updating their own install's `aifs-exec.bundle.js`), copy it from the git object — `git -C <repo> cat-file blob <tag>:dist/aifs-exec.bundle.js > <dest>` (or via `git show`) — **not** `Copy-Item`/`cp` from the working tree, which may be CRLF-converted. Better still, let `@ai:update` / the bootstrap zip place it (those already source LF-correct bytes). After any local bundle swap, **fully relaunch Cowork** so the sandbox mount re-syncs.
- **A truncated-executor error is a stale mount, not corruption (`stalemountexec`).** If `aifs-exec.bundle.js` reads as truncated (a `SyntaxError`/`CONFIG_E…` mid-statement) and every `aifs_*` call fails, the host file is almost certainly intact — the Cowork sandbox is serving a stale/torn projection. **First remedy: fully quit and relaunch the Cowork app** (re-syncs the mount), then retry a read-only `check-updates`. `@ai:member-bootstrap` (re-extract the executor from the bootstrap zip) is the fallback only if relaunch doesn't restore it. Do NOT assume data loss or "repair" intact files.
- **Then publish the backend** per the backend-first model above: clone at the new tags (`clone-script-generator`) → republish `/shared/dist/` + `manifest.json` (`backend-distribution`) → verify the manifest. The release is not "shipped" to members until the manifest reflects it.
- **Native binaries must be code-signed (C.1).** Every helper-binary release artifact is signed before checksums are computed (Windows Authenticode / Trusted Signing; macOS Developer ID + notarized `.app`; optional Linux GPG) so the directory `sha256` pins the **signed** bytes, and a `verify-signed` gate fails the release otherwise. Unsigned binaries are hard-blocked by Windows Smart App Control with no user bypass. The directory's `post_install` is **per-platform** — darwin installs the notarized `.app` (macOS registers bundles, not loose executables); never `--register` a bare darwin binary. See `lib/permission-helper-go/SIGNING.md`.
- **Install orchestration makes zero GitHub calls (C.1).** `create-org` (and the agent generally) never fetches `raw`/REST to resolve versions, the catalog, or the binary — all GitHub access is the git protocol (`ls-remote`, `clone`) and the signed binary's release-asset download, inside the host-run clone scripts. Version discovery is `git ls-remote --tags` (no `main` fallback); the binary is resolved backend-matched from the freshly-cloned listings.

## Distribution fetch protocol (SHA-pinned) — admin-side / deprecated fallback

Any task that fetches a directory, version, or archive file from GitHub (`infrastructure_directory_url`, `marketplace_directory_url`, `filesystem_adapter_directory_url`, fallback `*_version_url`, or a `zip_url`) **must use the SHA-pinned fetch protocol** below. Bare `/main/` (branch-form) raw URLs are cache-unsafe: the fetch layer caches them by exact URL and serves stale bytes long after a push, and query-param cache-busters (`?t=…`) are **stripped on the raw redirect**, so they do not defeat the cache (bug `20260601-8d20ea22-2`, three confirmed recurrences). A stale fetch *succeeds*, so the task reports "✓ up to date" against pre-release data with no error — the most dangerous failure mode. A commit-SHA-pinned path is immutable; the cache cannot serve it stale.

**Protocol** (replaces the cache-buster rule, marketplace 2.11.0 / core 3.11.0):

1. Derive `{owner}/{repo}/{branch}/{path}` from the configured URL.
2. Resolve the branch head SHA via the commits **LIST** endpoint with a unique nonce: `GET https://api.github.com/repos/{owner}/{repo}/commits?sha={branch}&per_page=1&nonce={epoch}` → `[0].sha`. Cache the SHA per repo for the session (a full check-updates run needs ≤4 resolutions). **Do NOT use the single-commit form `/commits/{branch}` with a `?t=` buster** — in proxied environments that request is redirect-stripped and served stale, exactly like bare raw URLs (bug `20260610-8d20ea22-sharesolve`, observed live: a day-old SHA returned with the buster visibly stripped). The list endpoint's query params are semantic and survive.
2a. **Freshness cross-check (amendment, core 3.11.2):** if the pinned fetch in step 3 compares as "no change" against the local cache/state AND there is independent reason to expect a change (e.g., a push you just made, or `expires_at` long past), probe `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}` — if IT shows a newer `directory_version`/`last_updated`, the step-2 resolution was stale: re-resolve with a fresh nonce, or treat the jsdelivr content as the advisory trigger to retry. A stale resolution yields old-but-valid content; this cross-check converts that silent lag into a detected condition.
3. Fetch `https://raw.githubusercontent.com/{owner}/{repo}/{SHA}/{path}` (for archives: `https://codeload.github.com/{owner}/{repo}/zip/{SHA}`). This result is **authoritative**.
4. **Fallback A** — SHA resolution failed (rate limit, network): fetch `https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}`. Different origin (defeats the local fetch-layer cache) but has its own CDN cache: label the result `source: jsdelivr-fallback` and treat it as advisory.
5. **Fallback B** — both failed: fetch the bare raw URL, label `source: unpinned`. An unpinned result is **never sufficient** to conclude "up to date"; classify the failure (allowlist-blocked vs network) per the standard failure-shape rules and surface the degraded confidence.
6. **Staleness comparison** (directory files): the fetched copy is newer iff `directory_version` increased, **or** `directory_version` is equal and `last_updated` is newer and the content actually differs (hash). Never key on `directory_version` alone (bug `20260607-8d20ea22-131906-d1rv`). The no-downgrade guard is unchanged and still applies to every path.
7. Record provenance (`source`, resolved SHA) wherever fetch metadata is persisted (e.g., `cache-metadata.json`).

Hosts `api.github.com` and `cdn.jsdelivr.net` are part of the canonical network allowlist for any environment running these tasks.

---

## File-integrity sentinel (`AIFS:FILE-END`)

Tail truncation — files cut mid-content by capped or interrupted writes — has corrupted both local and remote copies (bug `20260608-8d20ea22-003039-trunc`). The sentinel standard makes completeness a property of the file itself: a stamped file that does not end with its sentinel **is truncated**, deterministically, with no heuristics.

**Marker:** the logical marker is `AIFS:FILE-END`. The **last non-whitespace content** of a stamped file must be its per-format encoding:

| Format | Encoding (final line / final key) |
|---|---|
| Markdown, plain text | `<!-- AIFS:FILE-END -->` on its own line |
| JSON | top-level key `"_file_end": "AIFS:FILE-END"`, serialized last |
| Shell, Python | `# AIFS:FILE-END` |
| JavaScript | `// AIFS:FILE-END` |

Trailing whitespace/newlines after the marker are permitted. JSON consumers must tolerate (ignore) the `_file_end` key; schemas that enumerate keys must allow it.

**Stamped classes (v1):** collection source files (`collection.json`, `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `api/*`, `setup/*`, `internal/*`, `apps/*` scripts); core/marketplace/developer infrastructure equivalents; task-written JSON state files (`org-config.json`, `member-index.json`, manifests, `published-state.json`, `latest.json`) — stamped opportunistically whenever a task rewrites them.

**Excluded:** JSONL/append-mode files (per-line parse validity is their integrity check), binary files, third-party files, member free-form content.

**Adoption:** a collection opts in by declaring `"file_integrity": "sentinel-v1"` in `collection.json`. Preflight then treats a missing sentinel on a stampable file as an ERROR (WARNING for non-declaring collections). New collections scaffolded by `develop` declare it from birth. Writers re-stamp on every rewrite; the adapter's write path (gdrive ≥ 2.6.0) verifies post-write that a sentinel present in written content survived, and fails loudly if it did not.

**Detection contract:** missing sentinel on a stamped file ⇒ tail truncation — re-fetch before any heal decision, and never overwrite a complete copy with a truncated one. Sentinel presence does NOT prove semantic correctness; it proves the tail arrived. Size (`aifs_stat`) checks remain appropriate for non-tail anomalies.

---

## Collaborative Folder ACLs (`collaborative-acls.json`)

Under the least-privilege access model (adapter contract v2.0+, core 3.1.0+), a non-admin member is writer only on their own `/members/{hash}/` and `/shared/members/artifacts/{hash}/` and reader on everything else under `/shared/`. A collection whose members must **write shared collaborative state** (e.g., a shared bug log, a shared project tree) must therefore declare the ACLs it needs so they can be provisioned at install time. Collections that only read shared data, or whose members write only their own private namespace, omit this file.

**File:** optional, at the collection root: `/{collection}/collaborative-acls.json`.

**Schema:**

- `version` (string) — `"1.0"`.
- `acls[]` — each entry:
  - `path` (string) — target folder; supports `{param}` placeholders resolved at provisioning from `collection-setup-responses.md` and `org-config.json` (e.g., `{bug_log_path}`, `{all_members_group}`).
  - `recipient` (string) — email or group address (typically `{all_members_group}`).
  - `role` (string) — `reader` / `commenter` / `writer`.
  - `inherit` (boolean, optional, default `true`) — `true` = additive grant on top of parent inheritance (the normal collaborative-write case). `false` = explicit override that detaches the resource from parent inheritance (used to *restrict* a subfolder, e.g., keep a secrets dir out of a broad `all@ reader`); requires the applier to hold organizer/owner and the helper binary `permission-helper-go ≥ 0.3.0`.
  - `restrict` (boolean, optional) — documents that an `inherit:false` entry exists to remove inherited access rather than add it.
  - `rationale` (string, optional) — human-readable why.

**Provisioning contract:** `install-collection` Step 5.5 reads this file, resolves placeholders, filters already-satisfied entries (idempotent), and routes the remaining grants through the `permission-change-helper` skill for admin review + Accept. Collections and the installer **never** call `aifs_share`/`aifs_unshare`/`aifs_transfer_ownership` directly (see § "Permission-Modifying Operations"). The grant is applied under the admin's OAuth identity; members never grant themselves access. Member-facing task workflows must assume the grant is already in place and must not perform permission changes themselves; on an authorization failure they should direct the member to ask an admin to (re-)run `@ai:install-collection {name}`.

---

## Addressing: paths vs. ID anchors (owned content)

The adapter (gdrive ≥ 2.5.0) supports two addressing modes:

- **Absolute paths** (`/shared/...`, `/{collection}/...`) — for locations the caller can enumerate from the root. Members enumerate `/shared` and collection trees via the **all-members group's direct-on-folder grants** — the group's reader on `/shared` (create-org Step 4.5) and on each collection root (install-collection cr01), conveyed by **group membership**, NOT by per-member shares. (Do not add per-member reader shares to make enumeration work — that was the obsolete `catbredundant` workaround; direct-on-folder group grants enumerate fine, validated on gdrive 2026-06 with a group-only member.) Admins can enumerate everything.
- **ID anchors** — `id:{folderId}/relative/path` — for locations the caller is **granted on but cannot reach by walking from the root** (their own member space; items shared with them). Resolution starts at `{folderId}` and walks **downward only**. This is required because non-admin members are not Shared-Drive members and cannot enumerate containers like `/members/` (bug `20260522-8d20ea22`).
- **Cross-drive ID anchors** — `id:{driveId}:{itemId}/relative/path` (C.1.3 `crossdriveread`) — for content that lives on **another member's drive** and was shared to the caller. On OneDrive/SharePoint, item IDs are **drive-scoped**: a bare `id:{itemId}` resolves against the *caller's own* drive (`/me/drive`), so it fails `PATH_NOT_FOUND` for an item that physically lives in the owner's personal OneDrive even when the caller has been granted access. The qualified form carries the owner's `driveId`, which the adapter routes to `/drives/{driveId}/items/{itemId}` — reading the item where it actually lives, governed by the caller's granted permission (the delegated `Files.ReadWrite.All` token already covers "all files the user can access," including shared-with-me). The model is: **private = owner's personal drive, public/commons = the SharePoint site drive**; cross-drive anchors are how a member reads private content another member shared to them. (gdrive resolves shared content natively via `corpora:allDrives`, so the qualified form is OneDrive's parity mechanism; on gdrive a bare `id:{itemId}` already reaches shared items and the `driveId` segment is accepted-but-ignored.)

**Conventions:**

1. **Member space (reworked in core 3.9.0).** A member's private remote space is a folder named `Agent-Index-Private` **in the member's own My Drive** — created by the member's own credentials at bootstrap (`id:root/Agent-Index-Private`, then always referenced by its **resolved** Drive ID, never the `root` alias) and **owned by the member**. Ownership is the point: Google Drive permits folder-sharing on a Shared Drive only to drive Managers, so member-applied grants are impossible there (finding F12); on their own My Drive, the owner has full sharing power. The bootstrap writes a handshake file (`/shared/members/artifacts/{hash}/member-folder.json`); the admin-side `publish-updates` reconcile (6d) copies the ID into `members-registry.json`; installs cache it in `member-index.json` (apply-updates Step 1.5 keeps it fresh). Legacy `/members/{hash}/` Shared-Drive spaces are deprecated — content migrates member-side via apply-updates 3.9.0 Migration 2.
   *Custody note:* the org has no access to member spaces and cannot repair, audit, or reclaim them. Sharing grants the owner makes survive their removal from agent-index (the org loses governance, not the recipients' access). For org-managed Workspace accounts, content and grants last as long as the account; consumer-account members' content is permanently their own. Governance of shared member content is **by cooperation** (tasks following these conventions), not enforcement — adopt the model with that expectation.
2. **Owned, selectively-shared content** lives in the owner's member space (`id:{owner_member_folder_id}/{collection}/{slug}/`), **never** under `/shared`. Sharing is additive grants on the item folder via `permission-change-helper` with the **owner** Accepting (specs use the bare `id:{folder_id}` resource form, helper-go 0.4.0+): *share with X* = X `reader`; *collaborator X* = X `writer`; *share with org* = `{all_members_group}` `reader`. Pointer writes are hard-gated on the helper outcome reporting `applied`. When the owner `aifs_stat`s the item to capture its `item_id`, **also capture the returned `drive_id`** (the item's home drive — adapter 2.3.0+ returns it) for the pointer's `item_drive_id` (convention #3).
3. **Pointer index (discovery).** Each shared item gets one pointer file in the collection's open-shared index folder: `/shared/{collection}-index/{owner_hash}-{slug}.json` with fields `type`, `owner`, `owner_hash`, `slug`, `item_id` (the **shared item's own** Drive/Graph ID — for a folder, the folder id; for a single file, that file's own id), **`item_drive_id`** (the owner's home drive ID for that item, from the same `aifs_stat`; C.1.3 `crossdriveread`), `scope`, and (per-collection privacy choice) `title` / `collaborators`. The index folder is an open-shared area (`all@` writer, declared in the collection's `collaborative-acls.json`). One file per item — no shared mutable index, no write contention.
   - **Recipients open shared content via the cross-drive anchor** `id:{item_drive_id}:{item_id}` when `item_drive_id` is present, falling back to the bare `id:{item_id}` for older pointers (pre-C.1.3) and for own-drive items. The qualified form is what lets a recipient on OneDrive actually read content that lives on the owner's personal drive — a bare `id:{item_id}` resolves against the *recipient's* drive and returns `PATH_NOT_FOUND` (the `crossdriveread` failure observed in ms_prod_9: handoff-test-2 was discoverable but unopenable). On gdrive the bare anchor already reaches shared items, so the qualified form is harmless there. **Never** route around aifs to an external connector when a bare anchor 404s — add/repair `item_drive_id` instead (standards § "Reads go through aifs only").
   - **A share without a pointer is invisible to agent-index (`owncontentdisco`, ms-install-9).** Discovery is the pointer — the recipient's session finds shared owned content by reading these index files, NOT by enumerating another member's space (which it cannot reach, especially across personal OneDrives). So any owned-content share that should be discoverable in-session MUST write a pointer (hard-gated on the helper `applied` outcome, same as the grant). An **ad-hoc share with no owning collection / no pointer index** (e.g. a one-off note shared directly) is therefore **backend-native-discovery-only**: the grant works, but the recipient opens it through the backend's own "Shared with me" view, and agent-index will not surface it. The sharing flow must **say so** at share time ("Bill will find this in OneDrive → Shared with me; agent-index doesn't index ad-hoc personal-space shares") rather than leaving the recipient to discover the gap when their session can't find it.
4. **Soft-delete on org-shared surfaces.** Non-admin members **cannot trash/delete** files on the Shared Drive (Contributor role), so collections must never require deletion there: "delete" = overwrite metadata to mark archived; "unshare" = revoke the grant (helper `unshare`) + **overwrite** the pointer file with `scope: "revoked"`. Overwrites are writer-permitted; Shared-Drive deletions are admin-only. (Members CAN delete content in their own My Drive space — they own it — but pointer files live on the Shared Drive and always follow the overwrite convention. A collection should still prefer archive-marking over deletion in member spaces so changelogs and cross-references stay resolvable.)
5. **Rule of thumb:** *paths for what you can enumerate; ID anchors for what you're granted.* Never resolve a member-space path by name; always anchor on a known folder ID.

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
- Collection directory name must match the `name` field in `collection.json`. For marketplace collections distributed via Git, the repository name may use a prefix (e.g., `agent-index-marketplace-{name}`), but the collection directory on the remote filesystem and the `name` field must match.
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

**`adapter-bundle-update`** — The filesystem adapter exec bundle was updated.

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

**`provider-register`** — A capability provider was registered.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"provider-register"` |
| `capability` | string | Capability type name |
| `provider_collection` | string | Collection registered as provider |
| `capability_version` | string | Version of the capability contract |
| `provider_count` | integer | Total number of providers now registered for this capability type |

**`provider-deregister`** — A capability provider was deregistered.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"provider-deregister"` |
| `capability` | string | Capability type name |
| `provider_collection` | string | Collection that was deregistered |
| `reason` | string | `"collection-removed"` or `"manual"` |
| `provider_count` | integer | Total number of providers remaining for this capability type |
| `affected_bindings` | array | List of `{ consumer_collection, binding_name }` objects for bindings that referenced this provider |

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

Agent-index uses a two-tier filesystem model. Member-specific files live on the member's local machine. Org-wide shared files live on a remote storage backend (Google Drive, OneDrive, or S3) accessed through `aifs_*` tools running in exec mode.

### Local Files (native Read/Write/Edit)

Files under the member's local workspace — `members/{member_hash}/` — are accessed using Claude's native file tools. This includes:

- `member-index.json` — the member's installed capabilities registry
- `skills/` — installed skill definitions and state
- `tasks/` — installed task definitions and state
- `profile/` — preferences, role config, onboarding state

Local files are private to the member. No other member can access them.

### Remote Files (aifs_* tools in exec mode)

Files on the org's remote storage are accessed through the `aifs_*` tool family running in exec mode. This includes:

- `org-config.json` — org configuration
- `members-registry.json` — member hash-to-identity mapping
- Collection directories (`/{collection}/`) — skill and task definitions, setup templates, manifests
- `/shared/` — shared artifacts, marketplace cache, bootstrap zip, update instructions

**Collections must use `aifs_read` and `aifs_write` for all remote file access.** Never use native file tools (Read/Write/Edit) for paths under the remote filesystem root.

**Adapter contract v2.0 (added 2026-04-30):** The `aifs_*` family is extended with five additional ops — `aifs_share`, `aifs_unshare`, `aifs_get_permissions`, `aifs_transfer_ownership` (optional per backend), and `aifs_search` — plus an optional `if_revision` parameter on `aifs_write` for safe concurrent edits to shared state files. All ops execute under the calling member's OAuth identity; adapters never elevate privilege. The full operation specifications, including parameter schemas and backend-specific notes, live in `agent-index-filesystem/SPEC.md` v2.0. Consumer collections call these ops directly alongside the existing family — no capability-resolution layer is involved.

### Remote Access Failure Handling

Remote connectivity may be unavailable (expired credentials, exec bundle missing, network issues). Collections should handle this gracefully:

- If the capability only needs local data: proceed normally
- If the capability needs remote data and `aifs_auth_status()` returns `authenticated: false`: attempt automatic re-authentication by invoking the `aifs_authenticate` flow inline. If re-authentication succeeds, proceed normally. If it fails, surface a clear notice that remote connectivity is required and suggest `@ai:member-bootstrap` as a manual fallback
- Never halt silently — always inform the member what failed and why

---

## Permission-Modifying Operations

The v2.0 adapter contract introduced operations that modify access controls — `aifs_share`, `aifs_unshare`, `aifs_transfer_ownership` — alongside the read-only `aifs_get_permissions`. The read-only op is callable by collections directly. The three permission-modifying ops are **never** callable by collections directly. They go through the agent-index permission helper.

**The one sanctioned exception — `create-org` install-time bootstrap.** `create-org` (and the collection provisioning it performs at org-creation: the `/shared/` + root-file group-reader grants, and each installed collection's collaborative-folder/cr01 grants) applies `aifs_share` **directly**, not through the helper. This is the *only* place direct application is permitted, and it is safe for reasons that do not generalize: the operator is the **org creator**, freshly and interactively authenticated in this very session, who **owns the entire tenant/drive** being provisioned; the grants are deterministic, one-time setup of resources the operator already fully controls; and there is no third party whose access is being changed without their involvement. Helper-mediated review would add friction without adding safety here (there is no privilege to escalate — the operator already has organizer authority over everything being touched). Every **runtime / member-facing** sharing path — `invite-member`, owned-content sharing, any collection workflow — remains strictly helper-gated with no direct-apply fallback (`helperbypass`). If you are not `create-org` at install time, you do not call `aifs_share` directly. (Sanctioned per ms-install-8 review.)

**The direct path is preferred but not guaranteed — the helper is the fallback (`helperfallback`).** Direct application is permitted at create-org, but a given agent instance may still **decline** a permission-modifying call (the standing safety rule fires regardless of this sanction). So create-org must **never depend** on the direct call succeeding: if a grant is not applied directly for any reason, it falls back to the `permission-change-helper` for the remaining grants — same end state, applied under the admin's own token after their Accept (the admin is present and authenticated during install; the helper was installed in Phase 1). The direct path is an optimization that removes helper round-trips at bootstrap; the helper remains the guaranteed path. create-org halts only if BOTH the direct attempt and the helper fallback fail. (This is why `install-collection`, which provisions collaborative ACLs at member time, is helper-first by default — create-org's direct-apply is the bootstrap-only optimization layered on top.)

### Why permission-modifying ops are gated

Agents running inside any Claude-based execution context are categorically prohibited from making security-changing calls on the user's behalf, even with explicit authorization, because agents can be manipulated (prompt injection, tool result manipulation, social engineering) and any architecture that lets a manipulated agent change permissions is the attack the safety boundary is trying to prevent. A consumer collection workflow that asks the executing agent to call `aifs_share` directly will halt at that step and the task will not complete. This is by design.

The permission helper closes this gap by routing the privileged call out of the agent's call stack: the agent prepares a structured spec describing the proposed change, surfaces a review page in the member's browser, and the member's deliberate Accept click triggers an apply-script that uses the **member's existing OAuth token** to call the privileged op. The agent never directly initiates the permission change; the member does, with their own credentials, after explicit review.

The canonical implementation is the native Go binary `agent-index-show-plan`, distributed via the binaries registry declared in `infrastructure-directory.json` and installed at runtime to `mcp-servers/permission-helper-go/` by `apply-updates` Phase 1 step 7. The trust contract for that download path is documented later in this file in § "Trust contract for binary-tool downloads." The agent-side skill `permission-change-helper` (in `agent-index-core/api/`) is the only callable surface; collections invoke that skill, not the underlying binary directly.

(Pre-3.7.4 also shipped a parallel Node implementation at `agent-index-core/lib/permission-helper/`, installed at runtime to `mcp-servers/permission-helper/`. That implementation was removed in 3.7.4 — closes idea `remove-node-permission-helper-fallback` and bug `20260522-8d20ea22-2` via removal. Maintaining two implementations created bugs class — see the [3.7.4 scope decision record](/shared/projects/core-improvements/decisions/2026-05-24-release-3.7.4-scope.md) for rationale.)

The full architecture, lifecycle, and wire protocol are documented in `/shared/projects/access-control/decisions/permission-change-via-plan-page.md` (decision record) and `/shared/projects/access-control/artifacts/permission-change-helper-tech-design.md` (tech design).

### Required pattern for collections

Any task or skill that modifies access controls must:

1. Call the read-only `aifs_get_permissions` op first to capture current state (used as the `before` field in the spec for diff visualization).
2. Build a permission-change spec describing the proposed operations. Spec format documented in the tech design above.
3. Invoke the `permission-change-helper` skill with the spec.
4. Branch on the helper's outcome:
   - **applied** — read post-state via `aifs_get_permissions` to confirm and continue task workflow
   - **rejected** — surface to the member that the change was declined, halt task gracefully (and roll back any prior task state that depended on the share happening, if applicable)
   - **timed_out / page_closed** — surface the ambiguous state, offer to retry the step
   - **partial_failure** — surface what succeeded and what didn't, offer to retry just the failed ops
   - **apply_error** — surface the error in detail, halt
5. Continue the task workflow only after a successful apply has been verified post-state.

Tasks that previously called `aifs_share` / `aifs_unshare` / `aifs_transfer_ownership` directly (e.g. v3.1.0+ admin tasks before they're rewritten) are authoring errors. Preflight v1.2.X+ flags any direct call to these ops in a task workflow as an error.

**No direct-apply fallback — including from a sandbox (Release B.1, bug `20260617-8d20ea22-helperbypass`).** The fact that the agent runs in a Linux sandbox while the helper binary runs host-side does NOT license falling back to a direct `aifs_share`. The helper flow crosses that boundary by design: the agent writes the spec and emits the `agent-index://apply?spec=…` link, the user clicks + Accepts on their host, and the agent reads the outcome JSON. A task must never "apply directly with owner credentials because the helper can't be driven here." The ONLY sanctioned direct `aifs_share` is create-org's documented install-bootstrap exception (org-creator, one-time, org-root grants) — it does not extend to invite-member, share-idea, remove-member, or any member-facing/admin sharing task. (A hard runtime guard refusing agent-initiated share/unshare is desirable but deferred: the exec `aifs_share` is also the path create-org's bootstrap exception uses, so a blanket refusal would break it — tracked for when the bootstrap grants also move behind the helper.)

**Share recipients are the resolved `sharing_identity`, not the roster email (Release B.1, bug `20260617-8d20ea22-identitymap`).** When composing a permission-change spec, the recipient for an org member is that member's `sharing_identity` from `members-registry.json` — the backend-grantable identity (objectId/UPN on onedrive; email on gdrive). `invite-member` resolves it once (via `aifs_resolve_identity`) and persists it. Any other sharing task reads it from the registry; if a member's `sharing_identity` is missing (pre-1.8.0 entry), resolve via `aifs_resolve_identity` and backfill the entry. Never grant to the raw roster email on onedrive — it often isn't resolvable in the tenant, and the failure surfaces as a misleading generic `sharingFailed`. This is a registry-field read per task, not a per-collection identity lookup; only `invite-member` performs the resolution.

### What the helper is NOT

The helper is not a privileged service. It does not hold its own OAuth credential. It does not elevate privilege. It cannot make permission changes that the calling member doesn't already have authority to make. Adapters never call the helper directly — only collections (via the agent-side skill) do. The helper is purely orchestration: it produces a review page, listens for the member's Accept, and runs an apply-script that uses the member's existing token.

This pattern is the canonical answer to bug `20260502-8d20ea22-4` (access-control execution-context mismatch). Future adapters (S3, OneDrive, Dropbox) call into core's permission-helper as a peer; they do not implement adapter-specific helpers.

### Trust contract for the agent in the URL-handler invocation flow

The helper's invocation surface is a custom URL scheme (`agent-index://`) that the user clicks in chat. This section codifies what Claude does and does not do in this flow, so the safety boundary is in writing and testable at preflight.

**The agent does:**

- Build a permission-change spec from task context (data-only generation).
- Write the spec to `outputs/permission-plan-{timestamp}.json` in the workspace folder.
- Emit a markdown link in chat of the form `[summary text](agent-index://apply?spec=outputs/permission-plan-{timestamp}.json)`.
- **Also emit the same URL inside a fenced code block**, immediately after the markdown link, as a fallback for clients that strip or hide custom-scheme links (e.g., current Cowork desktop builds as of 2026-05-20). The fenced URL still requires deliberate user action (copy → paste into browser address bar), so the trust boundary is preserved. The dual emission is normative — preflight enforces it (see "Implementation enforcement" below). Added in core 3.7.3 to close bug `20260519-8d20ea22`.
- Wait for the user to report the outcome of clicking the link, or read the helper's structured outcome JSON if it's surfaced through a conversation channel. The outcome file is written by the binary on terminal state to `outputs/permission-plan-{timestamp}-outcome.json` (alongside the spec file; same timestamp).
- After the user reports completion, verify the post-state by calling `aifs_get_permissions` on each affected path (read-only, agent-callable directly).
- Surface concise narration to the user about what was applied and what verification confirmed.

**The agent does not:**

- Auto-fire the URL on the user's behalf. No HTML auto-redirects, no `window.location` injections in any document the user views, no programmatic navigation to `agent-index://...` URLs. The link must require a deliberate user click.
- Embed pre-authorization tokens in the URL that bypass the review-page Accept step. The URL points to a spec; the binary opens a review page; the user must click Accept on that page. Skipping the review at the URL layer is not allowed.
- Emit URLs that include the actual permission change as encoded parameters rather than referencing a spec file. Specs live on disk where the user can inspect them; URLs reference them by path.
- Auto-confirm on the user's behalf. The page's Accept button must require the user's explicit click; the agent does not emit any mechanism that would simulate or pre-trigger that click.
- Generate URLs targeting spec paths outside the workspace's `outputs/` directory. The helper binary should validate the spec path stays within the workspace and refuse otherwise — this is defense-in-depth against an attacker who can write to the URL bar.
- Suppress the OS-level "allow this site to open agent-index?" confirmation prompt that the browser shows on first use. That prompt is a user-visible signal; it must remain.

**Why these specific don'ts:** the safety boundary that gates permission writes is the rule "the agent shouldn't be the source of authority for security-changing actions." The URL-handler architecture routes around this by making the privileged action's call stack start at the user's deliberate click, not at the agent's tool call. Any of the listed don'ts would re-collapse the gap by putting the agent's automated emission upstream of the privileged action without the user's deliberate gating step in between. The list above is what makes the architecture honest.

**Implementation enforcement:** preflight checks should grep task workflows for the disallowed patterns (e.g., `<script>.*agent-index://`, `window\.location\s*=\s*['"]agent-index://`, `auto.*click.*Accept`). Any match is an authoring error and fails preflight. Preflight also verifies the **positive** pattern added in core 3.7.3: every task that emits an `agent-index://apply` markdown link must be paired (within ~5 lines) with a fenced code block containing the same URL. A markdown link without the code-fence twin is an authoring warning — preflight surfaces it. This gives the trust contract teeth at release time rather than relying on author memory.

### Trust contract for binary-tool downloads (added in core 3.4.0)

Binary tools (e.g. `permission-helper-go`) are downloaded from the registry declared in `infrastructure-directory.json` → `binaries[]` and installed by `apply-updates` Phase 1 step 7. This section codifies the trust boundary for that path.

**The agent does:**

- Read `infrastructure-directory.json` from `infrastructure_directory_url` (HTTPS only) to identify what binary tools the registry knows about.
- Read `org-config.json` → `binaries{}` to identify what versions the org has pinned.
- Read the local version file at the path declared by the registry's `version_file` to identify what's installed.
- Surface the upgrade summary to the user in chat — source URL, target version, SHA256 fingerprint (truncated), local version, install destination.
- Wait for explicit user Y/N confirmation in chat before downloading.
- On Y: download the binary via HTTPS, compute SHA256 of the downloaded bytes, compare against the registry's published SHA256.
- On SHA256 match: write atomically to `install_destination`, `chmod +x` on Unix, write the version string to the `version_file` path.
- Run the registry's `post_install_command` (e.g. `--register`).
- Surface the result of the install + post-install to the user.

**The agent does not:**

- Download binaries without explicit user Y/N approval in chat. The trust contract for the URL-handler flow extends to this: the user is the source of authority for making changes to their machine, including installing executables.
- Skip SHA256 verification, even if the user wants to "just install it." A SHA256 mismatch is a security failure path. Abort, do not retry, surface clearly.
- Install binaries to paths outside `mcp-servers/<name>/`. The registry's `install_destination` field is template-substituted with `{ext}` only; agents may not relocate binaries elsewhere.
- Run `post_install_command` if the install or SHA256 step failed. Registration steps assume the binary is correctly placed; running them on a partial/corrupt install can leave the system in a worse state than no install.
- Use download URLs not derived from the registry's `release_url_template`. URLs must come from the registry; the agent may not synthesize a URL that points elsewhere "because the registry seems out of date."
- Pin to versions below the registry's `min_required_version`. That floor exists to lock everyone out of known-bad versions; the floor is non-negotiable from the agent side. Admins may try via `pin-binary-version`; that task validates and refuses.
- Auto-run `--register` or any `post_install_command` outside the `apply-updates` flow. The trust contract requires the install + register pair to be a single user-approved step.

**Why these specific don'ts:** the same boundary that gates permission writes also gates binary installs. The agent must not be the source of authority for "putting an executable on the user's machine." User-approved download in `apply-updates` makes the user the gating step; SHA256 verification makes the registry's signed identity the second gating step. The list above keeps both gates honest.

**Implementation enforcement:** preflight checks should grep task workflows for disallowed patterns: bare `wget`/`curl` invocations for binary downloads outside the `apply-updates` Phase 1 step 7 flow, hard-coded URLs in any task that doesn't read from `infrastructure-directory.json`, any auto-confirm logic on the binary-install user-prompt step. Same pattern as the URL-handler enforcement above.

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

## Capability Provider Requirements

Collections may declare that they provide or require abstract capability types. This enables loose coupling between collections: a consumer collection codes against a capability interface, and the org chooses which provider collection fulfills it.

### Capability Type Registry

Well-known capability types are maintained in `agent-index-core/capability-types/`. Each type is a JSON file defining a set of operations with parameters and return values. New types may be proposed via the agent-index GitHub repository, following the same process as category additions.

Collections may also define custom capability types in a `/capability-types/` directory within the collection. Custom types are namespaced as `{collection-name}:{capability-name}` to avoid collisions with well-known types.

### Provider Declarations (`provides`)

Collections that implement a capability type declare this in the `provides` array of `collection.json`. Each entry must include:

| Field | Type | Description |
|---|---|---|
| `capability` | string | The capability type being provided. Must reference a well-known type or a custom type (namespaced). |
| `capability_version` | string | The version of the capability contract this provider implements. |
| `operations` | object | Map of operation names to implementation references. Each entry must have `implemented_by` (name of an API member) and `type` (`"skill"` or `"task"`). |

Every `implemented_by` value must reference a name listed in the collection's `api` array. The implementing skill or task must accept at minimum the parameters defined in the capability type's operation spec.

All operations marked `required: true` in the capability type definition must be present in the provider's `operations` map. Optional operations may be omitted.

### Consumer Declarations (`requires`)

Collections that need a capability type declare this in the `requires` array of `collection.json`. Each entry must include:

| Field | Type | Description |
|---|---|---|
| `capability` | string | The capability type being required. |
| `capability_version` | string | SemVer range (e.g., `">=1.0.0"`, `"^1.0.0"`). |
| `required_operations` | array | Operations the consumer must be able to call. At least one provider must implement all of these. |
| `optional_operations` | array | Operations the consumer will use if available. |
| `required` | boolean | If `true`, the collection cannot function without this capability. If `false`, reduced mode is acceptable. |
| `fallback` | string | Behavior when no provider is registered: `"skip_with_notice"`, `"prompt_manual"`, or `"error"`. |

### Capability Bindings

Consumer collections define named capability bindings — specific use cases that map to registered providers. Bindings are stored in a dedicated `capability-bindings.json` file in the member's local workspace:

**Path:** `members/{member_hash}/collections/{collection_name}/capability-bindings.json`

| Field | Type | Description |
|---|---|---|
| `version` | string | Schema version for the bindings file format. |
| `collection` | string | The consumer collection these bindings belong to. |
| `last_updated` | string | ISO date when bindings were last modified. |
| `bindings` | object | Map of binding names to binding configurations. |

Each binding entry:

| Field | Type | Description |
|---|---|---|
| `capability` | string | The capability type this binding draws from. |
| `provider_collection` | string | The registered provider collection bound to this use case. |
| `operation_subset` | array | Which operations this binding uses. |
| `provenance` | string | The provenance tier that governed this binding's configuration. |

Bindings are configured during the consumer collection's setup interview. When only one provider is registered for a capability type, bindings are auto-assigned without prompting. When multiple providers are registered, the setup interview presents binding choices using standard provenance tiers.

### Provider Registry in `org-config.json`

Registered providers are stored in `org-config.json` under `capability_providers`. Each capability type maps to an array of provider entries:

| Field | Type | Description |
|---|---|---|
| `provider_collection` | string | Name of the installed collection providing this capability. |
| `capability_version` | string | The capability type version the provider implements. |
| `registered_date` | string | ISO date when the provider was registered. |
| `registered_by` | string | `member_hash` of the admin who registered the provider. |
| `operations_available` | array | List of operations the provider implements. |
| `provider_config` | object | Provider-specific configuration set during registration. |

### Capability Type Versioning

Capability types follow semantic versioning. MAJOR bumps for removing required operations or breaking parameter signatures. MINOR bumps for adding operations or optional parameters. PATCH bumps for documentation changes only.

For the full capability provider specification including runtime resolution, install-time validation, and migration guidance, see `capability-provider-spec.md`.

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
