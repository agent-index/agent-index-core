# Agent-Index Core

The foundational collection for the agent-index system. Agent-index is an organizational knowledge and workflow layer built on top of Claude Cowork. It lets orgs define, share, and personalize AI-powered workflows — and lets members install those workflows into their own Cowork environment.

This repository is the starting point for every agent-index deployment.

---

## What's Included

**Infrastructure skills and tasks** (pre-installed for all members):
- **Session Start** — runs automatically at the start of every session to load member context
- **Member Bootstrap** — authenticates to the org's remote filesystem and creates the local member workspace
- **Org Setup** — installs skills and tasks from the org's collections into a member's workspace
- **Preferences Management** — manages session preferences and invocation aliases
- **System Tutorial** — explains how agent-index works

**Update management tasks**:
- **Publish Updates** — (admin) generates update instructions from org changes and publishes them for members
- **Apply Updates** — (member) reads pending update instructions and applies them locally

**Org management tasks**:
- **Create Org** — first-time org configuration
- **Edit Org** — manage admins, roles, adapter bundle, and launch the marketplace
- **Upload Install Log** — uploads local install state to the remote filesystem for admin visibility

**Member management tasks** (v3.1.0+, admin-only unless noted):
- **Invite Member** — onboards a new member; creates their member directory, applies per-folder ACLs, sends install instructions
- **Remove Member** — removes a member from the registry (Workspace IT handles Drive offboarding)
- **View Permissions** *(member-facing)* — shows who has access to a resource on the remote filesystem
- **View Audit Trail** — surfaces the audit trail for a resource (v1.0 navigates to Drive Activity; v2.0 will wrap the Activity API directly)
- **Verify Workspace Policy** — diagnostic that confirms Workspace settings support the access-control model

**Collection authoring tools**:
- **Author Collection** — guided workflow for building a new marketplace-eligible collection
- **Validate Collection** — checks a collection against the marketplace standards and reports compliance issues

---

## Prerequisites

- Claude Cowork (Teams plan or higher)
- A remote storage backend for shared org files — Google Drive, Microsoft OneDrive, or Amazon S3
- Git installed on the machine of the person doing org setup

---

## Getting Started: First-Time Org Setup

This process is done once by an org admin. It takes about 10–15 minutes.

### Step 1: Clone this repository

Clone agent-index-core to a local directory (e.g., `~/agent-index/`).

```bash
mkdir ~/agent-index && cd ~/agent-index
git clone https://github.com/agent-index/agent-index-core
```

After cloning, your local directory should look like this:

```
~/agent-index/
  /agent-index-core/          ← just cloned
    agent-index.json           ← root registry (inside agent-index-core)
```

### Step 2: Open Cowork and run org setup

Open Claude Cowork. Set your working directory to `~/agent-index/`.

Then say exactly this to Claude:

> **"Set up my agent-index org"**

Claude will read this README, find `agent-index.json`, and guide you through the rest of the setup — including naming your org, choosing your remote storage backend (Google Drive, OneDrive, or S3), authenticating, uploading org files to remote, and generating a bootstrap zip for members. As part of setup, Claude writes `CLAUDE.md` and `.claude/settings.json` locally, and uploads all shared files to the remote filesystem.

That's it. Claude takes it from there.

---

## Getting Started: Member Setup

After an org admin has completed org setup, new members follow this process:

1. Download the bootstrap zip from your org's shared storage (your org admin will provide download instructions specific to your storage backend)
2. Unpack the zip to `~/agent-index/`
3. Open Claude Cowork and set your working folder to `~/agent-index/`
4. Say: **"set up my agent-index member workspace"**

The bootstrap hook will detect you as a new member and guide you through authenticating to the org's remote storage and setting up your local workspace.

---

## Directory Structure

Agent-index uses a two-tier filesystem: member files are local, org/shared files are on remote storage accessed via `aifs_*` tools in exec mode.

**Local (on member's machine at `~/agent-index/`):**
```
~/agent-index/
  CLAUDE.md                           ← Claude context file (from bootstrap zip)
  agent-index.json                    ← root registry (from bootstrap zip)
  .claude/                            ← Cowork session config (from bootstrap zip)
    settings.json
  /agent-index-core/                  ← this repo (from bootstrap zip)
    .claude/
      hooks/
        session-bootstrap.sh          ← bootstrap script (runs at session start)
  /members/
    /a7f3b2c1d4e5f698/               ← member workspace (hash of email)
      member-index.json
      /skills/
      /tasks/
      /profile/
```

**Remote (on org's shared storage, accessed via `aifs_*` tools in exec mode):**
```
/
  org-config.json                     ← org configuration (written by create-org)
  members-registry.json               ← hash-to-identity mapping
  /agent-index-core/                  ← uploaded by create-org
  /agent-index-marketplace/           ← uploaded by marketplace installer
  /projects/                          ← example: installed marketplace collection
  /shared/
    /members/artifacts/               ← per-member shared artifact namespace
    /marketplace-cache/
    /bootstrap/
      member-bootstrap.zip            ← bootstrap zip for new members
    /updates/
      update-log.json                 ← published update instructions for members
      published-state.json            ← snapshot of org state at last publish
      latest.json                     ← lightweight pointer to latest update ID
```

---

## For Org Admins

### Installing marketplace collections

After org setup, say `@ai:marketplace` or "open marketplace" to browse and install collections for your org's members.

### Managing org admins

Say `@ai:edit-org` or "edit org" to add or remove org admins.

### Managing org roles

Say `@ai:edit-org` or "edit org" to define, edit, or remove org roles. Org roles determine which collections new members are prompted to install during onboarding.

### Publishing updates for members

After installing or upgrading collections, updating the adapter bundle, or making other org-level changes, run `@ai:publish-updates` to generate update instructions. This writes structured instructions to the remote filesystem that members can consume by saying `@ai:update`. Members see an update-available notice at the start of their next session.

### Building your own collections

See `standards.md` in this directory for the full specification for building agent-index collections. Any collection that meets the standard can be submitted to the marketplace.

---

## For Collection Authors

The agent-index collection standard is open. Anyone can build a marketplace-eligible collection. See `standards.md` for the full specification.

To submit a collection to the marketplace, open an issue at: https://github.com/agent-index/agent-index-resource-listings

---

## Version History

See CHANGELOG.md.
