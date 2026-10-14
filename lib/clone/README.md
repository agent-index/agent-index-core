# lib/clone -- committed repo-clone tooling (level-3)

These scripts replace the old pattern where the agent transcribed `templates/clone-script-generator.md`
into a bespoke per-run `.ps1`/`.sh` (fragile -- see bug `clonescripttagassumption`, where the agent
dropped the branch-HEAD logic; and token-heavy -- a full script emitted every run). All clone/tag
logic now lives here, written once and version-controlled. The calling task (`create-org`,
`install-collection`/`download-collection`, `apply-updates`) emits ONLY a small **data manifest** and
invokes the committed script.

## Which ref each repo gets (core 3.32.0)

`resolve-refs.js` is the **only** place that decides. Both drivers call it, then just execute its decision:

| Case | Ref |
|---|---|
| manifest `channel` set and the repo has branch `channel/<channel>` | that branch head (`ref_type: channel`) |
| infra mode, the repo has `v*` tags | highest release tag by numeric semver; a pre-release sorts below its release (`ref_type: tag`) |
| infra mode, zero tags | default-branch head, plus the phantom check against `version` (`ref_type: branch_head`) |
| collections mode, no channel branch | default-branch head (`ref_type: branch_head`) |

Every run merges its decisions into `<install_root>/.agent-index/clone-resolution.json` (`clone-resolution/1`: `channel`, `resolved_at`, `repos{name: {ref_type, ref, commit, version}}`). Publishing, update detection and displays read this record. Channel names must match `^[a-z0-9][a-z0-9-]{0,39}$`. The branch is `channel/<name>`.

Tests: `node --test lib/clone/resolve-refs.test.js`.

## Files
- `resolve-refs.js` (+ `resolve-refs.test.js`) -- the ref decision (channel / tag / default-branch head); no git writes.
- `clone-repos.ps1` / `clone-repos.sh` -- the driver. Reads a manifest, clones/pins each repo with the
  three-way tag / branch-HEAD / phantom discrimination, `clonescriptdirty` resilience (clear index.lock,
  reset --hard, continue-past-failure + per-repo summary). Core 4.0.0 removed the permission-helper
  binary install that infra mode used to run (the helper is retired; `lib/uninstall/` removes old copies).

## Manifest contract (the ONLY thing the agent produces -- pure data, no logic)
```json
{
  "mode": "infra" | "collections",
  "host_os": "windows" | "darwin" | "linux",
  "host_arch": "amd64" | "arm64",
  "install_root": "<abs path to agent-index/ folder>",
  "backend": "gdrive" | "onedrive",
  "channel": null | "dev-1",
  "repos": [ { "name": "agent-index-core", "git_url": "https://.../x.git", "version": "3.28.0" } ]
}
```
`version` is optional and only used to disambiguate a zero-tag branch-HEAD repo from a phantom.

## Invocation (surfaced to the admin by the calling task)
Windows: `powershell -ExecutionPolicy Bypass -File "<install_root>\agent-index-core\lib\clone\clone-repos.ps1" -Manifest "<install_root>\.agent-index\clone-manifest.json"`
darwin/linux: `bash "<install_root>/agent-index-core/lib/clone/clone-repos.sh" "<install_root>/.agent-index/clone-manifest.json"`

Exit codes: 0 all ok; 1 one or more repos failed (summary printed); 2 fatal (bad manifest).
