# Subroutine: clone-manifest-emitter (was: clone-script-generator)

**Type:** shared subroutine (Release C; reworked to level-3 committed tooling in C.1.5.0). Invoked by `create-org` (initial), `install-collection`/`download-collection` (add a collection), and `apply-updates`/upgrade (move the org to a newer release).

## C.1.5.0 change -- commit the logic, emit only data (retires `clonescripttagassumption`, `ps1nonascii`)
Previously this subroutine had the agent **transcribe** a full clone `.ps1`/`.sh` every run. That was fragile (the agent dropped the branch-HEAD discrimination in Part-3 validation even though the template was correct -- `clonescripttagassumption`) and token-heavy (a whole script emitted per run). The clone/tag/binary logic now lives in **committed, version-controlled scripts** at `agent-index-core/lib/clone/`:
- `clone-repos.ps1` / `clone-repos.sh` -- driver (three-way tag/branch-HEAD/phantom discrimination; `clonescriptdirty` resilience; `singletag`/`tls12`/ASCII hardening baked in).
- `install-helper-binary.ps1` / `install-helper-binary.sh` -- infra-mode backend-matched signed-helper install (`binwrongbackend`, `binfield`/current_version, sha256-verify-or-abort, `signing` field, per-platform registration incl. darwin bundle/`macosregister`).

**The agent now produces ONLY a data manifest and surfaces the committed-script invocation. The agent still makes ZERO GitHub calls** -- all `git ls-remote`/clone/fetch and the signed-asset download happen inside the committed scripts on the host (C.1 invariant, unchanged).

## What the subroutine does now
1. Detect `host_os`, `host_arch`, `install_root`, and (infra) `backend`. Assemble the `repos[]` set for the mode:
   - **infra:** `agent-index-core`, `agent-index-filesystem-<backend>`, `agent-index-marketplace`, `agent-index-resource-listings`.
   - **collections:** the selected collection repo(s), each `{ name, git_url }` (+ optional `version` from `marketplace-directory.json` `current_version`, used only to disambiguate a zero-tag branch-HEAD repo from a phantom).
2. Write the **manifest** to `<install_root>/.agent-index/clone-manifest.json` (torn-write discipline: read it back and confirm before surfacing). Shape:
   ```json
   { "mode": "infra|collections", "host_os": "...", "host_arch": "amd64|arm64",
     "install_root": "<abs>", "backend": "gdrive|onedrive",
     "repos": [ { "name": "...", "git_url": "https://.../x.git", "version": "3.28.0" } ] }
   ```
3. **Surface the committed-script invocation** for the admin to run natively (execution-policy bypass on Windows):
   - windows: `powershell -ExecutionPolicy Bypass -File "<install_root>\agent-index-core\lib\clone\clone-repos.ps1" -Manifest "<install_root>\.agent-index\clone-manifest.json"`
   - darwin/linux: `bash "<install_root>/agent-index-core/lib/clone/clone-repos.sh" "<install_root>/.agent-index/clone-manifest.json"`
   The driver prints a per-repo status line and a summary; exit 0 = all ok, 1 = one or more repos failed, 2 = fatal.

The two-mode split (infra vs collections) is unchanged and is expressed by the manifest `mode`. The two-script split at create-org still exists because collection selection is interactive and the catalog only appears after the infra clone lands.

## Invariants preserved (now enforced in `lib/clone/`, not re-derived per run)
- Infra repos tag-pinned to the highest `v*` (array-context `singletag` guard); collections default-branch HEAD-pinned (`colltags`).
- Three-way discrimination: tag exists -> checkout; zero tags AND cloned `collection.json`/`adapter.json` version == cataloged -> branch-HEAD SUCCESS; has tags but not this one (or zero tags + version mismatch) -> fail loud, no `main` fallback (`tagnofallback`).
- `clonescriptdirty`: clear `index.lock`, `reset --hard`, continue-past-failure with a per-repo summary.
- Binary: backend-matched entry (`binwrongbackend`), version from `current_version` (`binfield`), TLS 1.2 (`tls12`), sha256-verify-or-abort, `signing` handling, darwin bundle registration (`macosregister`).
- Scripts are committed ASCII, apostrophe-free (`ps1nonascii`, `clonescriptps1`) -- verified once at authoring, not re-risked each run.

## After the admin runs it (caller responsibility -- unchanged)
- Confirm clones present at expected tags (refuse to proceed on a missing/behind clone).
- Infra mode: read the now-local `marketplace-directory.json` to drive collection selection; trust the host-reported binary SHA for the dist publish (`binmountstale`).
- Diff the local clone against the backend and republish only what changed; compute the adapter bundle checksum on git-blob LF bytes (`git show HEAD:dist/aifs-exec.bundle.js`), not the working tree.

## Notes
- If `lib/clone/` scripts are ever changed, that is a normal versioned code change (bump core, changelog, preflight) -- NOT an agent edit at run time. This is the whole point of level-3: the logic is reviewed and tested once.

<!-- AIFS:FILE-END -->
