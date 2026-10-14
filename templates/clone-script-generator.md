# Subroutine: clone-manifest-emitter (was: clone-script-generator)

**Type:** shared subroutine (Release C; reworked to level-3 committed tooling in C.1.5.0). Invoked by `create-org` (initial), `install-collection`/`download-collection` (add a collection), and `apply-updates`/upgrade (move the org to a newer release).

## C.1.5.0 change -- commit the logic, emit only data (retires `clonescripttagassumption`, `ps1nonascii`)
Previously this subroutine had the agent **transcribe** a full clone `.ps1`/`.sh` every run. That was fragile (the agent dropped the branch-HEAD discrimination in Part-3 validation even though the template was correct -- `clonescripttagassumption`) and token-heavy (a whole script emitted per run). The clone/tag logic now lives in **committed, version-controlled scripts** at `agent-index-core/lib/clone/`:
- `clone-repos.ps1` / `clone-repos.sh` -- driver (three-way tag/branch-HEAD/phantom discrimination; `clonescriptdirty` resilience; `singletag`/`tls12`/ASCII hardening baked in).

> **HARD PROHIBITION (C.1.5.1, `clonescripttagassumption`): NEVER author a bespoke clone script.** Do NOT write, generate, or hand-craft a `clone-<name>.ps1`/`.sh` (or anything 'modeled on the existing clone scripts'). The ONLY sanctioned path is: (1) write the data manifest, (2) surface the invocation of the COMMITTED `agent-index-core/lib/clone/clone-repos.{ps1,sh}`. If you find yourself about to emit git/clone/checkout logic into a script, STOP -- that logic already lives in the committed script; you only supply the manifest. Leftover `clone-*.ps1` files in the workspace are NOT templates to copy; ignore them (and delete them). Validation caught the agent regenerating a bespoke script even with the committed one deployed -- this prohibition closes that.

**The agent now produces ONLY a data manifest and surfaces the committed-script invocation. The agent still makes ZERO GitHub calls** -- all `git ls-remote`/clone/fetch happen inside the committed scripts on the host (C.1 invariant, unchanged).

## What the subroutine does now
1. Detect `host_os`, `install_root`, and (infra) `backend`. (`host_arch` is optional and unused since core 4.0.0; the scripts still parse it, so older manifests stay valid.) Assemble the `repos[]` set for the mode:
   - **infra:** `agent-index-core`, `agent-index-filesystem-<backend>`, `agent-index-marketplace`, `agent-index-resource-listings`.
   - **collections:** the selected collection repo(s), each `{ name, git_url }` (+ optional `version` from `marketplace-directory.json` `current_version`, used only to disambiguate a zero-tag branch-HEAD repo from a phantom).
   - **`channel` (core 3.32.0, REQUIRED field, may be null):** the org's distribution channel. Read org-config `distribution_channel`; before org-config exists (create-org Phase 1), read the admin's `agent-index.json` `distribution_channel`. **Always pass it.** A manifest without it makes a channel org silently fall back to released code, the revert the channels design exists to prevent. `null` = released code.
2. Write the **manifest** to `<install_root>/.agent-index/clone-manifest.json` (torn-write discipline: read it back and confirm before surfacing). Shape:
   ```json
   { "mode": "infra|collections", "channel": null, "host_os": "...",
     "install_root": "<abs>", "backend": "gdrive|onedrive",
     "repos": [ { "name": "...", "git_url": "https://.../x.git", "version": "3.28.0" } ] }
   ```
3. **Surface the committed-script invocation** for the admin to run natively (execution-policy bypass on Windows):
   - windows: `powershell -ExecutionPolicy Bypass -File "<install_root>\agent-index-core\lib\clone\clone-repos.ps1" -Manifest "<install_root>\.agent-index\clone-manifest.json"`
   - darwin/linux: `bash "<install_root>/agent-index-core/lib/clone/clone-repos.sh" "<install_root>/.agent-index/clone-manifest.json"`
   The driver prints a per-repo status line and a summary; exit 0 = all ok, 1 = one or more repos failed, 2 = fatal.

The two-mode split (infra vs collections) is unchanged and is expressed by the manifest `mode`. The two-script split at create-org still exists because collection selection is interactive and the catalog only appears after the infra clone lands.

## Invariants preserved (now enforced in `lib/clone/`, not re-derived per run)
- **Ref decision lives in `lib/clone/resolve-refs.js` (core 3.32.0), shared by both drivers.** A repo with branch `channel/<channel>` comes from that branch head. Otherwise infra repos are tag-pinned to the highest `v*` (numeric semver; this fixes the bash first-field sort bug) and collections are default-branch HEAD-pinned (`colltags`).
- Every run writes `<install_root>/.agent-index/clone-resolution.json` (`clone-resolution/1`: channel; per repo ref_type, ref, commit, version). Publishing, update detection and displays read it.
- Three-way discrimination: tag exists -> checkout; zero tags AND cloned `collection.json`/`adapter.json` version == cataloged -> branch-HEAD SUCCESS; has tags but not this one (or zero tags + version mismatch) -> fail loud, no `main` fallback (`tagnofallback`).
- `clonescriptdirty`: clear `index.lock`, `reset --hard`, continue-past-failure with a per-repo summary.
- TLS 1.2 for every HTTPS call (`tls12`).
- Scripts are committed ASCII, apostrophe-free (`ps1nonascii`, `clonescriptps1`) -- verified once at authoring, not re-risked each run.

## After the admin runs it (caller responsibility -- unchanged)
- Confirm clones are present at the refs `clone-resolution.json` records (refuse to proceed on a missing clone or a FAILED line). On a channel org, expect `channel/<name>@…` lines for repos that have the branch and `(release tag)` for the rest.
- Infra mode: read the now-local `marketplace-directory.json` to drive collection selection.
- Diff the local clone against the backend and republish only what changed; compute the adapter bundle checksum on git-blob LF bytes (`git show HEAD:dist/aifs-exec.bundle.js`), not the working tree. (HEAD is the resolved ref: a tag or a channel head.)

## Notes
- If `lib/clone/` scripts are ever changed, that is a normal versioned code change (bump core, changelog, preflight) -- NOT an agent edit at run time. This is the whole point of level-3: the logic is reviewed and tested once.

<!-- AIFS:FILE-END -->
