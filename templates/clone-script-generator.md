# Subroutine: clone-script-generator

**Type:** shared subroutine (Release C). Generates a host-native, tag-pinned, idempotent **clone-or-pull script** the admin runs to populate their local clones and the permission-helper binary. Invoked by `create-org` (initial), `install-collection` (add a collection), and `apply-updates`/upgrade (move the org to a newer release). It is **regenerated every time the org's installed set or target version changes** — recurring by design (see Release C tech design doc 29 §1a). The git protocol it uses is NOT the rate-limited GitHub raw/REST path, so this is the sanctioned way to get files onto the admin's machine.

## Why this exists
Members must never read from github.com (stale-cache + rate-limit class — Jeff, ms-install-5, ms-install-6). The admin is the only GitHub touchpoint, over `git` + one binary download. This subroutine produces the script that does that, deterministically (tag-pinned) and idempotently (clone-or-pull, re-runnable).

## Inputs
- `host_os` — `windows` | `darwin` | `linux` (detected from the running environment; determines PowerShell vs bash output and the binary platform/filename).
- `host_arch` — `amd64` | `arm64`.
- `install_root` — absolute path to the admin's `agent-index/` folder (the repos are cloned as siblings under it; the running session is pointed here).
- `backend` — `onedrive` | `gdrive` (selects the adapter repo and the binary build).
- `repos[]` — each `{ name, git_url, tag }`. The standard set:
  - **initial (create-org):** `agent-index-core` (already cloned — pin it to the tag too), `agent-index-filesystem-<backend>`, `agent-index-marketplace`, `agent-index-resource-listings`, plus any selected collection repos.
  - **add (install-collection):** just the collection repo(s) being added, at the org's current tag.
  - **update (apply-updates/upgrade):** the repos moving to a new tag.
- `binary` (optional; include whenever the helper isn't already installed+current, and always on initial): `{ release_url, filename, sha256, install_destination, version }` resolved from `agent-index-resource-listings/infrastructure-directory.json` for `backend` + `host_os`/`host_arch`. Omit on an update where the pinned binary version is unchanged.

## Tag pinning
Every repo is checked out to a **version tag** (`v<repo-version>` — e.g. core `v3.18.0`, marketplace `v2.13.0`, a collection at its own version). The same instruction therefore yields the same bytes on every machine. The org records the resulting version **set** in `org-config.json` / `/shared/dist/manifest.json` (`org_release_tag` headline + per-artifact versions). Never pin to a branch (`main`) — that's the non-reproducible failure Release C exists to remove.

## Generated script behavior (same logic, per-OS syntax)
For each repo in `repos[]`:
1. If `<install_root>/<name>/.git` exists → `git -C <name> fetch --tags --depth=1 origin <tag>` then `git -C <name> checkout <tag>`. Else → `git clone --depth=1 --branch <tag> <git_url> <name>`.
2. Verify HEAD is at `<tag>` after; abort that repo loudly on mismatch (don't leave a half-checked-out tree).

If `binary` is present:
3. Download `release_url` → `<install_root>/<install_destination>` (host download; not the raw/REST API).
4. Compute SHA-256 of the downloaded file; **if it ≠ `sha256`, delete it and abort** (no install on mismatch — same security rule as apply-updates' binary reconcile).
5. Write `version` to the binary's `version.txt`.
6. Run `<binary> --register` (registers the `agent-index://` handler under HKCU on Windows / the per-user scheme handler on mac/linux). **This is folded in here so the binary never needs a separate script.**

The script is **idempotent**: re-running clone-or-pulls to the same tag, re-verifies the binary (skips re-download if the local SHA already matches), and re-registers harmlessly.

## After the admin runs it (caller responsibility)
The invoking task (`create-org`/`install-collection`/`apply-updates`) then:
- Confirms the clones are present and at the expected tags (refuse to proceed on a missing/behind clone — process-enforced, not "please remember").
- **Diffs the local clone against the backend and re-publishes only what changed** (diff + hash-verify): collections → their remote trees; the directories + binary → `/shared/dist/` + `manifest.json`; the bootstrap zip if the bundle or binary moved.

## Output format
- **windows** → a `.ps1` written to `<install_root>/.agent-index/clone-<purpose>-<tag>.ps1`, surfaced to the admin to run in PowerShell.
- **darwin/linux** → a `.sh` written to the same dir, surfaced to run in a shell.
Each script is self-contained, prints a clear per-repo / binary status line, and exits non-zero on any abort so the admin (and the calling task) can tell it failed.

## Notes
- The adapter repo's bundle is consumed from the clone by the caller (compute the checksum on the **git-blob LF bytes**, not the working-tree copy — Windows checkout converts LF→CRLF and breaks the SHA; ms-install-6).
- Shallow clone (`--depth=1`) keeps it light; the binary repo is NOT cloned (its built assets are GitHub Release assets, fetched by the `binary` block above, not present in the git tree).
- This subroutine GENERATES a script; it does not itself fetch anything. The admin runs the script on the host. The agent never downloads the binary into the sandbox (it can't get intact bytes there — ms-install-6).

<!-- AIFS:FILE-END -->
