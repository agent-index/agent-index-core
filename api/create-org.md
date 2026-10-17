---
name: create-org
type: task
version: 3.15.2
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

The remote filesystem replaces the previous shared-mount-drive model. Instead of requiring every member to mount a shared drive locally, the org's files live on a remote storage backend (Google Drive, OneDrive, or S3) accessed through an on-demand executor. Each member authenticates individually to the backend during their own setup. The admin configures the backend choice and connection details during this task.

This task is run once per org. If `org-config.json` already exists on the remote filesystem, this task detects it and offers `edit-org` instead.

### Inputs

The org admin provides: org name, remote filesystem backend choice, backend connection config, initial admin list. Optionally: launches the marketplace flow to install collections.

### Outputs

Written to the remote filesystem via the on-demand executor:
- `org-config.json` at the remote root — the authoritative org configuration record
- `members-registry.json` at the remote root — the member lookup table
- `CLAUDE.md` at the remote root — Claude context for the system
- `/shared/` directory structure initialized with all required subdirectories
- `/shared/dist/` — the distribution layer (Release C): `manifest.json` (authoritative org version record with per-artifact sha256), `/directories/` (adapter, marketplace, resource-listings, installed collections). Members read from here, never from github.com (see Step 11 and the `backend-distribution` subroutine).
- `/shared/bootstrap/member-bootstrap.zip` — the downloadable bootstrap package for members (Step 12; it carries the executor bundle)

Written locally:
- `agent-index.json` updated with the configured remote filesystem section
- `.claude/settings.json` with the session hook
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

If the file exists and `status` is `"phase3-in-progress"` (`createorgresume`, finding 53 — the org was partly created in an earlier Phase 3 session): re-open the install log first (item 1 below), restore the collected state, run `aifs_auth_status` (re-authenticate per Step 4 if needed), then tell the admin "Your org '{org_name}' was partly set up; the last finished step was {phase3_step}. I'll continue from step {next_step}." and resume at `next_step`. Do **not** go through Step 1's existing-org check: the org-config on the remote is this run's own partial work, not an org to hand to `edit-org`. Every Phase 3 step is idempotent, so re-running the step that was in flight is safe.

If the file exists and `status` is `"awaiting-network-allowlist"` or `"awaiting-session-restart"`:

1. **Re-open the install log FIRST (loggap).** Before anything else on a resume, locate the existing install log from the prior session and re-open it for appending; record a `session_resumed` entry immediately, and append every subsequent action of this session to that same log. A resumed session that doesn't re-open the log leaves a gap and then has to backfill (ms-install-7 `loggapresume`). Re-opening first is the standing rule for every resume, not an afterthought.

2. Surface: "I found a saved install state from a previous session. Let me verify everything is ready to continue."

3. Read the `required_domains` object from the install state file. This contains two groups:

   - `infrastructure`: domains needed to download adapter bundles (e.g., `raw.githubusercontent.com`)
   - `backend`: domains needed for the chosen storage backend's API (e.g., `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`)

   Test ALL domains from both groups for network reachability by attempting an HTTP CONNECT through the proxy (if `HTTPS_PROXY` is set) or a direct HTTPS connection.

   The test is: attempt an HTTP `CONNECT {domain}:443` request through the proxy. A `200` response means the domain is reachable. A `403` with `X-Proxy-Error: blocked-by-allowlist` means it is still blocked. DNS failure (`EAI_AGAIN`) means no proxy is being used and direct DNS is unavailable.

4. If ALL required domains are reachable:

   Surface: "Network access confirmed — all required domains are reachable. Resuming setup."

   Check what was completed in the previous session by inspecting `completed_steps`:

   - If `completed_steps` includes `"3c"` (config files and bundle already written): restore the collected state (`org_name`, `org_id`, `org_uuid`, `distribution_channel`, `backend`, `connection` config) from the install state file and skip directly to **Step 4** (authentication).

   - If `completed_steps` only goes through `"3b"` or earlier (domains were blocked before bundle download): restore the collected state and resume at **Step 3c** (download bundle and write config files).

5. If ANY required domain is still blocked: surface the specific domains that remain blocked and re-display the allowlisting instructions:

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

If the remote filesystem is already configured, find out whether the org already exists. Run both checks; the org exists if **either** one finds `org-config.json`:

1. **By id**, when the local `agent-index.json` has `remote_filesystem.connection.org_config_id`: on gdrive `aifs_read("id:{org_config_id}")`; on OneDrive the drive-qualified `aifs_read("id:{drive_id}:{org_config_id}")` (`drive_id` from the same connection; a bare `id:` resolves against the admin's own drive there — runtime-reference.md § "Addressing: Owned Content and Sharing", finding 63). This is the check that works for an admin who is not a Shared Drive member, because a root-level bare path does not resolve for them.
2. **By path**: `aifs_exists("/org-config.json")`, then `aifs_read("/org-config.json")` if it exists. Kept so the check works wherever it works today, including OneDrive site-drive members, without depending on the id form.

Record each check's outcome as one of: **found**, **not found** (the id read returned `FILE_NOT_FOUND`, or the path probe returned `exists: false`), **couldn't check** (any other error: `NOT_AUTHENTICATED`, `ACCESS_DENIED`, `CONFIG_ERROR`, `BACKEND_ERROR`, a network failure), or **skipped** (no `org_config_id` locally, so the id check did not run). Then:

**A. Either check found it.** **First check whether it is this task's own unfinished org (finding 53):** if `.agent-index/install-state.json` has `task: "create-org"`, a `status` other than `"completed"`, and `collected.org_id` equal to the org-config `org_id`, the org-config was written by an interrupted create-org — resume per Step 0 (set `next_step` from `phase3_step` if the file predates that field: the step after the last Phase 3 step in `completed_steps`), never route to `edit-org`. Otherwise surface "It looks like this org is already configured as '{org_name}'. Would you like to edit the org configuration instead?" If yes: invoke `run agent-index task edit-org`. Halt this task. If no: halt this task anyway. Never continue into a fresh install over an existing org.

**B. Neither found it, and at least one check couldn't check.** Nothing has been learned, so do not offer a fresh install. Surface: "I couldn't check whether an org already exists here: {the error from each check}. Fix the connection first (`@ai:member-bootstrap` reconnects), then run `@ai:create-org` again." Halt.

**C. Every check that ran came back not found.** Decide from local evidence, never from the admin's memory alone:

- **An org was created here before:** the local `agent-index.json` has an `org_config_id` (Step 11.5 stamps it only after a successful setup), or `.agent-index/install-state.json` has `status: "completed"` (Step 15). Do **not** offer a fresh install. Surface: "This workspace has already set up an org on this remote{, '{collected.org_name}' if the install state records it}, but I can't find its configuration now. That usually means your access changed or the configuration was moved. Check with your org's admins before doing anything else. Starting a new org here could overwrite theirs." Halt.
- **An earlier setup started and did not finish:** `.agent-index/install-state.json` exists for `create-org` with any other `status`. Show the evidence and ask: "An earlier setup{ for '{collected.org_name}'} started on {started_at} and never finished, and I can't find an org configuration on the remote. {Storage link.} Do you want to start the setup again from the beginning?" Proceed to Step 2 only on an explicit yes.
- **No local evidence either way:** ask the admin to look rather than recall: "I can't find an org configuration on this remote, and nothing in this workspace says whether one was set up before. Please open {storage link} and check for a file named `org-config.json` at the top level. Tell me once you've looked: is it there?" If they report it is there: treat as **B** (their access is the problem) and halt. Proceed to Step 2 only if they confirm they looked and it is not there.

**Storage link:** build it from the local connection so the admin can look for themselves. gdrive: `https://drive.google.com/drive/folders/{drive_id}`. OneDrive: `connection.site_url` if recorded. If neither is available, name the backend and the configured ids instead.

If the remote filesystem is not configured (empty backend/connection fields): this is a fresh install. Proceed to Step 2.

**Fresh clone: create `agent-index.json` from the template (`createorgnoseed`).** A fresh clone of agent-index-core has no `agent-index.json` at the project root; the workspace template ships at `agent-index-core/templates/agent-index.template.json` (the legacy `agent-index-core/agent-index.json` was retired in core 3.6.0). If the project root has no `agent-index.json` **and** that template exists:

1. Copy the template to `<project_dir>/agent-index.json` unchanged, except set the top-level `version` to the cloned core's version (`agent-index-core/collection.json` → `version`). Write shell-first and read it back (it must parse and contain `remote_filesystem`).
2. Tell the admin: "Created `agent-index.json` from the core template — this is a fresh install."
3. Continue as a fresh install (Step 2). Step 3c fills in `remote_filesystem` and `distribution_channel`.

This is part of the task, not a workaround: it is the only way a fresh clone gets its root configuration file.

If neither `agent-index.json` nor the template can be read: surface: "I couldn't find the agent-index root configuration file or its template. Make sure you've cloned agent-index-core into this directory before running org setup." Halt.

---

### Step 2: Collect Org Name

Ask: "What is the name of your organization?"

Accept any non-empty string. Generate the org ID: lowercase, spaces and special characters replaced with hyphens, consecutive hyphens collapsed, leading and trailing hyphens removed.

Show the generated ID: "I'll use `{org-id}` as your org's identifier — this is used internally and in directory names."

**On success:** Proceed to Step 3.

---

### Step 3: Choose Remote Filesystem Backend

Explain: "Agent-index stores your org's shared files — collection definitions, org config, shared reports — on a remote filesystem that all members access through an on-demand executor. Each member authenticates individually during their own setup."

**Never fetch `filesystem-adapter-directory.json` from GitHub here (`adapterdirraw`, finding 6).** `filesystem_adapter_directory_url` points at the raw default branch, not the release tag or channel this org will run, and nothing is cloned yet at this step (the adapter clone needs the backend chosen here, so the clone can't come first). Instead:
- If an `agent-index-resource-listings/` clone already exists under the install root (a re-run or resume), read `filesystem-adapter-directory.json` from it and offer the backends it lists.
- Otherwise present the supported backends below. Step 3c 1a then clones the listings at the org's resolved ref; right after it runs, check the chosen backend is listed in the cloned `filesystem-adapter-directory.json`. If it isn't, say so, ask the admin to choose again, and re-emit the infra manifest for that backend.

Present the supported backends:

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

Topology note to set expectations: a SharePoint document library is the org's shared root (everyone reads/writes the org tree there); each member's personal OneDrive becomes their private space automatically at their own bootstrap. A personal OneDrive cannot serve as the shared org root, so any multi-member org should use a SharePoint site.

**Member licensing prerequisite — surface this to the admin now (memberlicense).** Each member who will use owned-content capabilities (their private `Agent-Index-Private` space — used by strategy, capture, private ideas, etc.) needs a Microsoft 365 license that **includes OneDrive/SharePoint**. This is included by default in Business Basic, Business Standard, Business Premium, and Office 365/Microsoft 365 E1/E3/E5 — so most orgs already have it — but bare/unlicensed accounts (or Exchange-only/some frontline SKUs) will hit a "no OneDrive license" error at member bootstrap and won't get a private space (they can still read org shared files via site membership). Tell the admin explicitly:

> "Heads up: each member who'll use private/owned-content capabilities needs a Microsoft 365 license that includes OneDrive — that's standard in Business Standard/Premium and E3, so you likely already have it. To check or assign: **Microsoft 365 admin center → Users → Active users → select the user → Licenses and apps → enable a license that includes OneDrive/SharePoint**. A member without it can still read shared org files, but won't get a private space until a license is assigned and they've signed in to office.com once. Want to confirm your members are licensed before you invite them?"

Record the admin's acknowledgment in the install log. This is guidance, not a hard gate — proceed regardless of the answer.

- Ask for the Azure AD (Entra) tenant ID — the admin's Microsoft 365 organization ID. Provide guidance: "Entra admin center → Overview → Tenant ID. Your IT admin can provide it."
- Ask for the Azure AD application (client) ID — the admin registers a **public client** app. Provide guidance: "Entra → App registrations → New registration. Under Redirect URI, choose platform **Mobile and desktop applications** and enter **`http://localhost:3939/`**. Then go to Authentication → Advanced settings and set **'Allow public client flows' → Yes** (this is off by default and sign-in fails without it). Under API permissions add Microsoft Graph **delegated** permissions: `User.Read`, **`User.Read.All`**, `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `offline_access`, then **Grant admin consent** (required — `User.Read.All` is an admin-consent permission). Copy the Application (client) ID. **Do NOT create a client secret** — this adapter is a public client (PKCE). (`User.Read.All` lets the adapter resolve a member's roster email/UPN to their grantable tenant identity at invite time — `identitymap`/`identityperm`; without it `@ai:invite-member` cannot look up members and every resolution fails with a permission error. Plain `User.Read` only reads the signed-in user's own profile.)"
- Ask for the SharePoint site URL (recommended for any multi-member org) — Provide guidance: "Paste the document-library site URL, e.g. `https://contoso.sharepoint.com/sites/YourSite`. The site_id and drive_id are resolved automatically after you sign in (Step 4) — you don't need to find those GUIDs by hand. Leave blank only for a single-user / personal-OneDrive setup."
- Ask for the **all-members Microsoft 365 group** (recommended for any multi-member org; Release B) — Provide guidance: "This is the group that means 'everyone in the org' — used to grant all members read access to the org files (the *share-with-org* grant). Paste its email (e.g. `agentindex-members@contoso.onmicrosoft.com`) or its objectId (GUID). Microsoft 365 admin center → Teams & groups → Active teams & groups. If your SharePoint site is Teams/group-connected, this is usually the site's own M365 group. Leave blank for a single-user setup or to fall back to manual site-membership." Store as `connection.all_members_group`.

Note: OneDrive collects `tenant_id`, `client_id`, (optional) `site_url`, and (optional) `all_members_group` — **no client secret**. `site_id`/`drive_id` are not entered by hand; they are derived from `site_url` after authentication (Step 4). If `site_url` is blank, the member's default OneDrive is the root. If `all_members_group` is blank, the Step 4.5 share-with-org grant is skipped and members fall back to manual site membership (recorded in the install log).

**Amazon S3:**
- Ask for the S3 bucket name. Provide guidance: "Enter the name of the S3 bucket that will store your org's agent-index files. The bucket must already exist and the admin must have read/write access."
- Ask for the AWS region (e.g., `us-east-1`, `eu-west-1`).
- Ask for a key prefix (optional, defaults to empty). Provide guidance: "If this bucket is shared with other applications, enter a prefix like 'agent-index/' to isolate agent-index files. Leave blank if the bucket is dedicated to agent-index."
- Optionally ask for a custom endpoint (for S3-compatible services like MinIO, Cloudflare R2, or DigitalOcean Spaces). Leave blank for standard AWS S3.

Store the collected values. Do not write anything yet — all writes happen after confirmation.

**On success:** Proceed to Step 3b.

---

### Step 3b: Network Reachability Check

Before proceeding, verify that ALL domains needed for setup are reachable from this environment. The canonical host list lives in `agent-index-core/templates/network-allowlist.template.json` — this step reads that file and iterates every entry. (Pre-3.7.3 versions of this step listed three infrastructure hosts in prose and tested only one. The data-driven approach was introduced in core 3.7.3 to close bug `20260515-8d20ea22` and idea `setup-time-network-allowlist-verification`.)

**If the admin invoked with `--skip-network-check`:** log a warning ("Network reachability check skipped at admin request — first collection install may fail if allowlist is incomplete") and proceed to Step 3c. The flag is intended for air-gapped environments, internal mirrors, or development scenarios where the standard public hosts aren't applicable.

**Otherwise, run the reachability check:**

1. Read `agent-index-core/templates/network-allowlist.template.json` from the freshly-downloaded core (this file is part of the adapter-bundle-pair download flow that Step 3a sets up). If absent, fail with a clear error — the canonical file is required for setup.

2. Build the host list to test:
   - **Infrastructure tier:** every entry in `infrastructure[]` with `tested_by: "setup-time-reachability-check"`.
   - **Telemetry tier:** if `agent-index.json` has a non-empty `log_collector_url`, parse the hostname and include it. Marked as `required: false` — failures don't block the install.
   - **Backend tier:** if `backend.{chosen_backend_id}` is enumerated in the canonical file, use those entries. Otherwise, dynamic-read the chosen adapter's `adapter.json` `required_domains` field (available in the adapter directory or the downloaded adapter repo) and treat each domain as `required: true, tested_by: setup-time-reachability-check`.

3. Test each host. For each, issue an HTTPS GET against `https://{host}/` (or a known-200 endpoint per host if needed) with a 10-second timeout. Acceptance: any response other than connection-refused, connection-timeout, or proxy-403 (zero content-length, no upstream headers) is treated as reachable.

4. Collect results into two sets:
   - `blocked_required`: hosts with `required: true` that didn't pass.
   - `blocked_optional`: hosts with `required: false` (i.e., telemetry) that didn't pass.

5. **If `blocked_required` is empty:** Proceed to Step 3c. If `blocked_optional` is non-empty, surface a soft notice ("Optional telemetry hosts are not reachable: {...}. Install diagnostics will be skipped. Allowlist these hosts if you want diagnostics enabled.") but do not block.

6. **If `blocked_required` is non-empty:** Proceed to the allowlisting flow below. Surface each blocked host along with its `purpose` annotation from the canonical file so the admin understands what each host is for.

For documentation purposes, the canonical file currently enumerates the following infrastructure hosts: `raw.githubusercontent.com`, `github.com`, `api.github.com`, `codeload.github.com` (added in core 3.7.3 to close bug `20260515-8d20ea22`), `cdn.jsdelivr.net` (added in core 3.11.0 as the Distribution fetch protocol's fallback origin). Telemetry: derived dynamically from `log_collector_url`. Backend (gdrive): `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`. Other backends (OneDrive, S3) are not enumerated in the canonical file; their hosts come from each adapter's `adapter.json`. **Reading directly from the canonical file is the source of truth — never act on this snapshot paragraph; it exists only so a human reader knows roughly what to expect** (kept current by preflight reviews, not guaranteed).

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
    "org_uuid": "{random UUID v4 generated when org_id is collected in Step 3; reused on resume and written to org-config in Step 8}",
    "distribution_channel": "{from Step 3c 1-pre; null until asked / for released code}",
    "connection": {
      // All connection config collected in Step 3
    }
  },
  "required_domains": {
    "infrastructure": ["{ALL infrastructure[] hosts from agent-index-core/templates/network-allowlist.template.json — the canonical list; NEVER hardcode a subset here (bug 20260515-8d20ea22)}"],
    "backend": ["{domain1}", "{domain2}", "..."],
    "telemetry": ["{log_collector_hostname, if configured}"]
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
> {if telemetry domain is configured and blocked:}
> **For install diagnostics (optional):**
> - `{telemetry domain}`
>
> **To fix this:**
> 1. Go to **claude.ai** → **Admin Settings** → **Capabilities** → **Network access**
> 2. Add ALL of the following domains to the allowlist:
>    {comma-separated list of all required domains from all groups}
> 3. Save the changes
> 4. Start a **new Cowork session** (allowlist changes require a new session to take effect)
> 5. Open the same project folder and say: **"continue the agent-index org setup"**
>
> Your progress has been saved. Everything you've entered so far (org name, backend choice, connection config) will be restored automatically in the next session.

3. Halt. Do not proceed to Step 3c.

---

### Step 3c: Download Bundle, Write Config Files, and Save State

All required domains are reachable. This step downloads the adapter bundle, writes all local configuration files, and halts with a session restart instruction. The session hook and executor configuration written here will be loaded when the admin starts a new session.

**Idempotency guard (do this check FIRST — resume/idempotency).** Step 3c is the most-re-entered step (a session resuming after the allowlist halt can otherwise redo it). Before downloading or writing anything: if `install-state.json` already has `next_step` of `"4"` or later (or `status: "awaiting-session-restart"`), AND `mcp-servers/filesystem/aifs-exec.bundle.js` exists with a SHA matching `adapter.json`'s `exec_bundle_checksum`, AND `agent-index.json` parses with a populated `remote_filesystem` section — then Step 3c is **already complete**. Do not re-download the bundle or rewrite config; log a `step_skipped` entry and jump straight to Step 4. Only run the sub-steps below when that guard does not hold.

**The agent makes ZERO GitHub calls in this step (C.1 invariant).** All version/availability facts come from `git ls-remote` and the freshly-cloned listings — never `raw.githubusercontent.com` or the REST API. Resolving versions from `raw` is what installed stale version pins in ms-install-7 (`staleversionpins`). This step runs **two** host scripts with a collection-selection interview between them, because the catalog of installable collections only exists after the resource-listings clone lands, and a script cannot pause for an interview.

**1-pre. Distribution channel (core 3.32.0).** Before emitting any manifest, ask:

> "Should this org run released code (recommended), or a **distribution channel** of unreleased code for testing (e.g. `dev-1`)? Default: released code."

- **Default / no answer:** `distribution_channel: null`.
- **A channel name:** validate it against `^[a-z0-9][a-z0-9-]{0,39}$` and re-ask if invalid.
- **Write the answer** to the local `agent-index.json` `distribution_channel` now (org-config gets it in Step 8).
- **Tell the admin plainly** that every repo with a `channel/<name>` branch will come from it, that members get the same, and that `@ai:edit-org` → *Distribution channel* switches it later.
- **If the local `agent-index-core` clone predates channel support** (no `lib/clone/resolve-refs.js`), the channel can't take effect. Tell the admin to re-clone core from the channel first: `git clone -b channel/<name> <core repo url>` into the install root, replacing the existing clone. Then continue.

**1a. Emit the infra clone manifest + surface the committed clone script (`clone-script-generator`, `mode: infra`):**

Emit the infra clone **manifest** via the **`clone-script-generator`** subroutine (`templates/clone-script-generator.md`) with `mode: infra`, then surface the committed **`agent-index-core/lib/clone/clone-repos`** invocation (which reads that manifest) for the admin to run natively. **Pass `channel`** (from 1-pre; also record it in install-state `collected.distribution_channel` so a session restart can't lose it — create `install-state.json` with just that field now if it doesn't exist yet; item 4 below fills in the rest). That committed script (core 3.32.0+; it "pins" by resolving) resolves every repo's ref via `lib/clone/resolve-refs.js` (a `channel/<name>` head when the org has a channel and the repo has the branch; otherwise the latest `v*` tag; no `main` fallback — a missing tag fails loudly), records its decisions in `.agent-index/clone-resolution.json`, clones `agent-index-filesystem-<backend>`, `agent-index-marketplace`, `agent-index-resource-listings` (and pins the already-present `agent-index-core` to its tag). Surface the run instruction with execution-policy bypass on Windows (`powershell -ExecutionPolicy Bypass -File "…"`). Do NOT fetch the adapter or anything else from GitHub yourself — once the script runs, it is all in local clones. (Retires the old SHA-pinned-directory + `zip_url` path; survives only as the deprecated fallback, `admin-distribution.md` § "Distribution: backend-first (Release C — the current model)".)

Wait for the admin to confirm the infra script ran. If `agent-index-resource-listings/` or `agent-index-filesystem-<backend>/` is absent afterward, the script did not complete — re-surface it and halt. Then confirm the chosen backend appears in the cloned `agent-index-resource-listings/filesystem-adapter-directory.json` (Step 3; finding 6).

**1b. Collection-selection interview (reads the freshly-cloned catalog — the fix for the never-asked-collections gap):**

Now that `agent-index-resource-listings/marketplace-directory.json` is local, read it and present the available collections to the admin. Ask which (if any) they want installed at org creation. Record the selected collection repos + their `git_url`s. (If the admin wants none now, they can always add later via `@ai:download-and-install-collection`.) **This is the first time the admin is asked about collections** — pre-C.1 the flow cloned before ever asking (ms-install-7 finding).

**1c. Emit the collections clone manifest + surface the committed clone script (`clone-script-generator`, `mode: collections`) — only if collections were selected:**

If the admin selected any collections, emit a second **manifest** with `mode: collections` for the selected repos and surface the same committed `clone-repos` invocation (pointing at that manifest); **pass the same `channel`**, and each repo's `version` = the listings catalog `current_version`; the committed script resolves each repo itself (channel head, else tag `v<version>` — a missing tag fails that repo; bug `20260926-8d20ea22-133903-0ddf`). Wait for confirmation it ran. If none were selected, skip this sub-step.

**1d. Stage the adapter bundle from the local clone:**

Stage `dist/aifs-exec.bundle.js`, `dist/aifs-exec.sh`, and `adapter.json` from the local `agent-index-filesystem-<backend>` clone into `mcp-servers/filesystem/`. Compute the bundle SHA on the **git-blob (LF) bytes** — `git -C <clone> show HEAD:dist/aifs-exec.bundle.js` — **not** the working-tree copy: a Windows checkout converts LF→CRLF and breaks the checksum (ms-install-6). Verify it matches `exec_bundle_checksum` in the clone's `adapter.json`; that `adapter.json` is authoritative for the adapter version (record it).

Place: `mcp-servers/filesystem/aifs-exec.bundle.js` (executor bundle), `aifs-exec.sh` (shell wrapper), `adapter.json` (adapter metadata).

**2. Write `agent-index.json`** with the `remote_filesystem` section (**preserve** `distribution_channel` from 1-pre / install-state `collected`; never drop it when rewriting the file):

- **Set the top-level `version` to the ACTUAL installed core version (`createorgversionstale`, ms_install_10).** Read it from the cloned core's `collection.json` (`agent-index-core/collection.json` → `version`, e.g. `3.22.2`) and write that into `agent-index.json` `version`. Do **NOT** leave the template's hardcoded value (the template ships `"version": "3.1.1"`, which is stale — it does not track core releases). Every fresh org was being born with `version: 3.1.1` because this step never overwrote it, and apply-updates' core-update step (the only other corrector) never fires on a brand-new org (it's already latest), so the field sat wrong forever, skewing `check-updates` and tripping the version-sync migration. Set it here, at write time, from the installed core version.
- Set `backend` to the chosen backend identifier (`gdrive`, `onedrive`, or `s3`)
- Set `exec.adapter` to the chosen backend identifier
- Set `exec.adapter_version` to the version from the adapter directory
- Set `exec.bundle_path` to `mcp-servers/filesystem/aifs-exec.bundle.js`
- Set `exec.shell_wrapper` to `mcp-servers/filesystem/aifs-exec.sh`
- Set `auth.method` to `per-member`
- Set `auth.credential_store` to `.agent-index/credentials/` (relative to project root — this ensures credentials persist across Cowork sessions since the project directory is mounted from the host)
- Set `connection` to the collected config from Step 3
- **Do NOT set `remote_filesystem.connection.org_config_id` here** (bug `groupshareapivisibility`). That field is the Drive file id of `/org-config.json` — the single seed that lets `member-bootstrap` read org-config by `id:` with no web-UI visit — but `/org-config.json` does not exist yet at Step 3c (it is written in Step 8). It is populated later, in the new "Stamp resource ids" step (Step 11.5), which runs before the bootstrap zip is assembled so the zip's `agent-index.json` carries the id. Leave the field absent (or `null`) at 3c.

**3. Write `.claude/settings.json`** with the session hook (the hook loads the bootstrap script, which calls the on-demand executor):

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
    "org_uuid": "{random UUID v4 generated when org_id is collected in Step 3; reused on resume and written to org-config in Step 8}",
    "distribution_channel": "{from Step 3c 1-pre; null until asked / for released code}",
    "connection": {
      // All connection config collected in Step 3
    }
  },
  "required_domains": {
    "infrastructure": ["{ALL infrastructure[] hosts from agent-index-core/templates/network-allowlist.template.json — the canonical list; NEVER hardcode a subset here (bug 20260515-8d20ea22)}"],
    "backend": ["{domain1}", "{domain2}", "..."],
    "telemetry": ["{log_collector_hostname, if configured}"]
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
> - Wrote `.claude/settings.json` with the session hook
>
> The session hook will load when you start a new session, enabling the on-demand executor. To continue:
>
> 1. Start a **new Cowork session**
> 2. Open the same project folder
> 3. Say: **"continue the agent-index org setup"**
>
> Your progress has been saved. The next session will pick up at authentication — you'll sign in to {adapter_display_name} and verify connectivity.

**6. Halt.** Do not proceed to Step 4. The remote filesystem tools are not available in this session.

---

### Step 4: Admin Authentication

Now that the session hook is loaded (from `.claude/settings.json` written in Step 3c and loaded at session start), authenticate the admin to the remote filesystem.

This step runs in the new session (Phase 3). The `agent-index.json` and `.claude/settings.json` files were already written in Step 3c. The session hook enables the on-demand executor when this session launches.

Set `install-state.json` `status` to `"phase3-in-progress"` now, and update `phase3_step` / `next_step` after each Phase 3 step from here on (State Management; finding 53).

1. Verify the exec wrapper is available by calling `aifs_auth_status()` via the shell wrapper: `bash $CLAUDE_PROJECT_DIR/mcp-servers/filesystem/aifs-exec.sh aifs_auth_status '{}'`. If the wrapper cannot be found or executed, surface: "The executor wrapper isn't found at `mcp-servers/filesystem/aifs-exec.sh`. Please ensure the bootstrap zip was correctly unpacked and contains all files."

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

**OneDrive/SharePoint — resolve the site after authentication:** if the backend is `onedrive` and a `site_url` was collected in Step 3, now resolve it to the connection IDs (this needs the token, which is why it happens here rather than in Step 3). Call `aifs_resolve_site` with `{"site_url": "<the collected URL>"}`. On success it returns `site_id`, `drive_id`, `site_web_url`, and `drive_name`: set `connection.site_id` and `connection.drive_id` to the returned values and confirm to the admin: "Resolved SharePoint library '{drive_name}' at {site_web_url}." On failure (`INVALID_ARGS` for a malformed URL, or a Graph error), surface it and offer the manual fallback: ask the admin to paste `site_id` and `drive_id` directly. If no `site_url` was provided (single-user/personal-OneDrive), leave both blank — the member's default OneDrive is the root. (This sub-step is a no-op for gdrive and S3.)

> **Verify-after-write for local config (bug `20260615-8d20ea22-localcfgtrunc`).** When you persist the resolved `site_id`/`drive_id` (and any other connection values) to the local `agent-index.json`, the Cowork mount can truncate the write — install #1 was broken this way and #3 nearly was. After writing `agent-index.json` (and `members/{hash}/member-index.json`), **read it back and `JSON.parse` it**; if it fails to parse or is missing the values you just wrote, rewrite it via the shell (an executor-readable path) and re-verify before continuing. This is the local-side complement to the remote `ocstale` safe-rewrite rule. Never proceed past a local config write you haven't read back and parsed. **Prefer writing local config via the shell in the first place** (compose the full JSON in-memory, then write it with a single shell redirection to an executor-readable path) rather than the editor file-write path: in ms-install-4 and ms-install-5 the mount truncated essentially every editor-path config write, and the read-back then had to repair it. Shell-first avoids the torn write entirely; keep the read-back-and-parse as the backstop either way.

**OneDrive/SharePoint — post-auth content-host reachability gate:** the Step 3b reachability check could only test `graph.microsoft.com` and `login.microsoftonline.com`, but file content reads and >4MB uploads 302-redirect to the **tenant content host**, which isn't knowable until the site is resolved (just above). Derive it now from the resolved `site_web_url` / tenant: `{tenant}.sharepoint.com` and `{tenant}-my.sharepoint.com` (e.g. `contoso.sharepoint.com`, `contoso-my.sharepoint.com`). Test each through the proxy CONNECT tunnel (same method as Step 3b). If either is `blocked-by-allowlist`, **halt** with: "Add these to your Cowork network allowlist, then start a new session and resume: `{tenant}.sharepoint.com`, `{tenant}-my.sharepoint.com` (or `*.sharepoint.com`). These carry file content reads and large uploads — Step 5 will fail without them." Do not proceed to Step 5 until both resolve. (No-op for gdrive/S3.) This closes the gap where a blocked content host was discovered only by Step 5's read failing (bug `20260614-8d20ea22-sphost`).

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

On confirmation, execute the following writes. All remote writes use `aifs_*` tools. All local writes use Claude's native file tools.

**Important: sequential remote writes.** When writing multiple files to the remote filesystem, write them ONE AT A TIME — wait for each `aifs_write` to complete before starting the next one. Do NOT issue parallel writes. Google Drive allows duplicate folder names, so parallel writes that create intermediate directories (e.g., two files both targeting `/email-triage/`) will each independently create the folder, resulting in duplicates. The adapter serializes folder creation internally, but sequential writes from the caller eliminate the risk entirely.

**Remote writes (via the on-demand executor):**

1. Initialize the remote directory structure using `aifs_write` to create placeholder files in each directory (Google Drive requires at least one file to "create" a folder path). Write these sequentially, one at a time:

```
/shared/bootstrap/.gitkeep
/shared/members/artifacts/.gitkeep
/shared/marketplace-cache/.gitkeep
/shared/reports/.gitkeep
/shared/dashboards/.gitkeep
/shared/reference/.gitkeep
/shared/audit/.gitkeep
```

2. Write `org-config.json` to the remote root. **Refuse to overwrite an existing org (`createorgoverwrite`, core#19 follow-up).** Immediately before this write, check again with both Step 1 checks (by id when `org_config_id` is known, and by path). If either finds an `org-config.json` that isn't this task's own unfinished org (the Step 1 finding-53 test), halt: "An org configuration already exists here ('{org_name}'). I won't overwrite it — run '@ai:edit-org' to change it." A check that couldn't run also halts ("I couldn't confirm there's no existing org — fix the connection and run '@ai:create-org' again"). Only write when every check that ran came back not found, or found this task's own unfinished org:

```json
{
  "org_name": "{org_name}",
  "org_id": "{org_id}",
  "org_uuid": "{install-state collected.org_uuid — a random UUID v4 (crypto.randomUUID() / uuidgen, lowercase) generated once in Step 3 when org_id was collected. Permanent: it names every member's private space, Agent-Index-Private-{org_uuid} (member-bootstrap Step 5), so two orgs never collide in a member's My Drive. Never regenerate it.}",
  "agent_index_version": "{the ACTUAL agent-index-core version being installed — read it from the downloaded agent-index-core/collection.json `version`. Do NOT hardcode a default like 2.0.0: that is the `versionmarker` drift that made ms-install-5's check-updates report nonsense (org-config said 2.0.0 while collection.json said 3.15.0). The installed collection.json is the source of truth for the installed version.}",
  "distribution_channel": {the value chosen in Step 3c 1-pre — read it from install-state `collected.distribution_channel` / local `agent-index.json`; null for released code},
  "created": "{today YYYY-MM-DD}",
  "last_updated": "{today YYYY-MM-DD}",
  "remote_filesystem": {
    "backend": "{backend}",
    "auth": {
      "method": "per-member"
    },
    "connection": {
      // Backend-specific connection fields from Step 3
    }
  },
  // Note: in v3, the adapter exec config (bundle_path, shell_wrapper, adapter_version)
  // lives in agent-index.json → remote_filesystem.exec — NOT here. org-config.json
  // only carries org-level metadata (backend identifier, auth method, connection
  // bootstrap fields). The v2-era `mcp_server` block and the misplaced `exec` block
  // were both removed in core 3.6.0 (closes bug 20260502-8d20ea22-3). The strip
  // step in apply-updates Phase 1 step 5 catches existing installs.
  "paths": {
    "library_root": "/",
    "shared_root": "/shared/",
    "shared_artifacts_root": "/shared/members/artifacts/",
    "members_registry_path": "/members-registry.json",
    "marketplace_cache_path": "/shared/marketplace-cache/",
    "bootstrap_zip_path": "/shared/bootstrap/member-bootstrap.zip"
  },
  "resource_ids": {
    // The id-anchored bootstrap manifest (bug `groupshareapivisibility`). These are the
    // Drive file/folder ids that let a member reach the org tree by `id:` anchor with NO
    // web-UI visit — the fix that makes onboarding work purely from the bootstrap seed.
    // `shared_root` = Drive id of `/shared`; `members_registry` = Drive id of
    // `/members-registry.json`. Written as null HERE (org-config.json is being created in
    // this very write, and `/members-registry.json` is not written until item 3 below), then
    // POPULATED in the new "Stamp resource ids" step (Step 11.5) once all three resources
    // exist and their ids are stat-able. core/marketplace/collection roots do NOT need an
    // entry — each already carries its own `folder_id` under `installed_collections[]`.
    // NESTED items (e.g. /shared/dist) need NO id: they are reached by an id-anchored
    // RELATIVE path, `id:{shared_root}/dist`. The `id:` prefix is REQUIRED — a bare
    // `{folderId}/child` is treated as a literal path and fails.
    "shared_root": null,
    "members_registry": null
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
  "marketplaces": [
    // Catalog subscriptions (core 3.30.0 — admin-distribution.md § "Marketplaces: catalogs, subscriptions, provenance (normative — core 3.30.0; collision rules revised in 3.31.0)"). A new org
    // subscribes to exactly the public catalog. `source.ref` is RELATIVE to the install
    // root — never an absolute or /sessions/… path (appspathsandboxleak). The listings
    // repo is already cloned by the infra clone in Phase 1, so kind is `clone`. Further
    // catalogs are added later via @ai:edit-org → Manage marketplaces.
    {
      "id": "agent-index-public",
      "display_name": "Agent Index Marketplace",
      "enabled": true,
      "source": {
        "kind": "clone",
        "ref": "agent-index-resource-listings",
        "git_url": "https://github.com/agent-index/agent-index-resource-listings.git"
      },
      "namespace": null,
      "skip_if_unavailable": false,
      "trust_anchor": { "git_url": "https://github.com/agent-index/agent-index-resource-listings.git" },
      "subscribed_date": "{today YYYY-MM-DD}",
      "subscribed_by": "{member_hash}"
    }
  ],
  "installed_collections": [
    {
      "name": "agent-index-core",
      "version": "{the agent-index-core collection.json `version` actually uploaded in Step 9 — not a hardcoded default (versionmarker). Must match the remote /agent-index-core/collection.json.}",
      "installed_date": "{today YYYY-MM-DD}",
      "repo_url": "https://github.com/agent-index/agent-index-core",
      "status": "installed",
      "marketplace_id": "agent-index-public"
    }
  ]
}
```

3. Write `members-registry.json` to the remote root.

**Resolve and persist the admin's `sharing_identity` (`adminregidentity`, ms-install-9).** The admin is also a member — content gets shared *to* them (the first owned-content share in ms-install-9 was to the admin). Tasks that target a member by `sharing_identity` read it from the registry; if the admin's entry omits it, every share/remove targeting the admin must **re-resolve live** (and on a non-tenant-verified roster domain that means re-probing the `.onmicrosoft.com` form each time). So resolve it once here — the same way `invite-member` does: `aifs_resolve_identity(email)`; on onedrive if the roster email isn't a tenant identity, resolve the tenant UPN (the `.onmicrosoft.com` form / admin-supplied) — and write it into the admin's entry. On gdrive `sharing_identity == email`. Include `member_folder_id: null` (reconciled from the admin's own handshake on the next `publish-updates`, matching member entries). The admin entry should be schema-identical to an `invite-member` entry.

```json
{
  "version": "1.0.0",
  "last_updated": "{today YYYY-MM-DD}",
  "members": [
    {
      "member_hash": "{member_hash}",
      "display_name": "{display_name}",
      "email": "{email}",
      "sharing_identity": "{resolved grantable identity — tenant UPN on onedrive, = email on gdrive}",
      "org_role": null,
      "joined_date": "{today YYYY-MM-DD}",
      "member_folder_id": null
    }
  ]
}
```

Include entries for ALL admins defined in Step 7.

4. Write `CLAUDE.md` to the remote root. This is a reference copy. The canonical source is `agent-index-core/.claude/CLAUDE.md.template` — read it, substitute `{org_name}` with the org's display name, and write the result. The template includes:
   - A brief description of what agent-index is
   - The **Bootstrap Protocol** section: how to handle each `AGENT_INDEX_BOOTSTRAP` signal
   - The **Handling Member Requests** routing table — split into Core aliases, Marketplace aliases, and a Catch-all section that tells Claude how to resolve any other `@ai:{name}` invocation by checking the local member index and then scanning installed collections' `api/` directories. The catch-all is a routing instruction, not an allowlist — Claude must not treat unknown aliases as invalid without first attempting resolution.
   - The **Key Files** section: paths to `agent-index.json` (local), `org-config.json` (remote), `members-registry.json` (remote), `member-index.json` (local), `preferences.md` (local), `filesystem.md` (local)
   - The **Two-Tier Filesystem** section: local files via native tools, remote files via the `aifs_*` tools on the on-demand executor. Explain that `NOT_AUTHENTICATED` errors trigger automatic re-authentication — the system will attempt to restore the connection without member intervention. If automatic re-auth fails, the member can say `@ai:member-bootstrap` as a manual fallback.
   - The **Identity Resolution** section: SHA256 of lowercase email, first 16 hex characters
   - The **Important Constraints** section: never modify collection directories on remote, never write outside the current member's local workspace and `/shared/` on remote, always read skill/task definitions before executing, always get member confirmation before changes

If the template file is missing for any reason, fall back to generating the file from the sections above — but the template is the source of truth and should not be skipped lightly. Marketplace aliases in the template apply only when `agent-index-marketplace` is in `installed_collections`; if the marketplace section is irrelevant to this org (extremely rare), it can be omitted from the written file.

**Local writes:**

4.5. **Grant the all-members group reader access on `/shared/` AND the three root-level org-readable files.** This is what makes group membership the org's access mechanism: a non-admin member reads and enumerates the shared tree plus the canonical org files purely by being in the group, so `invite-member` adds **no** per-member reader shares. (The three-file grant closes the spec half of bug `20260527-8d20ea22-3`; the **`/shared/` grant is added in B.3 / 3.17.0** — it is the direct-on-folder group grant that lets `invite-member` drop its per-member `/shared/` reader, `catbredundant`.) On **gdrive** this explicit grant is required — non-admin members are not Shared-Drive members, so without it they cannot read or enumerate `/shared/`. On **OneDrive** it is belt-and-suspenders (site/library membership already conveys it).

**Backend capability check (still required — do NOT silently skip):** first read the adapter's `supported_operations`. Both shipping backends now support `share` — gdrive (2.x) and **onedrive (2.1.0+, Release B)** — so the per-file group grants below run on each, using that backend's `all_members_group` (a Google Group on gdrive, an M365 group on onedrive). If a *future* backend ever lacks `share`, **do not quietly no-op**: surface it to the admin, record `all_members_access: "manual"` in the install log, and continue. (Closed for onedrive: bug `20260614-8d20ea22-spacl`.)

> **(Pre-2.1.0 onedrive installs only)** If you encounter an onedrive adapter older than 2.1.0 (`share` still in `supported_operations_pending`), fall back to the interim instruction: members get read access by being **members of the SharePoint site** (`{site_web_url}`) — add them in SharePoint admin center → the site → Members — until the adapter is upgraded. The site owner (admin) is unaffected.

After the three files above (`/CLAUDE.md`, `/org-config.json`, `/members-registry.json`) have been written to remote in items 1-4, grant the org's all-members group reader access on each — and on the `/shared/` root folder. These grants enable every non-admin member to read the canonical org configuration, registry, and instructions, and to read + enumerate the `/shared/` tree — required for `session-start`, `org-setup` Phase 3 catalog assembly, identity resolution, and member access to shared org content. (Each collection root gets its own direct group-reader grant when the collection is installed — `install-collection` cr01 — so a single `/shared/` grant here plus the per-collection grants cover what the removed per-member "Category B" reader shares used to.) **Members ALSO need reader on `/agent-index-core/` and `/agent-index-marketplace/` (bug `memberorgreadblocked`):** members read core + marketplace capability definitions by path (`apply-updates`, `preferences-management`, `session-start`, `member-bootstrap`, `browse`/`find`, etc.), so without these two grants a non-drive-member's `member-bootstrap` runs blind and skips its provisioning. Those two roots are uploaded later (Steps 9 and 10), so their group-reader grants are applied **right after each upload** (id-anchored on the folder's Drive id) through the same permission-changes procedure. Never assume a member is a Drive member — a non-drive-member sees only what is explicitly shared.

**Apply through the core permission-changes procedure (core 3.32.0+; replaces the former install-time direct-apply exception).** Follow `/agent-index-core/internal/permission-changes.md` with one table for these four root grants:

```json
{
  "calling_task": "create-org",
  "purpose": "Let all members read the org's shared folder and its three root files",
  "confirmer": "admin",
  "changes": [
    { "op": "share", "resource": "/shared/", "resource_label": "/shared/ (the org's shared folder)", "is_folder": true, "recipient": "{all_members_group}", "role": "reader", "reason": "Members read and list shared org content", "source": "task_spec" },
    { "op": "share", "resource": "/CLAUDE.md", "resource_label": "/CLAUDE.md", "recipient": "{all_members_group}", "role": "reader", "reason": "Members' sessions read the org instructions", "source": "task_spec" },
    { "op": "share", "resource": "/org-config.json", "resource_label": "/org-config.json", "recipient": "{all_members_group}", "role": "reader", "reason": "Members read the org configuration", "source": "task_spec" },
    { "op": "share", "resource": "/members-registry.json", "resource_label": "/members-registry.json", "recipient": "{all_members_group}", "role": "reader", "reason": "Members resolve each other's identities", "source": "task_spec" }
  ]
}
```

The admin running `create-org` is the person confirming, and the grants run under their own credentials. These root files exist by now (items 1–4), so the procedure can read the org identities it needs (org-config `admins[]`, `all_members_group`, the members registry).

Where `{all_members_group}` is the org's all-members group, persisted in `org-config.json` at `remote_filesystem.connection.all_members_group`. On **gdrive** this is a Google Group address (typically `all@{org_domain}`) collected in Step 7. On **onedrive** this is the tenant **Microsoft 365 group** (email or objectId) connected to the SharePoint site — create-org captures it during the M365 connection step or derives it from the site's owners/members group; `aifs_share` passes it to a Graph `invite` (additive). Same grant, same role vocabulary, on both backends.

**Idempotency:** if a grant already exists (e.g., the admin is re-running `create-org` after a partial completion), the procedure shows it as already in effect and skips it. The step is safe to re-run.

**Failure handling:** if the procedure doesn't return `complete` because a grant `failed` — typically because the all-members Google Group hasn't been created yet at the Workspace level, or because the admin's OAuth scope doesn't include permission management on this drive — surface the failure and halt with admin-actionable instructions:

> "Could not grant `{all_members_group}` reader access on `{path}`: {error_summary}.
>
> **gdrive:** this usually means the all-members Google Group hasn't been created at the Workspace level yet. Create it via admin.google.com → Apps → Google Workspace → Groups for Business → new group `{all_members_group}`, configured so domain members can view content shared with it.
> **onedrive:** this usually means the M365 group `{all_members_group}` doesn't exist or isn't resolvable, or the tenant's SharePoint/OneDrive policy blocks internal sharing. Confirm the group exists in the Microsoft 365 admin center and that internal sharing is permitted for the site.
>
> Once the group exists, re-run `@ai:create-org` to resume from where this step left off, or re-run this step (the procedure skips grants already in place)."

If the admin declines a grant (on a backend that supports `share`), explain that members can't use the org without it and offer to re-run this table; don't proceed until it is `complete`. After all four grants are `applied` or already in effect, proceed to item 5.

5. Verify `.claude/settings.json` is present locally (already written in Step 3c). If missing or corrupted, rewrite it.

6. Write `CLAUDE.md` locally (same content as the remote copy, adapted to reference local paths where appropriate).

7. Write `current-state.md` recording completion of this step. The admin workspace doesn't exist until Step 13, so it lives at `.agent-index/create-org-current-state.md`, next to `install-state.json` (see State Management). Also update `install-state.json` (`phase3_step: "8"`), as after every Phase 3 step.

Confirm: "Your org '{org_name}' is configured. Org config and directory structure are live on the remote filesystem."

**On write failure:** Surface the specific remote write that failed. The admin can retry — writes are idempotent.

**On success:** Proceed to Step 9.

---

### Step 9: Upload Collections to Remote

Upload `agent-index-core/` to the remote filesystem so that members can read collection definitions via MCP during their setup.

Walk the local `agent-index-core/` directory and upload it, preserving the directory structure.

**Use `aifs_write_batch` in FIXED sub-batches of ~10 files per call (`bulkuploadserial`, gdrive adapter 2.9.0+ / onedrive 2.6.0+; sub-batching `createorgbatchcap`, finding 54 — the same rule as publish-updates Step 0, `pubstep0nobatch`).** A per-file `aifs_write` loop spawns a fresh Node process per file and times out well before a ~120-file core upload finishes — that per-file-spawn timeout is exactly what this op removes. But one batch of the whole tree doesn't fit either: on gdrive each file costs ~2.5 s with its read-back verify, so ~98 core files in one call overrun Cowork's ~3-minute tool-call cap and commit only partially. Build the `entries` array of `{path, content_file}` covering all in-scope files, then pass it to `aifs_write_batch` ~10 entries per call, one call after another (never in parallel). Each call ensures its unique parent folders (duplicate-parent-safe) and runs each file's full M2 durable read-back verify (below) inside its process. **Resume-safe:** before uploading (and again on any re-run after an interruption), `aifs_stat_batch` the in-scope paths and leave out files whose remote `size`/`md5Checksum` already matches the local LF-normalized bytes, so a re-run only uploads what is missing or different. **Fallback:** if the deployed adapter predates `aifs_write_batch` (pre-2.9.0/2.6.0), fall back to sequential per-file `aifs_write`, one at a time (the Step 8 sequential-write note). Check availability via `adapter.json` `version` (or a probe) before choosing the path. Do **not** hand-roll a per-file resuming uploader when the batch op is available.

**Exclude build artifacts and binaries from the core upload (corebin, ms-install-8).** Skip: `node_modules/`, `.git/`, `bin/`, any `**/dist/` directory, and any compiled binary (`*.exe`, Mach-O/ELF executables, `*.app/` bundles). **Skip repository and editor dotfiles at any depth, including the root (`dotfileupload`, finding 23):** every path segment that starts with `.` is skipped — `.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`, `.DS_Store`, `.vscode/`, `.idea/`, `.editorconfig` — **except** `.claude/` (core's `CLAUDE.md.template` and hooks), `cowork-plugin/.claude-plugin/` and `cowork-plugin/.mcp.json` (the Cowork plugin's own files) and `.gitkeep` (folder placeholders). This is the same list as publish-updates Step 0's skip-list, and applies to Steps 9.5 and 10 too. Core is *source + capability definitions* only. (ms-install-8 uploaded a stray committed 9 MB executable under `bin/` — pure bloat and the cause of the slow Step-9 transfer. This exclusion is the guard so no build output ever rides along.)

**Large / non-binary files (the `content_file` default):** a file passed as the inline `content` string is capped by the shell argument length (~128KB). For any text file larger than ~100KB, use the `content_file` form: `aifs_write` with `{"path": "...", "content_file": "<local path>"}`. Prefer `content_file` for *every* file in a bulk upload — it avoids the arg-size cliff.

**Durable read-back verify on every bulk-uploaded file (M2, `collectionjson-tornwrite`, core 3.22.4 / C.1.3.4 — HIGH).** Do NOT rely on `aifs_write`'s response-size check alone to conclude a file "landed intact." That check compares against the byte count the backend reports in the **write response** (write-time metadata); a OneDrive simple-PUT can return a full/expected size while durably committing a **truncated** object (a torn/partial commit), and the only re-read the adapter does is gated to sentinel-bearing files — so a non-sentinel JSON file (a `collection.json`, a manifest) can ship truncated and undetected. This actually happened on ms_install_10: core `collection.json` shipped at 31030 of 32402 bytes and was discovered only when a member failed to parse it. **After uploading each file, re-read it back from the backend and verify the committed bytes against the local source** — compare both byte count (`aifs_stat` `size`) **and** the **canonical SHA-256** (per `templates/backend-distribution.md`: hash the stored `size` bytes via `head -c <size>`, never `aifs_read` stdout). On any mismatch, **re-upload from source and re-verify (retry up to 2×); if it still mismatches, halt with a clear error naming the file** — never proceed past a file whose durable bytes don't match the source. (The torn-write observed was transient/one-off, so a re-upload recovers it; the point is to *detect* it deterministically rather than trust the write response.) This is the same round-trip discipline already mandatory for `/shared/dist/` artifacts (the publish-time SHA self-check), extended to the general bulk-upload path. Apply identically wherever this task or `publish-updates` Step 0 bulk-uploads source files.

**If a large file genuinely must be uploaded:** do it in a **single foreground `aifs_write` call** — do NOT background it (`nohup`/`&`). Cowork background processes do not persist across tool calls and only one VM process runs at a time, so a backgrounded upload silently dies and wastes calls (`biguploadbg`, ms-install-8). A ~15MB `content_file` upload completes within a single call's window; if it ever times out, retry the same single foreground call (the adapter write is atomic + size-verified).

Surface progress: "Uploading agent-index-core to remote filesystem... {N} files uploaded."

**Grant members reader on `/agent-index-core/` (memberorgreadblocked).** Immediately after the upload, `aifs_stat("/agent-index-core")` for its Drive id and grant the all-members group reader on it through the permission-changes procedure (one row: `share`, resource `id:{core_folder_id}` on gdrive, `/agent-index-core` on OneDrive, `{all_members_group}`, `reader`, `source: "task_spec"`), confirmed by the admin like the Step 8 root grants. (On OneDrive a bare `id:` resolves against the admin's own drive, not the site drive, so the path is the resource there — finding 63.) Without this, non-drive-members cannot read core capability definitions and `member-bootstrap` runs degraded (skips provisioning). Idempotent; id-anchored on gdrive (path on OneDrive, finding 63) so it's unambiguous. If the result isn't `complete`, continue the install but tell the admin plainly that members can't read core yet; `@ai:publish-updates` 6e offers the grant again.

**On success:** Proceed to Step 9.5.

---

### Step 9.5: Upload AND Provision the Selected Collections (collsetupgap — ms-install-9)

The collections the admin chose in the Phase-1 collection-selection interview (Step 3c-1b) were cloned locally (Step 3c-1c) but are **not yet on remote and not yet set up**. For each, do **both — upload AND provision** — in this step. Uploading without provisioning is the `collsetupgap` bug: the collection is present but `org-setup` **hard-blocks every member (including the admin) from installing any of its capabilities** until `collection-setup-responses.md` exists (bug `20260615-8d20ea22-setupresp`). In ms-install-9 this surfaced as "capabilities can't be installed" and required a manual recovery; it must be a planned step.

For **each** selected collection: `{name}` is the collection's **name from its `collection.json`** (e.g. `projects`), **not** the local clone directory (e.g. `agent-index-marketplace-projects`). Clones are named after their repositories; the remote folder and every runtime path (`/{collection}/api/{task}.md`) use the collection name (`createorgrepopath`, 3.32.0 live test — uploading under the repo name made every capability read `FILE_NOT_FOUND`).

1. **Upload** the local clone (`{clone_dir}/`, the repo-named directory) to `/{name}/` on remote (same `aifs_write_batch` ~10-file sub-batches + skip-list + per-file read-back verify as Step 9; per-file fallback only if the adapter predates the batch op).

   **One collection at a time, and no call longer than ~10 files (finding 55).** Upload, seed and provision one collection fully before starting the next, and keep every remote write in this step to ~10 files per call: the seed writes for six collections together overran Cowork's ~3-minute tool-call cap. Record the collection in `install-state.json` (`phase3_collections_done[]`) once its `status: installed` is written, so a resumed run skips the finished ones.
2. **Register** it in `org-config.json` `installed_collections` (safe org-config rewrite rule) as `status: downloaded` initially, with `"marketplace_id": "agent-index-public"` — the Phase-1 selection interview offers only the public catalog (provenance, core 3.30.0).
3. **Provision it — run the `install-collection` flow** (`agent-index-marketplace` task `install-collection`, Steps 4–5.7; invoke it per collection, or perform the equivalent inline). That flow:
   - **Setup interview / defaults** — read `/{name}/setup/collection-setup.md`, collect org-level params. Offer "accept defaults," but per the **setupresp guardrail** a defaults install STILL writes the responses file. Flag any default that is really a decision — notably **bug-reports `admin_roles`**, which depends on org roles: if roles were skipped (Step 14) it defaults to empty (triage is admin-status-only); the admin can define roles via `@ai:edit-org` and re-run later.
   - **Write** `/{name}/setup/collection-setup-responses.md` with `setup_status: complete`; **verify read-back** (`aifs_read` returns `setup_status: complete`) before the next collection.
   - **Seed** files the setup's Setup Completion section declares (e.g. bug-reports manifest + log key; library taxonomy/doc-types; the `/shared/{name}-index/` directory; projects commons/index), in ~10-file sub-batches.
   - **Create every folder the grants name (finding 55).** Before provisioning grants, read the collection's `collaborative-acls.json` and make sure each folder it names (`acls[].path` ending in `/`) exists on remote (`aifs_exists`; if missing, write a `.gitkeep` inside it, as Step 8 does for `/shared/`). A grant on a folder that doesn't exist has nothing to apply to (a fresh Dev Three org had no `/shared/projects/`).
   - **Provision grants** — the collection's `collaborative-acls.json` writer grants PLUS the unconditional collection code-dir reader grant (`all_members_group` reader on `/{name}/`; resource `id:{folder_id}` on gdrive, the path `/{name}` on OneDrive — finding 63). **Apply through the permission-changes procedure, exactly as `install-collection` Step 5.5 does**: one table per collection, the admin confirms, and `member_read_grant` follows the code-dir row. **The code-dir reader row is always in that collection's table** — also when the collection's own setup brings a grant table of its own (client-intelligence does): merge the setup's rows with the acls rows and the code-dir row into the one table; never let a setup-defined table replace the core-required row (`createorgcodedirrow`, 3.32.0 live test). The procedure's no-op filter makes it idempotent. Resolve `{all_members_group}` / `{param}` placeholders; skip + flag if unresolvable.
   - **Register capability providers** if the collection declares `provides[]`.
   - **Set** `status: installed` + `installed_date` in `org-config.json`.

**Before moving on, check the table for every collection:** it contains a row (proposed or already-in-effect) for the all-members reader on `/{name}/`. A collection whose table lacks it is not provisioned.

Only after **every** selected collection is uploaded AND provisioned are their capabilities installable — Step 13 then installs them into the admin's own workspace, and members install via `@ai:setup`. Do NOT defer this to Step 10.5's marketplace flow (that flow is for adding *further* collections interactively; the Phase-1 selections are handled here).

**On success:** Proceed to Step 10.

---

### Step 10: Bootstrap Agent-Index Marketplace

Ask the admin:

> "To browse and install collections, I need to download the agent-index marketplace tools first. This is a one-time step — it clones the `agent-index-marketplace` collection which provides everything needed to manage collections going forward. Ready to download it?"

If the admin says no: confirm and skip to Step 12. Note they can come back to this later.

If the admin says yes:

1. **Use the infra clone** from Step 3c: `agent-index-marketplace/` is already cloned at its resolved ref (a release tag, or the channel head on a channel org; see `.agent-index/clone-resolution.json`). Never download a ZIP or re-clone from `marketplace_repo_url`. (Before core 3.32.0 this step downloaded the default-branch ZIP, which ignored the release tag and would have reverted a channel org.)
2. If `agent-index-marketplace/` is missing, re-surface the Step 3c infra clone invocation and halt until it has run.
3. *(removed)*
4. *(removed)*
5. Verify the clone by confirming `collection.json` is readable.
6. Upload the entire marketplace collection to the remote filesystem (same `aifs_write_batch` ~10-file sub-batches + skip-list + per-file read-back verify as Step 9; per-file fallback only if the adapter predates the batch op).
6a. **Grant members reader on `/agent-index-marketplace/` (memberorgreadblocked).** After the upload, `aifs_stat("/agent-index-marketplace")` for its Drive id, then grant `{all_members_group}` reader on `id:{marketplace_folder_id}` (OneDrive: on `/agent-index-marketplace`, finding 63) through the permission-changes procedure (`source: "task_spec"`, admin confirms). Members read marketplace capability definitions by path; without this grant a non-drive-member can't. Idempotent; id-anchored. If not `complete`, continue but tell the admin; `@ai:publish-updates` 6e offers it again.
7. Update `org-config.json` on remote via `aifs_read` then `aifs_write` (follow the **safe org-config rewrite rule** below):
   - Add entry to `installed_collections` (with `"marketplace_id": "agent-index-public"`)
   - Update `last_updated`

> **Safe org-config rewrite rule (MUST follow for every `org-config.json` read-modify-write — bug `20260615-8d20ea22-ocstale`):** Never stage the rewritten config at a fixed, shared scratch path like `/tmp/oc.json` — a leftover file from another org's install can be picked up and uploaded, corrupting the canonical config (observed in two installs). (a) Build the new content **in memory** or in a **unique** path (`mktemp`), never a fixed name; (b) **before** the authoritative `aifs_write`, parse the bytes you are about to upload and **assert `org_id` matches this org and `remote_filesystem.connection.site_id`/`drive_id` match the in-session values** — abort if they don't; (c) only then write. This is the source-identity complement to `aifs_write`'s size-verify: confirm you're uploading the *right* config, not just that it landed intact. **(d) Never re-select the staged file by `ls`/newest-mtime/glob (`ocstalereselect`, C.1.4.0)** — hold the exact `mktemp` path in a variable and reference *that* directly; an ambient "newest staged config" pick can grab an older same-session copy whose `org_id` still matches (so (b) passes) and silently revert the edit you just made. **(e) Assert content, not just identity:** before the write, confirm the staged config actually contains the change (e.g. the collection you're registering appears in `installed_collections`) so a stale same-org copy is caught pre-write, not only by the read-back.

Proceed to Step 11.

---

### Step 10.5: Check Network Access and Open Marketplace

Before invoking any marketplace task, perform a lightweight connectivity check by attempting to fetch the `marketplace_directory_url` from `agent-index.json`:

If not reachable: surface the whitelisting guidance and halt. The admin can say 'open marketplace' once resolved.

If reachable: invoke `run agent-index-marketplace task list-marketplace-collections`. The marketplace flow takes over from here. **The Phase-1-selected collections are already uploaded AND provisioned in Step 9.5** — this step is only for adding *further* collections the admin didn't pick during setup; any added here go through the normal `download-collection` → `install-collection` path (which uploads + provisions them the same way). This is optional — most admins skip it and add collections later via `@ai:marketplace`.

---

### Step 11: Publish `/shared/dist/` (Release C — the org distribution layer)

Now that the collections are on the remote, publish the **distribution layer** members read from instead of GitHub, per the **`backend-distribution`** subroutine (`templates/backend-distribution.md`):
- Copy the three directory files (`infrastructure-directory.json`, `filesystem-adapter-directory.json`, `marketplace-directory.json`) **from the local `agent-index-resource-listings` clone** to `/shared/dist/directories/`.
- Write `/shared/dist/manifest.json` (`dist-manifest/2`) — the `org_release_tag`, `channel` / `channel_head` / `sources` from `.agent-index/clone-resolution.json` (core 3.32.0), per-artifact SHA-256s, and the installed collection versions (the org's version authority).
- Use the publish flow's **diff + hash-verify** (upload only changed; read back + verify SHA). On a fresh create-org everything is new, so all artifacts publish.

This is what makes member `apply-updates` / `check-updates` / `member-bootstrap` fully backend-sourced. (`publish-updates` re-runs this same publish on every later release.)

---

### Step 11.5: Stamp Resource IDs (id-anchored bootstrap — closes bug `groupshareapivisibility`)

By now the three resources members must reach at bootstrap all exist on remote: the `/shared/` tree (Step 8 item 1), `/members-registry.json` (Step 8 item 3), and `/org-config.json` (Step 8 item 2). This step records their Drive ids so that onboarding is addressable **purely by `id:` anchor with no web-UI visit** — the whole point of the fix. Run it AFTER those three exist and BEFORE the bootstrap zip is assembled (Step 12), because the zip's baked-in `agent-index.json` must carry `org_config_id`.

**The `id:` prefix is REQUIRED everywhere these ids are used.** A bare `{folderId}/child` is treated as a **literal path** and fails; the id-anchored form is `id:{fileId}` for a file and `id:{folderId}/rel` for something nested under a folder (e.g. `id:{shared_root}/dist`). This is why we seed ids rather than paths — a member with only the seed and no visit can still resolve the whole tree.

1. **Populate `org-config.json` `resource_ids` (remote).**
   - `aifs_stat("/shared")` → take its Drive folder id as `shared_root`.
   - `aifs_stat("/members-registry.json")` → take its Drive file id as `members_registry`.
   - Read-modify-write `org-config.json` via the **safe org-config rewrite rule** (Step 10's rule — unique `mktemp` staging, identity assert on `org_id` + `site_id`/`drive_id`, content assert that `resource_ids.shared_root` and `resource_ids.members_registry` are now non-null, never re-select the staged file by glob/mtime): set `resource_ids.shared_root` and `resource_ids.members_registry` to the stat'd ids. Read the write back and confirm both ids parse. (core/marketplace/collection roots need nothing added — each already carries `folder_id` under `installed_collections[]`. Nested items like `/shared/dist` need no id — they are reached by `id:{shared_root}/dist`.)

2. **Stamp `org_config_id` into the LOCAL `agent-index.json` (shell-first write).**
   - `aifs_stat("/org-config.json")` → take its Drive file id.
   - Write it into the local `agent-index.json` at `remote_filesystem.connection.org_config_id`. This is the single seed that lets `member-bootstrap` read org-config by `id:{org_config_id}` with no visit. **Write shell-first** (compose the full JSON in memory, then write it with a single shell redirection to an executor-readable path) rather than the editor file-write path — the Cowork mount can truncate an editor-path config write (bug `20260615-8d20ea22-localcfgtrunc`). Then **read it back and `JSON.parse` it**; if it fails to parse or is missing `org_config_id`, rewrite via the shell and re-verify. Never proceed past a local config write you haven't read back and parsed.
   - This MUST complete before Step 12 assembles the zip, because the zip bakes in this local `agent-index.json` and it must carry `org_config_id`.

**Idempotent.** Re-running create-org after a partial completion re-stats and re-writes the same ids — a no-op if they already match.

**On success:** Proceed to Step 12.

---

### Step 11.6: Seed the Update Baseline (`createorgupdatebaseline`, 3.32.0)

A new org starts with an update log, so every later mechanism has one path to follow:

1. **`/shared/updates/published-state.json`:** the org's current state, assembled exactly as `publish-updates` Step 1 assembles it (infrastructure versions and commits, installed collections with `source_commit`, CLAUDE.md hash, adapter checksum, `distribution_channel`). It is the baseline the first `publish-updates` diffs against, so that publish contains only real changes, not "everything is new".
2. **`/shared/updates/update-log.json`:** `{ "entries": [ { "id": "000", "type": "baseline", "date": "{today}", "summary": "Org created", "operations": [] } ] }`.
3. **`/shared/updates/latest.json`:** `{ "latest_id": "000" }`.

Write each file, read it back, and check it parses. In Step 13, set the admin's `member-index.json` `last_applied_update` to `"000"`. With `latest.json` present, session-start uses the update-instruction check, not the version-comparison fallback.

---

### Step 12: Generate and Upload Bootstrap Zip

Generate the member bootstrap zip. This is the minimal package that a new member downloads and unpacks to get started.

**Assemble the zip contents:**

Create a temporary directory with `mktemp -d` — in the sandbox, not under the mounted project folder (`{temp_directory}` below is the same `$WORK` the zip step uses; finding 67) — and populate it with:

```
agent-index/
├── agent-index.json                    # The local copy (with remote_filesystem configured)
├── .claude/
│   └── settings.json                   # SessionStart hook
├── mcp-servers/
│   └── filesystem/
│       ├── aifs-exec.bundle.js         # On-demand executor bundle
│       ├── aifs-exec.sh                # Shell wrapper for executor
│       └── adapter.json                # Adapter metadata (version, checksum, build timestamp)
├── agent-index-core/
│   └── .claude/
│       └── hooks/
│           └── session-bootstrap.sh    # Bootstrap script
├── agent-index-filesystem.plugin       # Cowork plugin for validation (Cowork only)
└── CLAUDE.md                           # Claude context
```

**Include the executor bundle (Release C):**

The executor bundle (`aifs-exec.bundle.js`, `aifs-exec.sh`, and `adapter.json`) was staged in Step 3c (from the local adapter clone). Copy these into the bootstrap zip at `mcp-servers/filesystem/…`. Do NOT re-download the bundle.

The `agent-index.json` in the zip is the fully configured copy from the local filesystem (written in Step 3c, then stamped with `org_config_id` in Step 11.5) — it includes the `remote_filesystem` section with backend, connection config, and auth settings. **It MUST include `remote_filesystem.connection.org_config_id`** (the Drive id of `/org-config.json`, stamped in Step 11.5) — this is the id-anchored bootstrap seed that lets `member-bootstrap` read org-config by `id:` with no web-UI visit (bug `groupshareapivisibility`). Before creating the zip, confirm the local `agent-index.json` you are about to bake in has a non-null `org_config_id`; if it is absent, Step 11.5 did not complete — go back and run it before proceeding. It does NOT include any credentials.

The `.claude/settings.json` includes only the session hook that enables the on-demand executor. It does not include server definitions — the executor is called directly via the shell wrapper.

**Include the Cowork plugin:**

Build the `agent-index-filesystem.plugin` file from `agent-index-core/cowork-plugin/`. The `.plugin` file is a zip archive of the plugin directory contents:

```bash
cd {project_dir}/agent-index-core/cowork-plugin && zip -r {temp_directory}/agent-index/agent-index-filesystem.plugin .claude-plugin/ .mcp.json scripts/ README.md
```

This plugin is used by Cowork for validation and configuration management. It discovers the workspace at runtime (by scanning `$HOME/mnt/*/` for `agent-index.json`) — no org-specific configuration needed. Cowork members should install this plugin for an optimal experience; the member-bootstrap skill guides them through it.

The `session-bootstrap.sh` is copied from the local `agent-index-core/.claude/hooks/`.

The `CLAUDE.md` is the local copy written in Step 8.

**Create the zip:**

`zip` needs to rename/unlink as it works, which the mounted workspace folder does not permit — building in place fails. Use a non-mount scratch dir for both the staging tree and the output, then read the result back:

```bash
WORK="$(mktemp -d)"            # NOT under the mounted project folder
# assemble agent-index/ under $WORK, then:
cd "$WORK" && zip -r "$WORK/member-bootstrap.zip" agent-index/
```

**Upload to remote:**

Upload via the `content_file` form (binary): `aifs_write` with `{"path": "/shared/bootstrap/member-bootstrap.zip", "content_file": "<$WORK/member-bootstrap.zip>", "encoding": "base64"}` — `content_file` is the RAW zip; never base64-encode it yourself first, or the backend stores base64 text as the zip (finding 67). Then read it back: `aifs_stat` `size` equals the local byte count, and the SHA-256 of the read-back bytes (`head -c <size>`) equals the local zip's — same check as `templates/regenerate-bootstrap.md` Step 6. (Avoid leaving temp read-back files in the mounted folder; write scratch to `mktemp` dirs.)

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
> 3. Open the `agent-index-filesystem.plugin` file inside `~/agent-index/` and confirm the install prompt in Cowork. (This connects Cowork to your org's shared storage.)
> 4. Open Cowork (Claude desktop app)
> 5. Set your working folder to `~/agent-index/`
> 6. Say: **"set up my agent-index member workspace"**
> 7. You'll be guided through authenticating to {backend display name} — have your {backend} account credentials ready.
>
> That's it. The setup process will handle everything else.
>
> *(If you use Claude Code CLI instead of Cowork, skip step 3 — the CLI reads the server config from `.claude/settings.json` automatically.)*

**On success:** Proceed to Step 13.

---

### Step 13: Set Up Admin Member Workspace

Say:

> "Your org is configured and the member bootstrap zip is ready for distribution. Now let's set up your own member workspace so you're ready to work."

The admin's member workspace is set up locally, following the same flow that members will experience (minus the bootstrap zip download — the admin already has everything local):

1. Create the local member workspace directory structure: `{project_dir}/members/{admin_hash}/` with subdirectories: `skills/`, `tasks/`, `profile/`
2. Create `member-index.json` for the admin (locally), with `"last_applied_update": "000"` (the baseline seeded in Step 11.6) and `"helper_removed": true` (a 4.0.0 install never had the retired permission helper, so apply-updates Step 1.6 has nothing to remove)
3. **Provision the admin's remote member space** — run the canonical **ensure-member-space subroutine** (defined in `member-bootstrap.md`, "ensure-my-drive-space"), exactly as a member would. The admin runs `create-org`, not `member-bootstrap`, so without this the admin never gets a remote member space and owned-content collections they run (strategy, capture, etc.) have no `member_folder_id` to anchor on. The subroutine: create `Agent-Index-Private-{org_uuid}` in the admin's own drive via `id:root/...`, stat the **resolved** id, record `member_folder_id` in the admin's `member-index.json`, and write the registry handshake. **Before running it, give the admin an artifacts dir like any member** (`adminartifactsdir`, finding 57): materialize `/shared/members/artifacts/{admin_hash}/.placeholder`, `aifs_stat` it for its id, and write `artifacts_dir_id` into the admin's `members-registry.json` entry (revision-aware; on gdrive by id, `id:{resource_ids.members_registry}`, on OneDrive by path, `/members-registry.json` — finding 63) — so the subroutine's handshake write is by id, not the path fallback. It is idempotent and backend-agnostic (`id:root` resolves to the admin's My Drive on gdrive / OneDrive). On OneDrive, if it returns `NOT_PROVISIONED`, surface the "sign in to office.com once" message and retry after. (Closes bug `20260615-8d20ea22-adminspace`.)
4. Run the preferences-management initial interview
5. If collections were installed via marketplace in Step 11, proceed to capability selection and installation for the admin

The transition should feel seamless — the admin does not need to separately invoke setup.

On completion: "Your member workspace is ready. You can start using your installed capabilities."

If the admin declines or wants to do this later: accept that, note they can say '@ai:setup' anytime.

**On success:** Proceed to Step 14.

---

### Step 13b: (removed)

(Step removed in core 4.0.0: the permission helper is retired. Proceed to Step 14.)

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

**First, make the admin's own workspace usable (closes bug 20260617-8d20ea22-admincaps).** Installing collections org-wide does NOT add their capabilities to the installing admin's personal `member-index.json`. Before presenting the summary, read `members/{admin_hash}/member-index.json`: if collections are installed org-wide but the admin's `skills`/`tasks` are empty (or missing collections), **offer to install them into the admin's workspace now** by running the `org-setup` first-time capability install for the admin: "Your org has {N} collections installed, but none are in your personal workspace yet — you can't run their capabilities until they are. Install them into your workspace now?" On yes, run org-setup's onboarding for the admin and confirm what got installed. Do NOT report the workspace as "ready" if it has no capabilities.

Present the final summary:

> **Org Setup Complete — {org_name}**
> Org ID: {org_id}
> Remote backend: {backend display name}
> Admins: {admin display names}
> Installed collections: {list}
> Org roles: {list, or "none defined yet"}
> Your member workspace: {capabilities installed: list, OR "set up, but no capabilities installed yet — run '@ai:setup' to install the ones you want to use"}
> Bootstrap zip: uploaded to {remote location}
>
> **To onboard new members:** run '@ai:invite-member' for each person. It provisions their access (the per-member share grants), registers them, and gives you their personalized install instructions — don't just hand out the bootstrap zip, because that skips the access grants and they'll have no read access on their first session. (The zip lives at {remote location} for reference; invite-member is the path.)
>
> **To start using capabilities yourself:** if any aren't in your workspace yet, say '@ai:setup' to install them.
>
> **To edit org configuration:** say '@ai:edit-org' or 'edit org'
> **To publish updates for members:** after making org changes, say '@ai:publish-updates' to generate update instructions that members can apply with '@ai:update'
> **To regenerate the bootstrap zip:** say '@ai:create-org' (it will detect the existing org and offer appropriate options)

### Step 16: Offer Install Log Upload

After the completion summary, if an install log file exists in `.agent-index/logs/` for this run, offer to share it with the agent-index development team:

> "Your install generated a diagnostic log that can help the agent-index team improve the setup experience. The log contains step-by-step diagnostics — which steps ran, timing, errors encountered, and reasoning. It includes hashed identifiers for your org and member but no credentials, tokens, or personal information."
>
> "Would you like to share this log with the agent-index team?"

If the admin accepts: invoke the `upload-install-log` task. It handles reading the config, building the envelope, and uploading.

If the admin declines: accept gracefully. "No problem. The log is saved locally at `.agent-index/logs/{log_filename}` if you want to review or upload it later with '@ai:upload-install-log'."

If `log_collector_url` or `log_collector_api_key` is not configured in `agent-index.json`: skip this step silently. The upload infrastructure is not yet set up.

**Channel orgs (`distribution_channel` set): don't offer the upload.** Logs from unreleased code would mix into the production diagnostics. Say instead: *"This org runs distribution channel {name}, so the install log stays local at `.agent-index/logs/{log_filename}`."* (`channellogupload`, 3.32.0 live test.)

**Telemetry key choice (added core 3.11.2 — distribution decision D3, deploy-readiness release record).** Before the first upload offer of a new org install, surface the telemetry identity explicitly rather than silently inheriting the template value:

> "Diagnostics uploads are configured with the **community key** (the default shipped with agent-index). If your organization was issued its own key, I can set it now; you can also disable telemetry entirely."
> Options: keep community key / enter org key (writes `log_collector_api_key` in `agent-index.json`) / disable (clears `log_collector_url`; upload steps then skip silently).

Paying customer orgs receive their own key from Agent Index Inc; the community key remains the default for free installs. The override is plain per-install config — no code path differs by key.

---

## Directives

### Remote Filesystem Access

All `aifs_*` operations are invoked via the on-demand executor shell wrapper: `bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh <tool_name> '<json_args>'`. Each call runs a fresh Node process, executes one operation, and exits. There is no persistent server or bridge. If the shell wrapper is not found, the exec bundle is missing from the install — surface an error and suggest '@ai:member-bootstrap'. In Cowork, `<project_dir>` resolves to the mounted workspace directory containing `agent-index.json`.

### Install Logging

This task must maintain a structured install log throughout its execution. The log captures intent, actions, results, errors, and reasoning — providing a complete diagnostic record for agent-index developers to review.

**Log file:** `.agent-index/logs/create-org-{run_id}.jsonl` where `run_id` is a timestamp generated when the task first starts (e.g., `create-org-20260328T180000Z`). Store the `run_id` in the install state file so subsequent sessions append to the same log. Create the `.agent-index/logs/` directory if it doesn't exist.

**When to write log entries:** Before and after every significant action. "Significant" means: step transitions, tool calls, file writes, decisions, errors, retries, and any moment where you are choosing between alternative approaches. The log should be continuous — there should never be a gap where something happened but wasn't logged.

**Critical rule:** Every log entry must be written to the file BEFORE the action it describes (for `intent` events) or IMMEDIATELY AFTER (for `result`, `error` events). Do not batch log entries. Do not skip logging because you are focused on solving a problem. If you find yourself troubleshooting, debugging, or trying alternative approaches, those are the MOST IMPORTANT moments to log — they are exactly what developers need to see.

**Log entry schema** (one JSON object per line, no trailing commas):

```json
{
  "ts": "ISO 8601 timestamp",
  "run_id": "create-org-{timestamp}",
  "session": 1,
  "step": "3c",
  "event": "intent | result | error | decision | session_start | session_resume | step_start | step_complete",
  "message": "Human-readable description of what is happening and WHY",
  "detail": {}
}
```

**Event types and when to use them:**

- **`session_start`**: First entry in a new session. Include: session number, whether resuming from install state, whether the exec shell wrapper exists and is executable.
- **`session_resume`**: When resuming from install state. Include: the install state status, completed steps, next step.
- **`step_start`**: When beginning a new step. Include: step number, brief description.
- **`step_complete`**: When a step finishes. Include: step number, duration, outcome.
- **`intent`**: BEFORE taking any action. Describe what you plan to do and why. This is the most important event type — it captures your reasoning. Examples:
  - "Calling aifs_auth_status to check if member is already authenticated"
  - "Writing .claude/settings.json with the session hook"
  - "Domain raw.githubusercontent.com is blocked — saving install state for resume"
  - "Executor wrapper not found at expected path — checking .claude/settings.json for session hook config"
- **`result`**: AFTER an action completes successfully. Include what happened.
- **`error`**: When something fails. Include: the full error message, whether it's retryable, what you plan to do next. In `detail`, include any error codes, stack traces, or diagnostic information available.
- **`decision`**: When choosing between alternatives. Include: what the options were, which you chose, and why. This is critical for diagnosing cases where the wrong path was taken.

**Detail object:** Use `detail` for structured data that supplements the message. Examples:

```json
{"detail": {"tool": "aifs_auth_status", "result": {"authenticated": false, "reason": "no_credential"}}}
{"detail": {"tool": "aifs_write", "path": "/org-config.json", "size_bytes": 1234}}
{"detail": {"blocked_domains": ["accounts.google.com"], "reachable_domains": ["raw.githubusercontent.com"]}}
{"detail": {"options": ["retry auth", "collect credentials again"], "chosen": "retry auth", "reason": "auth code may have expired"}}
{"detail": {"error_code": "NETWORK_ERROR", "retryable": true, "retry_count": 1}}
```

**What NOT to log:** File contents (especially anything containing credentials, OAuth client secrets, or tokens). Log the path and size, not the content.

**Session continuity (MUST hold — no gaps):** On resume, **re-opening the log is the FIRST action — before any reachability check, download, or write.** Read the `run_id` from the install state and re-open the existing `.jsonl`; if the install state somehow lacks a `run_id` (older state files), recover it by selecting the newest `create-org-*.jsonl` in `.agent-index/logs/` and appending to that, and write the recovered `run_id` back into the install state. Then **append to it** — never start a fresh log or stop logging mid-run. (In ms-install-5 the log stopped at session 1's halt because later sessions didn't re-open it first; this is the loggap defect — doing the re-open before anything else is what prevents it.) Every session that does work, including the final session that performs the remote writes and reaches completion, must append entries through the last step; a log that stops at an earlier session's halt is a defect (bug `20260614-8d20ea22-loggap`). The first entry on resume is `session_resume` with the install-state context. Treat `completed_steps` as **append-only and contiguous** — append each step as it finishes (do not skip entries, e.g. 10→12); it is an audit record, not a checkpoint shorthand. As a finalization check before the completion summary, confirm the log's last entry corresponds to the final step reached this session.

### Behavior

This task is run by a technical or semi-technical org admin. It can assume a higher level of comfort with concepts like OAuth client IDs, S3 buckets, and Google Cloud Console than a typical member setup flow. Explanations should be clear but not over-simplified.

The backend selection and authentication steps (Steps 3–5) are the critical path. If the admin cannot authenticate or the connectivity test fails, nothing else can proceed. Invest time in clear error messages and troubleshooting guidance here.

**Three-phase flow:** This task always spans at least two Cowork sessions, with an optional admin action in between:

- **Phase 1 (first session, Steps 1–3c):** Collect org info, pick the adapter, test domain reachability, download the adapter bundle, write all local config files (`agent-index.json`, `.claude/settings.json`), and write the install state file. Always ends with a halt — either because domains are blocked (admin must update allowlist) or because the session hook needs a session restart to load.
- **Phase 2 (admin action, outside Cowork):** If domains were blocked, the admin goes to Claude.ai admin settings and adds the required domains to the network allowlist. If domains were already reachable, this phase is skipped.
- **Phase 3 (second session, Steps 4+):** The admin starts a new Cowork session. The session hook loads from `.claude/settings.json`, enabling the on-demand executor. Step 0 detects the install state file, verifies domain reachability, and resumes at Step 4 (authentication). From here the flow continues uninterrupted through completion.

In sandboxed environments (Cowork), network access to backend API domains AND infrastructure domains (GitHub) may be blocked by the platform's network allowlist. Step 3b detects this and saves progress to `.agent-index/install-state.json`, giving the admin clear instructions to update the allowlist and resume in a new session. This is expected behavior, not an error — present it calmly and clearly. The admin should feel confident that their progress is saved and that resuming is straightforward.

Write nothing to the remote filesystem before the Step 8 confirmation. Steps 1–7 are purely data collection and local configuration. The Step 8 confirmation is the point of no return for remote writes.

The local `agent-index.json` and `.claude/settings.json` are written in Step 3c (end of Phase 1). This happens before the Step 8 confirmation because the session hook must be configured and loaded (in the next session) before authentication can proceed in Step 4. These local config files do not affect the remote filesystem.

### State Management

**Install state file (`.agent-index/install-state.json`):** Written in Step 3b or Step 3c to bridge the session gap between Phase 1 and Phase 3, and kept current through Phase 3. The file has three possible in-flight statuses:

- `"awaiting-network-allowlist"` — written in Step 3b when one or more required domains are blocked. The `next_step` field is `"3c"` because the bundle hasn't been downloaded yet. On resume (Step 0 in Phase 3), if domains are now reachable, the flow continues at Step 3c.
- `"awaiting-session-restart"` — written in Step 3c after all config files and the adapter bundle are in place. The `next_step` field is `"4"`. On resume (Step 0 in Phase 3), the flow skips directly to Step 4 (authentication).

The file captures all collected data (org name, backend, connection config) so the admin does not need to re-enter anything. The `required_domains` field is an object with `infrastructure` and `backend` arrays, enabling Step 0 to test all domains on resume.

- `"phase3-in-progress"` (`createorgresume`, finding 53) — written when Step 4 starts in the Phase 3 session, then rewritten after **every** Phase 3 step completes (4, 5, 6, 7, 8, 9, 9.5, 10, 11, 11.5, 11.6, 12, 13, 14): append the step to `completed_steps`, set `phase3_step` to it and `next_step` to the step that follows, refresh `updated_at`. On resume (Step 0) the flow continues at `next_step`; Step 1 and `edit-org` treat an org-config whose `org_id` matches `collected.org_id` as this run's unfinished org, not an existing org. Write it shell-first and read it back (the same torn-write guard as `agent-index.json`).

Update the `status` field to `"completed"` and the `updated_at` timestamp when the task finishes successfully (Step 15). Do not delete the file — it serves as an audit trail.

**Current state file (`current-state.md`):** Write after successful completion of Step 8. Record: org name, org ID, backend type, admin list, completion date. This provides a recovery reference if the task is interrupted during later steps. Location: `.agent-index/create-org-current-state.md` in the project directory, next to `install-state.json`; it stays there (the admin workspace, which holds other tasks' state directories, is only created in Step 13). `install-state.json` remains the machine-readable resume record; this file is the human-readable one.

If the task is re-invoked after Step 8 was completed but later steps were not: Step 0 (status `phase3-in-progress`) or Step 1's own-org check detects it; confirm with the admin where to resume, and continue from `next_step`.

### Constraints

Never overwrite an existing `org-config.json` on the remote filesystem without going through `edit-org`. The detection in Step 1 is mandatory.

Never proceed past Step 5 if the connectivity test fails. Without confirmed remote access, no subsequent step can succeed.

The current member running this task is always added to the admin list. They cannot remove themselves during create-org — they may do so later via `edit-org` as long as at least one other admin remains.

Never skip generating and uploading the bootstrap zip in Step 12. This is the distribution mechanism for members. Without it, members cannot set up agent-index.

Never include credentials or tokens in the bootstrap zip — no `.agent-index/credentials/`, no OAuth tokens, no path cache. The zip contains connection config: endpoint identifiers and the OAuth client ID, plus, on gdrive, the OAuth client **secret** the adapter's `connection_schema` requires. That secret belongs to an installed-app (desktop) OAuth client, which Google does not treat as confidential; members need it to sign in. Members authenticate individually during their setup (`zipsecretwording`, finding 52).

Never skip writing `CLAUDE.md` during Step 8 (both locally and on remote). This file gives Claude the context it needs to understand agent-index. Without it, the bootstrap hook's output is meaningless.

### Edge Cases

If the admin's generated org ID collides with a collection name already present on the remote filesystem (e.g., the admin names their org "Projects" which would generate `projects`, but a `projects/` directory already exists on remote): surface the conflict and ask for a different org name.

If `agent-index.json` cannot be read at the expected local path: surface: "I couldn't find the agent-index root configuration file. Make sure you've cloned agent-index-core into this directory before running org setup." Halt.

If the running admin's email cannot be determined from Cowork session context, ask for it directly. The email is required for identity resolution.

If the executor wrapper cannot be found or is not executable: surface the error clearly. Common causes: the bootstrap zip was not correctly unpacked, or the shell wrapper file permissions were lost. Offer guidance: "Make sure the executor bundle was correctly unpacked and that `aifs-exec.sh` has execute permissions. Check that the file exists at `mcp-servers/filesystem/aifs-exec.sh`."

If a remote write fails partway through Step 8 (some files written, some not): surface which writes succeeded and which failed. The admin can retry — all writes are idempotent (they overwrite existing files).

If the admin wants to use a backend not yet supported: surface: "Currently supported backends are Google Drive, Microsoft OneDrive/SharePoint, and Amazon S3. Support for additional backends is planned." Do not proceed with an unsupported backend.

Emails are the canonical identity input — not an edge case.
