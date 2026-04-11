---
name: org-setup
type: skill
version: 2.1.0
collection: agent-index-core
description: Orchestrates member onboarding and ongoing capability management — guiding members through role determination, installing and configuring skills and tasks from installed collections, and keeping installed capabilities current.
stateful: true
always_on_eligible: false
dependencies:
  skills:
    - preferences-management
    - member-bootstrap
  tasks: []
external_dependencies:
  - name: Remote filesystem MCP server
    description: Collection definitions are read from the remote filesystem via the agent-index-filesystem MCP server (aifs_* tools).
---

## About This Skill

The Org Setup Skill is the primary interface between a member and the capabilities their org has made available. It has two jobs: getting a new member fully configured on their first run, and serving as the ongoing entry point for installing new capabilities, checking for updates, and managing installed versions over time.

On first run, this skill orchestrates the full onboarding sequence. It reads the org's installed collections, determines which skills and tasks are relevant to the member's role, resolves the full dependency tree for each, runs the setup interview for each, and writes everything into the member's workspace. A member who completes this flow arrives at their first working session with a fully configured, personalized set of capabilities ready to use.

On subsequent runs, this skill acts as a capability catalog and management console. The member can see what they have installed, what is available but not installed, what has updates available, and what is approaching end of life. They can install new capabilities, trigger upgrades, or browse the catalog — all through natural language.

This skill is the meta-skill because it installs and configures every other skill and task. It is the layer that turns the org's collection library into a member's personal working environment.

### Member Identity Resolution

Member identity is resolved by computing SHA256 of the member's lowercase email address (from Cowork session context) and taking the first 16 hexadecimal characters. This hash is used as the member's local directory name under `members/` and as the `member_hash` throughout the system. The mapping between hash and display identity is stored in `members-registry.json` on the remote filesystem (accessed via `aifs_read`/`aifs_write`).

### When This Skill Is Active

When invoked, this skill takes over the session to conduct setup, upgrade, or catalog operations. It may run for an extended conversation — first-time onboarding involves multiple install and setup sequences. Throughout, it maintains a clear sense of progress so the member always knows where they are in the process.

This skill orchestrates other skills' setup flows. When it installs a skill or task, it invokes that skill or task's setup template as part of its own sequence. The member experiences this as a single continuous conversation, not as separate skill invocations.

### What This Skill Does Not Cover

This skill manages capability installation and lifecycle. It does not manage preferences or aliases — those are the Preferences Management Skill's domain. It does not install new collections at the org level — that is the marketplace. It does not manage the org's collection authoring — that is the Org Authoring Skill (not an infrastructure component; installed separately for org authors). It does not cover troubleshooting remote filesystem connectivity or member authentication — that is the Member Bootstrap Skill.

**Relationship to `@ai:update`:** The `apply-updates` task uses this skill as its execution engine for capability-level operations. When a member runs `@ai:update`, the update system reads published instructions, builds a plan, and delegates collection upgrades and new installs to this skill's existing upgrade and install flows. Members can also invoke this skill directly for manual capability management outside the update instruction system.

---

## Directives

### MCP Tool Usage

This skill uses `aifs_*` MCP tools on the `agent-index-filesystem` server for remote filesystem access. These are MCP tool calls — invoke them through the MCP tool interface when available. If `aifs_*` tools are not found in the tool list, the MCP server did not start. In Cowork, first attempt recovery using the aifs-bridge fallback: check `curl -s --max-time 2 http://127.0.0.1:7819/health` and if not running, start it with `bash agent-index-core/tools/aifs-bridge/aifs-call.sh --start`. If the bridge starts, use it for all `aifs_*` calls via `curl -s -X POST http://127.0.0.1:7819/call -d '{"tool":"TOOL_NAME","args":ARGS_JSON}'`. If the bridge also fails, guide the member to install the plugin and restart. In Claude Code CLI, check `.claude/settings.json` and restart the session.

### Behavior

When invoked, determine the context: first-time setup, ongoing management, or a specific operation (install, upgrade, browse). Use these signals:

- **First-time setup:** `member-index.json` exists but `installed.skills` and `installed.tasks` are both empty arrays, and no prior `onboarding-state` is recorded in the member profile. The member's `member_hash` is computed from their lowercase email address and used throughout their workspace.
- **Specific operation:** Member's invocation names an action — "install the time-off task," "check for updates," "show me what's available."
- **Ongoing management:** Any other invocation — show the member their current state and offer options.

In all cases: read `member-index.json` (local) and the installed collections catalog (remote) before responding. The installed collections catalog is assembled by reading `collection.json` from every collection directory on the remote filesystem via `aifs_list` and `aifs_read`. This is the source of truth for what is available to install.

Never install, modify, or remove anything without the member's explicit confirmation of the specific action. For batch operations (like first-time onboarding where many things are installed), present the full proposed install list and get one confirmation for the batch before proceeding.

Maintain a running progress state throughout any multi-step operation. If the session is interrupted mid-onboarding, the member can re-invoke this skill and it will resume from where it left off rather than starting over. Progress is tracked in `onboarding-state.md` in the member profile.

### Reading the Collections Catalog

The collections catalog is assembled at runtime from the remote filesystem — not a single file, but derived from what is installed on the org's remote storage.

To build the catalog:
1. Read `agent-index.json` to get `library_root`
2. List all directories at the remote library root via `aifs_list("/")`
3. For each directory, attempt to read `collection.json` via `aifs_read("/{directory}/collection.json")`
4. If `collection.json` is readable and valid: include this collection in the catalog
5. Skip `agent-index-core/` and `agent-index-marketplace/` — these are infrastructure, not user-installable capabilities
6. For each included collection, list the `api/` directory via `aifs_list("/{directory}/api/")` to enumerate available public skills and tasks

The result is a structured catalog: collection name, display name, category, description, and list of available API skills and tasks with their descriptions.

If no collections are found beyond the infrastructure collections: surface this to the member. There is nothing to install yet. The org admin needs to install collections via the marketplace before members can set up capabilities.

### First-Time Onboarding Sequence

**Phase 1 — Prerequisites check**

Verify that member bootstrap is complete by confirming `filesystem.md` exists in the member profile and the remote filesystem is accessible (call `aifs_auth_status()` to check). If not: invoke `run agent-index skill member-bootstrap` before proceeding. Do not continue until bootstrap is confirmed complete.

Verify that preferences setup is complete by confirming `preferences.md` exists in the member profile with populated values. If not: invoke `run agent-index skill preferences-management` to run the initial setup interview before proceeding. Do not continue until preferences are established.

**Phase 2 — Role determination**

Explain to the member that agent-index uses their role to suggest which skills and tasks are most relevant. A role is a starting point — they can install anything they want regardless of role, and they can change their role later.

**Step 1: Org role layer**

Read `org-config.json` from the remote filesystem via `aifs_read("/org-config.json")` and check for `org_roles`. If `org_roles` is defined and non-empty:

- Present org roles to the member: "Your org has defined these roles to help configure your workspace. Which best describes your function?"
- List each role with its `display_name` and `description`
- Allow the member to select one, or to skip ("none of these fit")
- When the member selects an org role:
  a. Write the selected `org_role` to the member's entry in `members-registry.json` on the remote filesystem via `aifs_read("/members-registry.json")` (read), modify in memory, then `aifs_write("/members-registry.json", ...)` (write back)
  b. Use the role's `default_collections` to determine which collections to focus on in Phase 3
- If the member skips: proceed without an org role (all collections treated equally in Phase 3)

**Step 2: Per-collection roles**

Within the collections identified by the org role (or all collections if no org role), present per-collection roles if they exist.

Assemble the list of available per-collection roles. Present them to the member with brief descriptions. Ask the member which role best describes their function.

If the member's role is clear from a single collection: present just that collection's roles.
If roles span multiple collections (e.g., an HR collection provides HR roles, an org collection provides company-specific roles): present all available roles grouped by collection and let the member choose.
If the member cannot find a matching role: allow them to proceed without a role. Use no role-suggested parameter defaults — all role-suggested parameters will fall back to member-defined during setup interviews.

Read the selected per-collection role definition. Load `recommended_skills`, `recommended_tasks`, and `parameter_defaults` into working context for use during Phase 3.

Write the selected per-collection role to `/members/{member-hash}/profile/role.md` as the fully flattened role definition (resolve inheritance before writing — the installed role has no `extends` references).

**Phase 3 — Capability selection**

When an org role was selected in Phase 2:
- Pre-filter the recommended capabilities to prioritize those from the role's `default_collections`
- Present them first, clearly grouped: "Recommended for your role:"
- Then offer: "You can also browse capabilities from other installed collections if you'd like."
- The member can still install from any collection — the org role just sets the defaults

When no org role was selected:
- Fall through to the existing behavior (present all available capabilities equally)

Present the recommended skills and tasks for the member's role (or org role's default collections). For each, provide:
- Display name
- One-sentence description (from the skill/task `description` frontmatter field)
- The alias that will be assigned

Ask the member to confirm the recommended set, modify it, or add capabilities from other collections.

If the member wants to browse beyond recommendations: present the full catalog of available skills and tasks grouped by collection. Allow the member to add any of them.

Once the member has confirmed their selection:

1. Resolve the full dependency tree for the confirmed set:
   - For each selected skill and task, read its `dependencies.skills` and `dependencies.tasks`
   - Check each dependency against the selected set — add any not already included
   - Repeat until the dependency tree is fully resolved (no new additions)
   - If a dependency cannot be found in any installed collection: flag it as unresolvable. The skill or task that requires it will be installed as `dependency_status: incomplete`. Surface this to the member.

2. Determine installation order: bottom-up dependency order. Skills that nothing depends on install first; skills that others depend on install before the skills that need them; tasks install after all their required skills.

3. Present the complete installation plan to the member:
   > "Here is what I will install for you, in order:
   > Skills: {list}
   > Tasks: {list}
   > {Any flagged as incomplete due to unresolvable dependencies}
   > Ready to proceed?"

Get confirmation before beginning any installations.

**Phase 4 — Installation and setup**

For each skill and task in the determined installation order:

1. Announce what is being installed: "Installing {display name}..."
2. Create the directory structure in the member's LOCAL workspace
3. Read the canonical definition file from the remote collection via `aifs_read("/{collection}/api/{name}.md")` and write it to the member's local workspace
4. Inject org-mandated parameter values (from the collection's `collection-setup-responses.md`, read via `aifs_read`) into the setup context
5. Inject role-suggested parameter defaults from `role.md` into the setup context
6. Read the setup template (`{name}-setup.md`) from the remote collection via `aifs_read("/{collection}/api/{name}-setup.md")`
7. Conduct the setup interview for this skill or task:
   - Skip questions for `[org-mandated]` parameters — inject the value silently
   - Pre-fill `[role-suggested]` parameters with role defaults — present to member for confirmation
   - Present `[member-overridable]` parameters with their defaults — invite changes
   - Ask for `[member-defined]` required parameters — these must be provided before completing setup
8. Write `setup-responses.md` with all collected values
9. Write the personalized installed instance to the member workspace
10. Write `manifest.json` with version, provenance, parameter provenance map, and dependency status
11. Write the entry to `member-index.json`:
    - Check for alias collisions against all existing entries in the member index
    - If no collision: write the collection-assigned default alias
    - If collision: surface it to the member and resolve before writing (see Alias Collision Handling)
12. Confirm installation: "{Display name} is installed. Invoke it with {alias}."

After all installations are complete, proceed to Phase 5.

**Phase 5 — Verification and completion**

Review the completed installations:
- Confirm count of skills and tasks installed
- List any that were flagged as `dependency_status: incomplete` with a brief explanation
- List any external dependencies surfaced, with the system name and contact provided in the collection manifest

Write onboarding completion state to `/members/{member-hash}/profile/onboarding-state.md`:

```markdown
# Onboarding State
**Completed:** {date}
**Role:** {role display name} from {collection}
**Skills Installed:** {N}
**Tasks Installed:** {N}

## Installed Capabilities
{list of name, collection, alias for each installed skill and task}

## Incomplete Installations
{list of any skills/tasks with dependency_status: incomplete, and why}

## External Dependencies Pending
{list of external systems that need access configured, with contacts}
```

After writing `onboarding-state.md`, also update the member's entry in `members-registry.json` on the remote filesystem (read via `aifs_read("/members-registry.json")`, modify, write back via `aifs_write("/members-registry.json", ...)`) with `org_role` set to the selected org role's `role_id` (or null if none selected).

Surface the completion summary to the member:

> "You're all set. Here's what was installed:
> {brief list of capabilities with aliases}
> {Any notices about incomplete installations or external dependencies}
> Start by trying {first recommended task alias} — {one sentence on what it does}.
> Say '@ai:tutorial' anytime to learn more about how the system works."

### Ongoing Management Mode

When invoked by a member who has already completed onboarding, determine what they want to do. If the invocation is general ("check my setup," "what's available"), present the management dashboard. If it is specific ("install time-off," "upgrade my email task"), proceed directly to that operation.

**Management Dashboard**

Present three sections:

*Installed* — all skills and tasks currently in `member-index.json`, with version, collection, and alias.

*Available* — skills and tasks in installed collections that are not yet in the member's index. Group by collection. Show the alias that would be assigned.

*Needs Attention* — any installed capabilities with `eol_date` within the deprecation threshold, any with `dependency_status: incomplete`, any where the collection version in the member index differs from the current collection version (an upgrade is available).

Offer actions: install something new, upgrade something, show details about a capability, or exit.

**Installing a Single Capability**

When a member asks to install a specific skill or task:
1. Find it in the collections catalog
2. Resolve its dependency tree — install dependencies first if needed
3. Run the setup interview (same as Phase 4, steps 6–11 above)
4. Confirm completion

**Upgrading an Installed Capability**

When a member asks to upgrade, or when upgrading is triggered from the management dashboard:

1. Read the current version from the member's local `member-index.json`
2. Read the new version's definition and setup template from the remote collection via `aifs_read("/{collection}/api/{name}.md")` and `aifs_read("/{collection}/api/{name}-setup.md")`
3. Read the member's existing local `setup-responses.md`
4. Run the upgrade flow from the collection's upgrade script (read via `aifs_read("/{collection}/upgrade/{old-version}-to-{new-version}.md")`) if one exists for this version boundary
5. Migrate preserved responses automatically
6. Present reset parameters and new parameters to the member for input
7. Produce the migration report: preserved / reset / requires attention
8. Write the updated installed instance, `setup-responses.md`, `manifest.json`
9. Update the version in `member-index.json`
10. Confirm: "{Display name} upgraded from {old version} to {new version}."

If no upgrade script exists for this version boundary (MINOR or PATCH upgrade): apply the new definition directly, carry all existing setup responses forward unchanged, update the version in `member-index.json`.

**Removing an Installed Capability**

When a member asks to remove a skill or task:
1. Check `member-index.json` for any other installed tasks that list this skill in their `dependencies.skills`
2. If dependencies exist: surface the affected tasks. Ask the member to confirm they understand those tasks will be affected. Require explicit confirmation before proceeding.
3. If no dependencies, or after confirmation: remove the entry from `member-index.json`, archive the member's installed directory to a timestamped backup location (do not delete — the member may want to reinstall), confirm removal.

### Alias Collision Handling

During installation, before writing an alias to `member-index.json`, check whether the alias is already in use by any existing entry (either as `alias` or `alias_override`).

If no collision: write the collection-assigned default alias and proceed.

If collision detected: surface it immediately:
> "The default alias for {new skill/task} is {alias}, but that alias is already used by {existing skill/task}. Please choose a different alias for one of them."

Present options:
- Keep the existing assignment, assign a new alias to the new capability (member provides)
- Reassign the existing capability to a new alias (member provides), give the default to the new one
- Assign new aliases to both

Do not proceed with installation of this capability until the collision is resolved. Write the resolution to both affected entries in `member-index.json`.

### Progress Tracking and Resumption

During multi-step operations (primarily first-time onboarding), write progress to `onboarding-state.md` after each completed phase. If the session is interrupted and the skill is re-invoked later:

1. Read `onboarding-state.md` to determine what has been completed
2. Confirm to the member where things stand: "It looks like you got through role selection and installed {N} capabilities last time. Want to pick up from there?"
3. Resume from the next incomplete phase

Do not re-run completed phases. Do not re-install capabilities that are already present in `member-index.json` unless the member explicitly requests a reinstall.

### Style & Tone

First-time onboarding is a significant moment for a new member — they are setting up their working environment. Conduct it with appropriate care: explain what is happening at each step, give the member genuine choices rather than just confirming defaults, and celebrate completion.

Ongoing management interactions should be efficient. The member knows the system and wants to get things done. Present information clearly, confirm actions concisely, and complete operations without unnecessary ceremony.

Setup interviews for individual skills and tasks should feel like a natural conversation about how the member works — not a configuration form. The goal is a well-configured capability, and the path to that is understanding how the member actually works.

### Constraints

Never install anything without explicit member confirmation. For batch installs, one confirmation for the full list is sufficient — but the full list must be presented before asking for confirmation.

Never skip dependency resolution. Every installation must have a fully resolved dependency tree before proceeding, even for single-capability installs triggered in ongoing management mode.

Never overwrite an existing installed instance without running the upgrade flow. If a capability is already installed and the member asks to install it again, treat it as a reinstall request — confirm explicitly and run the upgrade flow (or re-run setup if the member wants a clean reconfiguration).

Never modify `agent-index.json` or any collection directory on the remote filesystem. This skill reads collection definitions from remote via `aifs_read` — it does not modify them. All local writes are confined to the member's local workspace at `members/{member-hash}/`. The only remote write this skill performs is updating `members-registry.json` with the member's org role.

Never write an alias to `member-index.json` that collides with an existing alias without explicit collision resolution. The collision resolution must be completed before the installation entry is written.

If the collection's `collection-setup-responses.md` cannot be read from the remote filesystem via `aifs_read("/{collection}/collection-setup-responses.md")` (the collection was installed but org-level setup was never completed by an admin), surface this as a blocker for any capability from that collection:
> "The {collection display name} collection has not been configured by your org admin yet. Skills and tasks from this collection cannot be set up until an admin completes the collection setup. Contact your org admin to resolve this."

### Edge Cases

If a role is selected that has an `extends` chain deeper than 3 levels: surface an authoring error notice, do not install the role, and allow the member to select a different role or proceed without one. Report the issue to the member with enough detail to relay to their org admin.

If a setup interview for a specific skill or task fails partway through (member exits, session ends): write whatever responses were collected to `setup-responses.md` as a partial record. Mark the installation as incomplete in `manifest.json`. On the next run, detect the partial installation and offer to complete the setup from where it left off rather than starting over.

If the same skill or task appears in more than one installed collection (same `name` field in different collections): surface this during capability selection. Present both versions, explain which collection each comes from, and let the member choose which to install. Do not install both without explicit confirmation.

If a collection's API directory is empty (a collection is installed but has no skills or tasks in `api/`): include the collection in the catalog but note it as providing no installable capabilities. It may provide roles only, or it may be incompletely set up.

If the member's role has `recommended_tasks` that depend on skills not in `recommended_skills`: add the missing skills to the recommended set automatically and explain why: "I've also added {skill} because {task} requires it."

If an upgrade script references a version boundary that does not exist in the remote collection's `/upgrade/` directory (checked via `aifs_exists("/{collection}/upgrade/{old-version}-to-{new-version}.md")`): treat the upgrade as a MINOR upgrade — carry all responses forward unchanged, apply the new definition, update the version. Surface a notice that the expected upgrade script was not found so the member can report it to the collection maintainer.
