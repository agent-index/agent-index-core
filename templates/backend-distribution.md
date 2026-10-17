# Subroutine: backend-distribution

**Type:** shared subroutine (Release C). Defines the org-backend distribution layer: the `/shared/dist/` layout, the `manifest.json` schema (the org's version authority), the **publish** flow (admin side — `create-org`, `publish-updates`), and the **read+verify** contract (member side — `apply-updates`, `check-updates`, `member-bootstrap`). Members read everything here; **never** from github.com.

## Layout
```
/shared/dist/
  manifest.json            # the org version authority (tag set + per-artifact SHAs)
  directories/
    infrastructure-directory.json
    filesystem-adapter-directory.json
    marketplace-directory.json
```
There is no `binaries/` folder since core 4.0.0 (the permission helper was removed). publish-updates deletes a leftover `/shared/dist/binaries/` from older orgs (its Step 6.5).

## manifest.json schema
```json
{
  "schema": "dist-manifest/2",
  "org_release_tag": "v3.18.0",            // headline (core version); per-repo versions in artifacts[]
  "channel": null,                         // core 3.32.0: null = released code; else the org's distribution channel
  "channel_head": null,                    // channel orgs: a string "channel/<name>@<sha7>", e.g. "channel/dev-2@3f9c2ab"
  "sources": { "agent-index-core": { "ref_type": "tag", "ref": "v3.18.0", "commit": "…", "version": "3.18.0" } },  // from .agent-index/clone-resolution.json
  "generated_at": "<ISO>",
  "generated_by": "<admin member_hash>",
  "artifacts": [
    { "path": "directories/infrastructure-directory.json", "type": "directory", "sha256": "…" },
    { "path": "directories/filesystem-adapter-directory.json", "type": "directory", "sha256": "…" },
    { "path": "directories/marketplace-directory.json", "type": "directory", "sha256": "…" }
  ],
  "collections": [ { "name": "agent-index-core", "version": "3.18.0" }, { "name": "projects", "version": "4.0.0" } ]
}
```
**`dist-manifest/2` (core 3.32.0, distribution channels):** adds `channel`, `channel_head` and `sources{}` (one entry per published repo, copied from the admin's `.agent-index/clone-resolution.json`: `ref_type`, `ref`, `commit`, `version`). Readers MUST accept `/1` (no channel fields = released code). **`channel_head` is a single string, never an object (finding 77):** `"channel/<name>@<sha7>"` — the channel branch, `@`, and the first 7 hex characters of the core clone's `clone-resolution.json` `repos["agent-index-core"].commit` (e.g. `"channel/dev-2@3f9c2ab"`); `null` when `channel` is null. The per-repo ref/commit detail belongs in `sources`, not in `channel_head`. Since core 4.0.0 every `artifacts[]` entry is `type: "directory"`; readers ignore any leftover `type: "binary"` entry in an older manifest. Members' session-start banner reads `channel` (via the local mirror). `sources` serves audit and the live-test runbook's build check.

**`collections[]` source (core 3.31.0 — bug `20260924-8d20ea22-015603-a4ac`):** one entry per `org-config.json` → `installed_collections[]` entry with `status: "installed"`, carrying **that entry's `version`** — the version the org actually has on its backend. **Never** a catalog `current_version`: the catalog says what is *available*, the manifest says what the org *runs*. Before writing, assert every `collections[]` version equals the org-config version and the published-state version; abort on any mismatch. (Publish #076 took email-triage's catalog version 1.2.3 while the org ran 1.2.2, so members were told a version whose files were not on the backend.)

**Who rewrites the manifest (finding 74).** Only `create-org` Step 11 and `publish-updates` Step 6.5 write `manifest.json`. In publish-updates, published-state is written in Step 5, before 6.5, so it matches org-config and the assert holds. create-org Step 11 runs before Step 11.6 seeds published-state from the same org-config, so there the assert compares against org-config only. Tasks that change installed collections outside a publish — `download-collection`, `install-collection`, `upgrade-collection` — **do not republish `/shared/dist/`**: a collection they just installed or upgraded isn't in published-state until the next publish, so the assert would abort, and the manifest says what has been *published to members*, which that collection hasn't been yet. They tell the admin to run `@ai:publish-updates`, whose Step 6.5 brings the manifest up to date along with the update-log entry that tells members about the change.

`manifest.json` — not GitHub HEAD — is the answer to "what version is this org on, and is my copy correct." `check-updates` compares the member's installed state against it; `apply-updates`/`member-bootstrap` fetch artifacts by `path` and verify `sha256` before use.

## Canonical SHA-256 (MANDATORY — read this before computing any manifest SHA)
The manifest SHA and the member's verification SHA **must be byte-identical**, or the integrity gate rejects every member (the `manifestsha` failure: a manifest recorded `412094b4…` while members hashing the stored bytes got `e1d549e4…`). The mismatch came from hashing **shell-captured `aifs_read` stdout, which appends a trailing newline**, instead of the artifact's stored bytes. The canonical rule, applied **identically on both the publish side and the member side**:

> **Hash exactly the artifact's stored bytes — the `size` bytes reported by `aifs_stat` — never shell-captured stdout.** Text directory files are LF-normalized on upload (publish-updates Step 0), so the stored bytes equal the local clone's **git-blob LF bytes**.

Concrete, deterministic recipe (no trailing-newline ambiguity):
- **Publish side (admin has the local clone):** hash the local file's bytes directly — `sha256sum < "<file>"` (redirected stdin, NOT `cat | sha256sum` and NOT command-substitution), or for a text artifact the git-blob form `git show HEAD:"<path>" | sha256sum` (matches the LF bytes that get uploaded — same method already used for the adapter bundle, create-org Step 3c-1d). Do **not** compute the SHA from `aifs_read` output.
- **Member side (verification):** `s=$(aifs_stat <path>)` → take its `size`; `aifs_read` the artifact to a file and `head -c <size>` it (truncating any shell-appended trailing byte) before `sha256sum`. Truncating to the stat `size` is what makes the member hash equal the stored-byte hash regardless of how the shell framed stdout.

Both sides MUST follow this. A publish that computed the SHA any other way will be rejected by a correct member verifier.

## Publish flow (admin side — create-org Phase 2, publish-updates; no other caller)
Precondition (process-enforced): the admin's local clones are present and at the refs `.agent-index/clone-resolution.json` records (release tags; on a channel org, `channel/<name>` heads where the branch exists, release tags elsewhere, which is legitimate fallback). **Refuse to publish when the record's channel differs from org-config `distribution_channel`** (publish-updates Step 1's channel consistency check), and when a clone is missing. Don't silently push a stale or mixed set to members.
1. For each directory file (from the local `resource-listings` clone): compute SHA-256 **per the Canonical SHA-256 rule above** (stored/git-blob LF bytes). Never hash `aifs_read` stdout.
2. **Diff against the current backend `manifest.json`** — upload only artifacts whose SHA changed (or are new). For each upload, **read back and verify the stored SHA** using the canonical member-side recipe (stat `size` + `head -c` truncation) so the value written to the manifest is provably what a member will compute (catches the mount-truncation/torn-write class AND the trailing-newline class — `shell-first` + verify + retry).
3. Rewrite `manifest.json` with the new `org_release_tag`, `channel`/`channel_head`/`sources` (from the resolution record), artifact SHAs, and collection versions; verify it reads back + parses. **Round-trip self-check:** after writing, re-verify at least the `infrastructure-directory.json` entry via the member-side recipe and confirm it matches the value just written — if it doesn't, the publish computed the SHA wrong; abort and fix rather than shipping a manifest members will reject.
Idempotent: an unchanged artifact is a no-op; safe to re-run after a partial failure.

## Read + verify contract (member side — apply-updates, check-updates, member-bootstrap)
This gate is **mandatory and must actually run** — historically `check-updates`/`apply-updates` compared version numbers but never hashed the artifacts, so the integrity property the model promises did not exist (`shagateunimplemented`). Implement it:
1. `aifs_read("/shared/dist/manifest.json")` **first** — this is the authority.
2. To use a directory: `aifs_read` it from `/shared/dist/<path>`, compute SHA-256 **per the Canonical SHA-256 rule (stat `size` + `head -c` truncation)**, **compare to the manifest entry; refuse to use it on mismatch** (surface a clear "backend artifact corrupt/stale — ask your admin to re-publish via `@ai:update`"). Never fetch the artifact from GitHub. Do not silently downgrade a mismatch to a version-only check.

## GitHub fallback — DEPRECATED (Release C)
If `/shared/dist/` (or a needed artifact) is absent — only on a not-yet-migrated org — tasks MAY fall back to the legacy GitHub fetch, but must emit a one-line **deprecation warning** ("This org hasn't adopted backend distribution; the GitHub path is deprecated and will be removed — ask your admin to re-publish via `@ai:update`/`publish-updates`"). New installs (incl. customer B) always have `/shared/dist/` and never use the fallback. Removal targeted for the release after C.

## Cross-backend
- The directory JSONs are small — trivial on both SharePoint and gdrive.

<!-- AIFS:FILE-END -->
