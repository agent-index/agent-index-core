---
name: member-bootstrap
type: skill
version: 3.2.0
collection: agent-index-core
description: Guides a member through authenticating to the org's remote filesystem, verifying connectivity, creating the local member workspace, and registering with the org — the first step for any new member after unpacking the bootstrap zip.
stateful: true
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies:
  - name: Remote filesystem exec bundle
    description: The on-demand executor bundle (aifs-exec.bundle.js and aifs-exec.sh) must be present in mcp-servers/filesystem/. It is included in the bootstrap zip. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and guide the member to obtain a new bootstrap zip from their org admin.
---

## About This Skill

When a new member unpacks the bootstrap zip and opens Cowork (or Claude Code CLI) pointed at their `~/agent-index/` directory, they need to authenticate to the org's remote filesystem, verify connectivity, create their local workspace, and register themselves with the org. The Member Bootstrap Skill handles this entire flow.

**Runtime environment note:** The on-demand executor works identically in both runtimes. In Claude Code CLI and Cowork, the exec shell wrapper at `mcp-servers/filesystem/aifs-exec.sh` is called directly via bash. This skill detects which environment is active and guides accordingly.

This skill replaces the previous Filesystem Setup Skill. The old skill scanned for local cloud-sync mount points (Google Drive, OneDrive, Dropbox) and verified local directory access. The new model is different: the org's shared files live on a remote filesystem accessed through an on-demand executor, and member files live locally. This skill bridges the two — it gets the member authenticated to the remote side and creates the local workspace structure.

This skill is also the recovery tool when remote connectivity breaks — for example, when an OAuth refresh token is revoked and the member needs to re-authenticate. In normal operation, the on-demand executor handles access token refresh transparently (the member never sees auth prompts during regular use). Re-authentication is only needed when the refresh token itself is invalid — typically because the user revoked app access, the admin deleted the OAuth app, or the Google OAuth app is in "testing" status with 7-day refresh token expiry. In that context this skill runs a shorter reconnection flow rather than the full first-time setup.

### When This Skill Is Active

When invoked, this skill guides the member through a structured sequence: verify local bootstrap, authenticate to remote, test connectivity, create local workspace, register on remote, and hand off to preferences and capability setup.

This skill is triggered automatically by the Session Start Task when the member is detected as new (no local `member-index.json`). It is also triggered when session-start detects an authentication failure (`NOT_AUTHENTICATED` from the remote filesystem).

### What This Skill Does Not Cover

This skill establishes remote authentication and local workspace structure. It does not install collections, configure preferences, or set up member capabilities — those come after bootstrap is complete. It does not manage the remote filesystem backend choice or connection config — that is set during `create-org` by the org admin and baked into the bootstrap zip.

---

## Directives

### Remote Filesystem Access

All `aifs_*` operations are invoked via the on-demand executor shell wrapper: `bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh <tool_name> '<json_args>'`. Each call runs a fresh Node process, executes one operation, and exits. There is no persistent server or bridge. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and suggest '@ai:member-bootstrap'. In Cowork, `<project_dir>` resolves to the mounted workspace directory containing `agent-index.json`.

### Install Logging

This skill must maintain a structured install log during first-time setup and re-authentication flows. The log captures intent, actions, results, errors, and reasoning — providing a complete diagnostic record for agent-index developers to review. Skip logging for simple reconnection checks (where auth is already valid and only Step 4 runs).

**Log file:** `.agent-index/logs/member-bootstrap-{run_id}.jsonl` where `run_id` is a timestamp generated when the skill starts (e.g., `member-bootstrap-20260328T180000Z`). Create the `.agent-index/logs/` directory if it doesn't exist.

**When to write log entries:** Before and after every significant action. "Significant" means: step transitions, tool calls, decisions, errors, retries, and any moment where you are choosing between alternative approaches. The log should be continuous — there should never be a gap where something happened but wasn't logged.

**Critical rule:** Every log entry must be written to the file BEFORE the action it describes (for `intent` events) or IMMEDIATELY AFTER (for `result`, `error` events). Do not batch log entries. Do not skip logging because you are focused on solving a problem. If you find yourself troubleshooting, debugging, or trying alternative approaches, those are the MOST IMPORTANT moments to log — they are exactly what developers need to see.

**Log entry schema** (one JSON object per line, no trailing commas):

```json
{
  "ts": "ISO 8601 timestamp",
  "run_id": "member-bootstrap-{timestamp}",
  "session": 1,
  "step": "3",
  "event": "intent | result | error | decision | session_start | step_start | step_complete",
  "message": "Human-readable description of what is happening and WHY",
  "detail": {}
}
```

**Event types and when to use them:**

- **`session_start`**: First entry. Include: context type (first-time, re-auth, reconnection), member hash, whether the exec shell wrapper is available at `mcp-servers/filesystem/aifs-exec.sh`.
- **`step_start`** / **`step_complete`**: When beginning/finishing a step. Include: step number, duration, outcome.
- **`intent`**: BEFORE taking any action. Describe what you plan to do and why. This is the most important event type — it captures your reasoning. If you are considering multiple approaches, log that reasoning.
- **`result`**: AFTER an action completes successfully.
- **`error`**: When something fails. Include: the full error message, whether it's retryable, what you plan to do next.
- **`decision`**: When choosing between alternatives. Include: what the options were, which you chose, and why.

**Detail object:** Use `detail` for structured data — tool names, results, error codes, paths. Never log file contents containing credentials or tokens.

### Behavior

When invoked, determine the context: first-time setup, reconnection, or re-authentication.

- **First-time setup:** No `member-index.json` exists locally at `{project_dir}/members/{member_hash}/member-index.json`. The member has not been set up yet.
- **Re-authentication:** `member-index.json` exists locally (member is set up) but `aifs_auth_status()` returns `authenticated: false`. The credential has expired or been revoked.
- **Reconnection:** `member-index.json` exists and auth is valid, but the member is explicitly invoking this skill to verify or repair connectivity.

For re-authentication: skip directly to the authentication steps (Steps 2–3), verify connectivity (Step 4), then confirm and exit. Do not re-create the workspace or re-register.

For reconnection with valid auth: run the connectivity check (Step 4) only, confirm everything is working, and exit.

### First-Time Setup Sequence

**Step 1 — Verify local bootstrap**

Check that `agent-index.json` exists in the local project directory and contains a valid `remote_filesystem` section with `backend`, `connection`, and `auth` fields populated.

If valid: read the backend type and display it to the member. "Your org uses {Google Drive | Microsoft OneDrive | Amazon S3} for shared storage."

If `agent-index.json` is missing or the `remote_filesystem` section is empty/invalid: surface: "The bootstrap configuration is missing or incomplete. Make sure you've downloaded the correct bootstrap zip from your org admin and unpacked it into this directory." Halt.

**Step 2 — Check authentication status**

Call `aifs_auth_status()` to check if the member is already authenticated.

If `authenticated: true`: skip to Step 4. This can happen if the member previously authenticated (e.g., the admin who ran create-org) or if credentials were already configured.

If `authenticated: false`: proceed to Step 3.

**Step 3 — Authenticate member**

Guide the member through the backend-specific authentication flow.

Call `aifs_authenticate(action="start")` to initiate the flow. The adapter returns an `auth_url`, a `status` field, and backend-specific instructions.

The `status` field from `aifs_authenticate(action="start")` tells you which flow to use:

- `"awaiting_code"` — the adapter expects the member to paste back the URL their browser lands on after sign-in. **This is the normal path in Cowork and any other sandboxed environment**, because the browser running on the member's host cannot reach a callback server running inside our container.
- `"awaiting_callback"` — the adapter started a loopback callback server and will capture + exchange the code automatically. This happens only on developer-laptop installs where host == container. The member still just needs to sign in and grant access; if the redirect happens to fail, fall back to the paste-URL flow.

**Google Drive:**
Surface: "To connect to your org's shared storage, you'll need to sign in with your Google account. I'll give you a URL to open in your browser."

Present the OAuth URL from the `aifs_authenticate` response.

If `status` is `"awaiting_code"`: instruct the member: "Click this link, sign in with your Google account, and grant access. The browser will try to redirect to a `localhost` URL that won't load — that's expected. Copy the full URL from your browser's address bar and paste it back here." When the member pastes the URL (or just the code), call `aifs_authenticate(action="complete", auth_code="{pasted value}")` — the adapter will extract the code itself whether they pasted the full URL or just the code value.

If `status` is `"awaiting_callback"`: instruct the member: "Click this link, sign in with your Google account, and grant access. You'll see a success page when the handshake completes." Wait for the member to confirm they saw the success page, then call `aifs_authenticate(action="complete")` to verify. If they report the redirect failed, ask them to paste the full URL from their browser instead and call `aifs_authenticate(action="complete", auth_code="{pasted URL}")`.

**Microsoft OneDrive/SharePoint:**
Surface: "To connect to your org's shared storage, you'll need to sign in with your Microsoft account. I'll give you a URL to open in your browser."

Present the OAuth URL from the `aifs_authenticate` response. Follow the same paste-URL logic as Google Drive above, adjusted for Microsoft sign-in.

**Amazon S3:**
Surface: "To connect to your org's shared storage on AWS, you'll need to set up your AWS credentials. Your org admin should have provided instructions for your org's AWS setup."

Call `aifs_authenticate(action="start")` to get the auth instructions, then present them to the member. The instructions will mention three options: AWS SSO (`aws sso login`), access keys (`aws configure`), or environment variables. The member picks whichever their org uses.

Wait for the member to confirm they've configured credentials, then call `aifs_authenticate(action="complete")` to verify. This checks the AWS credential chain and confirms connectivity.

After authentication completes, verify via `aifs_auth_status()`. If `authenticated: true`: confirm to the member ("Connected as {user_identity}.") and proceed to Step 4.

If authentication fails: check the error details and handle accordingly:

- If the error includes `retryable: true` (expired or already-used authorization code): the code expired before it could be exchanged. This is the most common failure — surface: "The sign-in code expired. This happens if there's a delay. Let me generate a fresh link." Then immediately call `aifs_authenticate(action="start")` again to get a new URL. Do not ask the member to re-enter any configuration.
- If the error mentions `redirect_uri_mismatch`: this is a configuration issue. Surface: "There's a configuration mismatch with the sign-in setup. Please contact your org admin — they'll need to update the OAuth settings."

Other common issues:
- Wrong Google account: "Make sure you're signing in with the account your org admin shared access with."
- Wrong Microsoft account: "Make sure you're signing in with your org's Microsoft 365 account, not a personal Microsoft account."
- Microsoft consent not granted: "Your org's Azure AD admin may need to grant admin consent for the app. Contact your org admin."
- AWS credentials not found: "Run `aws configure` and enter the access key and secret key your org admin provided."
- AWS token expired (SSO): "Your SSO session may have expired. Run `aws sso login` again in a separate terminal, then confirm here."
- S3 access denied: "Your AWS credentials are valid but you don't have access to the S3 bucket. Contact your org admin to grant you read/write access to the bucket."

Do not proceed without successful authentication.

**Step 4 — Verify remote connectivity**

Confirm that the authenticated member can actually access the org's files on the remote filesystem.

Call `aifs_exists("/org-config.json")`.

If it returns `exists: true`: connectivity is confirmed. Read the org config: `aifs_read("/org-config.json")`. Extract the org name and display: "Connected to {org_name}'s agent-index."

If it returns `exists: false` or errors: surface the issue. Common causes:
- `ACCESS_DENIED`: "You're authenticated but don't have access to the org's files. Contact your org admin to grant access to the shared storage location."
- `BACKEND_ERROR`: Surface the backend-specific error message.
- The remote root may not be set up yet — if the admin hasn't completed create-org.

For re-authentication flows: stop here. Confirm connectivity is restored and exit: "Your connection is restored. You're good to go."

**Step 5 — Create local member workspace**

Determine the member's identity by computing SHA256 of the member's lowercase email address (from Cowork session context or from the auth identity returned by `aifs_auth_status()`) and taking the first 16 hexadecimal characters. This is the member's `member_hash`.

If the member's email cannot be determined: ask the member directly.

Confirm the member's display name (pre-populated from session context if available, otherwise ask).

Create the local directory structure:

```
{project_dir}/members/{member_hash}/
  /skills/
  /tasks/
  /profile/
```

If any of these directories already exist: skip creation, do not overwrite.

**Ensure the member's private remote space — "ensure-my-drive-space" subroutine** (reworked in core 3.9.0; this is the canonical definition, referenced by org-setup and apply-updates):

The member's private remote space is a folder named `Agent-Index-Private` **in the member's own My Drive** — created with the member's own credentials, owned by the member. It is NOT on the org Shared Drive (members cannot share Shared-Drive folders — Drive restricts folder-sharing to drive Managers; see standards.md § "Addressing").

1. `aifs_exists("id:root/Agent-Index-Private")`. If missing, create it:
   `aifs_write("id:root/Agent-Index-Private/.keep", "Agent-index private member space — created {date}")`.
2. `aifs_stat("id:root/Agent-Index-Private")` → record the **resolved** Drive ID as `new_id`. Never record the `root` alias anywhere — registry, handshake, member-index, and pointers must always carry real Drive IDs.
3. **One-time content migration:** if the local `member-index.json` already has a `member_folder_id` that differs from `new_id` AND `aifs_exists("id:{old_id}")` (a pre-3.9.0 Shared-Drive member space): recursively `aifs_list` the old space and copy every file to the same relative path under `id:{new_id}/`. **For each destination directory, materialize it first** (`aifs_write` of an empty `.keep`) — `aifs_copy` does NOT auto-create destination parents (verified live 2026-06-04; cross-drive copy itself works). Then `aifs_copy` per file (`source`/`destination` args); if a copy fails, fall back to `aifs_read` + `aifs_write` for that file. Never delete the old space (the admin archives it manually later). If there is no old space or no prior id, skip silently.
4. Write the handshake file so the admin-side reconcile can update the registry (members cannot write `/members-registry.json` fields reliably under least-privilege):
   `aifs_write("/shared/members/artifacts/{member_hash}/member-folder.json", {"member_hash": "{member_hash}", "member_folder_id": "{new_id}", "previous_folder_id": "{old_id or null}", "recorded": "{ISO 8601}"})`
5. Set `member_folder_id: "{new_id}"` in the local `member-index.json` (created below, or updated in place if it exists).

The subroutine is idempotent: re-runs find the folder existing, stat the same id, and harmlessly overwrite the handshake. All member-remote-space operations address the space as `id:{member_folder_id}/...` (standards.md § "Addressing: paths vs. ID anchors").

Create the local `member-index.json`:

```json
{
  "member_hash": "{member_hash}",
  "member_folder_id": "{new_id from the ensure-my-drive-space subroutine above}",
  "agent_index_version": "2.0.0",
  "last_updated": "{today YYYY-MM-DD}",
  "installed": {
    "skills": [],
    "tasks": []
  }
}
```

If `member-index.json` already exists: do not overwrite. This is a safety check — if it exists, this might be a re-run of setup and we should not lose installed capability records.

**Step 6 — Register member on remote**

Read the current `members-registry.json` from the remote filesystem: `aifs_read("/members-registry.json")`.

Check if the member is already registered (by `member_hash`).

If not registered: add the member's entry:

```json
{
  "member_hash": "{member_hash}",
  "display_name": "{display_name}",
  "email": "{email}",
  "org_role": null,
  "joined_date": "{today YYYY-MM-DD}"
}
```

Write the updated registry back: `aifs_write("/members-registry.json", "{updated content}")`.

If already registered: update `display_name` and `email` if they've changed, otherwise leave as is.

Surface: "You're registered with {org_name}."

**Step 7 — Write local profile**

Write the filesystem configuration to the member's local profile:

```
{project_dir}/members/{member_hash}/profile/filesystem.md
```

```markdown
# Filesystem Configuration
**Configured:** {date}
**Last Verified:** {date}

## Local Paths
project_root: {project_dir}
member_root: {project_dir}/members/{member_hash}/
member_hash: {member_hash}

## Remote Connection
backend: {backend type}
auth_method: per-member
auth_identity: {email or user identity from auth}
org_name: {org_name}
status: connected
```

**Step 8 — Confirm and hand off**

Confirm to the member that bootstrap is complete:

> "You're all set up and connected to {org_name}. Next, I'll help you configure your preferences and install your org's skills and tasks."

**Offer install log upload:** If an install log file exists in `.agent-index/logs/` for this run and `log_collector_url` is configured in `agent-index.json`, offer to share it:

> "Your setup generated a diagnostic log that can help the agent-index team improve the experience. It contains step-level diagnostics with hashed identifiers — no credentials or personal information. Would you like to share it?"

If the member accepts: invoke the `upload-install-log` task. If they decline: "No problem. The log is at `.agent-index/logs/{log_filename}` if you change your mind." If `log_collector_url` is not configured: skip silently.

Hand off to the preferences-management skill for the initial setup interview, then to org-setup for capability selection and installation.

If the member declines to continue: accept, and tell them they can say '@ai:prefs' for preferences or '@ai:setup' for capability setup anytime.

### Re-Authentication Flow

When invoked for re-authentication (member-index.json exists, auth status is false):

1. Surface: "Your connection to {org_name} needs to be refreshed. Let me help you re-authenticate — this will just take a moment."
2. Run Steps 2–3 (auth check and auth flow)
3. Run Step 4 (connectivity verification)
4. Update `filesystem.md` with new `Last Verified` date
5. Confirm: "Your connection is restored."

Do not re-create the workspace, re-register, or re-run preferences/setup.

### Automatic Invocation Behavior

When triggered by session-start (because `aifs_auth_status()` returned `authenticated: false`):

> "Your remote filesystem credentials have expired. Let me help you reconnect."

Then run the re-authentication flow. Keep it minimal — the member did not ask for this.

### Style & Tone

This skill is designed for members who may have no technical background. The authentication step is the most technical part — frame it in terms of actions, not concepts.

"Sign in with your Google account" — not "Complete the OAuth2 authorization flow."
"Paste the URL your browser lands on after signing in" — not "Provide the authorization code from the callback."

When something goes wrong, be specific and actionable. "Contact your org admin" is always an acceptable fallback, but include what to tell them.

### Constraints

Never write to any remote file other than `members-registry.json`. This skill reads from remote for org context but only writes the member registry entry. All other remote writes are handled by other skills and tasks.

Never overwrite an existing local `member-index.json`. If it exists, the member has installed capabilities and overwriting would lose that data.

Never store or display raw credentials or tokens. The adapter manages credential storage. This skill only orchestrates the auth flow — it never handles the actual secret material.

Never proceed past Step 3 without confirmed authentication. Every subsequent step depends on remote access.

Never create directories outside of `{project_dir}/members/{member_hash}/`. This skill creates the member's local workspace — nothing else.

### Edge Cases

If the member's auth identity (email from `aifs_auth_status()`) does not match their Cowork session email: surface this as a warning. "You authenticated as {auth_email} but your agent-index identity is based on {session_email}. Make sure you're using the correct account for your org." Proceed with the session email for member_hash computation — the auth identity is for storage access, the session email is for agent-index identity.

If `members-registry.json` cannot be read from remote (e.g., file doesn't exist): this likely means the org admin hasn't completed create-org. Surface: "The org's member registry doesn't exist yet. Your org admin needs to complete org setup first. Contact them and ask them to run create-org."

If the remote `org-config.json` version is newer than the local `agent-index.json` version: surface as an advisory notice. The bootstrap zip may be outdated. The member can still proceed, but they should request an updated bootstrap zip from their admin.

If the exec shell wrapper is not found at `mpc-servers/filesystem/aifs-exec.sh`, the exec bundle is missing from the install. Surface an error: "The remote filesystem exec bundle is missing from your bootstrap zip. Contact your org admin for a new bootstrap zip." In Cowork, the plugin validates the exec bundle presence — if the plugin is installed and the bundle is missing, it will surface this error during plugin installation.

If the member workspace already exists locally but member-index.json does not: this is a partial prior setup. Create member-index.json without recreating the directory structure. Proceed normally.

If a network timeout occurs during any remote call: surface the timeout, explain that the remote filesystem may be temporarily unavailable, and offer to retry. For auth flows, the auth code may still be valid — try completing with the same code before regenerating.
