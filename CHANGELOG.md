# Agent-Index Core — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

---

## [3.8.0] — 2026-06-03 — ID-anchored addressing & member-folder identity

### Added

- **`standards.md` § "Addressing: paths vs. ID anchors (owned content)"** — the normative model for the owned-content/sharing design: absolute paths for enumerable locations (`/shared`), `id:{folderId}/...` anchors for granted-but-non-enumerable locations (a member's own `/members/{hash}/` space; items shared with them); the `member_folder_id` registry field; the per-item pointer-index convention (`/shared/{collection}-index/{owner_hash}-{slug}.json` with `folder_id` for recipients to anchor on); and the **soft-delete convention** (members are Shared-Drive Contributors and cannot trash — "delete" = mark archived, "unshare" = revoke grant + overwrite pointer to `scope: revoked`). Companion to gdrive adapter 2.5.0 (anchor resolution + `aifs_stat` returning `id`), validated live as a non-admin on 2026-06-03.
- **`invite-member` 1.4.0 → 1.5.0** — Step 5 captures the new member folder's Drive `id` via `aifs_stat` (adapter 2.5.0+) and Step 8 records it as `member_folder_id` in the member's `members-registry.json` entry. This is what lets the member address their private space via `id:{member_folder_id}/...` (non-admins cannot resolve `/members/{hash}/` by path — bug `20260522-8d20ea22`).
- **`org-setup` 3.3.1 → 3.4.0** — ensures `member_folder_id` is cached into `member-index.json` (reading the member's own registry entry by known path); surfaces the backfill ask for pre-3.8.0 members. Also corrects the stale Invocation prose that still described catalog assembly via `aifs_list("/")` (the procedure itself was fixed in 3.7.4; the prose now matches).
- **`member-bootstrap` 3.0.1 → 3.1.0** — first-run workspace creation fetches `member_folder_id` from the registry and includes it in the new `member-index.json`.

### Notes

- `collection.json` 3.7.7 → 3.8.0. Changed-capability manifests bump with their capabilities; remaining manifests' `collection_version` reconciles via apply-updates manifest-sync.
- **Backfill:** members invited before 3.8.0 have no `member_folder_id` in the registry. Admin backfill: for each member, `aifs_stat("/members/{hash}/")` → write `member_folder_id` into their registry entry (revision-aware). Until then, collections that use the member's remote space are blocked for that member (clear message surfaced at setup).
- Ships with gdrive adapter **2.5.0** (id-anchored resolution + `stat.id`) — the anchor gate was validated live as testproduction (non-admin) before this release: anchor write/list/read/stat all green; old-path write correctly still fails; no `/shared` regression.

---

## [3.7.8] — 2026-06-02 — cache-bust directory fetches

### Fixed

- **`publish-updates` 3.5.0 → 3.6.0: Step 0a (`--check-upstream`) now appends a cache-buster (`?t={unix_seconds}`) to the `infrastructure_directory_url` fetch and to each entry's `zip_url` pull** (part of closing bug `20260601-8d20ea22-2`). Without it, the fetch layer's URL-keyed cache of `raw.githubusercontent.com` made `--check-upstream` read pre-release infrastructure versions, conclude "all infrastructure already at upstream," and silently fail to pull a release that was actually live on GitHub. Companion to `agent-index-marketplace` 2.9.0 (`check-updates` 2.6.0 + `refresh-marketplace-cache` 2.3.0).

### Added

- **`standards.md` § "Cache-busting directory/version fetches"** — normative rule that any task fetching a `raw.githubusercontent.com` directory/version URL must append a unique cache-buster, so future authored tasks don't reintroduce the silent-staleness footgun.

### Notes

- `publish-updates` 3.5.0 → 3.6.0; `collection.json` 3.7.7 → 3.7.8. Bootstrapping caveat: this fix can't be auto-detected by the very mechanism it repairs — the first pull of 3.7.8/marketplace 2.9.0 into an org needs a manual cache-busted fetch; thereafter it self-busts.

---

## [3.7.7] — 2026-05-31 — collaborative-folder ACL contract (doc)

### Added

- **`standards.md` § "Collaborative Folder ACLs (`collaborative-acls.json`)"** — documents the optional per-collection `collaborative-acls.json` artifact and the provisioning contract: collections whose members must write shared collaborative state declare the required grants (path, recipient, role, inherit); `install-collection` Step 5.5 (agent-index-marketplace 2.8.0) resolves and provisions them via `permission-change-helper` (admin Accept), never `aifs_share` directly. This is the documented, reusable answer to the cross-collection write-access gap (bug `20260531-8d20ea22`), first applied by bug-reports 1.3.0. Doc-only; no runtime/spec behavior change in core. `collection.json` 3.7.6 → 3.7.7.

---

## [3.7.6] — 2026-05-29 — cascade cleanup of the 3.7.4-era findings

Closes the four-bug cluster discovered during 3.7.4 verification: binary-side helper bugs that meant the v1.1 spec format and `inherit:false` machinery had never actually executed in production, plus the `org-setup` path-correction and `create-org` ACL gaps that meant non-admin members couldn't reliably read root-level org-readable files.

### Fixed

- **`permission-helper-go` 0.2.0 → 0.3.0** (closes bugs `20260527-8d20ea22` and `20260527-8d20ea22-2`). The Go binary's strict-equality `SchemaVersion` check rejected every v1.1 spec the agent emitted starting in core 3.7.3 — the entire `inherit:false` machinery had never executed end-to-end in production despite shipping. 0.3.0 accepts both v1.0 and v1.1 spec formats (v1.0 + the v1.1-only `inherit` field is rejected with a clear validation error), threads the optional `op.Inherit` field through the apply codepath to a Drive `Files.Update` with `InheritedPermissionsDisabled:true` *before* creating the explicit grant, and writes an atomic outcome JSON file (`<spec-basename>-outcome.json`) alongside the spec. Empirically verified in three layers: validation (4 scenarios), stub-apply (driver codepath exercised), and real-Drive apply (testproduction's account, v1.1 inherit:false → outcome=`applied`, `Files.Update` succeeded). Published as `github.com/agent-index/agent-index-permissions-binaries v0.3.0`. `infrastructure-directory.json` updated with new SHA256s and `min_required_version` bumped to `0.3.0`; org pin in `/org-config.json → binaries.permission-helper-go.version` bumped to `0.3.0` so `apply-updates` Phase 1 step 7 force-upgrades existing installs on next run.

- **`org-setup` 3.3.0 → 3.3.1 — corrected canonical setup-responses path** (closes the spec half of bug `20260527-8d20ea22-4`). Two call sites (Phase 4 step 4 and the upgrade flow step 3) previously referenced `/{collection}/collection-setup-responses.md` instead of the actual path `/{collection}/setup/collection-setup-responses.md`. Every `org-setup` run since the bug was introduced returned `PATH_NOT_FOUND` when trying to read the canonical, silently fell through without injecting org-mandated values, and wrote placeholder `setup-responses.md` files for affected capabilities. Future `org-setup` runs now read from the correct path and inject the values as designed.

- **`apply-updates` 3.7.0 → 3.7.1 — Phase 4.5 manifest-sync subroutine extended with step 9** (closes the data half of bug `20260527-8d20ea22-4`). `CURRENT_SUBROUTINE_REVISION` bumps from 2 to 3, which forces a full sweep on every existing install's first 3.7.6 apply-updates run. New step 9 reads the corrected-path canonical `/{collection}/setup/collection-setup-responses.md`, parses its `## Parameters` markdown section, compares against each installed capability's local `## Org-Mandated Parameters` section, and re-injects drifted values (or creates the section if the local file is a placeholder) while preserving member-defined values, role-suggested values, `setup_status` flags, comments, and YAML frontmatter untouched. Idempotent — no writes when there's no drift. Failure to read the canonical (`PATH_NOT_FOUND`, malformed YAML, etc.) skips the step for that collection with a notice; does NOT block the overall apply-updates flow.

- **`create-org` 3.1.0 → 3.1.1 — install-time ACL grants for root-level org-readable files** (closes the spec half of bug `20260527-8d20ea22-3`). New Step 4.5 grants `all@{org_domain}` reader on `/CLAUDE.md`, `/org-config.json`, and `/members-registry.json` immediately after they're written to remote. Uses direct `aifs_share` per the install-time bootstrap exception in `standards.md` (the admin running `create-org` has organizer authority on the new Shared Drive; helper-mediated review adds friction without adding safety in this context). Idempotent; safe to re-run after partial `create-org` completion. Failure surfaces an admin-actionable message about creating the all-members Google Group at the Workspace level.

- **`invite-member` 1.3.0 → 1.4.0 — Category B share-set extended with the three root-level org-readable files**. Complements `create-org` 3.1.1: new orgs get the grants at install time via `create-org`; new members invited to existing orgs get them in their onboarding spec. Pre-state reads (`claude_pre`, `orgconfig_pre`, `registry_pre`) added for the diff view; the example spec JSON updated with the three new share operations.

### Notes

- **Existing orgs created before 3.7.6:** the manual `/org-config.json` reader grant added 2026-05-27 (and the parallel `/CLAUDE.md` + `/members-registry.json` grants verified 2026-05-29) close the access gap for the existing `agent-index.ai` org. Future orgs get the grants automatically from `create-org` 3.1.1.
- **First 3.7.6 apply-updates impact:** the `CURRENT_SUBROUTINE_REVISION` bump means every existing install will see Phase 4.5 step 9 fire on first 3.7.6 apply-updates. For installs whose local `setup-responses.md` files are placeholders (the common case affected by bug `20260527-8d20ea22-4`), step 9 will create the missing `## Org-Mandated Parameters` section and populate it from canonical. Bounded latency: ~10–20 seconds added on first 3.7.6 apply-updates for a typical 7-collection / 45-capability install; subsequent runs are no-op.
- **Pre-publish rehearsal:** verified the four 3.7.6 spec changes via simulation tests against constructed inputs in a fresh `testproduction@agent-index.ai`-authenticated install. WS1 binary verified empirically against real Drive via testproduction's account. One spec-wording imprecision surfaced during the rehearsal (Phase 4.5 step 9 referenced an `org_mandated:` block that doesn't literally exist) and was tightened in place before publish.

---

## [3.7.5] — 2026-05-26 — companion follow-up to 3.7.4

Closes the remaining surface in bug `20260522-8d20ea22` that the 3.7.4 release intended to fix but didn't deliver end-to-end. 3.7.4 published the adapter and `org-setup` changes; gdrive 2.4.1 (published in update entry #028) corrected the Drive-API constraint regression introduced by 2.4.0; this release ships the third leg of the fix — `invite-member` 1.3.0 with the Category B direct-share grants. After 3.7.5, new non-admin onboarding actually works end-to-end. Existing non-admin members still need the one-time backfill runbook (`dev_source/backfill-non-admin-shares-3.7.4.md`).

### Fixed

- **`invite-member` 1.2.0 → 1.3.0 — Category B direct-share grants** (closes the gap in bug `20260522-8d20ea22` that 3.7.4 left open). The helper spec's share-set is now two categories:

  - **Category A (existing):** writer grants on the new member's private directory and shared-artifact directory.
  - **Category B (new):** direct READER grants for the new member on `/shared/` and on each user-facing entry in `org-config.installed_collections[]` (excluding `agent-index-core` and `agent-index-marketplace` infrastructure collections).

  Category B is what allows gdrive 2.4.1's drive-root fallback to surface those folders for non-Drive-members. Empirical two-account testing during the 2.4.1 cycle established that the all-members group's reader grants do NOT propagate to folder list-visibility through the Drive API, even when the group has reader on the parent. Group-mediated reads work for known file IDs; group-mediated listing does NOT. Direct shares are required.

  Per-share semantics: reader role; no `inherit: false`. For a fresh invite on an org with N user-facing installed collections, the spec contains 4 Category A operations + (1 + N) Category B operations.

### Notes

- **Existing non-admin members are NOT automatically backfilled by this release.** Runbook at `dev_source/backfill-non-admin-shares-3.7.4.md` walks the admin through it via the permission-change-helper (one Accept click per member). Run once after applying 3.7.5.
- **gdrive 2.4.1 was published independently as update entry #028** before this release; admins who applied #027 + #028 already have the corrected adapter. 3.7.5 only needs to broadcast the core changes.
- **Companion (out-of-band):** `agent-index-filesystem-gdrive` 2.4.1 (already published; see its CHANGELOG for the 2.4.0 → 2.4.1 post-mortem).
- **Verification:** empirical two-account test (`test-final.mjs`) ran as part of the 2.4.1 cycle. 13 of 13 ops pass with the adapter 2.4.1 + simulated Category B share. Real end-to-end verification of `invite-member` 1.3.0 happens when the admin invites a new test account after 3.7.5 lands.

### Bumped

- `invite-member` task 1.2.0 → 1.3.0 (Category B direct-share grants)
- All `*-manifest.json` `collection_version` fields bumped to 3.7.5

---

## [3.7.4] — <RELEASE_DATE> — "Closing the Loop"

Closes four gaps surfaced by 3.7.3's install-layer reliability work plus the non-admin onboarding blocker. After 3.7.4 every claim 3.7.3 made about end-to-end functionality is actually true. Scope decision recorded at `/shared/projects/core-improvements/decisions/2026-05-24-release-3.7.4-scope.md`.

### Fixed

- **Non-admin onboarding blocker** (closes bug `20260522-8d20ea22`, high severity, and bug `20260525-8d20ea22` — the 2.4.0 regression discovered during the rehearsal install). Three coordinated pieces verified empirically against two real accounts (Bill: Drive-member; testproduction: non-Drive-member):

  1. **Adapter (`agent-index-filesystem-gdrive` 2.4.1):** drops the broken `corpora: 'allDrives'` + `driveId` combination that 2.4.0 introduced (the Drive API rejects it: "driveId must be specified if and only if corpora is set to drive"). Adds `_detectDriveMembership()` (fail-open `drives.get` probe) and `_listParams()` helper that branches every `files.list` query — members get `corpora: 'drive'` + `driveId` (the pre-2.4.0 admin path); non-members get `corpora: 'user'` (no `driveId`). Adds a drive-root fallback in `_resolvePathToId`: when "in parents = `driveId`" returns 0 for a non-member, falls back to global name search with `corpora: 'allDrives'` (which DOES return entries the user has direct access to).

  2. **`invite-member`** — in 3.7.4 (1.2.0) ships only the welcome-email + Go-binary-path updates. The Category B direct-share grants that complete the non-admin onboarding fix were added as `invite-member` 1.3.0 in **core 3.7.5** (companion follow-up to gdrive 2.4.1), once the empirical two-account testing established that the all-members group's reader grants don't propagate to folder list-visibility through the Drive API. Without 1.3.0's direct-share grants, the adapter has nothing to find when it falls back to global name search at drive root. See the 3.7.5 entry above for full details.

  3. **`org-setup` 3.3.0:** catalog assembly rewritten to iterate `org-config.installed_collections[]` instead of `aifs_list('/')`. Defensive read semantics — if a collection's `collection.json` can't be read, the entry is skipped with a notice rather than halting bootstrap.

  **Existing non-admin members need a one-time backfill.** Runbook at `dev_source/backfill-non-admin-shares-3.7.4.md`. Walk: in a Claude session, ask Bill to "run the 3.7.4 non-admin shares backfill"; Claude reads org-config, iterates non-admin members, and invokes the permission-change-helper for each (one review page per member). Three members × ~9 shares per member on Bill's current org = three Accept clicks.

  **Process change from the 3.7.4 retro:** any change touching gdrive `files.list` query parameters or `drives.get` MUST run the two-account empirical suite before the version bump. The 2.4.0 incident shipped because mechanical verification (bundle contains the right strings) passed while the API constraint was untested; the verification gap was the cost. Going forward this is non-negotiable for adapter releases.

- **Node permission-helper removed** (closes bug `20260522-8d20ea22-2` via removal and implements idea `remove-node-permission-helper-fallback`). The `lib/permission-helper/` source tree is deleted; the Go binary at `mcp-servers/permission-helper-go/` (installed by `apply-updates` Phase 1 step 7 since core 3.4.0) is now the only permission-helper implementation. `apply-updates` Phase 1 step 6 — previously the Node-helper install — is replaced by an orphan-cleanup step that removes the local `mcp-servers/permission-helper/` directory on existing installs. Skill spec, setup spec, `invite-member`'s `external_dependencies`, and `standards.md` § "Permission-Modifying Operations" all updated to Go-binary-only language. Rationale per Bill: "We shouldn't be maintaining multiple solutions for exactly this reason."

- **`publish-updates` org-config writeback regression** (closes bug `20260522-8d20ea22-4`). Pre-3.7.4 the spec described the writeback to `org-config.installed_collections[]` as a sub-section inside Step 5, but a precisely-conflicting Constraints line forbade ALL `org-config.json` writes; the agent correctly hit the contradiction and the writeback never ran. 3.7.4 rewrites the Constraints section with a precisely-scoped write surface list (only `/shared/updates/*`, `/shared/bootstrap/member-bootstrap.zip`, and `/org-config.json`'s `installed_collections[]` + `agent_index_version` fields per Step 6), promotes the writeback to a clearly-named Step 6 with subsections 6a (per-operation `installed_collections[]` writeback), 6b (new top-level `agent_index_version` writeback), and 6c (one-time backfill prompt on detected drift). Drift source for `agent_index_version` backfill comparison: `published-state.infrastructure["agent-index-core"]` (verified pre-build; no schema change to published-state). `publish-updates` 3.4.0 → 3.5.0.

- **Apply-updates manifest-sync subroutine no longer cross-references the deleted Phase 1 step 6.** The LF-normalization mechanic — previously borrowed by reference from the Node-helper-install step's normalization — is now inlined directly into the subroutine step 4. Self-contained; no future caller has to trace back to a step that no longer exists. `apply-updates` 3.6.0 → 3.7.0.

### Added

- **Allowlist failure-mode recognition pattern** (implements section D of idea `allowlist-failure-mode-warnings-in-tasks`). New "Allowlist failure recognition" section in `collection-authoring-guide.md` documents the detection heuristic (HTTP 403 with empty body + no upstream headers, OR connection-refused, OR connection-timeout) and the canonical error message format. `publish-updates` Step 0a (when invoked with `--check-upstream`) gets an error-path branch for the GitHub-fetch surface. Marketplace 2.7.0 ships parallel branches for `refresh-marketplace-cache`, `download-collection`, `download-and-install-collection`, and `check-updates`. (SP5 originally listed `apply-updates` Phase 0 and `install-collection`; neither does HTTP fetches — both operate on `aifs_*` over the remote filesystem. Substituted `publish-updates` Step 0a as the actual upstream-fetch surface.)

### Notes

- **Verification cycle:** the initial WS1 build (which shipped as adapter 2.4.0) could not run the two-account empirical test from the build session — no OAuth credentials available there — and shipped on mechanical bundle verification only. The bundle was API-rejected on first use during the rehearsal install (bug `20260525-8d20ea22`). The corrected adapter 2.4.1 + invite-member 1.3.0 + the design realization that direct shares are required (not just adapter changes) all came from running the two-account test with real credentials uploaded into the build session. **13 of 13 ops pass** in `test-final.mjs` against the patched adapter (Bill: 6/6; testproduction baseline + with direct share: 7/7).
- **Transitional ordering for new non-admin members:** after applying 3.7.4, admins should run `@ai:publish-updates` to reconcile any `installed_collections[]` drift (the writeback bug fixed in this release will fire the new one-time backfill prompt) before inviting new non-admin members. The defensive read semantics in `org-setup` Phase 3 ensure new-member onboarding doesn't halt on stale entries, but the prompt-and-backfill closes the gap properly.
- **Companion releases:** marketplace 2.7.0 (allowlist failure branches in 4 tasks); filesystem-gdrive **2.4.1** (non-admin onboarding adapter fixes — supersedes the broken 2.4.0; see gdrive CHANGELOG for the empirical-test details and the post-mortem on 2.4.0's API constraint regression); client-intelligence 1.1.1 (V1 data-floor doc correction — `inherit: false` resolves immediate-parent leak but NOT ancestor leak; new idea `data-visibility-floor-ancestor-leak` files the real-fix design options for 3.8.0+); developer 1.4.0 (preflight Check 8 for `inherit: false` against pre-2.0 adapters).
- **Two new ideas filed** during release prep: `data-visibility-floor-ancestor-leak` (real fix for bug `-3`, three design options captured); `preflight-bundle-vs-config-drift-detection` (the "manifest claims, implementation discards" recurring pattern — explicitly deferred from 3.7.4 to keep theme crisp).
- **Process changes applied universally** per the 3.7.3 retro: cross-component dependency verification step caught three issues pre-build (Check 8 bash logic conflated `adapter_version` with `contract_version`; TD4 referenced a non-existent "Step 4a"; TD4's `agent_index_version` writeback assumed a published-state field that doesn't exist). All resolved before build kicked off.

### Bumped

- `apply-updates` task 3.6.0 → 3.7.0 (Phase 1 step 6 swap; LF-normalization inlining)
- `publish-updates` task 3.4.0 → 3.5.0 (Step 6 split + writeback fix + backfill prompt)
- `permission-change-helper` skill 1.1.0 → 1.2.0 (Go-binary-only)
- `permission-change-helper-setup` 1.0.0 → 1.1.0
- `org-setup` skill 3.2.2 → 3.3.0 (catalog assembly rewrite)
- `invite-member` task 1.1.0 → 1.2.0 (welcome-email access-model paragraph + Go-binary path references). NOTE: the Category B direct-share grants that gdrive 2.4.1 depends on shipped as `invite-member` 1.3.0 in **core 3.7.5** (follow-up release).
- All `*-manifest.json` `collection_version` fields bumped to 3.7.4

---

## [3.7.3] — 2026-05-20 — "Install-Layer Reliability"

Theme: fix the three problems a new admin most reliably hits on day one. Three tightly-coupled work-streams: allowlist reconciliation + setup-time verification; permission-helper trust-contract realignment + inherit passthrough; Phase 4.5 filesystem-drift detector. Decision record: `/shared/projects/core-improvements/decisions/2026-05-20-release-3.7.3-scope.md`.

### Fixed

- **Allowlist gap closed.** `codeload.github.com` is now in the canonical host list (closes bug `20260515-8d20ea22`). Every admin previously hit a proxy 403 the first time `download-and-install-collection` ran. The host list, previously duplicated and drifting across three prose surfaces (create-org.md Step 3b, marketplace's refresh-marketplace-cache.md, and marketplace's collection-setup.md), is now centralized as data in `agent-index-core/templates/network-allowlist.template.json` (closes idea `setup-time-network-allowlist-verification` sections A–C; section D — failure-mode warnings in execution-time tasks — deferred to follow-up idea `allowlist-failure-mode-warnings-in-tasks`).

- **`permission-change-helper` realigned with the standards.md trust contract.** Pre-3.7.3 the skill's Step 4 told the agent to invoke the Go binary directly (`<go-binary> <spec-path>`) — collapsing the safety boundary that the URL-scheme architecture exists to maintain. In the wild, this surfaced as the client-intelligence Step 8 ACL grant flow emitting a copy-paste-to-terminal CLI string instead of the canonical `agent-index://apply` markdown link (closes bug `20260519-8d20ea22`). Steps 4–7 are rewritten (now Steps 4–8) so the agent emits the markdown link plus a code-fenced URL fallback for clients that strip custom-scheme links (e.g., current Cowork desktop). The user's deliberate click on the link is the privileged-call entry point; the binary writes a structured outcome JSON the agent reads after the user reports completion. `standards.md` § "Trust contract for the agent in the URL-handler invocation flow" gets the code-fence emission as a normative requirement; the preflight positive check that verifies the dual emission is documented.

- **Phase 4.5 drift sweep no longer blind to filesystem state.** Bug `20260519-8d20ea22-2` (Layer 1) — Phase 4.5 trusted `manifest_sync` versions and `manifest_sync_subroutine_revision` revisions but never verified files were actually on disk in the canonical install layout. On installs that pre-dated the dual-write contract, 41 of 45 capabilities lived only at the legacy path; the detector saw nothing wrong. Phase 4.5 step 4 now also runs a parallel `aifs_stat` sub-check across each capability's canonical anchor file (`installed/{type}/{name}/{name}.md`); missing anchors mark the collection as drifted regardless of `manifest_sync` value. The existing subroutine then runs and (per its current step 5) dual-writes to both legacy and canonical paths, backfilling the missing canonical anchors. On the first 3.7.3 apply-updates run for any install with stranded capabilities, the sweep surfaces a per-collection notice and backfills automatically (estimated ~30–60 seconds added latency on a typical install). Layer 2 — explicit subroutine step 9 + `CURRENT_SUBROUTINE_REVISION` bump for verifiable canonical-layout backfill — is deferred to 3.8.0 alongside the capability-provider runtime's final layout decisions (tracked as follow-up idea `phase-4-5-canonical-layout-backfill`). Bug stays `acknowledged` until Layer 2 ships.

### Added

- **Permission-helper spec v1.1 — `inherit: boolean` field on share operations.** Optional, default `true` (backward-compatible with v1.0 specs). When `false`, the share is applied as an explicit override — the recipient sees only this resource, not parent-folder inherited grants. Enables the data-visibility floor on instance contents that client-intelligence 1.1.0 (companion release) activates for per-instance ACLs. The corresponding adapter implementation lives in gdrive 2.3.0 (companion release). The applying user must have `organizer` role on the Shared Drive (or `owner` on My Drive) to set `inherit: false`; non-organizer applications surface a clean `AccessDeniedError`. validate.js accepts the new field; apply.js threads it through to `aifs_share`; the helper page renders an inline override-inheritance annotation in the diff visualization. Closes the spec-plumbing portion (sections 1–3) of idea `helper-spec-needs-inherit-passthrough`. Section 4 (preflight check for `inherit: false` against pre-contract-2.0 adapters) deferred — stays in parent idea. Section 5 (authoring guide entry) cross-referenced from `authoring-guide-pattern-catalog`.

- **New task `@ai:verify-network-allowlist`** (`agent-index-core/api/verify-network-allowlist.md`). Standalone re-runnable reachability check; iterates the canonical host list, surfaces blocked hosts with `purpose` annotations and actionable allowlisting instructions. Useful after allowlist changes or to diagnose install failures. Natural-language triggers: "verify network allowlist", "check my allowlist", "is my network configured", "test network reachability".

- **`create-org` Step 3b rewrite.** Now reads `templates/network-allowlist.template.json` and iterates all entries with `tested_by: "setup-time-reachability-check"` (the previous spec said "at minimum test raw.githubusercontent.com" and only tested one). Tests every infrastructure host, telemetry host (if `log_collector_url` set), and backend host (canonical-file entries when enumerated, otherwise dynamic from adapter `required_domains`). Surfaces exactly which hosts are blocked with their `purpose` annotations. Supports `--skip-network-check` for air-gapped or unusual setups.

### Notes

- **Versions:** `agent-index-core` collection 3.7.2 → 3.7.3. `apply-updates` task 3.5.0 → 3.6.0 (Phase 4.5 step 4.1/4.2 added). `create-org` task 3.0.2 → 3.1.0 (Step 3b rewrite). `permission-change-helper` skill 1.0.0 → 1.1.0 (Steps 4–8 rewrite, `inherit` field). `verify-network-allowlist` task new at 1.0.0. All API manifests' `collection_version` bumped to 3.7.3.
- **Companion releases:** `agent-index-marketplace` 2.5.0 → 2.6.0 (allowlist message extensions in `refresh-marketplace-cache.md` and `setup/collection-setup.md`; `refresh-marketplace-cache` task 2.0.0 → 2.1.0). `agent-index-filesystem-gdrive` 2.2.2 → 2.3.0 (`share()` actually implements `inherit: false` via `inheritedPermissionsDisabled` — see adapter CHANGELOG for details). `agent-index-marketplace-client-intelligence` 1.0.0 → 1.1.0 (caller activation of `inherit: false` in `create-client` and `grant-permission`; resolves V1 data-visibility-floor limitation).
- **Follow-up ideas filed** in core-improvements: `allowlist-failure-mode-warnings-in-tasks` (allowlist idea section D), `remove-node-permission-helper-fallback`, `phase-4-5-canonical-layout-backfill` (bug `20260519-8d20ea22-2` Layer 2), `legacy-install-layout-removal` (consolidation migration prerequisite of Layer 2). Existing idea `helper-spec-needs-inherit-passthrough` updated with partial-implementation status (sections 1–3 implemented; sections 4–5 deferred).

---

## [3.7.2] — 2026-05-13

### Fixed

- **`apply-updates` 3.4.1 → 3.5.0: Phase 3 now syncs `agent-index.json`'s `remote_filesystem.exec.adapter_version` with the freshly-installed `mcp-servers/filesystem/adapter.json` `version`** (closes idea `bundle-vs-config-adapter-drift`). Pre-3.5.0 Phase 3 wrote the new adapter bundle + adapter.json but didn't update the denormalized `adapter_version` field in `agent-index.json`. Result: the two files could drift indefinitely — bundle gets refreshed every adapter-bundle-update, the config field stays at install-time value. Downstream code that reads `agent-index.json` to gate behavior on the adapter version would make wrong decisions. New step 3 in Phase 3 parses the just-installed `adapter.json` and rewrites `agent-index.json` to match. Idempotent (same-value no-op).

- **`remove-member` 1.0.1 → 1.1.0: now revokes the explicit member-directory grants `invite-member` created** (closes bug `20260513-8d20ea22-3`). New Step 2.5: build a permission-change spec with `unshare` ops for the two grants `invite-member` is known to have applied (writer on `/members/{hash}/` and `/shared/members/artifacts/{hash}/`), hand it to the permission-change-helper, surface the `agent-index://apply?spec=...` URL, admin reviews and accepts, helper applies via OAuth-as-self, post-state verified. Symmetric with `invite-member`. Bounded scope: only the two grants `invite-member` is known to have created; broader ACL cleanup (project/idea grants) still falls to Workspace IT per the existing checklist. Constraints section revised to permit this specific revocation while preserving the "never walk the broader ACL graph" rule.

- **`view-audit` 1.0.0 → 1.1.0: replaces non-functional Drive Activity URLs with working folder URLs + admin audit URLs** (closes bug `20260513-8d20ea22-2`). The previous URL pattern `https://drive.google.com/drive/activity/?fileId={file_id}` returned 404 — Google never exposed a public direct URL for the per-file Activity feed. v1.1.0 surfaces two working paths instead: (a) the folder/file URL (`https://drive.google.com/drive/folders/{id}` or `https://drive.google.com/file/d/{id}/view`) plus instructions to click the info icon → Activity tab in the Drive UI; and (b) for admins only, the org-wide Workspace audit URL (`https://admin.google.com/ac/reporting/audit/drive`) for cross-resource forensic queries. The "v2.0 will surface filtered activity inline" promise stays.

- **`permission-helper/validate.js` cleaned of trailing debris**. The canonical source at `lib/permission-helper/validate.js` had ~16 lines of botched-write debris (duplicate `applyExclusions` definition, second `module.exports`, stray fragment `esent, must be a boolean.` from an earlier draft) past the legitimate file end at line 146. The corrupt file was being copied to every member's local install via apply-updates Phase 1 step 6, breaking the Node permission-helper fallback. v3.7.2 ships the cleaned version; Step 0 sync will push it to remote; the next `@ai:update` for every member will rewrite the local file with clean content.

### Notes

- All API manifests' `collection_version` bumped 3.7.1 → 3.7.2. `apply-updates` task 3.4.1 → 3.5.0. `remove-member` task 1.0.1 → 1.1.0. `view-audit` task 1.0.0 → 1.1.0.
- Companion releases: `agent-index-marketplace` 2.4.0 → 2.5.0 (contract-version-aware surfacing in check-updates). `agent-index-marketplace-bug-reports` 1.1.0 → 1.2.0 (view-bugs reconcile-on-read closes `20260513-8d20ea22`). `agent-index-marketplace-developer` 1.3.0 → 1.3.1 (preflight-cli JS-integrity heuristic catches the validate.js debris class).

---


## [3.7.1] — 2026-05-12

### Fixed

- **`apply-updates` 3.4.0 → 3.4.1: Phase 4.5 sentinel-trigger fix** (closes bug `20260512-8d20ea22`). The 3.7.0 release added step 7 to the manifest-sync subroutine (reconcile `member-index.installed[].version` with the `.md` frontmatter version). The intent was for the first 3.7.0 apply-updates run on a 3.6.x install to sweep all installed collections and apply the new step. It didn't work for installs with already-populated `manifest_sync` (from a 3.6.1+ backfill where values matched `org-config.installed_collections`) — the outer drift detector classified all collections as "synced" and the subroutine never ran. Same structural pattern as bug `20260511-8d20ea22` (Phase 4.5 unreachable from per-collection-update loop): the outer trigger doesn't know about new subroutine steps.

  The fix introduces a `CURRENT_SUBROUTINE_REVISION` constant (currently `2` for the 3.7.0 step-7 shape) and a `manifest_sync_subroutine_revision[<collection>]` tracking field in `member-index.json`. Phase 4.5 now classifies a collection as drifted if `manifest_sync` is missing OR mismatched OR if the recorded revision is less than the current constant. Future subroutine-step additions just bump the constant; the trigger fires automatically on existing installs the next time they apply-updates. Belt-and-suspenders against the structural bug class.

- **`publish-updates` 3.3.0 → 3.4.0: writes back to `org-config.installed_collections[]`** (closes bug `20260512-8d20ea22-2`). Pre-3.4.0 publish-updates wrote the update-log entry, published-state snapshot, and latest.json pointer — but never updated `org-config.installed_collections[]` for infrastructure (core / marketplace) version bumps. The entries advanced only for marketplace-collection installs via `install-collection`. Result: the org's record of "what's installed" drifted from the actual collection.json versions on remote across every infrastructure release. Surfaced as "version mismatch" notes in `check-updates` reports. Also broke the 3.7.0 Phase 4.5 drift detector, which used `installed_collections[X].version` as the "should be synced to" target — with stale data, drift detection was unreliable.

  The fix: after the update-log + state + latest writes succeed, publish-updates now also reads `org-config.json`, walks the new entry's operations, and updates `installed_collections[]` entries to reflect the new `target_version` and `upgraded_date` (for upgrades) or adds/marks-removed entries (for installs / removes). Writes are idempotent. Failure here does NOT roll back the update-log entry — log is authoritative; org-config drift is recoverable on the next publish.

### Notes

- All API manifests' `collection_version` bumped 3.7.0 → 3.7.1. `apply-updates` task version 3.4.0 → 3.4.1. `publish-updates` task version 3.3.0 → 3.4.0. No other tasks changed.
- Companion data-shape change: `member-index.json` gains a `manifest_sync_subroutine_revision` object (sibling to `manifest_sync`). Pre-3.7.1 installs treat its absence as "revision 0" everywhere, which triggers a one-time sweep across every installed collection on the first 3.7.1 apply-updates run. For Bill's install — which already had a manual one-shot reconcile of `installed[].version` done out-of-band — this sweep is effectively a no-op (the subroutine writes the same values that are already there) but advances the recorded revision to 2, closing the bookkeeping loop.

---


## [3.7.0] — 2026-05-11

### Added

- **`apply-updates` 3.3.1 → 3.4.0: Edge Cases section restored and extended.** The `apply-updates.md` Edge Cases section was truncated mid-word at "(log was truncated or rebui" across every commit in the file's history — a long-standing documentation gap. 3.7.0 restores the missing tail and adds five new edge-case specifications: cursor pointing at a missing log entry (reset-vs-advance disambiguation), authentication failure mid-Phase-1, partial Phase 4 failure (cursor non-advancement and per-collection success tracking), network errors during Step 0 / Step 5, Phase 2/3 split-success semantics, Phase 4.5 with missing `installed_collections[]`, and the admin-publishing-their-own-update case. Closes idea `apply-updates-edge-cases-tail-restoration`. The Constraints section is also consolidated and extends to make the Phase 1 step 5 strip the documented exception to the "never modify org-level remote files" rule.

- **`apply-updates` 3.3.1 → 3.4.0 + `org-setup` 3.2.1 → 3.2.2: member-index `installed[].version` drift fix.** Two-pronged. (a) Spec clarification in `org-setup.md` — Phase 4 step 11 (install flow) and Upgrading flow step 9 now explicitly say "use the `.md` frontmatter version, not the collection version" when writing the per-capability `version` field in `member-index.json`. Historically this was ambiguous and the agent often wrote the collection-level version, producing the "44 local ahead of remote" rows in `check-updates` reports. (b) Data repair in `apply-updates.md` — the Phase 4.5 manifest-sync subroutine (introduced in 3.6.1) gains a new step 7 that also reconciles `member-index.installed[].version` with the freshly-read `.md` frontmatter version for every capability synced. On the first 3.7.0 apply-updates run, the subroutine's drift detection treats every collection as drifted (because the data shape changes), runs the sweep, and reconciles all 44 entries in one pass. Subsequent runs no-op.

- **Admin disambiguation for ambiguous "check for updates" routing** (`CLAUDE.md.template`). The natural-language phrase "check for updates" maps to two distinct intents — member-apply (`apply-updates`) and admin-available (`check-updates` in marketplace) — that look identical from the surface but answer different questions. The routing layer now surfaces a one-question clarifying prompt for admins issuing ambiguous phrases, presenting both options and routing the response. Non-admins always route to `apply-updates`; explicit `@ai:update` / `@ai:check-updates` aliases bypass the prompt. Closes idea `check-updates-admin-disambiguation`.

### Notes

- All API manifests' `collection_version` bumped 3.6.1 → 3.7.0. `apply-updates` manifest 3.3.1 → 3.4.0. `org-setup` manifest 3.2.1 → 3.2.2.
- Companion release: `agent-index-marketplace` 2.3.0 → 2.4.0 (adds the Available-to-Install section to `check-updates`). `agent-index-marketplace-developer` 1.2.4 → 1.3.0 (ships `lib/preflight-cli.js`, the runnable preflight CLI used by 3.7.0's push script as a mandatory pre-step).
- The Phase 4.5 subroutine extension means the first 3.7.0 apply-updates run does N capability writes per drifted collection — bounded, idempotent, surfaced in the per-cap progress output.

---


## [3.6.1] — 2026-05-11

### Fixed

- **`apply-updates` 3.3.0 → 3.3.1: hoist `manifest_sync` drift-detection sweep out of Phase 4's per-collection-update loop into a new unconditional Phase 4.5** (closes bug `20260511-8d20ea22`). The 3.6.0 spec placed the manifest_sync drift check inside Phase 4 step 3.5, which only fires when an apply-updates batch contains a `collection-update` operation. The 3.6.0 release itself shipped only `core-update` and `marketplace-update` operations, so the very upgrade that introduced the feature couldn't trigger its own backfill — every installed collection's local files stayed at the pre-3.6.0 versions and `manifest_sync` never got populated. The 3.6.1 fix extracts the file-content sync mechanics into a standalone subroutine, calls it from both Phase 4 step 3.5 (per-collection-update, same semantics as 3.6.0) AND from a new Phase 4.5 that runs unconditionally on every apply-updates invocation. Phase 4.5 reads `org-config.json` once, compares `installed_collections[].version` against `member-index.json`'s `manifest_sync` map, and invokes the subroutine for any collection that's missing or drifted. On a no-op run the cost is one remote read; on a drifted run it's bounded by the number of out-of-sync collections × capabilities each.

### Notes

- Bill's dev_install hit the bug as the first install to apply 3.6.0. A one-shot backfill script (`backfill-manifest-sync.js` in the outputs scratch dir) was run manually to recover; 7 collections / 45 capabilities synced, `manifest_sync` populated. The 3.6.1 release ships the spec fix so the next install upgrading from 3.5.x → 3.6.1 (or beyond) gets the backfill automatically.
- All API manifests' `collection_version` bumped 3.6.0 → 3.6.1. `apply-updates` task version 3.3.0 → 3.3.1. No other tasks changed.

---

## [3.6.0] — 2026-05-07

### Fixed

- **`apply-updates` Phase 4: file-content sync (closes bugs `20260502-8d20ea22-5` + `20260507-8d20ea22`).** Pre-3.6.0 Phase 4 bumped `member-index.json`'s recorded versions when a collection upgrade landed, but didn't actually rewrite the local `.md`, `-setup.md`, or `-manifest.json` files. Bookkeeping advanced; file content silently drifted. Two surfaces of the same gap: (a) `.md` content stale relative to the recorded version (caught when preflight self-diagnosed at v1.1.0 while the dashboard said v1.2.2), and (b) `manifest.json` `version` and `collection_version` fields trailing the canonical source by N patches across 50 capability manifests in the typical install. New sub-step 3.5 in Phase 4: for every capability the member has installed from the upgraded collection, read three files from remote (`{name}.md`, `{name}-setup.md`, `{name}-manifest.json`) and write to the member-local install path(s) with LF normalization. Sync `manifest.json` `version` (from frontmatter) and `collection_version` (from upgraded `collection.json`). Granular per-collection tracking via a new `manifest_sync: { "<collection>": "<version>", ... }` map in `member-index.json` — `apply-updates` detects drift between this map and `installed_collections[].version` and re-syncs. Subsumes a separate "one-time backfill" pattern: the first 3.6.0 apply-updates run sees every collection as drifted (no `manifest_sync` field yet), syncs everything, then `manifest_sync` is populated and subsequent runs only sync collections that actually changed. Also more robust than a single boolean gate — partial-failure recovery is automatic (the entry doesn't advance, next run retries).

- **`apply-updates` Phase 1 step 5: extended to also strip the misplaced `exec` block from `org-config.json`** (closes bug `20260502-8d20ea22-3`). The `mcp_server` strip shipped in 3.3.1; the parallel `exec` strip ships now. Pre-3.6.0 the `create-org` template incorrectly wrote the adapter exec block to `org-config.json` (the v3 location for that block is `agent-index.json → remote_filesystem.exec`, not `org-config.json`). Existing installs created on pre-3.6.0 templates have a duplicate `exec` block that was unread at runtime but persisted as a footgun. The new strip is non-destructive: only removes the block from `org-config.json`; leaves `agent-index.json`'s correct `exec` block alone.

### Changed

- **`create-org` 3.0.1 → 3.0.2** — template no longer writes the misplaced `exec` block to `org-config.json`. New orgs get a clean `org-config.json` from the start. Inline comment in the template explains where the exec block belongs (`agent-index.json`). Same fix in `org-config-schema.json`'s example; schema now also carries an inline note documenting the gdrive credentials inline-vs-split exception (closes bug `20260506-8d20ea22`).

- **`collection-authoring-guide.md` "OAuth credential split pattern" section** — adds a "Documented exception" note explaining why filesystem-backend credentials (currently `gdrive`) are inline in `org-config.json` rather than split out under `/org-config/apps/{app}/credentials.json` like every other OAuth-using collection. Reason: bootstrap order — the filesystem must authenticate before any `aifs_*` path resolves. This was a real source of confusion for collection authors; the guide now names the exception explicitly. (Also closes bug `20260506-8d20ea22`.)

- **`apply-updates` task 3.2.0 → 3.3.0** — new Phase 4 sub-step 3.5; extended Phase 1 step 5 strip; Phase 1 step 4 simplified (legacy collection-template fallback retired); Phase 1 step 5 legacy-template cleanup paragraph removed (no longer needed; see workspace-marker Phase 2 below).

- **`publish-updates` task 3.2.0 → 3.3.0 — Step 0 source-tree skip-list applied symmetrically across upload AND delete decisions.** Pre-3.3.0 the binary/swap/OS-metadata skip-list was only applied to the upload-side classification; remote-only files matching those patterns were still flagged as deletion candidates. The asymmetry surfaced 2026-05-07 during a publish run on dev_install: Step 0 proposed deleting two leftover `.exe` files from remote even though Step 0 itself wouldn't have uploaded them. The fix hoists the skip-list into a shared filter applied to both sides — Step 0 is a source-tree sync, and non-source files (binaries, OS metadata, editor scratch, ephemeral test files) are out of scope in both directions. Skip-list also extended with two new patterns: `test_*.{txt,md,json}` and `tmp_*` — common scratch artifacts that admins shouldn't be prompted to upload. (Closes idea `publish-updates-step0-symmetric-filters`.)

- **workspace-marker-vs-collection-template Phase 2.** The legacy collection-template file `agent-index-core/agent-index.json` is retired in 3.6.0 (Phase 1 in core 3.4.0 introduced the canonical template path `agent-index-core/templates/agent-index.template.json` with cleanup-on-upgrade in apply-updates Phase 1 step 5; Phase 2 removes the now-obsolete fallback paths and the legacy file itself). Three concrete changes: (a) `dev_source/agent-index-core/agent-index.json` deleted from source — `publish-updates` Step 0 will surface this as a remote-only deletion on the next publish; (b) `apply-updates` Phase 1 step 4 no longer falls back to the legacy path when reading the canonical template (single read at `templates/agent-index.template.json`); (c) the cleanup-on-upgrade paragraph in Phase 1 step 5 is removed, since post-3.4.0 installs already had the cleanup run on first-touch. The Go binary's `workspaceRoot()` defensive workaround is retained — it costs nothing and protects against any future tool that walks up looking for a workspace marker.

- **Pre-existing frontmatter drift cleanup** — preflight on this release surfaced four `.md` frontmatter values that had drifted out of sync with their `*-manifest.json` siblings across earlier releases. Brought into alignment now because the new Phase 4 sub-step 3.5 (which we are shipping in this same release) derives `manifest.json.version` from `.md` frontmatter — leaving the drift unfixed would have caused the 3.6.0 sync to silently overwrite (correct) manifest versions with (stale) frontmatter values. Files brought to consistency: `agent-index-core/api/edit-org.md` (3.0.1 → 3.0.2 to match manifest), `agent-index-core/api/publish-updates.md` (3.0.0 → 3.2.0 to match manifest), `agent-index-core/api/pin-binary-version.md` (added missing `version: 1.0.0` and `name:` field to non-standard frontmatter shape), `agent-index-marketplace/api/check-updates.md` (2.1.2 → 2.2.1 to match manifest). No semantic behavior changes — just the bookkeeping caught up.

### Migration notes

3.6.0's first apply-updates run on a pre-3.6.0 install does extra work: walks every installed collection's capabilities, reads 3 files per capability from remote, writes them locally. For a typical 7-collection / ~45-capability install that's ~135 `aifs_read` calls plus the corresponding writes — bounded and idempotent (gated on `member-index.json` → `manifest_sync` per-collection entries). Subsequent apply-updates runs only sync collections that actually changed. Same chicken-and-egg shape as 3.4.0/3.5.0: 3.6.0 itself ships through the existing 3.5.0 publish-updates flow; subsequent releases use the now-fixed Phase 4 logic end-to-end.

---

## [3.5.0] — 2026-05-05

### Added

- **`publish-updates` 3.2.0 — `--check-upstream` flag (Step 0a).** Fetches the latest infrastructure source from GitHub before scanning local. For each entry in `infrastructure-directory.json` → `infrastructure[]` whose `current_version > local_version`, prompts the admin to pull (per-entry confirmation, `--all` shortcut for power users), downloads the entry's `zip_url` over HTTPS, extracts to the local source tree (preserving `.git/`, applying LF normalization), then hands off to existing Step 0 scan-and-upload. Closes the manual `git pull` step from the admin's mental model — the entire release flow becomes one verb.

- **`publish-updates` 3.2.0 — smart prerequisite detection (Steps 0b + 0c).** Walks the file-level diff Step 0 produced and uses a lookup table to infer (a) which prerequisites must run before publish (currently: bootstrap-zip regen) and (b) which CHANGELOG entry types should be added (`core-update`, `marketplace-update`, `adapter-bundle-update`, `claude-md-update`, `members-registry-update`, `org-config-update`). Triggers on twelve file-path patterns covering bundle changes, CLAUDE.md, members-registry, the bootstrap-affecting subset of `org-config.json` fields, and per-collection api/manifest changes. Surfaces the aggregated picture for admin Y/N approval, then runs prerequisites as sub-steps. Closes bug `20260504-8d20ea22-6` (publish-updates intelligence). Closes most of the `admin-upstream-upgrade-flow` idea (the `upgrade-collection` for marketplace collections is the remaining sliver).

- **Shared `regenerate-bootstrap` subroutine** at `agent-index-core/templates/regenerate-bootstrap.md`. The bootstrap-zip regeneration procedure (formerly inlined in `edit-org` Step 5) is now a reusable text snippet referenced by both `edit-org` and the new `publish-updates` Step 0c. Takes `<project_dir>`, `<source-trigger>`, `<allow-skip>` parameters. Includes deterministic content hashing for skip-if-unchanged behavior, post-upload all-members re-share verification, and `published-state.json` `bootstrap_content_hash` tracking.

- **`check-updates` 2.2.1 — admin "what to do" guidance updated.** Where infrastructure or adapter upgrade rows surface to admins, the suggested next-step is now `@ai:publish-updates --check-upstream` rather than the pre-3.5.0 manual `git pull → @ai:edit-org → @ai:publish-updates` ritual. Pre-3.5.0 path retained as a fallback for admins who want to inspect the bundle before publishing.

### Changed

- **`edit-org` Step 5 simplified.** The "Regenerate and redistribute bootstrap zip" sub-section now references the shared subroutine at `agent-index-core/templates/regenerate-bootstrap.md` rather than duplicating the procedure inline. Behavior unchanged for callers; the source is just deduplicated.

### Migration notes

3.5.0 itself ships through the pre-3.5.0 release flow (manual `git pull` + the publish-updates Step 0 sync that landed in 3.4.0). Subsequent releases (3.6.0+) use `@ai:publish-updates --check-upstream` end-to-end. This is the same chicken-and-egg pattern as 3.4.0's publish-updates Step 0.

---

## [3.4.0] — 2026-05-05

### Added

- **Native Go permission-helper binary v0.2.0** (`lib/permission-helper-go/`) — production-quality reimplementation of the Node helper. Statically-linked single executable per platform (no Node on PATH required). Real `google.golang.org/api/drive/v3` integration with OAuth refresh, path resolution piggy-backing on the gdrive adapter's `path-cache.json`, typed errors mapped from Drive API codes (`permission_denied`, `not_found`, `rate_limited`, `drive_unavailable`). Same wire protocol, same review page, same trust contract as the Node helper. Implements the canonical Drive-native field form (lowercase roles `reader`/`commenter`/`writer`, `subject` for recipient identifiers in `before.recipients`).

- **Custom URL scheme handler `agent-index://`** — chat-side review links route directly to the binary via the OS handler. Per-platform registration (no admin/root rights required): Windows registry keys under `HKCU\Software\Classes\agent-index`, macOS `.app` bundle with `CFBundleURLSchemes`, Linux `.desktop` file with `MimeType=x-scheme-handler/agent-index`. `--register`/`--unregister` flags wired up, per-platform installers under `lib/permission-helper-go/installer/{windows,darwin,linux}/`.

- **Binary distribution architecture (registry + org pin + member-side reconciliation):**
  - `infrastructure-directory.json` extends with a `binaries[]` array — registry of native tools with `current_version`, `min_required_version` (security floor), `release_url_template`, per-platform `filename` + `sha256`, `install_destination`, `post_install_command`.
  - `org-config.json` extends with `binaries{}` — per-binary `version` + `policy` (`pinned`/`latest`/`min`), set by admins. Convergent: rollback is just changing the pin.
  - `apply-updates.md` Phase 1 step 7 — new flow that reads registry + org pin, compares against locally-installed version, prompts user with download summary (URL, target version, SHA256 fingerprint), verifies SHA256 on download, installs atomically, runs `post_install_command`. Trust contract: every binary download requires explicit user Y/N approval; SHA256 mismatch is a hard abort.
  - `check-updates.md` Step 2.6 — surfaces binary update availability alongside core/marketplace updates.
  - **`pin-binary-version` admin task** — single-purpose task to set or clear binary version pins in `org-config.json`. Validates against directory's `min_required_version`. Convergent semantics support clean rollback.

- **`permission-change-helper` skill prefers Go binary, falls back to Node helper** — detects which is installed at `mcp-servers/permission-helper-go/agent-index-show-plan{ext}`, invokes that if present; else falls back to existing `mcp-servers/permission-helper/show-plan.sh`. Same exit codes, same JSON status report shape from both implementations. Node helper kept as fallback for orgs not yet opted into the binary registry.

- **`--validate-only` flag in Go binary** — reads + parses + validates a spec without prompts, listener, or Drive calls. Useful for CI / dev sanity checks.

- **`publish-updates` 3.0.0 → 3.1.0 — Step 0 scan-and-upload** (closes bug `20260504-8d20ea22-6` partially: the upload half). Pre-3.4.0 publish-updates only wrote a CHANGELOG entry; it did not push the admin's local infrastructure files to remote. Admins had to copy them manually. As of 3.4.0, publish-updates Step 0 walks the local `agent-index-core/` and `agent-index-marketplace/` directories, hashes every file, compares against remote, and prompts the admin to upload differs/new + delete remote-only files. LF-normalized for shell scripts. Idempotent: re-runs on a fully-synced install do nothing. Power-user `--no-sync` flag skips Step 0 if files were already pushed via a script. Closes the admin's typical `git pull → publish-updates` flow without intermediate manual file copying. The fetch-from-upstream half (`--check-upstream` flag) is deferred to a future release per the `admin-upstream-upgrade-flow` idea.

- **Trust contract addition in `standards.md`** — codifies the do/don't list for binary downloads (registry-derived URLs only, mandatory SHA256 verification, user approval gating, no auto-run of post-install commands outside `apply-updates`).

- **Phase 1 of agent-index.json template disambiguation** — added `agent-index-core/templates/agent-index.template.json` (canonical workspace-bootstrap template). Legacy `agent-index-core/agent-index.json` kept at remote for one release for migration safety; removed in 3.5.0. `apply-updates` Phase 1 step 4 reads new path with fallback to legacy path on NOT_FOUND. `apply-updates` Phase 1 step 5 deletes the local copy of the legacy collection-template file (it confuses any tool that walks up looking for the workspace marker). The Go binary's `workspaceRoot()` includes a defensive `collection.json` sibling-skip workaround in case the cleanup hasn't run yet.

### Changed

- **`infrastructure-directory.json` `directory_version` 1.0.6 → 1.1.0** — schema extension for `binaries[]`. Backwards-compatible: pre-3.4.0 consumers ignore the new top-level field.
- **`agent-index-marketplace` 2.1.2 → 2.2.0** — added `check-updates` Step 2.6 (binary update surfacing).

### Fixed

- **Canonical Drive-native form propagated** through Node validator (`validate.js`), Go validator (`validate.go`), both page templates (`templates/page.html`), apply-script stub helpers, tech design (`permission-change-helper-tech-design.md`), helper skill (`permission-change-helper.md`), and `invite-member.md` example. Prior to 3.4.0 the codebase carried both title-case (`Reader`/`Commenter`/`Writer`) and lowercase forms, plus both `email` and `subject` field names in `before.recipients`. Now uniform: lowercase roles only, `subject` only — matching the Drive API and `aifs_get_permissions` output exactly.

### Migration notes

This release changes how native tools are distributed. The Node helper continues to ship and work; existing installs can keep using it. To switch to the Go binary:

1. After 3.4.0 lands, an admin runs `@ai:pin-binary-version permission-helper-go 0.2.0` to declare the version the org should run.
2. Members run `@ai:apply-updates`. Phase 1 step 7 surfaces "permission-helper-go 0.2.0 available, not installed" and prompts for download. On Y, the binary is downloaded from `agent-index/agent-index-permissions-binaries`, SHA256-verified, installed at `mcp-servers/permission-helper-go/`, and `--register` is run to wire up the URL scheme handler.
3. Subsequent `permission-change-helper` skill invocations prefer the Go binary; chat-side `agent-index://...` links are now clickable.

The Node helper remains available as a fallback. To roll back the org from Go to Node: `@ai:pin-binary-version permission-helper-go --remove`. Members keep their installed binary but the skill stops flagging updates.

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
