---
name: filesystem-setup
type: skill
version: 1.0.0
collection: agent-index-core
description: "[DEPRECATED in v2.0.0 — replaced by member-bootstrap] Guides a member through connecting to the org's shared filesystem, verifying access to collection directories and member workspace, and establishing the paths agent-index needs to function."
stateful: true
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
deprecated: true
replaced_by: member-bootstrap
---

> **⚠️ DEPRECATED:** This skill was replaced by `member-bootstrap` in agent-index-core v2.0.0. The v2.0.0 architecture uses a remote filesystem (Google Drive, OneDrive, or S3) accessed via MCP server instead of a locally mounted shared drive. See `member-bootstrap.md` for the current workflow.

## About This Skill

Agent-index depends on a shared filesystem that every member can access — a synchronized directory that holds the org's installed collections, the member's installed skill and task instances, and the shared artifact space. This filesystem is typically a cloud-synced drive (Google Drive for Desktop, OneDrive, Dropbox, or equivalent) that appears as a local directory on the member's machine.

The Filesystem Setup Skill handles the process of connecting to that filesystem, verifying that the right directories are readable and writable, and writing the confirmed paths to the member's profile so that agent-index can function reliably. It is the first thing a new member does, and it is the recovery tool when connectivity breaks.

This skill is designed to be run by members who may have no technical background. It asks simple questions, interprets answers generously, verifies what the member provides, and gives clear feedback at every step. When something is wrong, it explains what is wrong and what to do — not in technical terms, but in terms of actions the member can take.

### When This Skill Is Active

When invoked, this skill guides the member through a structured verification sequence. It asks for or detects the filesystem root path, verifies each required directory in sequence, and writes confirmed paths to the member's profile. The member's input is required only when paths cannot be detected automatically.

This skill is also triggered automatically by the Session Start Task when `agent-index.json` cannot be read at the expected path — meaning the filesystem is not connected. In that context it runs as a recovery flow rather than a first-time setup flow, but the verification sequence is identical.

### What This Skill Does Not Cover

This skill establishes filesystem connectivity only. It does not install collections, configure preferences, or set up member capabilities — those come after filesystem setup is confirmed. It does not manage cloud sync service configuration (installing Google Drive for Desktop, for example) — it assumes the sync service is already installed and the member needs to connect agent-index to it. If the sync service itself is not installed, this skill surfaces that as the prerequisite and stops.

---

## Directives

### Behavior

When invoked, determine whether this is a first-time setup or a reconnection. First-time setup is indicated by the absence of a `member-index.json` file at any expected location. Reconnection is indicated by a readable `member-index.json` but an inaccessible `agent-index.json`.

Conduct the verification sequence step by step. Do not skip verification steps even if the member says everything is already set up. Verification is the product of this skill — confirmation that the filesystem is correctly connected, not just the member's belief that it is.

Attempt automatic path detection before asking the member to provide paths. Common sync service mount points vary by OS and configuration — try the most common locations silently before asking. If detection succeeds, show the member what was found and ask them to confirm rather than asking them to type a path.

Common mount point patterns to attempt (try in order, silently):
- `~/Google Drive/My Drive/`
- `~/Google Drive/Shared drives/`
- `~/OneDrive/`
- `~/Dropbox/`
- `~/Library/CloudStorage/` (macOS unified cloud storage)
- `/mnt/` subdirectories (Linux)

Within each detected mount point, look for the presence of `agent-index.json` as the signal that this is the correct filesystem root.

If automatic detection finds a candidate: present it to the member for confirmation before proceeding.
If automatic detection finds nothing: ask the member to navigate to their synced drive folder and provide the path, or to drag the folder into the conversation if their environment supports it.

### First-Time Setup Sequence

**Step 1 — Locate filesystem root**
Detect or ask for the path to the directory containing `agent-index.json`. This is the filesystem root.

Verify: `agent-index.json` exists and is readable at the provided path.

If verified: confirm to member and proceed to Step 2.
If not found: explain that `agent-index.json` is the marker file for an agent-index filesystem and it was not found at the provided path. Offer two possibilities: (a) the path is wrong — ask them to check, (b) the org filesystem has not been set up yet — they should contact their org admin.

**Step 2 — Verify collection directories**
Read `agent-index.json` to get the `library_root`. Verify that at least `agent-index-core/` and `agent-index-marketplace/` exist and are readable within the library root. These are the minimum required collection directories.

If verified: confirm and proceed to Step 3.
If missing: surface which directories are missing. Explain that these are required agent-index infrastructure collections and the org admin needs to set them up before members can connect. Do not proceed — there is nothing functional to connect to yet.

**Step 3 — Verify or create member workspace**
Determine the member's identity by computing SHA256 of the member's lowercase email address (from Cowork session context) and taking the first 16 hexadecimal characters. This is the member's `member_hash`.

If the member's email cannot be determined from session context: ask the member directly for their email address. Explain: "I need your email address to set up your workspace — this is used to generate your member identifier."

Confirm the member's display name (pre-populated from Cowork session context if available, otherwise ask).

Check whether `/members/{member_hash}/` exists:
- If it exists and is writable: confirm and proceed to Step 4
- If it exists but is not writable: surface a permissions error. The member workspace exists but this member cannot write to it. They should contact their org admin to correct the permissions.
- If it does not exist: create the directory structure:
  ```
  /members/{member_hash}/
    /skills/
    /tasks/
    /profile/
    /shared-artifacts/
  ```
  Confirm creation and proceed to Step 4.

**Step 4 — Create or verify member index**
Check whether `/members/{member_hash}/member-index.json` exists:
- If it exists: read it and confirm it is valid JSON. If valid, this is a reconnection — skip to Step 5.
- If it does not exist: create an empty member index:
  ```json
  {
    "member_hash": "{member_hash}",
    "agent_index_version": "{version from agent-index.json}",
    "last_updated": "{today's date}",
    "installed": {
      "skills": [],
      "tasks": []
    }
  }
  ```
  Confirm creation and proceed to Step 5.

**Step 4.5 — Write member entry to registry**
Write or update the member's entry in `/members/members-registry.json`:
- If the registry file exists: read it and add or update the member's entry
- If it does not exist: create it with the member's entry

Entry format:
```json
{
  "member_hash": "{member_hash}",
  "display_name": "{display_name}",
  "email": "{email}",
  "org_role": null,
  "joined_date": "{today's date}"
}
```

Confirm the registry is updated and proceed to Step 5.

**Step 5 — Verify shared space**
Verify that `/shared/` exists and is readable. Write access is not required for most members — read-only is sufficient for viewing reports and dashboards.

If readable: confirm and proceed to Step 6.
If not found or not readable: surface as a warning, not a blocker. The member can proceed without shared space access — it only affects the ability to view aggregated reports. They should notify their org admin.

**Step 6 — Write confirmed paths to profile**
Write the confirmed filesystem root path and member hash to a paths record in the member's profile directory:

```
/members/{member_hash}/profile/filesystem.md
```

```markdown
# Filesystem Configuration
**Configured:** {date}
**Last Verified:** {date}

## Paths
filesystem_root: {confirmed root path}
agent_index_json: {confirmed path to agent-index.json}
member_hash: {member_hash}
member_root: {confirmed member directory path}
shared_root: {confirmed shared path or "not accessible"}
```

**Step 7 — Confirm and hand off**
Confirm to the member that filesystem setup is complete. Surface any warnings from Steps 5. Tell the member what to do next:

If this is first-time setup:
> "Your filesystem is connected. Next, say '@ai:setup' to configure your preferences and install your org's skills and tasks."

If this is a reconnection:
> "Your filesystem is reconnected. Your installed skills and tasks are available again."

### Reconnection Flow

A reconnection is identified when `member-index.json` exists and is readable but `agent-index.json` is not accessible. The member's installation is intact — only the filesystem connection is broken.

Run the full verification sequence (Steps 1–6) exactly as in first-time setup. The difference is in Step 4: since `member-index.json` already exists, create it is skipped. In Step 7, use the reconnection confirmation message.

Do not re-create directories or files that already exist and are correctly formed. Only create or repair what is missing or broken.

### Automatic Invocation Behavior

When this skill is invoked automatically by the Session Start Task (because `agent-index.json` could not be read), surface a brief explanation before beginning:

> "It looks like the org filesystem isn't connected right now. Let me help you reconnect — this will just take a moment."

Then run the reconnection flow. Do not run the full first-time setup interview if `member-index.json` exists.

### Style & Tone

Many members will run this skill exactly once, at onboarding. It should feel simple and guided — not technical. Avoid filesystem jargon where possible. "The folder where your org's shared tools live" is better than "the filesystem root containing agent-index.json."

When something goes wrong, be specific about what is wrong and what the member can do. If the resolution requires contacting an admin, say so directly and tell the member exactly what to tell the admin.

For automatic reconnection flows (triggered by Session Start Task), keep the interaction minimal. The member did not ask for this — they just opened a session and something needs to be fixed. Get it fixed and get out of the way.

### Constraints

Never assume a path is correct without verifying it. Every path provided by the member or detected automatically must be verified by attempting to read a known file at that path before being accepted.

Never create files or directories outside of `/members/{member_hash}/`. This skill may create the member's workspace directory structure and profile files — nothing else. It does not modify collection directories, `agent-index.json`, or any other member's workspace.

Never proceed past Step 2 if the minimum required collection directories (`agent-index-core/` and `agent-index-marketplace/`) are not present. There is nothing functional to connect to.

Never ask the member to provide an absolute filesystem path if automatic detection can find the correct location. Only ask when detection fails.

Never silently accept a path that fails verification. If a path is provided and verification fails, surface the failure and ask for clarification or offer alternatives.

### Edge Cases

If multiple candidate filesystem roots are found during automatic detection (e.g., the member has both Google Drive and OneDrive synced, and both contain an `agent-index.json`): present both options to the member and ask which org they want to connect to. Do not guess.

If the member's workspace directory exists but contains unexpected files or a corrupted `member-index.json`: do not overwrite silently. Surface what was found, explain that it looks like a prior installation may be incomplete or corrupted, and ask whether to attempt repair or start fresh. Repair means re-creating only missing or invalid files. Start fresh means archiving the existing workspace to a timestamped backup directory and creating a clean one.

If `agent-index.json` is found but its contents are not valid JSON or are missing required fields: surface this as an org-level configuration issue. The member cannot proceed — their org admin needs to fix the root configuration file. Provide the member with the exact error to relay to their admin.

If the member's environment does not support automatic path detection (e.g., a remote or containerized environment): skip detection silently and ask directly for the path. Do not surface detection failure as an error — just ask.

If Step 3 creates a member workspace and then a subsequent step fails: do not remove the workspace that was created. Leave it in place — a partial workspace is better than no workspace, and the next run of this skill will complete what this run started.

If this skill is invoked while the filesystem is already correctly connected and the member's workspace is fully intact: confirm that everything looks good and no changes were made. Do not re-run setup unnecessarily.
