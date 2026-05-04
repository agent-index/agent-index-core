# agent-index-permission-helper

Pre-built helper for the agent-index permission-change pattern. The agent prepares a structured spec; this helper renders a review page in the member's browser; the member's deliberate Accept click triggers an apply-script that uses the member's existing OAuth token (via the gdrive adapter's `aifs-exec.sh`) to make the permission change.

The helper is the answer to the structural problem in bug `20260502-8d20ea22-4`: agents are categorically prohibited from making security-changing calls on the user's behalf, even with authorization. By keeping the privileged call out of the agent's call stack, the helper lets the v3.1.0+ admin task family (`invite-member`, `remove-member`, etc.) run end-to-end without crossing that boundary.

See:
- Decision record: `/shared/projects/access-control/decisions/permission-change-via-plan-page.md`
- Tech design: `/shared/projects/access-control/artifacts/permission-change-helper-tech-design.md`
- Standards: `agent-index-core/standards.md` § "Permission-Modifying Operations"
- Agent-side skill: `agent-index-core/api/permission-change-helper.md`

## Layout

```
lib/permission-helper/
├── show-plan.sh          # Canonical entry point (bash wrapper)
├── show-plan.js          # Main binary (Node)
├── listener.js           # HTTP server + SSE
├── lifecycle.js          # Listener state machine
├── apply.js              # Apply-script (spawned as child by listener)
├── template.js           # Page rendering helpers
├── validate.js           # Spec validator
├── templates/
│   └── page.html         # Review page (self-contained, strict CSP)
├── package.json          # Node engines requirement, no runtime deps
└── README.md             # This file.
```

At install time (during the agent-index-core upgrade flow), these files are copied to `<project_dir>/mcp-servers/permission-helper/` — analog to how `mcp-servers/filesystem/` is populated by the gdrive adapter. The agent-side skill invokes `<project_dir>/mcp-servers/permission-helper/show-plan.sh`.

## Usage

```bash
show-plan.sh /path/to/spec.json
```

The spec format is documented in the tech design. Briefly: a JSON object with `version`, `operations` (array of `{op, resource, recipient, role?, before?}`), and `context` (with `requestor`, `purpose`, optional `calling_task`).

The binary:

1. Validates the spec.
2. Picks a random localhost port and generates a one-time UUID token.
3. Renders the page from `templates/page.html` with the spec embedded as a `<script type="application/json">` block and the token in `data-token`.
4. Starts an HTTP listener and opens the user's default browser to the page.
5. Waits for one of: Accept (→ apply-script), Reject, idle timeout (10 min), page close (15s heartbeat gap), SIGINT/SIGTERM.
6. On Accept: spawns `apply.js` as a child, streams its JSON-per-line stdout to the page via SSE.
7. Writes a final JSON status report to its own stdout, exits with a meaningful code.

Exit codes:

| Code | Meaning |
|------|---------|
| 0    | Apply completed successfully |
| 1    | User clicked Reject |
| 2    | Idle timeout reached |
| 3    | Apply-script reported failure (partial or full) |
| 4    | Page closed without action |
| 5    | Validation error (bad spec, bad port, bad signature, etc.) |
| 130  | SIGINT |
| 143  | SIGTERM |

Final stdout JSON (single line):

```json
{
  "outcome": "applied|rejected|timed_out|page_closed|partial_failure|apply_error|validation_error|terminated",
  "applied_operations": [<op_index>, ...],
  "failed_operations": [{"op_index": N, "error": {...}}, ...],
  "verified_post_state": [{"op_index": N, "resource": "/path", "recipients": [...]}, ...],
  "user_edits": {...} | null,
  "error_detail": "..." | null
}
```

## Headless mode

For environments where browser launch isn't viable (CI, restricted firewalls, headless servers), invoke with `--cli`:

```bash
show-plan.sh /path/to/spec.json --cli
```

This skips the browser path entirely. The binary prints the spec as a human-readable summary to stderr, prompts y/N at the terminal, and on `y` runs the apply-script inline. Same exit codes, same security properties — the user's `y` is the deliberate action in lieu of the browser click.

## Dependencies

Runtime: Node ≥ 18. No external npm packages — Node stdlib only.

The apply-script invokes `aifs-exec.sh` from the gdrive adapter's install path (`mcp-servers/filesystem/aifs-exec.sh`). If the gdrive adapter is not installed or the v2.0 contract ops (`aifs_share`, `aifs_unshare`, `aifs_transfer_ownership`) are not implemented in the bundle, every operation will fail with `AIFS_EXEC_FAILED`. See bug `20260502-8d20ea22-2` for the upstream bundle gap.

## Versioning

Tracked separately from `agent-index-core`'s collection version. The helper version (in `package.json`) reflects the helper's own contract; the core version reflects the full collection. The agent-side skill `permission-change-helper.md` ships in core's api/ and tracks core's version cadence.

For v0.1: helper at 1.0.0, ships in core 3.3.0.

## Testing

Manual end-to-end testing requires:

1. A working agent-index install with the gdrive adapter (or a stub `aifs-exec.sh` that simulates v2.0 ops).
2. A sample spec at a known path (see `samples/` if added).
3. Invoke `bash show-plan.sh /path/to/sample-spec.json` and walk through the page.

Automated tests are out of scope for v0.1.
