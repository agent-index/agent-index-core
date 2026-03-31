---
name: session-start
type: task
version: 2.0.0
collection: agent-index-core
description: Executes automatically at the start of every Cowork session to load member context, register installed capabilities, and surface system notices before any member interaction.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem MCP server
    description: The agent-index-filesystem MCP server must be running for remote connectivity checks, org config reads, and update checks. In Claude Code CLI it is started by .claude/settings.json. In Cowork it is started by the agent-index-filesystem plugin.
reads_from: null
writes_to: null
---

## About This Task

The Session Start Task is the foundation of every agent-index session. It runs automatically and silently before any member interaction begins. Its job is to reconstruct the member's working context from the member's local workspace and the org's remote filesystem so that Claude arrives at the first member interaction already oriented — knowing who the member is, what capabilities they have installed, what aliases invoke those capabilities, and whether anything in their environment requires attention.

This task does not perform work on behalf of the member. It performs work on behalf of the system, so that every subsequent interaction in the session is informed and capable rather than cold and generic.

Because this task runs before the member can intervene, it is designed to be fault-tolerant. Partial context is better than no context. If later steps fail, Claude surfaces what is missing and continues with what it has. The only unrecoverable failure is the inability to read the member index — without it, Claude cannot know what this member has installed and cannot provide a meaningful session.

### What a Member Experiences

In a correctly configured environment, the member experiences nothing unusual — Claude is simply ready. At the configured verbosity level, Claude may confirm readiness with a brief summary. At `silent`, nothing is surfaced unless there are notices that require attention (deprecation warnings always surface regardless of verbosity).

If something went wrong during session start, Claude surfaces a clear, specific notice about what is missing and offers to resolve it before proceeding.

### What This Task Does Not Cover

This task does not install, upgrade, or configure anything. It does not interact with the collection layer or the marketplace. It does not make decisions about the member's work. It is purely a context-loading and notice-surfacing operation. It reads from both local files (member workspace) and remote files (org config, members registry, collection versions via `aifs_*` tools), but never writes to either.

---

## Workflow

### Step 1: Read Member Index

Compute the member's `member_hash` by taking SHA256 of the member's lowercase email address (from Cowork session context) and using the first 16 hexadecimal characters. Read the local file `members/{member_hash}/member-index.json` from the project directory.

Parse the full contents. Register all installed skills and tasks into session context including: name, collection, installed path, version, assigned alias, alias override (if set), and EOL date. The effective alias for each entry is the `alias_override` if set, otherwise the `alias` field.

This step is the only hard dependency in the entire sequence. If `member-index.json` cannot be found or cannot be parsed:

**On success:** Proceed to Step 2 with full registry loaded.

**On failure:** Halt session start. Surface the following to the member:

> "I wasn't able to load your agent-index member index. This file is required to know what skills and tasks you have installed. This usually means your member profile hasn't been set up yet. To fix this: if you haven't set up agent-index yet, say **'set up my agent-index member workspace'** to begin. If you have set up before and need to reconnect to remote storage, say **'@ai:member-bootstrap'** to re-authenticate."

Do not proceed with any further steps. Do not attempt to infer installed capabilities from the filesystem directly.

---

### Step 2: Check Remote Filesystem Connectivity

First, check whether `aifs_*` tools are available in the tool list. If they are not present at all, the MCP server did not start. This is a different condition from "server running but not authenticated" — it means the server launch mechanism is not configured for this runtime.

**If `aifs_*` tools are not in the tool list:** Proceed to Step 3 with a tool-availability notice queued for Step 8. The member can still use locally installed capabilities, but all remote operations will be unavailable. The notice should reflect the runtime environment:

In Cowork:
> "The remote filesystem tools aren't available — the agent-index-filesystem plugin may not be installed. Look for `agent-index-filesystem.plugin` in your workspace folder, install it, and restart this Cowork session. You can still use your installed skills and tasks this session. Say '@ai:member-bootstrap' if you need help."

In Claude Code CLI:
> "The remote filesystem connector isn't responding. You can still use your installed skills and tasks this session. Check that `.claude/settings.json` includes the MCP server configuration and restart the session, or say '@ai:member-bootstrap' to troubleshoot."

Skip the `aifs_auth_status()` call and all subsequent remote operations (Steps 5 and 7 depend on remote access and will be skipped per their existing remote-unavailable handling).

**If `aifs_*` tools are available:** call `aifs_auth_status()` to verify authentication.

**If `authenticated: true`:** Confirm connectivity by calling `aifs_exists("/org-config.json")`. If the file exists, remote connectivity is confirmed. Proceed to Step 3.

**If `authenticated: true` but `aifs_exists("/org-config.json")` fails or returns `exists: false`:** Proceed to Step 3 with a connectivity warning queued for Step 8. The member can still use locally installed capabilities.

> "The remote filesystem is authenticated but the org configuration could not be read. You can still use your installed skills and tasks this session, but you won't be able to install new capabilities or check for updates until connectivity is restored. Say '@ai:member-bootstrap' if you'd like to troubleshoot."

**If `authenticated: false`:** Proceed to Step 3 with an authentication failure notice queued for Step 8. Do not halt — the member index was already loaded in Step 1 and the session can proceed with locally installed capabilities. Queue the following notice for Step 8:

> "Your remote filesystem credentials have expired. You can still use your installed skills and tasks this session, but you won't be able to install new capabilities or check for updates until you re-authenticate. Say '@ai:member-bootstrap' to reconnect."

**If `aifs_auth_status()` itself errors (MCP server running but unresponsive):** Proceed to Step 3 with a connectivity failure notice queued for Step 8:

> "The remote filesystem connector isn't responding. You can still use your installed skills and tasks this session. If this persists, say '@ai:member-bootstrap' to troubleshoot."

---

### Step 3: Load Always-On Skills

Read `preferences.md` from the member's local workspace at `members/{member_hash}/profile/preferences.md`.

Extract the `always_on_skills` list. For each skill listed:

1. Look up the skill in the registered member index from Step 1
2. If found: read the skill definition file from its `installed_path`
3. Load the skill's `Directives` section into active session context
4. Mark the skill as loaded

If a skill listed in `always_on_skills` is not found in the member index (it was listed in preferences but is not installed):
- Queue a notice for Step 6: "{skill-name} is listed as always-on in your preferences but does not appear to be installed. Say '@ai:setup' to install it."
- Continue with remaining skills — do not halt.

If `preferences.md` cannot be read:
- Skip always-on skill loading entirely
- Queue a notice for Step 6: "Your preferences file could not be read. Default settings will be used this session. Say '@ai:prefs' to review or restore your preferences."
- Continue to Step 4.

**On success:** All available always-on skills loaded. Proceed to Step 4.

---

### Step 4: Check Deprecation Warnings

Scan the `eol_date` field of every entry in the member index loaded in Step 1.

For each entry where `eol_date` is not null:
1. Calculate the number of days between today and the `eol_date`
2. Compare against the member's configured `deprecation_warning_threshold` (default: 60 days; read from `preferences.md` if loaded, otherwise use default)
3. If days remaining is less than or equal to the threshold: queue a deprecation notice for Step 6

Deprecation notice format:
> "{display-name} (from {collection}) will reach end of life on {eol_date} — {N} days from now. Say '@ai:marketplace' to check for an upgrade."

If `eol_date` has already passed:
> "{display-name} (from {collection}) passed its end-of-life date on {eol_date}. It may no longer function correctly. Say '@ai:marketplace' to upgrade or replace it."

Deprecation warnings are always surfaced in Step 6 regardless of the member's `session_summary_verbosity` setting.

**On success:** All EOL dates checked, notices queued as needed. Proceed to Step 5.

---

### Step 5: Check for Available Updates (Lightweight)

Check the member's preferences to determine if `session_start_update_notices` is enabled (default: true). If disabled, skip this step entirely and proceed to Step 6.

If enabled, perform a lightweight update check. This is not a full `check-updates` run — it uses locally available information only and makes at most one network request (marketplace cache refresh).

**Infrastructure check:** If Step 2 confirmed remote connectivity, read the remote `agent-index-core/collection.json` and `agent-index-marketplace/collection.json` versions via `aifs_read`. If `check-updates` has been run before and cached its results in the remote marketplace cache at `/shared/marketplace-cache/last-update-check.json` (via `aifs_read`), compare against those cached results. If no cached results exist, skip infrastructure version comparison (a full `check-updates` will establish the baseline). If remote connectivity failed in Step 2, skip this check entirely.

**Collection check:** If the marketplace cache is fresh (not expired per `marketplace_cache_ttl_hours`), compare installed collection versions from `org-config.json` (read via `aifs_read("/org-config.json")` if remote is available) against the cached marketplace directory. If the cache is expired, do not trigger a refresh — session-start should not make remote requests that could delay startup. Use the existing cache regardless of staleness. If remote connectivity failed in Step 2, skip this check entirely.

**Capability check:** Compare the member's installed capability versions from their local `member-index.json` against the collection versions on the remote filesystem (via `aifs_read("/{collection}/collection.json")` for each collection the member has capabilities from). If remote connectivity is unavailable, skip this check — it requires remote access to compare against current collection versions.

Queue notices for Step 8 based on results:

- If infrastructure updates are available (from cached check-updates results):
  > "Agent-index infrastructure updates are available. Say '@ai:check-updates' for details."

- If collection updates are available (from marketplace cache comparison):
  > "{N} installed collection(s) have updates available. Say '@ai:check-updates' for details."

- If capability upgrades are available (member's version behind collection version):
  > "{N} of your installed capabilities can be upgraded. Say '@ai:setup' to upgrade, or '@ai:check-updates' for details."

These notices are advisory. They surface at the same priority level as role-based collection suggestions — below deprecation warnings and hard failures.

If any check encounters an error (file unreadable, missing cache): skip silently. Update notices are informational and must never delay or disrupt session start.

**On success:** Notices queued as applicable. Proceed to Step 6.

---

### Step 6: Load Active Task State

Determine whether a specific task is indicated for this session. A task is considered indicated if:
- The member's working directory context corresponds to a task folder
- The member's first message explicitly names a task or uses a task alias
- The member's `preferences.md` lists the task under `eager_loading_exceptions`
- The member's global `task_state_loading` preference is set to `eager`

If a task is indicated:
1. Look up the task in the member index
2. Read `current-state.md` from the task's `installed_path/state/current-state.md`
3. Load the state into active session context
4. Mark the task as active for this session

If `current-state.md` does not exist for an indicated task (first session with this task):
- This is normal — proceed without loading state
- The task will write its first `current-state.md` at the end of this session

If no task is indicated and `task_state_loading` is `lazy` (default):
- Skip state loading
- Task state will load on demand when the member invokes a task

**On success:** State loaded if applicable. Proceed to Step 7.

---

### Step 7: Check Pending Role-Based Collection Installs

If Step 2 confirmed remote connectivity: read the member's `org_role` from the remote `members-registry.json` via `aifs_read("/members-registry.json")` (look up by `member_hash`). If remote connectivity is unavailable, skip this step entirely — role-based suggestions require remote access.

If the member has an `org_role` set (not null):
1. Read `org-config.json` via `aifs_read("/org-config.json")` and find the matching role in `org_roles`
2. Get the role's `default_collections` list
3. Compare against the member's installed capabilities in the local `member-index.json` — specifically, check which collections the member has at least one skill or task installed from
4. For each collection in `default_collections` that the member has NO installed skills or tasks from: queue a notice for the final step

Notice format:
> "Your org role ({role display name}) includes the {collection display name} collection, which you haven't installed yet. Say '@ai:setup' to add it."

If the member has no org_role, or if org_roles is empty in org-config: skip this step entirely.

**On success:** Proceed to the final notices step.

---

### Step 8: Surface Notices and Confirm Readiness

Collect all queued notices from Steps 2–7. Surface them to the member in this priority order:

1. **Hard failures** (anything that blocks a capability — missing always-on skill, connectivity failure)
2. **Deprecation warnings** (always shown, regardless of verbosity)
3. **Advisory notices** (remote connectivity warning, preference file issues)
4. **Update-available notices** (infrastructure, collection, or capability updates — from Step 5)
5. **Role-based collection suggestions** (recommended collections not yet installed)

Then confirm session readiness at the member's configured `session_summary_verbosity` level:

**`brief` (default):**
> "Ready. {N} skills and tasks loaded. {Any notices.}"

**`detailed`:**
> "Session ready for {member display name} — {role display name}.
> Always-on skills: {list}
> Installed capabilities: {N} skills, {N} tasks
> {Any notices.}"

**`silent`:**
Surface only notices that require attention (deprecation warnings, hard failures). No readiness confirmation otherwise.

If there are no notices and verbosity is `silent`: output nothing. The session begins without any session-start message.

Update-available notices (from Step 5) are only shown at `brief` and `detailed` verbosity. They are suppressed at `silent` unless they involve a MAJOR infrastructure update, which always surfaces.

**On completion:** Session start is complete. Claude is ready for member interaction.

---

## Directives

### MCP Tool Usage

This task uses `aifs_*` MCP tools on the `agent-index-filesystem` server for remote filesystem access. These are MCP tool calls — invoke them through the MCP tool interface, never via shell scripts or direct invocation of `server.bundle.js`.

If `aifs_*` tools are not found in the tool list, the MCP server did not start. This is distinct from authentication failure (where the tools exist but return `authenticated: false`). When tools are entirely absent, the cause depends on the runtime environment, and the notice queued for Step 8 should reflect this:

- **Cowork:** The plugin is not installed. Queue: "The remote filesystem tools aren't available — the agent-index-filesystem plugin may not be installed. Look for `agent-index-filesystem.plugin` in your workspace folder, install it, and restart this Cowork session. Say '@ai:member-bootstrap' if you need help."

- **Claude Code CLI:** The settings.json config is missing or the server failed to start. Queue: "The remote filesystem connector isn't responding. Check that `.claude/settings.json` includes the MCP server configuration and restart the session. Say '@ai:member-bootstrap' to troubleshoot."

### Behavior

Run this task automatically at the start of every session before any member interaction. Do not wait for the member to invoke it. Do not announce that you are running it unless a notice needs to be surfaced or the verbosity setting calls for a readiness confirmation.

Execute steps sequentially. Do not skip steps unless a step's own failure handling explicitly permits skipping. Do not re-order steps.

Treat this task as infrastructure, not as a member-facing interaction. The member did not ask for this to run — it runs because it must. Keep all output minimal and purposeful.

### Fault Tolerance

Step 1 is the only hard failure. If `member-index.json` cannot be read, halt and surface the recovery message defined in Step 1. Do not attempt any further steps.

For all other steps: a failure is a degraded condition, not a session-ending condition. Queue a notice, continue with reduced capability, and surface the notice in Step 8. Never silently swallow a failure — always surface what is missing and offer a path to resolution.

Do not attempt to infer or reconstruct missing information from the filesystem. If a file is missing, say it is missing. The member or admin must resolve it through the appropriate skill or task.

### Notice Tone

Notices surfaced in Step 6 must be:
- Specific: name the exact skill, task, or file that has the issue
- Actionable: always include what the member can do to resolve it
- Non-alarming: degraded capability is normal in some situations (first setup, reconnecting after travel). Do not frame notices as errors unless they are genuinely blocking.

### State Management

This task is `stateful: false`. It does not write `current-state.md`. It has no persistent state of its own — its outputs are loaded into session context and written to the session summary, not to disk.

### Constraints

Never modify any file during session start — local or remote. This task reads files — it never writes, moves, creates, or deletes them. The only exception is `current-state.md` for other tasks loaded in Step 6, which is a read operation.

Never prompt the member for input during session start. If information is missing, queue a notice for Step 8. The member will respond to that notice if they choose to. Do not block session start waiting for member input.

Never surface more than one readiness confirmation. If verbosity is `brief` or `detailed`, one summary message at the end of Step 8. Nothing during the steps themselves unless a hard failure in Step 1 requires immediate surfacing.

Never infer a member's identity. The `member-index.json` path must include the correct member ID. If Claude is operating in an environment where the member ID is ambiguous, surface an error and halt rather than guess.

### Edge Cases

If `member-index.json` exists but is empty or contains no installed skills or tasks: this is a valid state (member has not installed anything yet). Proceed normally. In Step 6, surface: "No skills or tasks are installed yet. Say '@ai:setup' to get started."

If an always-on skill's definition file exists in the member index but the file at `installed_path` cannot be read: queue a notice that the skill file is missing or corrupted and offer '@ai:setup' to reinstall. Do not halt.

If the member has both `alias` and `alias_override` set for an entry: always use `alias_override` as the effective alias. Register both in session context so Claude can recognize either form.

If `preferences.md` is readable but missing specific fields (e.g., `always_on_skills` is absent): use the system defaults for missing fields. Do not treat a partial preferences file as a failure.

If a deprecation warning EOL date has already passed and the skill or task is still installed: surface the past-EOL notice as a high-priority notice, above other deprecation warnings but below hard failures.

If multiple entries in the member index share the same effective alias (a collision that should have been caught at install time but wasn't): surface a collision warning in Step 6 naming both entries and recommend '@ai:prefs' to resolve. Register both entries but note the ambiguity — when the member invokes that alias, Claude should ask which they mean until the collision is resolved.
