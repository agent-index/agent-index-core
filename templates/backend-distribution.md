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

## Publish flow (admin side — create-org Phase 2, publish-updates)
Precondition (process-enforced): the admin's local clones are present and at the expected release tag. **Refuse to publish if any clone is behind its tag** (don't silently push a stale version to members).
1. For each directory file (from the local `resource-listings` clone) and the backend binary (from the admin's host, staged by the clone script): compute SHA-256.
2. **Diff against the current backend `manifest.json`** — upload only artifacts whose SHA changed (or are new). For each upload, **read back and verify the stored SHA** (catches the mount-truncation/torn-write class on large binaries — `shell-first` + verify + retry).
3. Rewrite `manifest.json` with the new `org_release_tag`, artifact SHAs, and collection versions; verify it reads back + parses.
4. Bake the current backend binary into `/shared/bootstrap/member-bootstrap.zip` when it changed (so first-time members get it without any fetch).
Idempotent: an unchanged artifact is a no-op; safe to re-run after a partial failure.

## Read + verify contract (member side — apply-updates, check-updates, member-bootstrap)
1. `aifs_read("/shared/dist/manifest.json")` **first** — this is the authority.
2. To use a directory or binary: `aifs_read` it from `/shared/dist/<path>`, compute SHA-256, **compare to the manifest entry; refuse to use it on mismatch** (surface a clear "backend artifact corrupt/stale — ask your admin to re-publish"). Never fetch the artifact from GitHub.
3. Binary specifically: `aifs_read` the bytes (base64) → write to the host-mounted `install_destination` **shell-first + verify** (large file; mount-truncation risk) → member runs `--register` once. On first bootstrap the binary instead comes from the unpacked bootstrap zip (no read needed).

## GitHub fallback — DEPRECATED (Release C)
If `/shared/dist/` (or a needed artifact) is absent — only on a not-yet-migrated org — tasks MAY fall back to the legacy GitHub fetch, but must emit a one-line **deprecation warning** ("This org hasn't adopted backend distribution; the GitHub path is deprecated and will be removed — ask your admin to re-publish via `@ai:update`/`publish-updates`"). New installs (incl. customer B) always have `/shared/dist/` and never use the fallback. Removal targeted for the release after C.

## Cross-backend
- The directory JSONs are small — trivial on both SharePoint and gdrive.
- The **binary via aifs** is the new, large, per-adapter path (base64; ~1.5 MB onedrive / ~10 MB gdrive; SharePoint vs Drive large-file semantics differ). Publish-side upload-and-verify and member-side read-and-place must both be tested on **both** backends (ms-install-7).

<!-- AIFS:FILE-END -->
