# lib/clone -- committed repo-clone tooling (level-3)

These scripts replace the old pattern where the agent transcribed `templates/clone-script-generator.md`
into a bespoke per-run `.ps1`/`.sh` (fragile -- see bug `clonescripttagassumption`, where the agent
dropped the branch-HEAD logic; and token-heavy -- a full script emitted every run). All clone/tag/binary
logic now lives here, written once and version-controlled. The calling task (`create-org`,
`install-collection`/`download-collection`, `apply-updates`) emits ONLY a small **data manifest** and
invokes the committed script.

## Files
- `clone-repos.ps1` / `clone-repos.sh` -- the driver. Reads a manifest, clones/pins each repo with the
  three-way tag / branch-HEAD / phantom discrimination, `clonescriptdirty` resilience (clear index.lock,
  reset --hard, continue-past-failure + per-repo summary), and (infra mode) invokes the binary installer.
- `install-helper-binary.ps1` / `install-helper-binary.sh` -- infra-mode backend-matched signed-helper
  resolver+installer (binwrongbackend, current_version/binfield, sha256-verify-or-abort, signing field,
  per-platform registration incl. darwin bundle/macosregister).

## Manifest contract (the ONLY thing the agent produces -- pure data, no logic)
```json
{
  "mode": "infra" | "collections",
  "host_os": "windows" | "darwin" | "linux",
  "host_arch": "amd64" | "arm64",
  "install_root": "<abs path to agent-index/ folder>",
  "backend": "gdrive" | "onedrive",
  "repos": [ { "name": "agent-index-core", "git_url": "https://.../x.git", "version": "3.28.0" } ]
}
```
`version` is optional and only used to disambiguate a zero-tag branch-HEAD repo from a phantom.

## Invocation (surfaced to the admin by the calling task)
Windows: `powershell -ExecutionPolicy Bypass -File "<install_root>\agent-index-core\lib\clone\clone-repos.ps1" -Manifest "<install_root>\.agent-index\clone-manifest.json"`
darwin/linux: `bash "<install_root>/agent-index-core/lib/clone/clone-repos.sh" "<install_root>/.agent-index/clone-manifest.json"`

Exit codes: 0 all ok; 1 one or more repos failed (summary printed); 2 fatal (bad manifest / binary install).
