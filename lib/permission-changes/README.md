# lib/permission-changes -- committed plan/verify/record tooling (Level 3)

The mechanical half of the core permission-changes procedure
(`internal/permission-changes.md`; normative model: `runtime-reference.md` § "Permission changes: list,
confirm, apply, verify"). Added in agent-index-core 3.32.0. It replaced `lib/permission-spec/`
(the permission-change-helper spec builder), which core 4.0.0 removed along with the helper.

**Pure data.** The script never calls the storage backend. The agent makes every `aifs_*` call and
handles the confirmation turn. The script does the parts that must be identical every run:
diffing against current access, dropping no-ops, flagging outside-org recipients and high-impact
changes, rendering the exact table, judging results against the re-read state, and building the
approval-record line.

## Invocation

```
node "<project_dir>/agent-index-core/lib/permission-changes/permission-changes.js" <plan|verify|record> --input <file.json>
```

(or JSON on stdin). Add `--dry-run` to validate only. Output is JSON on stdout.

Exit codes: `0` ok; `2` invalid input or usage. On exit 2, stdout carries only
`{ok:false, errors[]}`, never a partial result.

## Commands

| Command | Input | Output |
|---|---|---|
| `plan` | `{calling_task, purpose, confirmer: admin\|owner\|collection_admin, mode?: independent\|all_or_nothing, changes[], current: {resource → {permissions[], owner?, location?}}, org: {backend, all_members_group, member_identities[]}}` | `{rows[], nothing_to_change, standard_rows[], high_impact_rows[], consequence_lines[], table_markdown, confirmation_prompt}` |
| `verify` | `{plan: <plan output>, confirmation: {standard: all\|none, declined_rows[], high_impact_confirmed[]}, apply_results: {row → {ok:true, result} \| {ok:false, error:{code,message}}}, post: {resource → {permissions[], owner?}}}` | `{run_result: complete\|partial\|none, rows[] (with final state), needs_recheck, revert_offer, summary_lines[]}` |
| `record` | `{run: {calling_task, purpose, confirmer_role, backend, rows, run_result, confirmation_text?, per_row_confirmations?, ts?, run_id?}}` | `{line}`: one JSONL line for `members/{hash}/state/permission-changes.jsonl` |

A change is `{op: share|unshare|transfer_ownership, resource: id:{itemId}|/abs/path, resource_label?, is_folder?, recipient, role (share only: reader|commenter|writer), inherit? (share only), reason? (defaults to the run's `purpose`), source}`.

`org.member_identities` is every registry member's `email` and `sharing_identity`, **plus** any identities the caller declares as org members for this run (e.g. `invite-member`'s new member, whose registry entry is written later). Append those to the same array.

`source` must be one of `task_spec`, `collaborative_acls`, `org_config`, `member_request` or
`current_state`. **There is no value for content the agent read**, so such a change can't be
proposed. `location` (`my_drive` | `shared_drive`) on a `current` entry tells `plan` whether a
gdrive ownership transfer is possible.

## Final states

`applied`, `skipped_noop`, `declined`, `failed`, `verify_mismatch`, `not_attempted`, `unsupported`,
`awaiting_recipient`. Only `applied` and `skipped_noop` satisfy a dependent step.

A `task_spec` share row whose recipient already holds a **higher** role (not owner) stays
`skipped_noop` but gets `excess_access: true` and a "more than this needs" note in the
"Not changing" table (finding 65). The script never proposes removing it.

`resource` may be a drive-qualified anchor `id:{driveId}:{itemId}` (OneDrive cross-drive items,
finding 63). Failure codes `EXTERNAL_SHARE_BLOCKED` / `EXTERNAL_SHARE_UNSUPPORTED` / `POLICY_DENIED` read as "your Microsoft
365 / Google Workspace sharing settings don't allow sharing with people outside the org" plus the
backend's message when that message names a policy; when it doesn't (Graph's generic `sharingFailed`),
"Microsoft/Google refused to share outside the org — usually the tenant's external-sharing setting
(…)" plus the backend's code and text (finding 84); on onedrive an outside-org `INVALID_SUBJECT` says the person must be added to the
tenant first (findings 72, 75).

## Tests

`node --test lib/permission-changes/permission-changes.test.js` runs Phase U of `retire-permission-helper-test-plan.md`.

<!-- AIFS:FILE-END -->
