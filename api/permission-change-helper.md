---
name: permission-change-helper
type: skill
version: 1.3.4
collection: agent-index-core
description: Orchestrates permission-modifying operations (aifs_share, aifs_unshare, aifs_transfer_ownership) by emitting a canonical agent-index:// markdown link (with code-fenced URL fallback) that the user clicks to launch the review page via OS URL-scheme handler. Reads structured outcome JSON written by the helper binary; verifies post-state via aifs_get_permissions. The canonical agent-callable surface for any task that needs to modify access controls.
stateful: false
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Permission-helper binary
    description: The pre-built `agent-index-show-plan` helper. The canonical implementation is the native Go binary at `mcp-servers/permission-helper-go/agent-index-show-plan` (extension `.exe` on Windows), distributed via the binaries registry and installed by `apply-updates` Phase 1 step 7. Pre-3.7.4 versions also shipped a Node fallback at `mcp-servers/permission-helper/show-plan.sh`; this was removed in 3.7.4 (closes idea `remove-node-permission-helper-fallback`). If the Go binary is not present, the helper cannot run — surface a `binary_not_found` outcome and direct the member to `@ai:update` (to install the binary on pre-3.4.0 installs) or `@ai:member-bootstrap` (to repair a broken install).
  - name: Browser
    description: The member's default browser. The helper opens a localhost URL for the member to review the proposed change. Headless contexts can use the `--cli` fallback.
---

## About This Skill

The Permission-Change Helper is the canonical agent-callable surface for any task or skill that needs to modify access controls on the org's remote filesystem. Tasks like `invite-member`, `remove-member`, and any future flow that calls `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` go through this skill rather than calling those ops directly.

The reason for the layering is documented in `agent-index-core/standards.md` under "Permission-Modifying Operations" and in the access-control project's decision record at `/shared/projects/access-control/decisions/permission-change-via-plan-page.md`. In short: agents are prohibited from making security-changing calls on the user's behalf, even with authorization, because agents can be manipulated. The helper sidesteps this by keeping the privileged call out of the agent's call stack — the agent prepares a structured proposal and surfaces it in the member's browser; the member's deliberate Accept click triggers a script that uses the member's existing OAuth token to make the actual call. The agent is upstream of the privileged action, never inside it.

This skill is the agent-side bookend to the pre-built `agent-index-show-plan` binary. The canonical implementation is the native Go binary at `mcp-servers/permission-helper-go/agent-index-show-plan` (extension `.exe` on Windows). It's distributed via the binaries registry and installed by `apply-updates` Phase 1 step 7. Production-quality: real Drive API integration, OAuth refresh, custom URL scheme handler (`agent-index://`), per-platform installers.

Pre-3.7.4 also shipped a Node fallback at `mcp-servers/permission-helper/show-plan.sh` from `agent-index-core/lib/permission-helper/` during `apply-updates` Phase 1 step 6. That fallback was removed in 3.7.4 (closes idea `remove-node-permission-helper-fallback`) — see the [3.7.4 scope decision record](/shared/projects/core-improvements/decisions/2026-05-24-release-3.7.4-scope.md) for rationale. The skill's job is now: detect that the Go binary is present, emit the canonical `agent-index://` markdown link (with code-fenced URL fallback per the trust contract) for the user to click, parse the structured outcome JSON the binary writes, verify post-state via `aifs_get_permissions`, and surface clear narration to the member at each phase.

### When This Skill Is Active

This skill is invoked by other skills/tasks, not directly by members. A typical flow:

1. Calling task — say, `invite-member` — reaches a step where it needs to grant the new member read access to admin-published files.
2. Calling task builds a spec describing the proposed shares.
3. Calling task invokes this skill with the spec.
4. This skill takes over the session for the duration of the review (typically <2 minutes for a typical batch).
5. Returns control to the calling task with a structured outcome report.

Members should not directly invoke this skill. If a member says "share this with Jeff," the right routing is to a task like `invite-member` (or whatever flow owns the broader workflow) which then calls this skill internally. This skill is plumbing, not a user-facing surface.

### What This Skill Does Not Cover

- **Read-only permission queries** — `aifs_get_permissions` is callable directly by any task. This skill is only for the three permission-modifying ops.
- **Bulk audit and reconciliation** — separate concern. A future `audit-and-reconcile-permissions` task could use this skill internally for any changes it proposes, but the audit itself is not this skill's job.
- **Workspace-level settings** (`admin.google.com` configuration, group-membership editing in some surfaces) — these don't have a Drive API path and require Pattern 2 fallback (UI clicks). Not handled by this skill.
- **Cross-org permission changes** — handled by the existing Drive UI; out of scope for agent-index entirely.

---

## Directives

### Input Contract

This skill is invoked with a permission-change spec. The full schema is documented in `/shared/projects/access-control/artifacts/permission-change-helper-tech-design.md`. Briefly, the spec is JSON with:

- `version` (string) — schema version (`"1.0"` for the original shape; `"1.1"` for specs that use the `inherit` field added in core 3.7.3). Both versions are accepted; `"1.1"` enables `inherit` validation, `"1.0"` rejects `inherit` if present.
- `operations` (array, non-empty) — list of operations, each one of `op: "share"` / `"unshare"` / `"transfer_ownership"` with `resource`, `recipient`, and `role` (for shares). May include a `before` field with current permission state for diff visualization.
  - **`resource` format (`specresource`, ms-install-9).** Must be EITHER an absolute path starting with `/`, OR the target item's **own** id-anchor `id:{itemId}`. It must **NOT** be a composite of a parent-folder id plus a relative name (e.g. `id:{folderId}/handoff-test.md`) — the helper binary rejects that ("resource must be a path starting with / or an ID anchor of the form id:{folderId}"). When sharing a **file inside an id-anchored space** (e.g. a member's `Agent-Index-Private`), the calling task MUST resolve the **file's own** item id via `aifs_stat` and pass `id:{fileItemId}` — not `id:{parentFolderId}/{name}`. (This broke the first real owned-content share: the spec used the parent folder's id + filename and the binary refused it until the file's own id was resolved.)
- `operations[].inherit` (boolean, optional, share operations only) — added in core 3.7.3. When `true` (the default if omitted, matching v1.0 behavior), the share is additive on top of parent-folder inheritance. When `false`, the share is applied as an explicit override: the recipient sees only this resource, not the parent. Used for narrower-than-parent ACLs (per-instance grants in client-intelligence, per-idea ACLs in access-control Phase 5, etc.). Requires `organizer` role on the Shared Drive (or `owner` on My Drive) to set — the adapter surfaces an `AccessDeniedError` with an actionable message if the applying user lacks the role. Backward-compatible: specs without `inherit` behave exactly as v1.0.
- `context` (object) — `requestor` member_hash, `calling_task` slug, plain-English `purpose` string for display.
- `mode` (optional) — `"fail_soft"` (default) or `"all_or_nothing"`.

If the calling task hands you anything that doesn't match this shape, fail fast with a clear error. Do not attempt to repair or normalize malformed specs — that's the calling task's responsibility.

### Behavior

When invoked with a valid spec, perform these steps in order:

**Step 1 — Validate the spec.**

Run schema validation. Required fields must be present. `operations` must be non-empty. Each operation's `op` must be one of the allowed values. **`resource` must be a valid target reference (`specresource`):** either an absolute path starting with `/`, or a bare item id-anchor `id:{itemId}` — but NOT a parent-folder-id-plus-relative-name composite like `id:{folderId}/{name}`. If you detect a composite `id:{...}/{...}` form, return `{ outcome: "validation_error", error_detail: "resource is a folder-id + relative path; resolve the target's OWN item id via aifs_stat and pass id:{itemId}" }` — do not emit the URL (the binary would reject it anyway). `recipient` must look like a valid email or group address. For specs with `version: "1.1"`, validate `inherit` on share operations: must be boolean if present; rejected on non-share operations. For `version: "1.0"` specs that include `inherit`, reject with a clear error pointing at the version bump. If validation fails, return immediately to the calling task with `{ outcome: "validation_error", error_detail: <description> }`. Do not emit the URL.

**Step 2 — Capture pre-state if not already provided.**

For each operation in the spec, if the `before` field is missing or empty, call `aifs_get_permissions` on the resource to capture current state. Populate `before.recipients` in the spec. This is what the page renders as the "Currently:" half of its diff visualization. If `aifs_get_permissions` fails (resource not found, etc.), proceed without `before` — the page will render without the diff and just show the planned end-state.

**Step 2.5 — Build the spec with the committed `build-permission-spec` CLI (mandatory; level-3).**

Do NOT hand-author the spec JSON. Calling tasks emit ONLY a **data ops-list** and produce the spec with the committed CLI at `agent-index-core/lib/permission-spec/build-permission-spec.js`:

```
node "<project_dir>/agent-index-core/lib/permission-spec/build-permission-spec.js" \
     --project-dir "<project_dir>" --task {calling_task} --ops '<json-array>'
```

where `<json-array>` is `[{ "op": "share|unshare|transfer_ownership", "resource": "<path or id:...>", "recipient": "<email/UPN>", "role": "reader|writer" (share only), "before": <optional pre-state> }, ...]`.

The CLI **enforces** what used to be hand-authored and drifted: the op vocabulary (rejects `transfer` in favor of `transfer_ownership`, closing `transferdocopname`), email/UPN recipient form (rejects bare objectIds, `recipidform`), the required `role` for a `share`, and the **canonical output path `<project_dir>/outputs/permission-plan-<ISO>.json`** (closing `permspecscratchpad` and the historical `.agent-index/` vs `outputs/` drift). It prints `{ spec_path, link_path, op_count, summary }` on stdout -- **use the `spec_path`/`link_path` it returns verbatim** in Step 3 and Step 4. An `op_count` of 0 is a legitimate no-op (e.g. onedrive site-membership makes grants redundant): skip the helper link and report "no permission changes needed." (Steps 3-4 below are unchanged; the CLI simply replaces the by-hand JSON authoring and satisfies the under-`<project_dir>` write path by construction -- still assert it.)

**Step 3 — Write the spec to disk.**

**Resolve `<project_dir>` = the absolute directory that contains `agent-index.json`.** Write the spec to **`<project_dir>/.agent-index/permission-plan-{ISO-timestamp}.json`** — an absolute path **UNDER the mounted project directory**. Do **NOT** use the agent's session scratchpad / sandbox working directory (`permspecscratchpad`): the permission helper runs NATIVELY on the host and can only read files under the mounted project directory, so a scratchpad spec is invisible to it and the `--cli` / URL-handler run fails with `could not read spec … The system cannot find the path specified` (`validation_error`).

**Hard gate — do all three BEFORE emitting any `--cli` command or review link:**
1. Compute the **absolute** path you actually wrote to.
2. **ASSERT that absolute path begins with the resolved `<project_dir>`.** A scratchpad path fails this and MUST be rewritten under `<project_dir>` before continuing. *(A plain `test -f`/exists check is NOT sufficient on its own — it passes from the agent's own view of the scratchpad, which the host cannot read; that exists-only check is exactly why the C.1.4.1 fix recurred non-deterministically. The startswith-`<project_dir>` assertion is the check that catches it.)*
3. `test -f` the file at that absolute path.

Only after all three pass, surface the exact absolute path in the review link / `--cli` command. The timestamp ensures uniqueness across multiple plans in one session. **`<project_dir>/outputs/` is the canonical location (written by the `build-permission-spec` CLI)** (it's the member/admin workspace metadata dir, always under `<project_dir>`, and was the path the invite-member recovery used successfully); `<project_dir>/outputs/` is also acceptable — the only hard requirement is that the path is under `<project_dir>`.

**Step 4 — Emit the canonical URL surface in chat.** (Rewritten in core 3.7.3 to realign with `standards.md` § "Trust contract for the agent in the URL-handler invocation flow" — closes bug `20260519-8d20ea22`.)

The agent does **not** invoke the binary directly. Instead, it emits two paired outputs in chat that the user clicks (or copies) to trigger the URL-scheme handler, which is what actually invokes the binary in the user's deliberate-action context. This keeps the privileged call out of the agent's call stack, per the safety boundary documented in standards.md.

Emit, in this order:

1. A markdown link summarizing the action:
   ```
   [Review and apply N permission changes for {calling_task}](agent-index://apply?spec=outputs/permission-plan-{timestamp}.json)
   ```
   Where `N` is the operation count, `{calling_task}` is the slug of the task that invoked this skill, and `{timestamp}` matches the spec file's filename.

2. The same URL inside a fenced code block, as a fallback for clients that strip or hide custom-scheme links (e.g., current Cowork desktop builds as of 2026-05-20):
   ```
   agent-index://apply?spec=outputs/permission-plan-{timestamp}.json
   ```
   The fenced URL still requires deliberate user action (copy → paste into browser address bar), preserving the trust boundary. This dual-emission is normative per standards.md § "The agent does" — preflight enforces it.

3. A single-sentence narration:
   > "Review the proposed changes and click Accept to apply with your own credentials. If the link above doesn't open a review page, your OS URL-scheme handler may not be registered — copy the URL from the code block into your browser, or run `@ai:member-bootstrap` to verify your install."

**Headless / unregistered-handler fallback (`clihelpurl`, ms-install-9).** If the member reports the `agent-index://` link does nothing (the handler was never registered — common until `--register` is run, and unavoidable in the unsigned-bypass interim where SAC may block the handler), give them the binary's `--cli` command. **`--cli` takes the spec FILE PATH, not the `agent-index://` URL** — passing the URL fails with "could not read spec … The filename, directory name, or volume label syntax is incorrect." The correct command (run by the member, in their own terminal, under their own credentials — this preserves the trust boundary exactly like the click would):
```
<install_path>/mcp-servers/permission-helper-go/agent-index-show-plan{ext} --cli "outputs/permission-plan-{timestamp}.json"
```
It prints the same review, applies on the member's `y`/Accept, and writes the same `outputs/permission-plan-{timestamp}-outcome.json`. Do NOT pass `--cli "agent-index://apply?spec=..."` — strip it to the bare spec path. (And surface this proactively when you know the handler isn't registered, rather than after the member hits the dead link.)

**Give a shell-correct, cwd-independent command (`clihelpcwd` + `clihelppwsh`, ms_prod_9).** The spec path is relative to the project_dir (where `outputs/` lives), but the member's shell may be anywhere. Hand over a command that runs **regardless of cwd** and **in the member's actual shell** — use **absolute paths for both the binary and the spec** (this sidesteps cwd entirely; no `cd` needed) and pick the form for the platform. Two failures to avoid, both observed live: a relative fragment run from the parent folder (`No such file or directory`), and a bash-style `cd … && …` pasted into Windows PowerShell (`The token '&&' is not a valid statement separator in this version`).

- **Windows (PowerShell)** — use the call operator `&` with absolute paths; do **not** use `&&`:
  ```
  & "<project_dir>\mcp-servers\permission-helper-go\agent-index-show-plan.exe" --cli "<project_dir>\outputs\permission-plan-{timestamp}.json"
  ```
- **macOS / Linux (bash/zsh)** — absolute paths:
  ```
  "<project_dir>/mcp-servers/permission-helper-go/agent-index-show-plan" --cli "<project_dir>/outputs/permission-plan-{timestamp}.json"
  ```

`<project_dir>` is the directory containing `agent-index.json` — **resolve it to the real absolute path; never leave it as a placeholder.** The binary is installed under the **canonical name `agent-index-show-plan`(`.exe` on Windows)** — NOT the backend-suffixed source name (`…-onedrive`), which is the build artifact, not the install_destination. (Absolute paths + the right shell operator mean the member can paste-and-run from anywhere.)

The Go binary is what the URL-scheme handler invokes. The binary lives at `<project_dir>/mcp-servers/permission-helper-go/agent-index-show-plan{.exe}`. Pre-3.7.4 also shipped a Node fallback at `<project_dir>/mcp-servers/permission-helper/show-plan.sh`; that fallback was removed in 3.7.4 (closes idea `remove-node-permission-helper-fallback`). If the Go binary isn't present at the expected path, surface a `binary_not_found` outcome and direct the member to `@ai:update` or `@ai:member-bootstrap`.

**Backend-specific binary (Release B).** The helper binary is **per-adapter**: the gdrive build embeds the Google Drive API, the onedrive build (`agent-index-show-plan-onedrive`) embeds Microsoft Graph. They share a common Go core (spec parse, plan render, Accept gate, token handling, post-apply verify) and differ only in the backend driver. `apply-updates` Phase 1 step 7 installs the build **matching the org's `remote_filesystem.backend`** to the **same canonical path** above — so this skill, `invite-member`, `remove-member`, setup, etc. reference the path unchanged regardless of backend. The privileged op still runs only from the binary, on the user's Accept, under the member's own token; the agent never invokes it. (Generic delegation via `aifs_share` is not possible: the binary runs host-side with no Node runtime to reach the executor — hence the embedded per-backend API.)

**Step 5 — Wait for the user to report the outcome.**

Per standards.md line 582. The agent does not poll, does not invoke the binary, does not navigate the user. It waits for the user's next message in chat. Expected reports include "done", "accepted", "applied", "rejected", "canceled", "didn't work", or any natural-language signal that the review flow has reached terminal state. The agent interprets the report and proceeds to Step 6.

If the user reports something ambiguous ("hmm", "interesting"), ask one clarifying question — "Did the changes apply, or are you still reviewing?" — and wait. Don't assume.

**Step 6 — Read the outcome JSON file.**

The URL-scheme-launched binary writes a structured outcome file on terminal state. Path: `outputs/permission-plan-{timestamp}-outcome.json` (alongside the spec file, same timestamp).

Read the outcome file. Expected schema:

```json
{
  "outcome": "applied" | "rejected" | "timed_out" | "page_closed" | "partial_failure" | "apply_error" | "validation_error",
  "applied_operations": [<op spec>, ...],
  "failed_operations": [<op spec + error>, ...],
  "user_edits": { ... },
  "completed_at": "<ISO 8601>"
}
```

The `outcome` value mirrors the structured outcome the calling task ultimately receives — see § "Output Contract" below.

**If the outcome file doesn't exist** after the user reported done: surface a diagnostic to the calling task and the user:
> "I expected an outcome file at `outputs/permission-plan-{timestamp}-outcome.json` but didn't find it. Likely causes: the OS URL-scheme handler isn't registered (most common — run `@ai:member-bootstrap`), the binary failed before writing the outcome, or the click never reached the binary. The spec file at `outputs/permission-plan-{timestamp}.json` is preserved if you want to retry."

Return `{ outcome: "outcome_file_missing", error_detail: "..." }` to the calling task. Don't assume any state was applied or not applied — the actual Drive state is unknown until verified.

**Step 7 — Verify post-state.**

For `outcome: applied` (or `partial_failure` with at least one successful operation), call `aifs_get_permissions` on each affected resource and confirm the resulting permission state matches what the outcome file reported. Discrepancies (outcome said success, but `aifs_get_permissions` shows the change wasn't applied) are treated as failure even if the binary reported success — return `{ outcome: "verification_failed", verified_state: [...], expected_state: [...] }`.

This is defense-in-depth. Drive's API occasionally returns success for share operations that don't actually take effect (rare, but documented), and the verification step catches it. For `inherit: false` operations, verification also confirms that parent inheritance is in fact disabled — `aifs_get_permissions` should show the explicit grant without the inherited entries that the parent folder would otherwise contribute.

**Step 8 — Surface the outcome to the chat.**

Produce concise narration for the member based on the verified outcome:

- **applied:** "Done. Verified that {recipients} now have {roles} on {resources}."
- **rejected:** "You declined the proposed change. No permissions were modified."
- **timed_out:** "The review window timed out without action. No permissions were modified. Want to retry?"
- **page_closed:** "The review page was closed before the change could be applied. No permissions were modified. Want to retry?"
- **partial_failure:** "{N of M} operations applied successfully. The remaining {failed_count} failed: {brief detail}. Want to retry just the failed ones?"
- **apply_error / verification_failed:** "The change could not be applied: {error}. No partial state remains." (Or: "Partial state may exist; check {affected resources}.")
- **outcome_file_missing:** Surface the diagnostic from Step 6.
- **validation_error / binary_validation_error:** Surface as a system-level issue rather than a user-action outcome.

Then return the structured outcome to the calling task so it can branch on the result.

### Spec Editing on the Page

The page allows the member to edit certain fields per operation before clicking Accept. Specifically: `recipient` (email/group address) and `role` (`reader`/`commenter`/`writer` for shares — Drive-canonical lowercase). The member can also uncheck individual operations in a batch via per-row checkboxes. The submitted spec on Accept reflects these edits.

When you receive the post-Accept spec back from the binary's stdout, surface a brief note in the chat narration if the member made edits: "Note: you adjusted the recipient/role for {op_index} before applying — applied with the edited values." This makes it clear that the applied result may not match the spec your calling task originally submitted.

### Style & Tone

The narrative phases should be terse. The member is doing the deliberate review work — they don't need verbose play-by-play from the agent. One sentence before opening the browser, one sentence summarizing the outcome after. Don't repeat what the page already showed.

If the helper fails for an infrastructural reason (binary not found, browser launch failed), the narration should be helpful but honest: explain what went wrong and what the member can do. Don't pretend the failure was the member's choice.

### Constraints

- **Never call `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` directly.** This skill exists specifically because the agent isn't permitted to. The user's click on the `agent-index://` link is what initiates the privileged call; the URL-scheme handler invokes the binary; the binary calls the apply-script using the user's OAuth token.
- **Never invoke the binary directly from the agent.** Per standards.md § "Trust contract for the agent in the URL-handler invocation flow" and the rewrite that landed in core 3.7.3 (closes bug `20260519-8d20ea22`), the agent emits the markdown link plus the code-fenced URL; the user's click is the privileged-call entry point. Do not bash-invoke `<go-binary> <spec>` from the skill — that would re-collapse the safety boundary the URL-scheme architecture exists to maintain.
- **Always emit the code-fenced URL alongside the markdown link.** This is normative per standards.md § "The agent does." The pair-emission supports clients that strip custom-scheme links from rendered markdown (current Cowork desktop builds). The fenced URL still requires deliberate user action (copy → paste), so the trust boundary is preserved.
- **Never modify the spec after the user submits it.** The spec the page POSTs back to the binary is the spec the apply-script runs. Editing it post-submission would defeat the review.
- **Never retry an operation automatically without explicit member input.** Retries are member-driven via the page's Retry button or a fresh skill invocation. Don't insert auto-retry loops in the agent.
- **Never poll `aifs_get_permissions` during the apply phase.** The apply-script does its own per-op verification and writes the outcome file at terminal state. Polling from the agent during the wait is wasted tokens and could race with the script.
- **Always verify post-state on `outcome: applied`.** Even if the outcome file reports success, run the verification step. Discrepancies must be surfaced.
- **Never invoke this skill recursively.** If a calling task's outcome handling logic concludes "I should retry this share," that's the calling task's decision — it can call this skill again with a new spec. This skill should never call itself.

### Edge Cases

- **Spec has zero operations.** Validation rejects it. Return `validation_error`.
- **Binary exits with an unexpected code (not in the table above).** Return `{ outcome: "unexpected_exit", exit_code: N, stdout: <truncated>, stderr: <truncated> }` and let the calling task decide.
- **Browser opens but the page fails to load.** The binary's listener will eventually idle-timeout (10 minutes). Return `timed_out`. Do not try to reopen the browser from the agent — the binary owns that surface.
- **The apply-script appears to hang (no output for >5 minutes).** The binary has its own apply-script timeout that handles this; you'll get exit code 3 with diagnostic info. Don't independently kill the binary.
- **Multiple permission changes needed in a single calling task workflow.** Each one goes through this skill separately, in sequence, with member confirmation each time. Don't try to batch independent semantic operations into a single spec — each spec corresponds to one user-confirmable batch.

---

## Output Contract

Returns to the calling task a structured outcome object:

```
{
  "outcome": "applied" | "rejected" | "timed_out" | "page_closed" | "partial_failure" | "apply_error" | "verification_failed" | "validation_error" | "binary_not_found" | "binary_validation_error" | "terminated" | "unexpected_exit",
  "applied_operations": [<op spec>, ...],     // present when applied or partial_failure
  "failed_operations": [<op spec + error>, ...],  // present when partial_failure or apply_error
  "verified_post_state": [<resource: recipients>, ...],  // present when applied (after verification)
  "user_edits": { ... },                       // present if the member edited the spec on the page before applying
  "error_detail": <string>                     // present on error outcomes
}
```

The calling task branches on `outcome` to decide how to proceed.
