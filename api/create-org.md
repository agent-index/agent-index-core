---
name: create-org
type: task
version: 2.0.0
collection: agent-index-core
description: First-time org setup — establishes the org's identity, configures the remote filesystem backend, uploads org resources, generates the member bootstrap zip, sets up the admin's local workspace, and optionally defines org roles.
stateful: true
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills:
    - member-bootstrap
    - org-setup
  tasks: []
external_dependencies:
  - name: Remote filesystem backend
    description: The admin must have access to a supported remote storage service (Google Drive, OneDrive, or S3) and appropriate credentials to authenticate.
reads_from: null
writes_to: null
---

## About This Task

Create-org is the first thing an org admin runs after cloning agent-index-core. It establishes the org's presence in the agent-index system — giving the org a name and ID, configuring the remote filesystem backend, uploading org resources, generating a bootstrap zip for member distribution, recording the initial admin list, and optionally launching the marketplace to install collections.

The remote filesystem replaces the previous shared-mount-drive model. Instead of requiring every member to mount a shared drive locally, the org's files live on a remote storage backend (Google Drive, OneDrive, or S3) accessed through an MCP server. Each member authenticates individually to the backend during their own setup. The admin configures the backend choice and connection details during this task.

This task is run once per org. If `org-config.json` already exists on the remote filesystem, this task detects it and offers `edit-org` instead.

### Inputs

The org admin provides: org name, remote filesystem backend choice, backend connection config, initial admin list. Optionally: launches the marketplace flow to install collections.

### Outputs

Written to the remote filesystem via MCP:
- `org-config.json` at the remote root — the authoritative org configuration record
- `members-registry.json` at the remote root — the member lookup table
- `CLAUDE.md` at the remote root — Claude context for the system
- `/shared/` directory structure initialized with all required subdirectories
- `/shared/bootstrap/member-bootstrap.zip` — the downloadable bootstrap package for members

Written locally:
- `agent-index.json` updated with the configured remote filesystem section
- `.claude/settings.json` with the MCP server configuration and session hook
- `CLAUDE.md` local copy
- The admin's local member workspace

### Cadence & Triggers

Run once at org inception. Not repeatable — detected and redirected to `edit-org` if org is already configured.

---

## Workflow

### Step 0: Check for Install State (Resume from Previous Session)

Before doing anything else, check for `.agent-index/install-state.json` in the project directory.

If the file does not exist: proceed to Step 1 normally.

If the file exists and `status` is `"completed"` or any unrecognized value: ignore it and proceed to Step 1 normally.

If the file exists and `status` is `"awaiting-network-allowlist"` or `"awaiting-session-restart"`:

1. Surface: "I found a saved install state from a previous session. Let me verify everything is ready to continue."

2. Read the `required_domains` object from the install state file. This contains two groups:

   - `infrastructure`: domains needed to download adapter bundles (e.g., `raw.githubusercontent.com`)
   - `backend`: domains needed for the chosen storage backend's API (e.g., `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`)

   Test ALL domains from both groups for network reachability by attempting an HTTP CONNECT through the proxy (if `HTTPS_PROXY` is set) or a direct HTTPS connection.

   The test is: attempt an HTTP `CONNECT {domain}:443` request through the proxy. A `200` response means the domain is reachable. A `403` with `X-Proxy-Error: blocked-by-allowlist` means it is still blocked. DNS failure (`EAI_AGAIN`) means no proxy is being used and direct DNS is unavailable.

3. If ALL required domains are reachable:

   Surface: "Network access confirmed — all required domains are reachable. Resuming setup."

   Check what was completed in the previous session by inspecting `completed_steps`:

   - If `completed_steps` includes `"3c"` (config files and bundle already written): restore the collected state (`org_name`, `org_id`, `backend`, `connection` config) from the install state file and skip directly to **Step 4** (authentication).

   - If `completed_steps` only goes through `"3b"` or earlier (domains were blocked before bundle download): restore the collected state and resume at **Step 3c** (download bundle and write config files).

4. If ANY required domain is still blocked: surface the specific domains that remain blocked and re-display the allowlisting instructions:

   > **The following domains are still not reachable:**
   > - `{domain}`: {reason}
   >
   > These domains must be added to your Cowork network allowlist before setup can continue.
   >
   > **To update your network allowlist:**
   > 1. Go to **claude.ai** → **Admin Settings** → **Capabilities** → **Network access**
   > 2. Add the following domains to the allowlist:
   >    {list of all blocked domains}
   > 3. Save the changes
   > 4. Start a **new Cowork session** (allowlist changes require a new session to take effect)
   > 5. Open the same project folder and say: **"continue the agent-index org setup"**

   Halt. Do not proceed.

---

### Step 1: Check for Existing Org Configuration

Read `agent-index.json` from the local project directory. Check if `remote_filesystem` is already fully configured (backend and connection fields populated).

If the remote filesystem is already configured: start the MCP server and attempt `aifs_exists("/org-config.json")`. If it exists, read it and surface: "It looks like this org is already configured as '{org_name}'. Would you like to edit the org configuration instead?" If yes: invoke `run agent-index task edit-org`. Halt this task.

If the remote filesystem is not configured (empty backend/connection fields): this is a fresh install. Proceed to Step 2.

If `agent-index.json` cannot be read: surface: "I couldn't find the agent-index root configuration file. Make sure you've cloned agent-index-core into this directory before running org setup." Halt.

---

### Step 2: Collect Org Name

Ask: "What is the name of your organization?"

Accept any non-empty string. Generate the org ID: lowercase, spaces and special characters replaced with hyphens, consecutive hyphens collapsed, leading and trailing hyphens removed.

Show the generated ID: "I'll use `{org-id}` as your org's identifier — this is used internally and in directory names."

**On success:** Proceed to Step 3.

---

### Step 3: Choose Remote Filesystem Backend

Explain: "Agent-index stores your org's shared files — collection definitions, org config, shared reports — on a remote filesystem that all members access through an MCP server. Each member authenticates individually during their own setup."

Read the available backends from `filesystem-adapter-directory.json` (fetch from `filesystem_adapter_directory_url` if not cached). Present the supported backends based on the directory entries:

> **Supported storage backends:**
> 1. **Google Drive** — Uses a shared drive or folder. Members authenticate via Google OAuth.
> 2. **Microsoft OneDrive/SharePoint** — Uses a OneDrive folder or SharePoint document library. Members authenticate via Microsoft OAuth.
> 3. **Amazon S3** — Uses an S3 bucket. Members authenticate via AWS credentials or SSO.

Ask: "Which storage backend will your org use?"

Based on the selection, collect backend-specific connection config:

**Google Drive:**
- Ask for the Drive ID (if using a shared drive) or leave blank for personal drive
- Ask for the root folder ID — the folder that will contain all agent-index files. The admin should create this folder first and provide its ID (available in the folder's URL).
- Ask for the OAuth client ID (`client_id`) — the admin must register an OAuth application in Google Cloud Console. Provide brief guidance: "You'll need an OAuth2 client ID from Google Cloud Console. Create a project, enable the Google Drive API, create OAuth credentials for a 'Desktop app', and paste the client ID here."
- Ask for the OAuth client secret (`client_secret`) — required for the OAuth flow. Provide guidance: "Copy the client secret from the same OAuth credentials page in Google Cloud Console."

**Microsoft OneDrive/SharePoint:**
- Ask for the Azure AD tenant ID — the admin's Microsoft 365 organization ID. Provide guidance: "You can find this in the Azure Portal under Azure Active Directory → Overview → Tenant ID. If your org uses Microsoft 365, your IT admin can provide it. Use 'common' for multi-tenant apps."
- Ask for the Azure AD client ID — the admin must register an app in Azure Portal. Provide guidance: "Register an app in Azure Portal → App registrations → New registration. Set redirect URI to 'http://localhost:3939/callback' (type: Web). Under API permissions, add Microsoft Graph → Files.ReadWrite.All and User.Read (delegated). Copy the Application (client) ID."
- Optionally ask for the drive ID — if using a specific OneDrive or SharePoint document library. Leave blank to use the authenticated user's default OneDrive.
- Optionally ask for the site ID — if targeting a SharePoint site. Provide guidance: "For SharePoint, you can find the site ID via the Graph API or SharePoint admin center."

**Amazon S3:**
- Ask for the S3 bucket name. Provide guidance: "Enter the name of the S3 bucket that will store your org's agent-index files. The bucket must already exist and the admin must have read/write access."
- Ask for the AWS region (e.g., `us-east-1`, `eu-west-1`).
- Ask for a key prefix (optional, defaults to empty). Provide guidance: "If this bucket is shared with other applications, enter a prefix like 'agent-index/' to isolate agent-index files. Leave blank if the bucket is dedicated to agent-index."
- Optionally ask for a custom endpoint (for S3-compatible services like MinIO, Cloudflare R2, or DigitalOcean Spaces). Leave blank for standard AWS S3.

Store the collected values. Do not write anything yet — all writes happen after confirmation.

**On success:** Proceed to Step 3b.

---

### Step 3b: Network Reachability Check

Before proceeding, verify that ALL domains needed for setup are reachable from this environment. There are two groups of required domains:

**Infrastructure domains** (needed to download the adapter bundle in Step 3c):
- `raw.githubusercontent.com` — adapter bundle download
- `github.com` — adapter repository access (if cloning)
- `api.github.com` — adapter directory lookup (if using API)

Determine the actual infrastructure domains by inspecting the `filesystem_adapter_directory_url` in `agent-index.json` and the chosen adapter's `zip_url` from the adapter directory. At minimum, test `raw.githubusercontent.com`.

**Backend domains** (needed for authentication and filesystem access in Phase 3):

Read the `required_domains` field from the chosen adapter's `adapter.json` (available in the adapter directory or the downloaded adapter repo).

- **Google Drive:** `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`
- **Microsoft OneDrive/SharePoint:** `login.microsoftonline.com`, `graph.microsoft.com`
- **Amazon S3:** `*.amazonaws.com` (specifically `s3.{region}.amazonaws.com` and `sts.{region}.amazonaws.com` for the configured region)

Test ALL domains from both groups for network reachability (see Step 0 for the test method).

**If all domains are reachable:** Proceed to Step 3c.

**If any domain is blocked:** The environment's network allowlist does not include the required domains. This is common in sandboxed environments like Cowork. The setup cannot proceed until the admin updates the network allowlist.

1. Write `.agent-index/install-state.json` to the project directory:

```json
{
  "task": "create-org",
  "status": "awaiting-network-allowlist",
  "started_at": "{ISO timestamp of when create-org started}",
  "updated_at": "{current ISO timestamp}",
  "completed_steps": ["1", "2", "3", "3b"],
  "next_step": "3c",
  "backend": "{chosen backend_id}",
  "adapter_display_name": "{display_name from adapter.json}",
  "collected": {
    "org_name": "{org_name}",
    "org_id": "{org_id}",
    "connection": {
      // All connection config collected in Step 3
    }
  },
  "required_domains": {
    "infrastructure": ["raw.githubusercontent.com"],
    "backend": ["{domain1}", "{domain2}", "..."]
  },
  "blocked_domains": ["{domain1}", "..."],
  "resume_prompt": "continue the agent-index org setup"
}
```

2. Surface the allowlisting instructions. Explain WHY each group of domains is needed so the admin understands and can advocate for the changes with their IT team:

> **Network access required**
>
> Setup needs to reach the following domains, but they are currently blocked by your Cowork network allowlist:
>
> {if any infrastructure domains are blocked:}
> **For downloading the filesystem adapter:**
> {for each blocked infra domain, on its own line:}
> - `{domain}`
>
> {if any backend domains are blocked:}
> **For connecting to {adapter_display_name}:**
> {for each blocked backend domain, on its own line:}
> - `{domain}`
>
> **To fix this:**
> 1. Go to **claude.ai** → **Admin Settings** → **Capabilities** → **Network access**
> 2. Add ALL of the following domains to the allowlist:
>    {comma-separated list of all required domains from both groups}
> 3. Save the changes
> 4. Start a **new Cowork session** (allowlist changes require a new session to take effect)
> 5. Open the same project folder and say: **"continue the agent-index org setup"**
>
> Your progress has been saved. Everything you've entered so far (org name, backend choice, connection config) will be restored automatically in the next session.

3. Halt. Do not proceed to Step 3c.

---

### Step 3c: Download Bundle, Write Config Files, and Save State

All required domains are reachable. This step downloads the adapter bundle, writes all local configuration files, and halts with a session restart instruction. The MCP server configuration written here will be loaded when the admin starts a new session.

**1. Download the adapter bundle:**

Read `filesystem-adapter-directory.json` (fetch from `filesystem_adapter_directory_url` in `agent-index.json` if not cached). Find the entry matching the chosen backend. Download the adapter repo via its `zip_url`. Extract `dist/server.bundle.js` and `adapter.json` from the downloaded zip.

Verify bundle integrity: compute SHA-256 of `server.bundle.js` and compare against `bundle_checksum` in `adapter.json`. If mismatch, report the error and prompt the admin to retry.

Place the files at their final locations:
- `mcp-servers/filesystem/server.bundle.js` — the MCP server bundle
- `mcp-servers/filesystem/adapter.json` — adapter metadata (version, checksum, build timestamp)

**2. Write `agent-index.json`** with the `remote_filesystem` section:

- Set `backend` to the chosen backend identifier (`gdrive`, `onedrive`, or `s3`)
- Set `mcp_server.adapter` to the chosen backend identifier
- Set `mcp_server.adapter_version` to the version from the adapter directory
- Set `mcp_server.bundle_path` to `mcp-servers/filesystem/server.bundle.js`
- Set `auth.method` to `per-member`
- Set `auth.credential_store` to `.agent-index/credentials/` (relative to project root — this ensures credentials persist across Cowork sessions since the project directory is mounted from the host)
- Set `connection` to the collected config from Step 3

**3. Write `.claude/settings.json`** with the MCP server configuration:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/agent-index-core/.claude/hooks/session-bootstrap.sh",
            "timeout": 30
          }
        ]
      }
    ]
  },
  "mcpServers": {
    "agent-index-filesystem": {
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/mcp-servers/filesystem/server.bundle.js"],
      "env": {
        "AIFS_CONFIG_PATH": "${CLAUDE_PROJECT_DIR}/agent-index.json"
      }
    }
  }
}
```

**4. Write `.agent-index/install-state.json`:**

```json
{
  "task": "create-org",
  "status": "awaiting-session-restart",
  "started_at": "{ISO timestamp of when create-org started}",
  "updated_at": "{current ISO timestamp}",
  "completed_steps": ["1", "2", "3", "3b", "3c"],
  "next_step": "4",
  "backend": "{chosen backend_id}",
  "adapter_display_name": "{display_name from adapter.json}",
  "collected": {
    "org_name": "{org_name}",
    "org_id": "{org_id}",
    "connection": {
      // All connection config collected in Step 3
    }
  },
  "required_domains": {
    "infrastructure": ["raw.githubusercontent.com"],
    "backend": ["{domain1}", "{domain2}", "..."]
  },
  "bundle": {
    "adapter_version": "{version}",
    "bundle_checksum": "{sha256}",
    "downloaded_at": "{ISO timestamp}"
  },
  "resume_prompt": "continue the agent-index org setup"
}
```

**5. Surface the session restart instruction:**

> **Phase 1 complete — session restart required**
>
> I've completed all the setup I can in this session:
> - Downloaded and verified the {adapter_display_name} adapter bundle
> - Wrote `agent-index.json` with your backend configuration
> - Wrote `.claude/settings.json` with the MCP server configuration
>
> The MCP server configuration will load when you start a new session. To continue:
>
> 1. Start a **new Cowork session**
> 2. Open the same project folder
> 3. Say: **"continue the agent-index org setup"**
>
> Your progress has been saved. The next session will pick up at authentication — you'll sign in to {adapter_display_name} and verify connectivity.

**6. Halt.** Do not proceed to Step 4. The MCP server tools are not available in this session.

---

### Step 4: Admin Authentication

Now that the MCP server is loaded (from `.claude/settings.json` written in Step 3c and loaded at session start), authenticate the admin to the remote filesystem.

This step runs in the new session (Phase 3). The `agent-index.json` and `.claude/settings.json` files were already written in Step 3c. The MCP server should have started automatically when this session launched.

1. Verify the MCP server is available by calling `aifs_auth_status()`. If the tool is not found, the session may not have loaded settings.json correctly — surface: "The filesystem MCP server doesn't appear to be running. Check that `.claude/settings.json` is present and contains the `agent-index-filesystem` server entry, then restart the session."

2. If `aifs_auth_status()` returns `authenticated: false`, call `aifs_authenticate(action="start")` to initiate the auth flow. The response will include an `auth_url` and a `status` field indicating how the callback will be handled:

   **For Google Drive and Microsoft OneDrive/SharePoint:**

   If `status` is `"awaiting_callback"`: the adapter has started a temporary callback server on port 3939. Tell the admin: "Open this URL in your browser and sign in. After granting access, you'll see a success page and can come back here." Then call `aifs_authenticate(action="complete")` — the authorization code was captured automatically by the callback server. No manual code entry needed.

   If `status` is `"awaiting_code"`: the callback server could not start (port unavailable). Tell the admin: "Open this URL in your browser and sign in. After granting access, you'll be redirected to a page that may fail to load — this is expected. Copy everything after `code=` in the URL bar (up to the `&` if there is one) and paste it here." Then call `aifs_authenticate(action="complete", auth_code="{pasted_code}")`.

   **For S3:** "Run `aws configure` or `aws sso login` in a separate terminal to set up your AWS credentials, then confirm here."

3. Verify authentication via `aifs_auth_status()`. If it returns `authenticated: true`, proceed.

**On auth failure:** Surface the error clearly and check the error details:

- If the error includes `retryable: true` (typically an expired or already-used authorization code): surface the message and immediately offer to restart the auth flow. Say: "The authorization code expired — this happens if there's a delay. Let me generate a fresh one." Then call `aifs_authenticate(action="start")` again to get a new URL. Do not ask the admin to re-enter any configuration — just restart the OAuth flow.
- If the error is `redirect_uri_mismatch`: this is a configuration issue in Google Cloud Console. Surface the message and guide the admin to fix it before retrying.
- For other errors: surface the error message and offer to retry.

Do not proceed without successful authentication — every subsequent step depends on remote access.

**On success:** Proceed to Step 5.

---

### Step 5: Test Remote Connectivity

Perform a write/read/delete cycle to confirm the admin has full access to the remote filesystem:

1. Write a test file: `aifs_write("/._agent-index-connectivity-test", "ok")`
2. Read it back: `aifs_read("/._agent-index-connectivity-test")`
3. Verify the content matches
4. Delete it: `aifs_delete("/._agent-index-connectivity-test")`

Surface: "Remote filesystem connectivity confirmed — read and write access verified."

**On failure:** Surface the specific error. Common issues:
- `ACCESS_DENIED`: "You can connect to the remote storage but don't have write access. Check that your account has edit permissions on the target folder/bucket."
- `BACKEND_ERROR` with details: surface the backend's error message.

Halt if the test fails. Do not proceed without confirmed read/write access.

**On success:** Proceed to Step 6.

---

### Step 6: Confirm Remote Filesystem Layout

Present the remote filesystem layout that will be created:

> **Remote Filesystem Layout**
> Root: (the configured remote root — Drive folder, S3 bucket, etc.)
> `/org-config.json` — Org configuration
> `/members-registry.json` — Member lookup table
> `/CLAUDE.md` — Claude context
> `/agent-index-core/` — Core collection (uploaded from local)
> `/shared/bootstrap/` — Member bootstrap zip
> `/shared/members/artifacts/` — Per-member shared output namespace
> `/shared/marketplace-cache/` — Cached marketplace data
> `/shared/reports/` — Aggregated reports
> `/shared/dashboards/` — Dashboards
> `/shared/reference/` — Reference materials
> `/shared/audit/` — Audit logs

Ask: "This is the directory structure I'll create on your remote storage. Proceed?"

If the admin confirms: proceed.
If the admin needs changes: explain which paths are configurable in `agent-index.json` and which are fixed. Halt if changes are needed.

**On success:** Proceed to Step 7.

---

### Step 7: Collect Initial Admin List

Explain: "Org admins can install and manage collections and manage other admins. You'll be added automatically — who else should be an org admin?"

Resolve the running admin's identity: compute SHA256 of their lowercase email address (retrieved from Cowork session context), take the first 16 hex characters. This is their `member_hash`. Pre-populate the admin list with the running admin's `member_hash`, display name, and email address.

Ask if there are additional admins to add. Accept any number of additional admins, including zero.

For each additional admin: ask for their display name and email address. Compute their `member_hash` using the same method (SHA256 of lowercase email, first 16 hex chars).

Present the complete admin list with display names for confirmation.

**On success:** Proceed to Step 8 with confirmed admin list.

---

### Step 8: Confirm and Write Org Configuration

Present a complete summary:

> **New Org Configuration**
> Org name: {org_name}
> Org ID: {org_id}
> Remote backend: {backend display name}
> Admins: {admin display names}
> Remote root: {description of remote location}
>
> Ready to create your org?

Wait for explicit confirmation.

On confirmation, execute the following writes. All remote writes use MCP tools. All local writes use Claude's native file tools.

**Remote writes (via MCP):**

1. Initialize the remote directory structure using `aifs_write` to create placeholder files in each directory (Google Drive requires at least one file to "create" a folder path):

```
/shared/bootstrap/.gitkeep
/shared/members/artifacts/.gitkeep
/shared/marketplace-cache/.gitkeep
/shared/reports/.gitkeep
/shared/dashboards/.gitkeep
/shared/reference/.gitkeep
/shared/audit/.gitkeep
```

2. Write `org-config.json` to the remote root:

```json
{
  "org_name": "{org_name}",
  "org_id": "{org_id}",
  "agent_index_version": "2.0.0",
  "created": "{today YYYY-MM-DD}",
  "last_updated": "{today YYYY-MM-DD}",
  "remote_filesystem": {
    "backend": "{backend}",
    "mcp_server": {
      "adapter": "{backend}",
      "adapter_version": "1.0.0",
      "bundle_path": "mcp-servers/filesystem/server.bundle.js"
    },
    "auth": {
      "method": "per-member"
    },
    "connection": {
      // Backend-specific connection fields from Step 3
    }
  },
  "paths": {
    "library_root": "/",
    "shared_root": "/shared/",
    "shared_artifacts_root": "/shared/members/artifacts/",
    "members_registry_path": "/members-registry.json",
    "marketplace_cache_path": "/shared/marketplace-cache/",
    "bootstrap_zip_path": "/shared/bootstrap/member-bootstrap.zip"
  },
  "admins": [
    {
      "member_hash": "{member_hash}",
      "display_name": "{display_name}",
      "email": "{email}",
      "granted_by": "system",
      "granted_date": "{today YYYY-MM-DD}"
    }
  ],
  "org_roles": [],
  "installed_collections": [
    {
      "name": "agent-index-core",
      "version": "2.0.0",
      "installed_date": "{today YYYY-MM-DD}",
      "repo_url": "https://github.com/agent-index/agent-index-core",
      "status": "installed"
    }
  ]
}
```

3. Write `members-registry.json` to the remote root:

```json
{
  "version": "1.0.0",
  "last_updated": "{today YYYY-MM-DD}",
  "members": [
    {
      "member_hash": "{member_hash}",
      "display_name": "{display_name}",
      "email": "{email}",
      "org_role": null,
      "joined_date": "{today YYYY-MM-DD}"
    }
  ]
}
```

Include entries for ALL admins defined in Step 7.

4. Write `CLAUDE.md` to the remote root. This is a reference copy. The content must include:
   - A brief description of what agent-index is
   - The **Bootstrap Protocol** section: how to handle each `AGENT_INDEX_BOOTSTRAP` signal
   - The **Handling Member Requests** routing table
   - The **Key Files** section: paths to `agent-index.json` (local), `org-config.json` (remote), `members-registry.json` (remote), `member-index.json` (local), `preferences.md` (local), `filesystem.md` (local)
   - The **Two-Tier Filesystem** section: local files via native tools, remote files via `aifs_*` MCP tools. Explain that `NOT_AUTHENTICATED` errors mean re-auth via `@ai:member-bootstrap`.
   - The **Identity Resolution** section: SHA256 of lowercase email, first 16 hex characters
   - The **Important Constraints** section: never modify collection directories on remote, never write outside the current member's local workspace and `/shared/` on remote, always read skill/task definitions before executing, always get member confirmation before changes

Use the canonical `CLAUDE.md` template from `agent-index-core/.claude/` as the source content. If no template exists, generate it from the sections above.

**Local writes:**

5. Verify `.claude/settings.json` is present locally (already written in Step 3c). If missing or corrupted, rewrite it.

6. Write `CLAUDE.md` locally (same content as the remote copy, adapted to reference local paths where appropriate).

7. Write `current-state.md` to the task's state directory recording completion of this step.

Confirm: "Your org '{org_name}' is configured. Org config and directory structure are live on the remote filesystem."

**On write failure:** Surface the specific remote write that failed. The admin can retry — writes are idempotent.

**On success:** Proceed to Step 9.

---

### Step 9: Upload Collections to Remote

Upload `agent-index-core/` to the remote filesystem so that members can read collection definitions via MCP during their setup.

Walk the local `agent-index-core/` directory and upload each file using `aifs_write`. Preserve the directory structure. Skip `node_modules/`, `.git/`, and other non-essential directories.

Surface progress: "Uploading agent-index-core to remote filesystem... {N} files uploaded."

**On success:** Proceed to Step 10.

---

### Step 10: Bootstrap Agent-Index Marketplace

Ask the admin:

> "To browse and install collections, I need to download the agent-index marketplace tools first. This is a one-time step — it clones the `agent-index-marketplace` collection which provides everything needed to manage collections going forward. Ready to download it?"

If the admin says no: confirm and skip to Step 12. Note they can come back to this later.

If the admin says yes:

1. Check for git availability by running `git --version` silently.
2. If git is available: ask "I can clone this as a Git repository or download it as a ZIP. Cloning lets you pull updates directly. Which would you prefer?" Default to ZIP if no preference.
3. If git is not available: proceed with ZIP silently.
4. Download `agent-index-marketplace` locally from the `marketplace_repo_url` in `agent-index.json`.
5. Verify the download by confirming `collection.json` is readable.
6. Upload the entire marketplace collection to the remote filesystem via MCP (same process as Step 9).
7. Update `org-config.json` on remote via `aifs_read` then `aifs_write`:
   - Add entry to `installed_collections`
   - Update `last_updated`

Proceed to Step 11.

---

### Step 11: Check Network Access and Open Marketplace

Before invoking any marketplace task, perform a lightweight connectivity check by attempting to fetch the `marketplace_directory_url` from `agent-index.json`:

If not reachable: surface the whitelisting guidance and halt. The admin can say 'open marketplace' once resolved.

If reachable: invoke `run agent-index-marketplace task list-marketplace-collections`. The marketplace flow takes over from here. Any collections installed by the marketplace should also be uploaded to the remote filesystem.

---

### Step 12: Generate and Upload Bootstrap Zip

Generate the member bootstrap zip. This is the minimal package that a new member downloads and unpacks to get started.

**Assemble the zip contents:**

Create a temporary directory and populate it with:

```
agent-index/
├── agent-index.json                    # The local copy (with remote_filesystem configured)
├── .claude/
│   └── settings.json                   # SessionStart hook + MCP server config
├── mcp-servers/
│   └── filesystem/
│       ├── server.bundle.js            # Pre-built MCP server bundle
│       └── adapter.json                # Adapter metadata (version, checksum, build timestamp)
├── agent-index-core/
│   └── .claude/
│       └── hooks/
│           └── session-bootstrap.sh    # Bootstrap script
└── CLAUDE.md                           # Claude context
```

**Include the adapter bundle:**

The adapter bundle (`server.bundle.js` and `adapter.json`) was already downloaded and verified in Step 3c. It is available at `mcp-servers/filesystem/` in the project directory. Copy these files into the bootstrap zip contents at `mcp-servers/filesystem/server.bundle.js` and `mcp-servers/filesystem/adapter.json`. Do NOT re-download the bundle.

The `agent-index.json` in the zip is the fully configured copy from the local filesystem (written in Step 3c) — it includes the `remote_filesystem` section with backend, connection config, and auth settings. It does NOT include any credentials.

The `.claude/settings.json` includes both the session hook and the MCP server configuration for the chosen backend. The MCP server command points to the bundled path: `node ${CLAUDE_PROJECT_DIR}/mcp-servers/filesystem/server.bundle.js`.

The `session-bootstrap.sh` is copied from the local `agent-index-core/.claude/hooks/`.

The `CLAUDE.md` is the local copy written in Step 8.

**Create the zip:**

```bash
cd {temp_directory} && zip -r member-bootstrap.zip agent-index/
```

**Upload to remote:**

Read the zip file as binary content and upload via `aifs_write("/shared/bootstrap/member-bootstrap.zip", "base64:{content}")`.

**Generate download instructions:**

The download instructions are backend-specific:

**Google Drive:** Generate a shareable link for the zip file. The admin may need to adjust sharing settings so org members can download it. Surface: "The bootstrap zip has been uploaded to your Google Drive. Share the file or folder with your org members so they can download it."

**Microsoft OneDrive/SharePoint:** Generate a shareable link for the zip file via OneDrive/SharePoint sharing. Surface: "The bootstrap zip has been uploaded to your OneDrive/SharePoint. Share the file with your org members — they can find it at `/shared/bootstrap/member-bootstrap.zip` in the document library, or you can generate a share link from the OneDrive/SharePoint web interface."

**S3:** Generate a presigned URL or provide the S3 path. Surface: "Members can download the bootstrap zip using: `aws s3 cp s3://{bucket}/{prefix}shared/bootstrap/member-bootstrap.zip ~/member-bootstrap.zip`"

**Present the member instructions:**

Surface a ready-to-send text block that the admin can copy and send to members:

> **Instructions for your org members:**
>
> To set up agent-index on your machine:
>
> 1. Download the bootstrap zip from: {download location/instructions}
> 2. Unzip it into your home directory: `unzip member-bootstrap.zip -d ~/`
>    (This creates `~/agent-index/`)
> 3. Open Cowork (Claude desktop app)
> 4. Set your working folder to `~/agent-index/`
> 5. Say: **"set up my agent-index member workspace"**
> 6. You'll be guided through authenticating to {backend display name} — have your {backend} account credentials ready.
>
> That's it. The setup process will handle everything else.

**On success:** Proceed to Step 13.

---

### Step 13: Set Up Admin Member Workspace

Say:

> "Your org is configured and the member bootstrap zip is ready for distribution. Now let's set up your own member workspace so you're ready to work."

The admin's member workspace is set up locally, following the same flow that members will experience (minus the bootstrap zip download — the admin already has everything local):

1. Create the local member workspace directory structure: `{project_dir}/members/{admin_hash}/` with subdirectories: `skills/`, `tasks/`, `profile/`
2. Create `member-index.json` for the admin (locally)
3. Run the preferences-management initial interview
4. If collections were installed via marketplace in Step 11, proceed to capability selection and installation for the admin

The transition should feel seamless — the admin does not need to separately invoke setup.

On completion: "Your member workspace is ready. You can start using your installed capabilities."

If the admin declines or wants to do this later: accept that, note they can say '@ai:setup' anytime.

**On success:** Proceed to Step 14.

---

### Step 14: Define Org Roles (Optional)

Ask the admin:

> "Would you like to define org roles now? Roles determine which collections members are prompted to install when they join — for example, an 'Engineer' role might default to the Projects and Developer Tools collections. You can always add or edit roles later via '@ai:edit-org'."

If the admin says yes:

1. For each role, collect: display name and a brief description.
2. Generate role_id: lowercase, spaces replaced with hyphens (same convention as org_id).
3. Present the list of installed collections (excluding agent-index-core and agent-index-marketplace). Ask which collections should be defaults for this role.
4. Allow the admin to define multiple roles, one at a time.
5. After all roles are defined, present the complete list for confirmation.
6. On confirmation, update `org-config.json` on the remote filesystem via `aifs_read` then `aifs_write`, adding to the `org_roles` array.

If the admin says no: skip, remind them they can do this later via '@ai:edit-org'.

**On success or skip:** Proceed to Step 15.

---

### Step 15: Completion Summary

Present the final summary:

> **Org Setup Complete — {org_name}**
> Org ID: {org_id}
> Remote backend: {backend display name}
> Admins: {admin display names}
> Installed collections: {list}
> Org roles: {list, or "none defined yet"}
> Your member workspace: ready
> Bootstrap zip: uploaded to {remote location}
>
> **To onboard new members:** send them the instructions from Step 12. They download the bootstrap zip, unzip to `~/agent-index/`, open Cowork, and say "set up my agent-index member workspace."
>
> **To edit org configuration:** say '@ai:edit-org' or 'edit org'
> **To regenerate the bootstrap zip:** say '@ai:create-org' (it will detect the existing org and offer appropriate options)

---

## Directives

### MCP Tool Usage

This task uses the `agent-index-filesystem` MCP server for all remote filesystem operations. The server is configured in `.claude/settings.json` and starts automatically when the Cowork session launches.

**Tool invocation:** When this document says `aifs_read(path)`, `aifs_write(path, content)`, `aifs_auth_status()`, etc., these are MCP tool calls on the `agent-index-filesystem` server. Invoke them as MCP tools — they will appear in the tool list with names like `mcp__agent-index-filesystem__aifs_read`. They are NOT shell commands, JavaScript functions, or Python calls.

**Critical prohibition:** NEVER invoke the MCP server binary (`server.bundle.js`) directly via bash, node, or any shell script. NEVER build wrapper scripts (bash, Python, Node.js, or otherwise) to pipe JSON-RPC messages to the server process. The MCP server is managed by the Cowork runtime — all interaction MUST go through the MCP tool interface. If an `aifs_*` tool call fails or the tool is not found in the tool list, diagnose the MCP configuration (check `.claude/settings.json`, verify the bundle path exists) and surface the problem to the admin. Do not attempt workarounds.

**If MCP tools are not available:** This means the MCP server did not load. The most common causes are: (1) `.claude/settings.json` is missing or malformed, (2) the server bundle at `mcp-servers/filesystem/server.bundle.js` doesn't exist, (3) the session needs to be restarted for settings changes to take effect. Surface the specific issue and halt — do not proceed without working MCP tools.

### Behavior

This task is run by a technical or semi-technical org admin. It can assume a higher level of comfort with concepts like OAuth client IDs, S3 buckets, and Google Cloud Console than a typical member setup flow. Explanations should be clear but not over-simplified.

The backend selection and authentication steps (Steps 3–5) are the critical path. If the admin cannot authenticate or the connectivity test fails, nothing else can proceed. Invest time in clear error messages and troubleshooting guidance here.

**Three-phase flow:** This task always spans at least two Cowork sessions, with an optional admin action in between:

- **Phase 1 (first session, Steps 1–3c):** Collect org info, pick the adapter, test domain reachability, download the adapter bundle, write all local config files (`agent-index.json`, `.claude/settings.json`), and write the install state file. Always ends with a halt — either because domains are blocked (admin must update allowlist) or because the MCP server config needs a session restart to load.
- **Phase 2 (admin action, outside Cowork):** If domains were blocked, the admin goes to Claude.ai admin settings and adds the required domains to the network allowlist. If domains were already reachable, this phase is skipped.
- **Phase 3 (second session, Steps 4+):** The admin starts a new Cowork session. The MCP server loads from `.claude/settings.json`. Step 0 detects the install state file, verifies domain reachability, and resumes at Step 4 (authentication). From here the flow continues uninterrupted through completion.

In sandboxed environments (Cowork), network access to backend API domains AND infrastructure domains (GitHub) may be blocked by the platform's network allowlist. Step 3b detects this and saves progress to `.agent-index/install-state.json`, giving the admin clear instructions to update the allowlist and resume in a new session. This is expected behavior, not an error — present it calmly and clearly. The admin should feel confident that their progress is saved and that resuming is straightforward.

Write nothing to the remote filesystem before the Step 8 confirmation. Steps 1–7 are purely data collection and local configuration. The Step 8 confirmation is the point of no return for remote writes.

The local `agent-index.json` and `.claude/settings.json` are written in Step 3c (end of Phase 1). This happens before the Step 8 confirmation because the MCP server must be configured and loaded (in the next session) before authentication can proceed in Step 4. These local config files do not affect the remote filesystem.

### State Management

**Install state file (`.agent-index/install-state.json`):** Written in Step 3b or Step 3c to bridge the session gap between Phase 1 and Phase 3. The file has two possible statuses:

- `"awaiting-network-allowlist"` — written in Step 3b when one or more required domains are blocked. The `next_step` field is `"3c"` because the bundle hasn't been downloaded yet. On resume (Step 0 in Phase 3), if domains are now reachable, the flow continues at Step 3c.
- `"awaiting-session-restart"` — written in Step 3c after all config files and the adapter bundle are in place. The `next_step` field is `"4"`. On resume (Step 0 in Phase 3), the flow skips directly to Step 4 (authentication).

The file captures all collected data (org name, backend, connection config) so the admin does not need to re-enter anything. The `required_domains` field is an object with `infrastructure` and `backend` arrays, enabling Step 0 to test all domains on resume.

Update the `status` field to `"completed"` and the `updated_at` timestamp when the task finishes successfully (Step 15). Do not delete the file — it serves as an audit trail.

**Current state file (`current-state.md`):** Write after successful completion of Step 8. Record: org name, org ID, backend type, admin list, completion date. This provides a recovery reference if the task is interrupted during later steps.

If the task is re-invoked after Step 8 was completed but later steps were not: detect the state, confirm with the admin where to resume, and continue from the next incomplete step.

### Constraints

Never overwrite an existing `org-config.json` on the remote filesystem without going through `edit-org`. The detection in Step 1 is mandatory.

Never proceed past Step 5 if the connectivity test fails. Without confirmed remote access, no subsequent step can succeed.

The current member running this task is always added to the admin list. They cannot remove themselves during create-org — they may do so later via `edit-org` as long as at least one other admin remains.

Never skip generating and uploading the bootstrap zip in Step 12. This is the distribution mechanism for members. Without it, members cannot set up agent-index.

Never include credentials or tokens in the bootstrap zip. The zip contains connection config (endpoint identifiers, OAuth client IDs) but never secrets. Members authenticate individually during their setup.

Never skip writing `CLAUDE.md` during Step 8 (both locally and on remote). This file gives Claude the context it needs to understand agent-index. Without it, the bootstrap hook's output is meaningless.

### Edge Cases

If the admin's generated org ID collides with a collection name already present on the remote filesystem (e.g., the admin names their org "Projects" which would generate `projects`, but a `projects/` directory already exists on remote): surface the conflict and ask for a different org name.

If `agent-index.json` cannot be read at the expected local path: surface: "I couldn't find the agent-index root configuration file. Make sure you've cloned agent-index-core into this directory before running org setup." Halt.

If the running admin's email cannot be determined from Cowork session context, ask for it directly. The email is required for identity resolution.

If the MCP server fails to start (e.g., the bundle cannot be found or is corrupted): surface the error clearly. Common causes: the adapter bundle was not downloaded correctly during org setup, Node.js not available. Offer guidance: "Make sure Node.js is installed and the adapter bundle exists at the expected path (mcp-servers/filesystem/server.bundle.js)."

If a remote write fails partway through Step 8 (some files written, some not): surface which writes succeeded and which failed. The admin can retry — all writes are idempotent (they overwrite existing files).

If the admin wants to use a backend not yet supported: surface: "Currently supported backends are Google Drive, Microsoft OneDrive/SharePoint, and Amazon S3. Support for additional backends is planned." Do not proceed with an unsupported backend.

Emails are the canonical identity input — not an edge case.
