# Agent-Index Runtime Reference

**Maintained by:** agent-index
**Last Updated:** 2026-10-01

---

## About This Document

This is the runtime reference for agents working in an agent-index org. It holds the rules a session needs **only when performing a specific operation** — changing permissions, sharing owned content, writing shared data, resolving identities. The rules every session needs at all times are in the org's `CLAUDE.md` and are **authoritative there**; this document does not restate them, and points to them where they matter.

**How to reach it.** By ID anchor: `id:{folder_id}/runtime-reference.md`, where `{folder_id}` is the `agent-index-core` entry in `org-config.json` → `installed_collections[]`. A bare `/agent-index-core/...` path does not resolve for a non-Drive member.

**Citing it.** Cite as `runtime-reference.md § "Exact Heading"`. Headings only — no line numbers, no bold labels.

**What used to be here.** This document and two others replace `standards.md`, which is retired (Core Improvements decision `2026-09-22-retire-standards-md`). Marketplace eligibility and authoring requirements are in the developer collection's `marketplace-eligibility.md`; admin and distribution material is in `admin-distribution.md`.

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

## Addressing: Owned Content and Sharing

The addressing rules every session needs — the `id:` prefix, the top-level-id manifest, collection reads by `folder_id`, and what a root-level `FILE_NOT_FOUND` means — are in CLAUDE.md and are authoritative there. This section holds the detail needed only when a task stores, shares, or opens owned content, and the background to the bootstrap rule.
The adapter (gdrive ≥ 2.5.0) supports two addressing modes:

- **Absolute paths** (`/shared/...`, `/{collection}/...`) — for locations the caller can enumerate from the root — in practice **admins only** (Shared-Drive members). A non-admin member is not a Shared-Drive member and cannot enumerate the root, so a bare `/{collection}` resolve fails or resolves the wrong folder (12 of 12 collections in the 2026-09-23 sweep), and a bare `/shared/...` resolve works today only through the adapter's name-search fallback, which is being removed (Core Improvements CI-016). Member-facing reads use ID anchors: `id:{folder_id}` from `installed_collections[]` for collections and `id:{resource_ids.shared_root}` for `/shared`. Members are *authorized* on `/shared` and collection trees via the **all-members group's direct-on-folder grants** — the group's reader on `/shared` (create-org Step 4.5) and on each collection root (install-collection cr01), conveyed by **group membership**, NOT by per-member shares. (Do not add per-member reader shares to make enumeration work — that was the obsolete `catbredundant` workaround; direct-on-folder group grants enumerate fine, validated on gdrive 2026-06 with a group-only member.) Admins can enumerate everything.
- **ID anchors** — `id:{folderId}/relative/path` — for locations the caller is **granted on but cannot reach by walking from the root** (their own member space; items shared with them). Resolution starts at `{folderId}` and walks **downward only**. This is required because non-admin members are not Shared-Drive members and cannot enumerate containers like `/members/` (bug `20260522-8d20ea22`).
- **Cross-drive ID anchors** — `id:{driveId}:{itemId}/relative/path` (C.1.3 `crossdriveread`) — for content that lives on **another member's drive** and was shared to the caller. On OneDrive/SharePoint, item IDs are **drive-scoped**: a bare `id:{itemId}` resolves against the *caller's own* drive (`/me/drive`), so it fails `PATH_NOT_FOUND` for an item that physically lives in the owner's personal OneDrive even when the caller has been granted access. The qualified form carries the owner's `driveId`, which the adapter routes to `/drives/{driveId}/items/{itemId}` — reading the item where it actually lives, governed by the caller's granted permission (the delegated `Files.ReadWrite.All` token already covers "all files the user can access," including shared-with-me). The model is: **private = owner's personal drive, public/commons = the SharePoint site drive**; cross-drive anchors are how a member reads private content another member shared to them. (gdrive resolves shared content natively via `corpora:allDrives`, so the qualified form is OneDrive's parity mechanism; on gdrive a bare `id:{itemId}` already reaches shared items and the `driveId` segment is accepted-but-ignored.)

**Conventions:**

1. **Member space (reworked in core 3.9.0).** A member's private remote space is a folder named `Agent-Index-Private` **in the member's own My Drive** — created by the member's own credentials at bootstrap (`id:root/Agent-Index-Private`, then always referenced by its **resolved** Drive ID, never the `root` alias) and **owned by the member**. Ownership is the point: Google Drive permits folder-sharing on a Shared Drive only to drive Managers, so member-applied grants are impossible there (finding F12); on their own My Drive, the owner has full sharing power. The bootstrap writes a handshake file (`/shared/members/artifacts/{hash}/member-folder.json`); the admin-side `publish-updates` reconcile (6d) copies the ID into `members-registry.json`; installs cache it in `member-index.json` (apply-updates Step 1.5 keeps it fresh). Legacy `/members/{hash}/` Shared-Drive spaces are deprecated — content migrates member-side via apply-updates 3.9.0 Migration 2.
   *Custody note:* the org has no access to member spaces and cannot repair, audit, or reclaim them. Sharing grants the owner makes survive their removal from agent-index (the org loses governance, not the recipients' access). For org-managed Workspace accounts, content and grants last as long as the account; consumer-account members' content is permanently their own. Governance of shared member content is **by cooperation** (tasks following these conventions), not enforcement — adopt the model with that expectation.
2. **Owned, selectively-shared content** lives in the owner's member space (`id:{owner_member_folder_id}/{collection}/{slug}/`), **never** under `/shared`. Sharing is additive grants on the item folder via `permission-change-helper` with the **owner** Accepting (specs use the bare `id:{folder_id}` resource form, helper-go 0.4.0+): *share with X* = X `reader`; *collaborator X* = X `writer`; *share with org* = `{all_members_group}` `reader`. Pointer writes are hard-gated on the helper outcome reporting `applied`. When the owner `aifs_stat`s the item to capture its `item_id`, **also capture the returned `drive_id`** (the item's home drive — adapter 2.3.0+ returns it) for the pointer's `item_drive_id` (convention #3).
3. **Pointer index (discovery).** Each shared item gets one pointer file in the collection's open-shared index folder: `/shared/{collection}-index/{owner_hash}-{slug}.json` with fields `type`, `owner`, `owner_hash`, `slug`, `item_id` (the **shared item's own** Drive/Graph ID — for a folder, the folder id; for a single file, that file's own id), **`item_drive_id`** (the owner's home drive ID for that item, from the same `aifs_stat`; C.1.3 `crossdriveread`), `scope`, and (per-collection privacy choice) `title` / `collaborators`. The index folder is an open-shared area (`all@` writer, declared in the collection's `collaborative-acls.json`). One file per item — no shared mutable index, no write contention.
   - **Recipients open shared content via the cross-drive anchor** `id:{item_drive_id}:{item_id}` when `item_drive_id` is present, falling back to the bare `id:{item_id}` for older pointers (pre-C.1.3) and for own-drive items. The qualified form is what lets a recipient on OneDrive actually read content that lives on the owner's personal drive — a bare `id:{item_id}` resolves against the *recipient's* drive and returns `PATH_NOT_FOUND` (the `crossdriveread` failure observed in ms_prod_9: handoff-test-2 was discoverable but unopenable). On gdrive the bare anchor already reaches shared items, so the qualified form is harmless there. **Never** route around aifs to an external connector when a bare anchor 404s — add/repair `item_drive_id` instead (CLAUDE.md § "Reads go through aifs only").
   - **A share without a pointer is invisible to agent-index (`owncontentdisco`, ms-install-9).** Discovery is the pointer — the recipient's session finds shared owned content by reading these index files, NOT by enumerating another member's space (which it cannot reach, especially across personal OneDrives). So any owned-content share that should be discoverable in-session MUST write a pointer (hard-gated on the helper `applied` outcome, same as the grant). An **ad-hoc share with no owning collection / no pointer index** (e.g. a one-off note shared directly) is therefore **backend-native-discovery-only**: the grant works, but the recipient opens it through the backend's own "Shared with me" view, and agent-index will not surface it. The sharing flow must **say so** at share time ("Bill will find this in OneDrive → Shared with me; agent-index doesn't index ad-hoc personal-space shares") rather than leaving the recipient to discover the gap when their session can't find it.
4. **Soft-delete on org-shared surfaces.** Non-admin members **cannot trash/delete** files on the Shared Drive (Contributor role), so collections must never require deletion there: "delete" = overwrite metadata to mark archived; "unshare" = revoke the grant (helper `unshare`) + **overwrite** the pointer file with `scope: "revoked"`. Overwrites are writer-permitted; Shared-Drive deletions are admin-only. (Members CAN delete content in their own My Drive space — they own it — but pointer files live on the Shared Drive and always follow the overwrite convention. A collection should still prefer archive-marking over deletion in member spaces so changelogs and cross-references stay resolvable.)
5. **Rule of thumb** — *paths for what you can enumerate; ID anchors for what you're granted.* The rule is authoritative in CLAUDE.md; it is not restated here.
6. **Bootstrap entry points are id-anchored (C.1.4.3 — `groupshareapivisibility`).** A newly-added group member cannot rely on by-path/name resolution for the org's *top-level* resources during onboarding: absolute-path resolution must enumerate the Shared-Drive root, which a non-drive-member cannot do (see `rootsilent`), and a freshly-conveyed group grant is not immediately reflected in name resolution (group-grant propagation latency — the `pathcachestale` finding, i.e. timing, not a cache to warm). By contrast, id `get`, descendant enumeration by id, and writes by id all work **immediately** regardless of visit/propagation (validated pre-visit on a fresh member, 2026-07-11). So `member-bootstrap` and the whole onboarding path address bootstrap-critical resources by **id anchor**, never by path.
   - **The `id:` prefix is REQUIRED.** `id:{fileId}` / `id:{folderId}/rel/seg` resolves; a **bare** `{folderId}/child` is treated as a literal path segment and fails with `BACKEND_ERROR` (validated 2026-07-11 — the write only succeeded once the `id:` prefix was added). Always emit the `id:` prefix.
   - **Top-level-id-manifest rule.** Every **root-child** resource needs its Drive id recorded so it can be reached without enumerating the root: `/org-config.json` (its id is baked into the bootstrap zip's `agent-index.json` as `remote_filesystem.connection.org_config_id`), `/shared` and `/members-registry.json` (in org-config `resource_ids`), and core/marketplace/collection roots (already carried as `installed_collections[].folder_id`). **Nested** resources need NO id of their own — reach them by walking down from an id-addressed ancestor (`id:{shared_root}/dist`, `id:{core_folder_id}/api/session-start.md`), which works because id-anchored resolution enumerates children of a granted folder. `create-org` populates the manifest; `publish-updates` back-fills existing orgs and re-stamps the zip.
   - **org-config is the keystone.** `member-bootstrap` reads it FIRST by its baked-in id; everything else is reachable from the ids org-config carries. If that single read fails, the only manual fallback is a one-click "open this one file in drive.google.com" link for org-config — never a tour of five folders.
   - **This does not change the permission model.** Access still comes from the all-members group's direct-on-folder grants (convention above); id-anchoring only changes *addressing*, not *authorization*. Do not add per-member reader shares (`catbredundant`).

---

## Members Registry and Identity Configuration

The identity rule itself — SHA-256 of the lowercase email, first 16 hex characters, used as `member_hash` — is in CLAUDE.md and is authoritative there. This section holds the configuration and registry schema.
Agent-index uses hash-based member identity. Member directories are named using a truncated SHA256 hash of the member's lowercase email address, providing privacy while maintaining deterministic resolution. Hashes are used for both local workspace directory names and remote registry lookups.

### Configuration

Identity resolution is configured in `agent-index.json`:

```json
"identity_resolution": {
  "method": "sha256-email",
  "hash_length": 16
}
```

| Field | Type | Description |
|---|---|---|
| `method` | string | Always `sha256-email` in v2.0 |
| `hash_length` | integer | Number of hex characters to use from the SHA256 hash. Default: 16 |

### Members Registry

The members registry maps hashes to display identities. The file is `/members-registry.json` at the backend root, but it is **read by ID anchor**, never by that path: `aifs_read("id:{resource_ids.members_registry}")`, with the id from `org-config.json` (itself read by `org_config_id` from local `agent-index.json`). A root-level path does not resolve for a non-Drive member — it returns `FILE_NOT_FOUND` although the file exists. Shape:

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

## Shared Artifacts and Data

Write and read paths for data other members can see. The shared filesystem root is `/shared/` on the remote filesystem, addressed by ID anchor: `{shared_root}` below is `resource_ids.shared_root` from `org-config.json`. A bare `/shared/...` path works today only through the adapter's name-search fallback, which is being removed (CI-016). The frontmatter declarations (`produces_shared_artifacts`, `reads_from`, `writes_to`) are authoring requirements and live in the developer collection's `marketplace-eligibility.md`. The remote write constraints are in CLAUDE.md § "Important Constraints".

### Writing Shared Artifacts

Tasks that produce shared artifacts must write them to the remote filesystem using `aifs_write`. The write path depends on the artifact type:

**Per-member artifacts** (files attributed to a specific member, like reports or submitted work): write to `/shared/members/artifacts/{member_hash}/{filename}`. The `member_hash` namespace prevents filename collisions between members. The member's hash is available from session context. Example:

```
aifs_write("id:{shared_root}/members/artifacts/a7f3b2c1d4e5f698/weekly-report-2026-03-24.md", content)
```

**Collection-scoped shared data** (files that belong to the collection, not a specific member, like project definitions or shared configs): write to `/shared/{collection-defined-path}/`. Each collection defines its own path structure under `/shared/`. Example:

```
aifs_write("id:{shared_root}/projects/project-alpha/project.md", content)
```

### Reading Shared Data (Aggregation)

Tasks that aggregate data from the remote shared filesystem (reporting dashboards, cross-project summaries, etc.) read using `aifs_read` and `aifs_list`. Common patterns:

- **List then read:** `aifs_list("id:{shared_root}/projects/")` to discover entries, then `aifs_read` each one
- **Known path read:** `aifs_read("id:{shared_root}/members/artifacts/{hash}/report.md")` for a specific artifact
- **Existence check:** `aifs_exists("id:{shared_root}/projects/project-alpha/project.md")` before reading

---

## Adapter Operations Contract

The two-tier model — local files through native tools, remote files through `aifs_*` on the on-demand executor, and the failure-handling rule — is in CLAUDE.md and is authoritative there. Remote locations are addressed as CLAUDE.md § "Key Files" and this document's § "Addressing: Owned Content and Sharing" describe: `org-config.json` by `org_config_id`, the registry by `resource_ids.members_registry`, collections by `installed_collections[].folder_id`, and `/shared` by `resource_ids.shared_root`.

**Adapter contract v2.0 (added 2026-04-30):** The `aifs_*` family is extended with five additional ops — `aifs_share`, `aifs_unshare`, `aifs_get_permissions`, `aifs_transfer_ownership` (optional per backend), and `aifs_search` — plus an optional `if_revision` parameter on `aifs_write` for safe concurrent edits to shared state files. All ops execute under the calling member's OAuth identity; adapters never elevate privilege. The full operation specifications, including parameter schemas and backend-specific notes, live in `agent-index-filesystem/SPEC.md` v2.0. Consumer collections call these ops directly alongside the existing family — no capability-resolution layer is involved.

**The operation semantics are an external, versioned contract.** Parameter schemas, return shapes and error formats for every `aifs_*` operation are specified in `agent-index-filesystem/SPEC.md`, the specification adapter packages implement against. They are not restated here (Core Improvements CI-013 decision). The agent-facing summary of tools and arguments is the executor's own `aifs-exec.sh --help`.
