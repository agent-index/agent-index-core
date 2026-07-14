# Subroutine: clone-script-generator

**Type:** shared subroutine (Release C; reworked in C.1). Generates a host-native, tag-pinned, idempotent **clone/pull + binary script** the admin runs natively. Invoked by `create-org` (initial), `install-collection` (add a collection), and `apply-updates`/upgrade (move the org to a newer release). Regenerated every time the org's installed set or target version changes — recurring by design.

**C.1 invariant — the agent makes ZERO GitHub calls.** All GitHub access lives inside the scripts this subroutine generates: the **git protocol** (`git ls-remote`, `git clone`/`fetch`) and the signed binary's **release-asset** download. The agent never fetches `raw.githubusercontent.com` or the REST API to resolve versions, collections, or the binary — that path produced stale versions and a wrong-backend binary in ms-install-7 (`staleversionpins`, `binwrongbackend`). Version/availability facts come only from `git ls-remote` and the freshly-cloned listings.

## Two modes

This subroutine emits one of two scripts depending on the caller's phase:

- **`infra` mode** (create-org Step 3c-1; apply-updates infra reconcile): clones the infrastructure set — `agent-index-core` (already cloned; pin it to the tag too), `agent-index-filesystem-<backend>`, `agent-index-marketplace`, `agent-index-resource-listings` — and resolves + downloads + verifies + registers the **backend-matched signed helper binary**. Emits **no** collection clones. This is what makes the authoritative `marketplace-directory.json` available locally so create-org can run its collection-selection interview.
- **`collections` mode** (create-org Step 3c-3; install-collection): clones only the selected collection repos at their tags. No infra, no binary.

The two-script split exists because collection selection is an **interactive** decision and the catalog only exists after the resource-listings clone (infra mode) lands. A single script can't pause for the interview.

## Inputs
- `mode` — `infra` | `collections`.
- `host_os` — `windows` | `darwin` | `linux` (detected; selects PowerShell vs bash and the binary platform/filename).
- `host_arch` — `amd64` | `arm64`.
- `install_root` — absolute path to the admin's `agent-index/` folder (repos are siblings under it).
- `backend` — `onedrive` | `gdrive` (infra mode: selects the adapter repo AND the binary build).
- `repos[]` — each `{ name, git_url }`. **No `tag` field is supplied** — the script resolves the tag itself via `ls-remote` (see Tag discovery). Standard sets:
  - **infra:** core, `agent-index-filesystem-<backend>`, marketplace, resource-listings.
  - **collections:** the selected collection repo(s).

The binary is **not** an input. In infra mode the generated script resolves it from the freshly-cloned `agent-index-resource-listings/infrastructure-directory.json` (see Binary resolution) — this is the fix for `binwrongbackend`/`staleversionpins`: nothing about the binary or versions is known to the agent ahead of the clone.

## Version resolution — DIFFERENT per mode (C.1.1)

The two repo classes ship differently and MUST be resolved differently (ms-install-8 `colltags`):
- **Infrastructure repos** (infra mode: core, adapter, marketplace, resource-listings) are **release-tagged** → pin to the highest `v*` tag.
- **Collection repos** (collections mode) are **NOT tagged** — they ship from the default branch (`main`), versioned via `current_version` in the marketplace directory → clone the default branch and pin the exact **HEAD commit**.

### Infra repos — tag-pinned (single-tag safe)
1. `git ls-remote --tags --refs <git_url>` → parse `refs/tags/v*`.
2. **Pick the highest semver — in ARRAY context.** A repo with exactly one tag is the common case (the adapter ships a single `v2.2.1`). In PowerShell, `(… | Sort-Object …)[-1]` on a single match returns a **scalar string**, so `[-1]` then indexes the last **character** (`"1"`) and git tries to clone branch "1" (`singletag`, ms-install-8). The generated script MUST force array context — `@(… | Sort-Object {[version]($_ -replace '^v')} )[-1]`, or `… | Select-Object -Last 1` — so a one-tag repo still yields the whole tag string. (Same hazard in bash is absent, but emit the equivalent guard for parity.)
3. **Clone, or update-in-place with a clean checkout (J2, `clonescriptdirty`).** If the dir does not exist: `git clone --depth=1 --branch <tag> <git_url> <name>`. **If the dir already exists, pre-clean before checkout** — a previously-checked-out tree is routinely "dirty" vs the LF-committed blobs on Windows (autocrlf rewrites line endings on checkout — `crlfcheckout`; see `.gitattributes` note below), and a leftover `index.lock` from an interrupted run blocks git entirely. So the generated script MUST, for an existing dir, run: remove `<name>/.git/index.lock` if present → `git -C <name> fetch --tags --depth=1` → `git -C <name> reset --hard` (discard working-tree drift — these are pristine source clones; the tag content supersedes anything local) → `git -C <name> checkout <tag>` (or `reset --hard <tag>`). Then verify HEAD is at `<tag>`.
   - **Continue past a single repo's failure — do NOT exit the whole script (`clonescriptdirty`, ms-install rollout).** Wrap each repo so a clone/checkout failure records the repo + reason and moves to the **next** one; print a per-repo summary at the end (`N ok, M failed: <names>`) and exit non-zero only if any failed. Before C.1.3.2 the script exited on the first repo's error, leaving the rest (marketplace/adapter/listings) untouched and forcing a manual `reset --hard` rescue.
4. **No blanket `main` fallback — discriminate zero-tag branch-HEAD repos from phantoms (`clonescripttagassumption`, preserves `tagnofallback`).** When a repo exposes no matching `v*` tag, the emitted script MUST NOT assume every untagged repo is an error, and MUST NOT silently pull `main`. It decides per repo, using the **same three-way discrimination as Check 12** in `agent-index-marketplace-developer/lib/preflight-cli.sh`:
   - **A tag `v{version}` (or any `v*` tag) exists** → check it out (pin to the highest tag as in steps 1-3; unchanged).
   - **The repo has ZERO tags AND the freshly-cloned default-branch `collection.json` (or `adapter.json`) `version` equals the requested/cataloged version** → this is a legitimate **branch-HEAD distribution** (some repos ship from default-branch HEAD with the version carried in `collection.json`, e.g. `agent-index-marketplace-brand-book`). Check out the default branch and report **SUCCESS** — the emitted status line MUST read like `cloned at main@<sha> (branch-HEAD distribution, no release tags)`, NOT a failure.
   - **The repo HAS tags but not the requested `v{version}`** (or has zero tags but the cloned `collection.json` version does NOT match the cataloged version) → **fail loudly** (`ERROR: no release tag found for <name>`) — this is a real phantom / never-released version (`tagnofallback`, ms-install-7). Do NOT fall back to `main`. A genuinely untagged infra release with no branch-HEAD version match is an upstream release bug.
   The emitted PowerShell (and bash) MUST implement this three-way branch per repo — do not collapse it back to a bare `checkout v{version}` that fails loud on every untagged repo.

### Collection repos — default-branch, HEAD-SHA pinned
Collections have no release tags by design (`colltags`). For each selected collection repo:
1. `git clone --depth=1 <git_url> <name>` (default branch — do NOT pass `--branch v*`; there is no tag, and requiring one is the bug).
2. Record the exact pinned commit: `git -C <name> rev-parse HEAD` → report `OK clone <name> at <branch>@<sha>`. The HEAD SHA is the reproducibility anchor (the org records it; `current_version` from `marketplace-directory.json` is the human-facing version).
3. Verify `collection.json` is present after clone; abort that collection loudly if not.

## Binary resolution (infra mode only — backend-matched, from the fresh clone)
After the resource-listings repo is cloned at its tag, the generated script — not the agent — resolves and installs the helper:

1. Read `<install_root>/agent-index-resource-listings/infrastructure-directory.json` (the just-cloned, authoritative copy).
2. Select the `binaries[]` entry whose **`backend` equals the org `backend`** (`permission-helper-go` for gdrive, `permission-helper-go-onedrive` for onedrive). **Never** install the wrong-backend build — that is `binwrongbackend`.
3. From that entry, resolve the version from **`current_version`** (NOT `version` — the directory field is `current_version`; reading the wrong field yields an empty string and a broken `.../download/v//...{version}` URL — `binfield`, ms-install-8), the `platforms[]` row matching `host_os`/`host_arch` (`filename`, `sha256`), and the `release_url_template`. Substitute `{version}` into BOTH the `release_url_template` and the `filename` **before** assembling the URL (the template embeds `{version}` in the filename too).
4. Download the release asset to a path under `install_destination`. **On Windows PowerShell 5.1, force TLS 1.2 first** — `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12` — because PS 5.1 defaults to TLS 1.0, which GitHub's download CDN rejects with "The connection was closed unexpectedly" (`tls12`, ms-install-8). The directory binary entry's **`signing`** field says what to expect: `"trusted"` ⇒ the asset is code-signed (Windows Authenticode; macOS Developer ID + notarized) and the `sha256` pins the signed bytes; `"unsigned-bypass"` ⇒ the asset is intentionally unsigned while certs are pending, so a host block at launch/register (Windows Smart App Control) is **expected** and the generated script should print the SAC Evaluation-mode workaround (SIGNING.md) rather than treating it as a failure. Either way the `sha256` pins the actual published bytes — verify it.
5. Compute SHA-256 of the download; **if it ≠ the directory `sha256`, delete it and abort** (no install on mismatch).
6. Write `version` to the binary's `version.txt`.
7. **Register, per platform (`post_install` is now per-platform — see infrastructure-directory schema):**
   - **windows:** place the signed `.exe` at `install_destination`; run `<binary> --register` (HKCU URL-scheme handler).
   - **linux:** place the binary; run `<binary> --register` (writes `~/.local/share/applications/*.desktop` + `xdg-mime`).
   - **darwin:** the bare binary CANNOT register a URL scheme — macOS registers **bundles**. Run the shipped macOS installer (`installer/darwin/install.sh`, or expand the shipped `.app`/`.pkg`) which places the notarized `Agent-Index Helper.app` in `~/Applications/`, then registers via `lsregister`. Do NOT run `--register` against a bare file on darwin (that is the `macosregister` bug).
8. **Native-platform registration failure is a HARD error** — exit non-zero with an actionable message. (A Linux-sandbox registration of a Windows/Mac binary is NOT host registration; only the script running on the member's real host registers the host.)

## Output format & PowerShell hardening
- **windows** → a `.ps1` written to `<install_root>/.agent-index/<mode>-<purpose>.ps1`.
- **darwin/linux** → a `.sh` written to the same dir.

PowerShell emission rules (every one was a real failure — `clonescriptps1` in ms-install-7, then `singletag`/`tls12` in ms-install-8):
- **Judge success by `$LASTEXITCODE`, not by stderr.** `git` writes normal progress to stderr; do NOT set `$ErrorActionPreference = "Stop"` such that native-command stderr aborts the script. Redirect git's chatter (`2>$null` or capture) and check the exit code explicitly.
- **Emit NO apostrophes or single-quote characters inside string literals** (e.g. write "does not" not "doesn't"). An apostrophe in a message string broke the PowerShell parser mid-run. Prefer double-quoted, apostrophe-free wording.
- **Emit PURE ASCII — the generated `.ps1` MUST contain only ASCII characters (0x00-0x7F) in every string, comment, and status line (`ps1nonascii`).** Non-ASCII characters break Windows PowerShell 5.1 parsing. Replace each with its ASCII equivalent when writing the script: em-/en-dashes (em-dash, en-dash) -> `-`; smart/curly quotes (curly single and double) -> straight `'`/`"` (subject to the no-apostrophe rule above); arrows -> `->`; ellipsis -> `...`; non-breaking spaces -> a regular space. Do NOT let this markdown template's own prose punctuation leak into the emitted script content. (This markdown file may keep normal Unicode punctuation in its prose; the constraint applies only to bytes written into the `.ps1`.)
- **Force array context for any single-result pipeline you index** (`@(...)[-1]` / `Select-Object -Last 1`). A scalar from a one-element pipeline indexed with `[-1]` returns a character, not the item (`singletag`). This bit tag selection; apply it anywhere the script does `(...)[-1]`/`[0]`.
- **Force TLS 1.2 before any `Invoke-WebRequest`/download** (`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`). PS 5.1 defaults to TLS 1.0, which GitHub's CDN rejects (`tls12`).
- The **run instruction the caller surfaces** must invoke with execution-policy bypass, not a bare call:
  `powershell -ExecutionPolicy Bypass -File "<install_root>\.agent-index\<mode>-<purpose>.ps1"`
  (Default Windows execution policy blocks local `.ps1`; the bare `& "...ps1"` form fails with `UnauthorizedAccess`.)

Each script prints a clear per-repo / per-binary status line and exits non-zero on any abort, so both the admin and the calling task can detect failure.

## After the admin runs it (caller responsibility)
The invoking task (`create-org`/`install-collection`/`apply-updates`):
- Confirms the clones are present and at the expected tags (refuse to proceed on a missing/behind clone — process-enforced).
- In **infra** mode, before proceeding, reads the now-local `marketplace-directory.json` to drive collection selection, and trusts the **host-reported binary SHA** (printed by the script) for the dist publish rather than re-reading the large binary through the sandbox mount (`binmountstale`, ms-install-6/7).
- **Diffs the local clone against the backend and republishes only what changed** (diff + hash-verify): collections → their remote trees; the directories + binary → `/shared/dist/` + `manifest.json`; the bootstrap zip if the bundle or binary moved.

## Notes
- The adapter repo's bundle is consumed from the clone by the caller — compute the checksum on the **git-blob LF bytes** (`git -C <clone> show HEAD:dist/aifs-exec.bundle.js`), not the working-tree copy (Windows checkout converts LF→CRLF and breaks the SHA; ms-install-6).
- Shallow clone (`--depth=1 --branch <tag>`) keeps it light; the binary repo is NOT cloned (its signed assets are GitHub Release assets, fetched by the binary block above).
- This subroutine GENERATES a script; it never fetches anything itself. The admin runs the script on the host. The agent never downloads the binary into the sandbox (it cannot get intact bytes there — ms-install-6).

<!-- AIFS:FILE-END -->
