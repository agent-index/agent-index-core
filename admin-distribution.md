# Agent-Index Admin and Distribution

**Maintained by:** agent-index
**Last Updated:** 2026-10-01

---

## About This Document

This document is for the **org admin**: publishing releases, distributing collections to members, marketplace subscriptions, the update log, and org roles. Members' sessions do not need it, except where a member-side task reads what the admin publishes; those points are marked.

**How to reach it.** By ID anchor: `id:{folder_id}/admin-distribution.md`, where `{folder_id}` is the `agent-index-core` entry in `org-config.json` → `installed_collections[]`.

**Citing it.** Cite as `admin-distribution.md § "Exact Heading"`. Headings only — no line numbers, no bold labels.

**What used to be here.** This document and two others replace `standards.md`, which is retired (Core Improvements decision `2026-09-22-retire-standards-md`). Runtime rules are in CLAUDE.md and `runtime-reference.md`; marketplace eligibility and authoring requirements are in the developer collection's `marketplace-eligibility.md`.

---

## Distribution: backend-first (Release C — the current model)

**Members never fetch from github.com.** Each org's own backend is its distribution layer: the admin (the only GitHub touchpoint, over the **git protocol** — clone/pull, which is not subject to the raw/REST rate cap) publishes everything members need — collections, the directories, and the helper binary — to `/shared/dist/` on the org backend. Members read directories + binary from `/shared/dist/` and **SHA-verify them against `/shared/dist/manifest.json`** (the org's version authority), and read collection capability files from each collection's **id-anchored canonical base** (`id:{folder_id}`), gated on the manifest's collection versions. See the `backend-distribution` and `clone-script-generator` subroutines (`templates/`). This eliminates both root causes that recurred across Jeff / ms-install-5 / ms-install-6 — GitHub rate limiting (members make zero GitHub calls) and stale-cache (members read the backend, the admin's deterministic tag-pinned publish, not GitHub's cache-fronted raw layer).

- **Member runtime path:** backend-first, always. `check-updates` answers "is this member current?" against `/shared/dist/manifest.json`; `apply-updates`/`member-bootstrap` fetch directories + binary from `/shared/dist/` and SHA-verify. **The SHA gate is real and mandatory (C.1.3):** both tasks compute the artifact SHA per the **Canonical SHA-256 rule** (`backend-distribution.md` — hash the stored `size` bytes, never `aifs_read` stdout) and refuse a mismatch. Pre-C.1.3 these tasks read the manifest for version numbers but never hashed the artifacts (`shagateunimplemented`), and a manifest computed from stdout-with-newline (`412094b4…`) didn't match the stored bytes (`e1d549e4…`) (`manifestsha`) — both fixed by computing identically on the publish and member sides.
- **One read path for collection files:** `id:{folder_id}` only, never a bare `/{collection}`. This is a runtime rule every session needs, so it is authoritative in CLAUDE.md and not restated here.
- **`publish-updates` republishes `/shared/dist/` on every publish (C.1.3, `publishdistgap`)** — manifest + directories + binary — so the member-facing authority never goes stale after an in-place update, with a publish-time round-trip SHA self-check.
- **Admin path:** local clones (tag-pinned) → publish to the backend. "Is the org current with upstream?" is an admin-only **git** check (`git fetch` + compare tags), not a raw fetch.
- **NEVER `WebSearch` to discover versions, releases, or directory state (`adminupstreamstale`, C.1.3.4 — HIGH).** A `WebSearch` returns a cached, weeks-stale snapshot of the *public* directory; an admin "update our org" run that web-searched concluded "org is ahead / nothing to update" against a June-9 cache while the org was many releases ahead, and the update never happened. For a **self-distributing org** (admin publishes from local clones rather than consuming the public directory) the canonical "latest release" is the **clone working tree / git tags**, and the public broadcast directory is *by design behind* the org's internal versions — so it must not be treated as upstream. "Update our org" routes to **clone-script refresh (git fetch --tags) → `publish-updates` from the refreshed clones**, never web/raw discovery. Repairing a corrupt remote file likewise re-sources from the clone (`git show HEAD:<path>`), never a web fetch.
- **The SHA-pinned GitHub fetch protocol below is now the ADMIN-only path and the DEPRECATED member fallback** (used only by a not-yet-migrated org, with a deprecation warning; removal targeted for the release after C). New installs always have `/shared/dist/` and never use it.

**Reads go through aifs only** (`wrongconnectorfallback`). Authoritative in CLAUDE.md § "Reads go through aifs only"; not restated here.

---

## Marketplaces: catalogs, subscriptions, provenance (normative — core 3.30.0; collision rules revised in 3.31.0)

An org may consult **more than one marketplace catalog**. Three things are kept separate because they have different owners and different lifetimes. Design record: `68-solution-design-multi-marketplace.md`.

| Layer | What it is | Where it lives | Who reads it |
|---|---|---|---|
| Catalog | what a marketplace offers | `marketplace-directory.json` in a catalog repo | admin |
| Subscription | which catalogs this org consults | `org-config.json` → `marketplaces[]` | admin |
| Provenance | which catalog each installed collection came from | `org-config.json` → `installed_collections[].marketplace_id` | admin |

**Catalogs are admin-only.** Members never read a catalog; they read what the admin has published to `/shared/dist/`. Nothing in this section changes the member runtime path, the dist manifest schema, or `apply-updates`.

### Catalog identity

A catalog declares its own identity at the top level of `marketplace-directory.json`:

| Field | Type | Rule |
|---|---|---|
| `marketplace_id` | string | kebab-case, globally meaningful. Declared by the catalog, **never assigned by a subscriber** (APT/DNF assign repo ids locally, which makes provenance strings incomparable across installs — do not inherit that). |
| `display_name` | string | human label. A subscriber may override it locally; the id never changes. |
| `namespace` | string \| null | optional reserved name prefix (3.31.0). `null` = the catalog reserves nothing. A reservation stops *other* catalogs from offering `{ns}-*` names; it does **not** restrict the catalog's own entries. |

A catalog file with no `marketplace_id` is the legacy public catalog and is read as `marketplace_id: "agent-index-public"`, `namespace: null`. Entry schema (`collections[]`) is unchanged.

### Subscriptions — `org-config.json` → `marketplaces[]`

| Field | Type | Description |
|---|---|---|
| `id` | string | must equal the catalog's declared `marketplace_id` (verified at subscribe and on every read). |
| `display_name` | string | local label; defaults to the catalog's. |
| `enabled` | bool | `false` = stop consulting this catalog **without** deleting the subscription. Provenance referencing it stays interpretable. |
| `source` | object | `{ "kind": "clone", "ref": "<repo dir relative to install_root>", "git_url": "…" }` or `{ "kind": "url", "ref": "<https url>" }`. |
| `namespace` | string \| null | copied from the catalog at subscribe; re-verified on read. |
| `skip_if_unavailable` | bool | default **`false`**: an unreadable source aborts the listing with a named error. `true` opts that one source into being skipped with a visible notice. Never silently return a partial catalog. |
| `trust_anchor` | object | for `clone`: `{ "git_url": "…" }` — the clone's `origin` must match. Trust is scoped to a source, never global. |
| `subscribed_date`, `subscribed_by` | string | ISO date; admin `member_hash`. |

**`source.ref` for `clone` is stored relative to the install root** (e.g. `"agent-index-resource-listings"`), never absolute — same rule and same reason as `apps_path` (core 3.29.2, `appspathsandboxleak`): an absolute path captured in one session is a dead sandbox mount in every other. Consumers resolve it against the install root at read time.

**Source kinds (v1):** `clone` — a catalog repo cloned into the install root by the committed `lib/clone/clone-repos` script (the current Release-C admin path; subscribing a new `clone` source adds its repo to the infra clone manifest). `url` — the legacy public-directory fetch, retained only for a not-yet-migrated org. `backend` (a catalog JSON on the org's own backend, for an org with no clones) is **reserved and not implemented in v1** — a subscription declaring it is refused.

Subscriptions are org policy: editable only by an admin, via `@ai:edit-org` → Manage marketplaces.

### Unique names and optional namespaces

The naming rules that make multiple catalogs safe — unique names, optional namespace reservations, the hyphen separator, non-overlapping reservations — constrain catalog and collection authors, so they live in the developer collection's `marketplace-eligibility.md` § "Unique names and optional namespaces". The rest of this section assumes them.

### Provenance — `installed_collections[].marketplace_id`

- **Written at download/install from the catalog the entry was selected from; never recomputed** from whatever catalogs are subscribed later.
- **Survives unsubscription** (and `enabled: false`). A collection whose origin catalog is disabled or unsubscribed is reported as such, not as "untracked."
- **`null` means sideloaded** — installed without a catalog entry. A first-class, permanent-capable state; retrofitting a catalog later is a one-field edit, not a reinstall.
- Existing entries are back-filled to `"agent-index-public"` by `publish-updates` 6g; `agent-index-core` and `agent-index-marketplace` are always `"agent-index-public"`.

### Collisions

With unique names enforced, a bare-name lookup resolves to at most one catalog. A conflicting name (offered by two catalogs) is **refused for new installs**, naming both catalogs; the admin resolves it at the catalog. Installed collections are unaffected: update checks and upgrades look in the collection's **origin catalog only** (its `marketplace_id`), so a same-named entry appearing in another catalog cannot redirect an upgrade — it is surfaced as a warning. There is **no `priority` field and no pinning** — APT/DNF need those because a dependency solver must pick a candidate with no human present; agent-index has no solver and an admin is present at every install. Do not add one as a convenience.

### Legacy orgs

If `org-config.json` has no `marketplaces[]`, consumers synthesise exactly one subscription: `id: "agent-index-public"`, `enabled: true`, `namespace: null`, `skip_if_unavailable: false`, source `clone` at `agent-index-resource-listings` when that clone exists under the install root, else `url` from `agent-index.json` → `marketplace_directory_url`. Output must be identical to pre-3.30.0 behaviour. `publish-updates` 6g writes the synthesised entry for real. `marketplace_directory_url` stays in `agent-index.json` and is not removed in 3.30.x.

### Decommissioned: `/shared/marketplace-cache/`

The web-fetched catalog cache has had no writer on a clone-publishing org since marketplace 2.17.0 (`mktcatalogwebfetch`) and must not be read as a catalog or version source. Marketplace 2.20.0 removes its last reader (`check-updates` Step 3). Member currency is `/shared/dist/manifest.json` → `collections[]`.

---

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
- **Author orchestrator/helper scripts via heredoc to native tmp, not the Write tool onto the mount (`scriptnulltail`, M4 / C.1.3.4).** The same torn-write/null-tail hazard that affects backend writes also affects the **host Write tool writing onto the Cowork mount**: a script written there can come back tail-truncated or with NUL bytes in the tail (observed live during the ms_install_10 member apply — the resync orchestrator had to be rewritten via `bash` heredoc to a native `mktemp` path before it would run). When generating a script to execute, write it to a native temp dir via a `bash` heredoc (`cat > "$(mktemp -d)/x.py" <<'EOF' … EOF`), then **compile/verify it** (`python -m py_compile` / `node --check`) before running — never trust a Write-tool file on the mount for executable content. (This is the host-side sibling of the `collectionjson-tornwrite` backend bug.)
- **Never read/consume a `/tmp` scratch file you did not create in the current session (`staletmpinject`, C.1.3.6).** Cross-session `/tmp` is shared: a fixed, predictable scratch name (e.g. `/tmp/reg.json`) can already hold a stale file left by an unrelated prior session, and consuming it injects wrong context. During a live `invite-member` this clobbered `/members-registry.json` with a phantom member because a `> /tmp/reg.json` redirect silently failed (`Permission denied` on a leftover file owned by another session) and the read-modify-write fell through to the pre-existing bytes. When staging a remote-read → modify → remote-write, always: (a) use a **unique per-invocation** path (`mktemp`) or a session-owned scratch dir you create — never a fixed shared name; and (b) **assert the populate step actually succeeded** — check its exit status AND that the file is non-empty / parses as expected — **before** consuming it; a failed populate must abort loud, never silently fall through to whatever bytes were already there. Keep the read-back-after-write verify on remote coordination files (`/members-registry.json`, `/org-config.json`, …) — it is the net that caught this. **And never re-discover the staged file by `ls`/newest-mtime/glob (`ocstalereselect`, C.1.4.0):** hold the exact unique path you wrote in a variable and reference *that* for the authoritative write. Ambient "newest staged file" selection can pick an *older same-session, same-org* copy — its `org_id` matches, so an identity-only assertion passes — and silently revert a just-made edit (a near-miss on `org-config.json` during a Dev 2 create-org). So also **extend the pre-write assertion beyond identity to content**: assert the staged bytes actually contain the change you just made (e.g. the entry you're registering is present) so a stale same-org copy is caught *before* the write, not only by the read-back.
- **Then publish the backend** per the backend-first model above: clone at the new tags (`clone-script-generator`) → republish `/shared/dist/` + `manifest.json` (`backend-distribution`) → verify the manifest. The release is not "shipped" to members until the manifest reflects it.
- **Native binaries must be code-signed (C.1).** Every helper-binary release artifact is signed before checksums are computed (Windows Authenticode / Trusted Signing; macOS Developer ID + notarized `.app`; optional Linux GPG) so the directory `sha256` pins the **signed** bytes, and a `verify-signed` gate fails the release otherwise. Unsigned binaries are hard-blocked by Windows Smart App Control with no user bypass. The directory's `post_install` is **per-platform** — darwin installs the notarized `.app` (macOS registers bundles, not loose executables); never `--register` a bare darwin binary. See `lib/permission-helper-go/SIGNING.md`.
- **Install orchestration makes zero GitHub calls (C.1).** `create-org` (and the agent generally) never fetches `raw`/REST to resolve versions, the catalog, or the binary — all GitHub access is the git protocol (`ls-remote`, `clone`) and the signed binary's release-asset download, inside the host-run clone scripts. Version discovery is `git ls-remote --tags` (no `main` fallback); the binary is resolved backend-matched from the freshly-cloned listings.

---

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

## Update Instructions

**This is a shared wire format.** The admin writes it (`publish-updates`); members read it (`apply-updates`, and `session-start` via `latest.json`). Changes to the format must keep the member-side readers working. Members address the update log by ID anchor, `id:{resource_ids.shared_root}/updates/...`, not by a bare `/shared/updates/` path.

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
