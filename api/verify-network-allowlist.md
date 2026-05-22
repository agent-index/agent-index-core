---
name: verify-network-allowlist
type: task
version: 1.0.0
collection: agent-index-core
description: Tests reachability of all required hosts in the canonical network allowlist. Surfaces any blocked hosts with actionable allowlisting instructions. Re-runnable any time to confirm coverage after allowlist changes or to diagnose install failures.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
reads_from: "agent-index-core/templates/network-allowlist.template.json (canonical host list); agent-index.json (log_collector_url)"
writes_to: null
---

## About This Task

`@ai:verify-network-allowlist` is the standalone version of the reachability check that runs at org-setup time (per `create-org.md` Step 3b). It tests every host in the canonical network allowlist and surfaces which hosts are blocked by the current Cowork network environment.

Use cases:
- An admin updates their allowlist and wants to confirm coverage before running collection installs.
- A collection install fails mysteriously and the admin wants to rule out network issues quickly.
- Periodic audit of allowlist coverage.

The task is non-destructive: it issues HTTPS GET requests, doesn't mutate state, and can be re-run any number of times.

### Inputs

None. The task is invocation-only — no parameters, no setup state to read.

### Outputs

Surface to chat:
- A summary line ("All N required hosts reachable" / "{B} of {N} required hosts blocked").
- For blocked hosts: each named with its `purpose` annotation and actionable allowlisting instructions.

### Cadence & Triggers

On demand. Natural-language phrases that map here include: "verify network allowlist", "check my allowlist", "is my network configured", "test network reachability". The `@ai:verify-network-allowlist` alias is the explicit invocation.

---

## Workflow

### Step 1: Read the canonical host list

Read `agent-index-core/templates/network-allowlist.template.json` from the local agent-index install directory (typically `<project_dir>/agent-index-core/templates/network-allowlist.template.json` after Phase 1 step 6 of apply-updates has copied it locally).

If the file is missing: surface "The canonical allowlist file is not present in your install. Run `@ai:update` to fetch the latest core, then retry. If the file still doesn't appear, your install may be corrupted — try `@ai:member-bootstrap`." Halt.

Parse the JSON. Verify `schema_version` is `1.0` (current). If higher, surface "This allowlist file uses schema version {X} which is newer than this task understands. Update your install via `@ai:update`." Halt.

### Step 2: Build the host list to test

Mirroring `create-org.md` Step 3b's algorithm:

1. **Infrastructure tier:** every entry in `infrastructure[]` with `tested_by: "setup-time-reachability-check"`. All `required: true`.

2. **Telemetry tier:** read `<project_dir>/agent-index.json` and inspect `log_collector_url`. If non-empty, parse the hostname and add as a single entry with `required: false`. If empty, skip telemetry entirely.

3. **Backend tier:** read `<project_dir>/agent-index.json` and inspect `remote_filesystem.backend`. If `backend.{backend_id}` is enumerated in the canonical file (currently only `gdrive`), use those entries. Otherwise, read the adapter's `adapter.json` (at `<project_dir>/mcp-servers/filesystem/adapter.json`) and use its `required_domains` field, treating each as `required: true, tested_by: setup-time-reachability-check`.

### Step 3: Test each host

For each host in the assembled list:

1. Issue an HTTPS GET against `https://{host}/` with a 10-second timeout. Use bash `curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://{host}/`.
2. Acceptance: any HTTP response code (200, 301, 302, 401, 403, 404) is treated as reachable — the host responded, even if the specific endpoint isn't a valid API path. The point is to verify network connectivity, not API correctness.
3. Failure conditions: connection-refused, connection-timeout, or proxy-403 with zero content-length and no upstream headers. Distinguish proxy-403 (allowlist-blocked) from host-403 (host responded; we just hit a forbidden path) by checking for upstream-server headers in the response.

Issue tests in parallel where possible. ~5–10 hosts on a typical setup completes in 1–2 seconds when parallelized.

### Step 4: Report

**If all required hosts pass:**

> "Your network allowlist is complete. Tested {N} hosts; all reachable. ✓
>
> Infrastructure: {list reachable infrastructure hosts}
> Backend ({backend_id}): {list reachable backend hosts}
> {if telemetry tested}: Telemetry: {host} — {reachable | not reachable (optional)}"

If `blocked_optional` is non-empty (telemetry hosts blocked but required hosts pass):

> "Optional telemetry host(s) blocked: {hosts}. Install diagnostics will be skipped. To enable, allowlist {hosts} and re-run this check."

**If any required host is blocked:**

> "Network allowlist incomplete. {B} of {N} required hosts are blocked:
>
> Blocked:
> - `{host1}` — {purpose1}
> - `{host2}` — {purpose2}
> ...
>
> To fix:
> 1. Go to **claude.ai** → **Admin Settings** → **Capabilities** → **Network access**
> 2. Add ALL of the following hosts to the allowlist: {comma-separated list of blocked hosts}
> 3. Save the changes
> 4. Start a **new Cowork session** (allowlist changes require a new session to take effect)
> 5. Re-run `@ai:verify-network-allowlist` to confirm coverage."

### Step 5 (optional): Persist the result

If the admin invoked with `--persist`: write `<project_dir>/.agent-index/last-allowlist-check.json` with `{timestamp, schema_version, results: [{host, tier, reachable, http_code}], summary}`. Useful for diagnostics or audit trails.

---

## Directives

### Behavior

This is a fast, transparent check. Avoid verbose narration — admins typically invoke when they want a yes/no answer. The "all green" path should be a single confirmation sentence + the host list. The "some blocked" path should give the admin exactly what they need to fix it.

If the admin asks about a specific host ("is google.com reachable" or similar), the task can also accept that as a one-off check by passing the host as an invocation argument — but this is convenience, not the core flow.

### Constraints

Never mutate state. The task is purely diagnostic.

Never assume a specific blocked host is benign without testing — e.g., if the admin says "skip telemetry," that's still a host the task verifies and surfaces; the admin decides what to do with the result.

Never cache results across invocations (other than via the optional `--persist` write). The whole point of the task is "test right now."

### Edge Cases

- **Curl unavailable:** if the runtime can't issue the HTTPS GET (no curl, no Node http module), fall back to a different fetch mechanism if available; otherwise surface "Cannot run reachability test in this environment — curl and Node http both unavailable." Halt.

- **All hosts time out simultaneously:** likely a complete network outage rather than allowlist drift. Surface "All hosts timed out. Check your internet connection rather than allowlist." Don't list every host.

- **Schema version newer than expected:** surface and halt as in Step 1.
