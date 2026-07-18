# lib/permission-spec -- committed permission-spec builder (level-3)

`build-permission-spec.js` replaces the pattern where each calling task **hand-authored** the
permission-change-helper spec JSON inline. That hand-authoring produced recurring bugs:
`transferdocopname` (op string "transfer" instead of "transfer_ownership"), `recipidform`
(a bare objectId where an email/UPN was required), and `permspecscratchpad` (spec written to the
sandbox scratchpad instead of under the mounted project dir). The op vocabulary, recipient form,
and canonical output path now live in ONE validated, committed tool.

## Contract
The calling task emits ONLY a **data ops-list** (a JSON array) -- what the agent is good at -- and
invokes the CLI. The CLI validates, formats, and writes the spec to the canonical path, then prints
the exact `spec_path` + `link_path` so the caller never guesses where it landed.

```
node <project_dir>/agent-index-core/lib/permission-spec/build-permission-spec.js \
     --project-dir "<project_dir>" --task <calling_task> --ops-file "<ops.json>"
```
(or `--ops '<inline-json-array>'`.)

Op descriptors: `{ "op":"share|unshare|transfer_ownership", "resource":"<path or id:...>",
"recipient":"<email/UPN>", "role":"reader|writer" (share only), "before":<optional pre-state> }`.

- `op` must be `share` | `unshare` | `transfer_ownership` (rejects "transfer" -- transferdocopname).
- `recipient` must be email/UPN form, never a bare GUID (recipidform).
- `share` requires `role` reader|writer; `transfer_ownership` sets role owner; `unshare` takes no role.
- Spec is ALWAYS written to `<project_dir>/outputs/permission-plan-<ISO>.json` (permspecscratchpad).
- An empty ops-list is valid (op_count 0) -- signals a no-op so the caller can skip the helper link.

Output (stdout JSON): `{ spec_path, link_path, op_count, summary }`. Exit 0 wrote spec; 1 validation
error (nothing written); 2 usage/IO error.
