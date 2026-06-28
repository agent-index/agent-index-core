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
  binaries/
    agent-index-show-plan-<backend>-<version>-<os>-<arch>[.exe]   # the org's backend builds
```

## manifest.json schema
```json
{
  "schema": "dist-manifest/1",
  "org_release_tag": "v3.18.0",            // headline (core version); per-repo versions in artifacts[]
  "generated_at": "<ISO>",
  "generated_by": "<admin member_hash>",
  "artifacts": [
    { "path": "directories/infrastructure-directory.json", "type": "directory", "sha256": "…" },
    { "path": "directories/filesystem-adapter-directory.json", "type": "directory", "sha256": "…" },
    { "path": "directories/marketplace-directory.json", "type": "directory", "sha256": "…" },
    { "path": "binaries/agent-index-show-plan-onedrive-0.5.0-windows-amd64.exe",
      "type": "binary", "version": "0.5.0", "backend": "onedrive", "os": "windows", "arch": "amd64", "sha256": "…" }
  ],
  "collections": [ { "name": "agent-index-core", "version": "3.18.0" }, { "name": "projects", "version": "4.0.0" } ]
}
```
`manifest.json` — not GitHub HEAD — is the answer to "what version is this org on, and is my copy correct." `check-updates` compares the member's installed state against it; `apply-updates`/`member-bootstrap` fetch artifacts by `path` and verify `sha256` before use.

## Canonical SHA-256 (MANDATORY — read this before computing any manifest SHA)
The manifest SHA and the member's verification SHA **must be byte-identical**, or the integrity gate rejects every member (the `manifestsha` failure: a manifest recorded `412094b4…` while members hashing the stored bytes got `e1d549e4…`). The mismatch came from hashing **shell-captured `aifs_read` stdout, which appends a trailing newline**, instead of the artifact's stored bytes. The canonical rule, applied **identically on both the publish side and the member side**:

> **Hash exactly the artifact's stored bytes — the `size` bytes reported by `aifs_stat` — never shell-captured stdout.** Text directory files are LF-normalized on upload (publish-updates Step 0), so the stored bytes equal the local clone's **git-blob LF bytes**.

Concrete, deterministic recipe (no trailing-newline ambiguity):
- **Publish side (admin has the local clone):** hash the local file's bytes directly — `sha256sum < "<file>"` (redirected stdin, NOT `cat | sha256sum` and NOT command-substitution), or for a text artifact the git-blob form `git show HEAD:"<path>" | sha256sum` (matches the LF bytes that get uploaded — same method already used for the adapter bundle, create-org Step 3c-1d). Do **not** compute the SHA from `aifs_read` output.
- **Member side (verification):** `s=$(aifs_stat <path>)` → take its `size`; `aifs_read` the artifact to a file and `head -c <size>` it (truncating any shell-appended trailing byte) before `sha256sum`. Truncating to the stat `size` is what makes the member hash equal the stored-byte hash regardless of how the shell framed stdout.
- **Binaries:** use the **host-reported SHA** printed by the infra clone script (never re-hash a large binary through the sandbox mount — `binmountstale`); the host SHA is the manifest value.

Both sides MUST follow this. A publish that computed the SHA any other way will be rejected by a correct member verifier.

## Publish flow (admin side — create-org Phase 2, publish-updates)
Precondition (process-enforced): the admin's local clones are present and at the expected release tag. **Refuse to publish if any clone is behind its tag** (don't silently push a stale version to members).
1. For each directory file (from the local `resource-listings` clone) and the backend binary (from the admin's host, staged by the clone script): compute SHA-256 **per the Canonical SHA-256 rule above** (stored/git-blob LF bytes for directories; host-reported SHA for the binary). Never hash `aifs_read` stdout.
2. **Diff against the current backend `manifest.json`** — upload only artifacts whose SHA changed (or are new). For each upload, **read back and verify the stored SHA** using the canonical member-side recipe (stat `size` + `head -c` truncation) so the value written to the manifest is provably what a member will compute (catches the mount-truncation/torn-write class on large binaries AND the trailing-newline class — `shell-first` + verify + retry).
3. Rewrite `manifest.json` with the new `org_release_tag`, artifact SHAs, and collection versions; verify it reads back + parses. **Round-trip self-check:** after writing, re-verify at least the `infrastructure-directory.json` entry via the member-side recipe and confirm it matches the value just written — if it doesn't, the publish computed the SHA wrong; abort and fix rather than shipping a manifest members will reject.
4. Bake the current backend binary into `/shared/bootstrap/member-bootstrap.zip` when it changed (so first-time members get it without any fetch).
Idempotent: an unchanged artifact is a no-op; safe to re-run after a partial failure.

## Read + verify contract (member side — apply-updates, check-updates, member-bootstrap)
This gate is **mandatory and must actually run** — historically `check-updates`/`apply-updates` compared version numbers but never hashed the artifacts, so the integrity property the model promises did not exist (`shagateunimplemented`). Implement it:
1. `aifs_read("/shared/dist/manifest.json")` **first** — this is the authority.
2. To use a directory or binary: `aifs_read` it from `/shared/dist/<path>`, compute SHA-256 **per the Canonical SHA-256 rule (stat `size` + `head -c` truncation)**, **compare to the manifest entry; refuse to use it on mismatch** (surface a clear "backend artifact corrupt/stale — ask your admin to re-publish via `@ai:update`"). Never fetch the artifact from GitHub. Do not silently downgrade a mismatch to a version-only check.
3. Binary specifically: `aifs_read` the bytes (base64) → write to the host-mounted `install_destination` **shell-first + verify** (large file; mount-truncation risk) → member runs `--register` once. On first bootstrap the binary instead comes from the unpacked bootstrap zip (no read needed).

## GitHub fallback — DEPRECATED (Release C)
If `/shared/dist/` (or a needed artifact) is absent — only on a not-yet-migrated org — tasks MAY fall back to the legacy GitHub fetch, but must emit a one-line **deprecation warning** ("This org hasn't adopted backend distribution; the GitHub path is deprecated and will be removed — ask your admin to re-publish via `@ai:update`/`publish-updates`"). New installs (incl. customer B) always have `/shared/dist/` and never use the fallback. Removal targeted for the release after C.

## Cross-backend
- The directory JSONs are small — trivial on both SharePoint and gdrive.
- The **binary via aifs** is the new, large, per-adapter path (base64; ~1.5 MB onedrive / ~10 MB gdrive; SharePoint vs Drive large-file semantics differ). Publish-side upload-and-verify and member-side read-and-place must both be tested on **both** backends (ms-install-7).

<!-- AIFS:FILE-END -->
