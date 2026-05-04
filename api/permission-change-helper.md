---
name: permission-change-helper
type: skill
version: 1.0.0
collection: agent-index-core
description: Orchestrates permission-modifying operations (aifs_share, aifs_unshare, aifs_transfer_ownership) by preparing a review page in the member's browser, waiting for member-applied execution via the existing OAuth token, and verifying post-state. The canonical agent-callable surface for any task that needs to modify access controls.
stateful: false
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Permission-helper binary
    description: The pre-built `agent-index-show-plan` binary at `mcp-servers/permission-helper/show-plan.sh`, installed by core during apply-updates. If not found, the helper cannot run — surface an error and direct the member to '@ai:update' or '@ai:member-bootstrap'.
  - name: Browser
    description: The member's default browser. The helper opens a localhost URL for the member to review the proposed change. Headless contexts can use the `--cli` fallback.
---

## About This Skill

The Permission-Change Helper is the canonical agent-callable surface for any task or skill that needs to modify access controls on the org's remote filesystem. Tasks like `invite-member`, `remove-member`, and any future flow that calls `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` go through this skill rather than calling those ops directly.

The reason for the layering is documented in `agent-index-core/standards.md` under "Permission-Modifying Operations" and in the access-control project's decision record at `/shared/projects/access-control/decisions/permission-change-via-plan-page.md`. In short: agents are prohibited from making security-changing calls on the user's behalf, even with authorization, because agents can be manipulated. The helper sidesteps this by keeping the privileged call out of the agent's call stack — the agent prepares a structured proposal and surfaces it in the member's browser; the member's deliberate Accept click triggers a script that uses the member's existing OAuth token to make the actual call. The agent is upstream of the privileged action, never inside it.

This skill is the agent-side bookend to the pre-built `agent-index-show-plan` binary that ships in `mcp-servers/permission-helper/`. The skill's job is to validate the input spec a calling task hands it, invoke the binary, branch on the binary's outcome, verify post-state, and surface clear narration to the member at each phase.

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

- `version` (string) — schema version (currently `"1.0"`)
- `operations` (array, non-empty) — list of operations, each one of `op: "share"` / `"unshare"` / `"transfer_ownership"` with `resource`, `recipient`, and `role` (for shares). May include a `before` field with current permission state for diff visualization.
- `context` (object) — `requestor` member_hash, `calling_task` slug, plain-English `purpose` string for display.
- `mode` (optional) — `"fail_soft"` (default) or `"all_or_nothing"`.

If the calling task hands you anything that doesn't match this shape, fail fast with a clear error before invoking the binary. Do not attempt to repair or normalize malformed specs — that's the calling task's responsibility.

### Behavior

When invoked with a valid spec, perform these steps in order:

**Step 1 — Validate the spec.**

Run schema validation. Required fields must be present. `operations` must be non-empty. Each operation's `op` must be one of the allowed values. `resource` must start with `/`. `recipient` must look like a valid email or group address. If validation fails, return immediately to the calling task with `{ outcome: "validation_error", error_detail: <description> }`. Do not invoke the binary.

**Step 2 — Capture pre-state if not already provided.**

For each operation in the spec, if the `before` field is missing or empty, call `aifs_get_permissions` on the resource to capture current state. Populate `before.recipients` in the spec. This is what the page renders as the "Currently:" half of its diff visualization. If `aifs_get_permissions` fails (resource not found, etc.), proceed without `before` — the page will render without the diff and just show the planned end-state.

**Step 3 — Write the spec to disk.**

Write the spec to `outputs/permission-plan-{ISO-timestamp}.json` using a native file write. The agent-index project_dir's `outputs/` directory is the standard location for tool inputs/outputs. The timestamp ensures uniqueness if the calling task generates multiple plans in the same session.

**Step 4 — Invoke the binary.**

Run: `bash <project_dir>/mcp-servers/permission-helper/show-plan.sh <absolute-path-to-spec.json>`.

Capture stdout, stderr, and exit code. The binary will:
- Open the member's default browser to a localhost URL displaying the review page.
- Wait for the member's action (Accept, Reject, or page-close).
- If Accept: spawn the apply-script which calls the appropriate `aifs_*` ops via the existing `aifs-exec.sh` wrapper (using the member's OAuth token).
- Stream progress to the page via Server-Sent Events.
- On terminal state, write a final JSON status report to stdout and exit with a meaningful exit code.

The agent-side narrative during this wait should be minimal — something like: "I'm opening a review page in your browser. Review the proposed changes there and click Accept to apply them with your own credentials." Then wait for the binary's exit. Do not poll or interfere; the binary owns the user interaction surface during this window.

If the binary cannot be found at `mcp-servers/permission-helper/show-plan.sh`, return immediately with `{ outcome: "binary_not_found", error_detail: "Permission helper not installed. Run @ai:update to install it, or @ai:member-bootstrap if the install appears broken." }`.

**Step 5 — Parse the binary's exit.**

Branch on exit code:

| Exit code | Meaning | Outcome |
|---|---|---|
| 0 | Apply completed successfully | Proceed to Step 6 (verification) |
| 1 | User clicked Reject | Return `{ outcome: "rejected" }` |
| 2 | Idle timeout reached | Return `{ outcome: "timed_out" }` |
| 3 | Apply-script reported failure | Parse stdout JSON for partial vs total failure detail, return `{ outcome: "partial_failure"|"apply_error", failed_operations: [...], applied_operations: [...] }` |
| 4 | Page closed without action | Return `{ outcome: "page_closed" }` |
| 5 | Validation error before browser launch | Return `{ outcome: "binary_validation_error", error_detail: <stderr> }` |
| 130 / 143 | SIGINT / SIGTERM | Return `{ outcome: "terminated" }` |

For exit code 0, the stdout JSON includes `applied_operations` (all successful) and any user edits the page captured (e.g., recipient changes from inline editing). Pass these through to the calling task.

**Step 6 — Verify post-state.**

For exit code 0 (or 1 in fail-soft mode for partially-applied operations), call `aifs_get_permissions` on each affected resource and confirm the resulting permission state matches what the apply-script reported. Discrepancies (apply-script said success, but `aifs_get_permissions` shows the change wasn't applied) are treated as failure even if the apply-script reported success — return `{ outcome: "verification_failed", verified_state: [...], expected_state: [...] }`.

This is defense-in-depth. Drive's API occasionally returns success for share operations that don't actually take effect (rare, but documented), and the verification step catches it.

**Step 7 — Surface the outcome to the chat.**

Produce concise narration for the member based on the outcome:

- **applied:** "Done. Verified that {recipients} now have {roles} on {resources}."
- **rejected:** "You declined the proposed change. No permissions were modified."
- **timed_out:** "The review window timed out without action. No permissions were modified. Want to retry?"
- **page_closed:** "The review page was closed before the change could be applied. No permissions were modified. Want to retry?"
- **partial_failure:** "{N of M} operations applied successfully. The remaining {failed_count} failed: {brief detail}. Want to retry just the failed ones?"
- **apply_error / verification_failed:** "The change could not be applied: {error}. No partial state remains." (Or: "Partial state may exist; check {affected resources}.")
- **binary_not_found / validation_error / binary_validation_error:** Surface as a system-level issue rather than a user-action outcome.

Then return the structured outcome to the calling task so it can branch on the result.

### Spec Editing on the Page

The page allows the member to edit certain fields per operation before clicking Accept. Specifically: `recipient` (email/group address) and `role` (Reader/Commenter/Writer for shares). The member can also uncheck individual operations in a batch via per-row checkboxes. The submitted spec on Accept reflects these edits.

When you receive the post-Accept spec back from the binary's stdout, surface a brief note in the chat narration if the member made edits: "Note: you adjusted the recipient/role for {op_index} before applying — applied with the edited values." This makes it clear that the applied result may not match the spec your calling task originally submitted.

### Style & Tone

The narrative phases should be terse. The member is doing the deliberate review work — they don't need verbose play-by-play from the agent. One sentence before opening the browser, one sentence summarizing the outcome after. Don't repeat what the page already showed.

If the helper fails for an infrastructural reason (binary not found, browser launch failed), the narration should be helpful but honest: explain what went wrong and what the member can do. Don't pretend the failure was the member's choice.

### Constraints

- **Never call `aifs_share`, `aifs_unshare`, or `aifs_transfer_ownership` directly.** This skill exists specifically because the agent isn't permitted to. The binary is the only path; the binary calls the apply-script; the apply-script calls the ops via `aifs-exec.sh` in the user's environment.
- **Never modify the spec after the member submits it.** The spec the page POSTs back to the binary is the spec the apply-script runs. Editing it post-submission would defeat the review.
- **Never retry an operation automatically without explicit member input.** Retries are member-driven via the page's Retry button or a fresh skill invocation. Don't insert auto-retry loops in the agent.
- **Never poll `aifs_get_permissions` during the apply phase.** The apply-script does its own per-op verification and reports through the SSE channel. Polling from the agent during the wait is wasted tokens and could race with the script.
- **Always verify post-state on exit code 0.** Even if the apply-script reports success, run the verification step. Discrepancies must be surfaced.
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
