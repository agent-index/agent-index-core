# Collection Authoring Guide

**Companion to:** `standards.md` (the formal specification)
**Version:** 1.2.0
**Last Updated:** 2026-04-01

---

## Purpose

`standards.md` defines what a collection must contain. This guide explains how to build one well. It covers design decisions, authoring patterns, and practical advice drawn from building the first-party collections (Projects, Strategy, Capture, Email Triage). Read `standards.md` first — this guide assumes you know the required file structure and schemas.

---

## Thinking About Your Collection

Before writing any files, answer three questions:

**What recurring workflow does this automate?** A collection should map to something a person does repeatedly — triaging email, managing projects, running competitive briefings. If you can't describe the workflow in one sentence, you may be bundling too much into a single collection.

**Who configures it and who uses it?** Agent-index has a two-level configuration model: org admins set policies, members personalize within those policies. If your collection has no org-level decisions (everything is per-member), you still need a `collection-setup.md`, but it can be minimal. If it has heavy org-level configuration (like Projects, which has 10+ feature flags), plan your setup interview carefully.

**What's the minimum viable set of skills and tasks?** Start small. A collection with one task and one config skill is perfectly valid. You can add capabilities in MINOR versions without breaking anything. The email-triage collection launched with 4 API members; Capture launched with 6. Neither needed more at v1.0.

---

## Skills vs. Tasks

The distinction matters for how members interact with your collection:

**Tasks** are things the agent *does*. They run, produce output, and finish. Email triage scans the inbox and delivers a summary. Project creation walks through a brief and writes a project file. Tasks have a clear start and end.

**Skills** are things the agent *knows how to do on demand*. They're interactive capabilities that respond to member requests. Email triage config lets members manage their categories whenever they want. Project editing lets members modify any aspect of a project. Skills are ongoing — there's no single "run" that completes.

The practical difference: tasks typically have a `Workflow` section with numbered steps. Skills typically have a `Directives` section describing how to handle different member requests. Both patterns are valid and well-tested across the existing collections.

### When to split a skill from a task

If your task has a "configure settings" sub-flow that members will want to invoke independently, split it into a separate skill. Email Triage did this: the core triage *task* scans the inbox, but category management is a separate *skill* (`email-triage-config`) because members adjust categories at different times than when they run triage.

If two capabilities share the same state file (like `setup-responses.md`), that's fine — skills and tasks within a collection can read and write the same files. Just document which files each one touches.

---

## Designing the Parameter Model

`standards.md` requires that every parameter in a setup template be annotated with one of four provenance tiers. But the spec doesn't explain *when to use which tier* — that's a design decision. Here's the guidance.

### `org-mandated`

These are decisions the org admin makes once and members can't override. Use this tier for anything where inconsistency across members would cause problems: shared filesystem paths, label naming conventions, delivery channels, platform choices.

**Test:** If two members in the same org configured this differently, would things break or get confusing? If yes, it's org-mandated.

**Examples:** `delivery_method` (email-triage), `shared_projects_path` (projects), `comms_platform` (projects)

### `role-suggested`

Defaults vary by the member's org role, but the member can override. This tier is rare — most collections don't need it. Use it when a sensible default depends on what someone does in the org (an engineer might want different priority sensitivity than an executive).

**Test:** Would different roles in the org reasonably want different defaults for this parameter? If yes, and you can define those defaults, use role-suggested.

**Examples:** `priority_sensitivity` (email-triage)

### `member-overridable`

There's a default (set by the org or the collection), but members can customize it. This is the most common tier for list-type parameters where you want to give members a starting point but let them personalize.

**Test:** Is there a reasonable default, but members will likely want to tweak it? If yes, it's member-overridable.

**Examples:** `categories` (email-triage), `default_validation_level` (strategy)

### `member-defined`

No default exists — the member must provide this value. Use for inherently personal data: their Slack ID, credential paths, VIP sender lists, relevance criteria.

**Test:** Is there literally no sensible default because the value is unique to each person? If yes, it's member-defined.

**Examples:** `slack_user_id`, `credentials_path`, `vip_senders` (email-triage)

### Common mistake: Over-using `org-mandated`

It's tempting to make everything org-mandated for consistency. Resist this. Members who can't customize their experience disengage. The email-triage collection makes `categories` member-overridable even though the org provides defaults — this means every member can add categories for their specific email patterns while still starting from a shared baseline.

---

## Writing Setup Interviews

Setup templates are *interview scripts*, not configuration forms. The agent reads them and conducts a conversation with the member. Write them accordingly.

### Progressive disclosure

Don't ask all questions upfront. Gate questions behind earlier answers:

```markdown
### `brief_enabled` [org-mandated]
Ask: "Would you like to enable structured project briefs?"
- If yes → proceed to `brief_sections`
- If no → skip to `milestones_enabled`
```

This keeps the interview focused. A member who doesn't want briefs shouldn't have to sit through questions about which brief sections to include.

### Write the actual question

Don't just describe the parameter — write the exact question the agent should ask. Compare:

**Weak:**
```markdown
### `delivery_method` [org-mandated]
How the triage summary is delivered.
Options: slack, chat
```

**Strong:**
```markdown
### `delivery_method` [org-mandated]
How triage summaries are delivered to members after each run.
- Options: `slack`, `chat`
- Ask: "How should triage summaries be delivered to your team?
  'slack' sends a DM after each run. 'chat' outputs directly in the conversation."
- If `slack`: validate that a Slack MCP server is connected.
```

The strong version gives the agent everything it needs to conduct a natural conversation, including validation logic and follow-up behavior.

### Explain implications, not just options

When a parameter has non-obvious consequences, explain them:

```markdown
### `priority_sensitivity` [role-suggested]
How aggressively to flag emails as high priority.
- `high` — flag if any one priority criterion is met (most emails flagged, least likely to miss something)
- `medium` — flag if two or more criteria are met (balanced)
- `low` — flag only if all three criteria are met (fewest emails flagged, quietest experience)
```

Members make better decisions when they understand what each option actually does in practice.

### The Setup Completion section is a contract

The numbered steps in Setup Completion tell the agent exactly what to write and where. Be precise:

```markdown
## Setup Completion

1. Write `setup-responses.md` to the member's task directory with all configured parameters in YAML format
2. Write `manifest.json` to the member's task directory
3. Create empty `triage-corrections.json` with the base schema
4. Create empty `triage-run-log.json` placeholder
5. Test Gmail credentials by running `label_emails.py --dry-run` with a dummy label
6. Register entry in `member-index.json` with alias `@ai:email-triage`
7. Confirm to member: "Email Triage is set up with {N} categories. Say '@ai:email-triage' to run it."
```

Every file the setup creates must be listed here. If a future skill or task depends on a file existing, setup must create it (even as an empty placeholder).

---

## Writing Task Workflows

Task workflows are the most complex part of a collection. They're step-by-step instructions that an agent follows to complete a job. The quality of these instructions directly determines how well the task performs.

### Use numbered steps with clear names

```markdown
### Step 1 — Load Configuration
### Step 2 — Retrieve Inbox Emails (Batch Loop)
### Step 3 — Filter Out Replied Threads
### Step 4 — Classify Each Email
```

The step name should tell you what happens without reading the body. An agent scanning the workflow should be able to build a mental model from the step names alone.

### Sub-steps for branching logic

When a step has multiple paths, use labeled sub-steps:

```markdown
### Step 4 — Classify Each Email

**4a. Check ignore list.** If the sender matches any entry in `ignore_senders`, classify as spam.

**4b. Check learned sender rules.** Read `sender_rules` from `triage-corrections.json`.
If the sender matches a rule with confidence `high`, apply the rule's category.

**4c. Check category signals.** For each configured category, check `sender_patterns`
and `subject_patterns`. If any pattern matches, classify into that category.

**4d. Agent judgment.** Read each category's `signals.description` and use contextual
reasoning to classify.
```

This precedence-chain pattern (try A, then B, then C, then fall back to D) is extremely common in collection workflows. Make the order explicit.

### Specify failure behavior at every step

Don't assume things will work. For every step that can fail, say what happens:

```markdown
If any script call fails for individual messages, note the failure but continue processing.
```

```markdown
If Slack delivery fails and delivery_method is `slack`, fall back to outputting the summary in chat.
```

The pattern is: **fail gracefully, log the error, continue where possible, inform the member.** Never let a single email or a single API call abort the entire run.

### Batch processing pattern

If your task processes a variable number of items, use the batch loop pattern:

```markdown
### Step 2 — Retrieve Inbox Emails (Batch Loop)

Retrieve up to 50 emails per batch. Process Steps 3–5 for the current batch, then check
for remaining unread emails. Continue looping until no new emails remain. Track all
processed message IDs across batches to avoid re-processing.
```

Key elements: batch size limit, process-then-check loop, deduplication across batches.

### Template variables in bash commands

When your workflow includes shell commands, use `{variable}` syntax for values that come from configuration:

```bash
python {apps_path}/gmail-labeler/label_emails.py \
    --label "{label}" \
    --credentials-dir "{credentials_path}" \
    --message-id <ID> [--message-id <ID> ...]
```

Document every variable you use. If `{apps_path}` appears in your workflow, it must be defined in the setup template as a parameter.

---

## Specifying Storage Access in Workflows

Agent-index's two-tier filesystem (see `standards.md`) means every data-access step in a task must answer two questions: **where** does the data live, and **how** does the agent access it? Getting either one wrong causes real problems — the Capture collection shipped v1.0 with paths like `/members/{member_hash}/capture/` in its workflows without specifying the tool family, and agents consistently used `aifs_*` (remote) instead of native file tools (local), storing personal capture items on the shared Google Drive.

### Always state the tool family

When a workflow step reads or writes data, explicitly name the tool family:

**Good:**
```markdown
Read `items.json` from the member's **local** capture directory: `members/{member_hash}/capture/`.
Use native file tools (Read/Write), not `aifs_*` — capture data is local-first.
```

**Bad:**
```markdown
Read `items.json` from `/members/{member_hash}/capture/`.
```

The bad version is ambiguous — the leading slash suggests a remote path, but even without it, an agent might default to whichever tool family it tried first in the session. Be explicit.

### Path conventions as a signal, not a guarantee

The convention is: relative paths (`members/{hash}/...`) are local, absolute paths with a leading slash (`/shared/...`, `/org-config.json`) are remote. But conventions alone aren't enough. Agents don't always infer the tool family from path syntax, especially when context from other tools in the session creates momentum toward one tool family. The path convention helps humans reading the spec; the explicit tool-family instruction is what actually controls agent behavior.

### Local-first as a design default

Unless a collection's data is inherently shared (like org config or cross-member project files), default to local storage. Member-specific working data — capture items, draft strategies, personal preferences — should live on the member's machine. This is faster (no remote round-trips), works offline, and respects the privacy boundary described in `standards.md`. If data needs to be shared later, provide an explicit "promote to shared" workflow rather than starting on the remote filesystem.

### The "bare Read" anti-pattern

The most common mistake is writing `Read \`projects-manifest.json\`` without specifying the tool. This looks clear to a human reader, but agents interpret "Read" as "use whatever file tool is available" — which defaults to native local file tools. If the file lives on the remote filesystem, the agent reads locally, finds nothing, and tells the member they have no data.

**Bad:**
```markdown
Read `projects-manifest.json` and find the matching project.
```

**Good:**
```markdown
Read `projects-manifest.json` via `aifs_read` and find the matching project.
```

This applies to every read and write in a workflow — not just the first one. If Step 1 says `aifs_read` but Step 3 says "Read the project's `current-state.md`" without the tool qualifier, the agent may revert to local reads in Step 3. Be explicit every time.

The Projects collection v3.0.0 shipped with this bug in 7 of 12 task files — the newer tasks (manage-ideas, project-decide, project-pulse, share-idea) included the tool qualifier, but the older tasks (archive-project, edit-project, update-project, etc.) were missed during the migration. This caused agents to report "no projects found" even when the remote filesystem had data, because they only checked locally.

### Common patterns

**Local-only data** (capture items, drafts, personal state):
```markdown
Read `items.json` from the member's local directory: `members/{member_hash}/capture/`.
Use native file tools (Read/Write).
```

**Remote shared data** (org config, shared projects):
```markdown
Read `project.md` from `{shared_projects_path}/{project_slug}/` using `aifs_read`.
```

**Mixed** (strategy collection — starts local, promoted to shared):
```markdown
Tool selection: Operations on the member's private workspace (`members/{member_hash}/strategies/`)
use native Read/Write tools. Operations on the shared strategies path (`{shared_strategies_path}`)
use `aifs_*` MCP tools.
```

The mixed pattern is the most complex and the most important to get right. State the tool selection rule once at the top of the workflow, then reference it in each step where it matters.

---

## Writing Skill Directives

Skills use a `Directives` section instead of numbered workflow steps. The structure is different because skills are reactive — they respond to whatever the member asks for.

### Start with the invocation pattern

Every skill should begin by describing what happens when it's first invoked:

```markdown
### Invocation

When the member invokes this skill, begin by reading their current `setup-responses.md`
for `email-triage`. Display a summary of their current configuration:
- Number of configured categories with names
- Number of VIP senders
- Current priority sensitivity setting

Then ask what they'd like to do.
```

This ensures the agent always orients itself before taking action.

### Enumerate supported operations

List every operation the skill supports with clear subsections:

```markdown
### Supported Operations

**Add a category** — Walk the member through defining a new category...

**Edit a category** — Show existing categories, let them select one to modify...

**Remove a category** — Show existing categories, let them select one to remove...

**Manage VIP senders** — Show current list, add or remove entries...
```

If a member asks for something not in the list, the agent knows it's out of scope.

### Guardrails section

Every skill should end with explicit guardrails — things the skill must never do:

```markdown
### Guardrails

- Never modify the `delivery_method`, `slack_user_id`, or `credentials_path`
- Never delete the member's `triage-corrections.json` or `triage-run-log.json`
- Always confirm destructive operations before executing
```

Guardrails prevent the agent from making well-intentioned but harmful changes. Be specific about what's off-limits.

---

## Writing Manifests

Manifests are the machine-readable metadata for each skill and task. They're consumed by the system for dependency resolution, capability discovery, and setup validation.

### Keep manifests and frontmatter in sync

The manifest (`-manifest.json`) and the markdown frontmatter should agree on: name, type, version, collection, stateful flag, dependencies, and external dependencies. If they diverge, the system trusts the manifest. Keep them aligned to avoid confusion.

### Parameter provenance must be exhaustive

Every parameter mentioned in the setup template must appear in the manifest's `parameter_provenance` object. If a parameter exists in setup but not in the manifest, tooling can't validate it.

### Dependency declarations

Only declare dependencies on skills and tasks that your API member *requires at runtime*. Setup-time dependencies (like "install email-triage before installing email-triage-config") belong in the setup template's Pre-Setup Checks, not in the manifest's `dependencies` field.

```json
"dependencies": {
  "skills": [],
  "tasks": ["email-triage"]
}
```

This says: "email-triage-train requires the email-triage task to have run at least once (to produce a run log)."

---

## The Iterative Learning Pattern

This is an optional design pattern (not required by `standards.md`) used by several first-party collections. If your collection involves classification, recommendations, or any decision the agent makes that the member might want to correct, consider this approach.

### The pattern

1. **Task runs** and writes a log of its decisions (e.g., `triage-run-log.json`)
2. **Training skill** reads the log and walks the member through reviewing decisions
3. **Corrections** are recorded in a corrections file (e.g., `triage-corrections.json`)
4. **Next task run** reads the corrections file and uses learned rules to improve

### Design considerations

**Keep the log and corrections as separate files.** The log is ephemeral (overwritten each run). The corrections are persistent (append-only, never truncated). Mixing them creates upgrade and data-loss risks.

**Define a promotion threshold.** When the same correction happens N times (email-triage uses 3), promote it from a soft correction to a hard rule. This prevents the member from having to correct the same thing forever.

**Cap the corrections array.** Unbounded append-only arrays grow forever. Set a limit (email-triage uses 500) and archive older entries when exceeded.

**Make the training skill suggest config changes.** If the member keeps correcting the same pattern, the skill should suggest making it a permanent configuration change: "You've corrected GitHub notifications 5 times — want me to add a dev-notifications category?"

---

## Bundling Scripts and Apps

If your collection needs to run code beyond what the agent can do natively (API calls with auth, data transformations, etc.), bundle scripts in an `/apps/` directory.

### Script conventions

Every bundled script should:

1. **Have a shebang line** (`#!/usr/bin/env python3`)
2. **Check dependencies on import** and print a clear install command if missing
3. **Accept a `--credentials-dir` flag** — never hardcode credential paths
4. **Support `--dry-run`** — let the agent (and the member) preview actions before committing
5. **Use clear exit codes** — `0` for success, `1` for errors
6. **Print structured output** — the agent reads stdout to determine what happened

### Credential handling

Never store credentials inside the collection directory. Scripts should accept a `--credentials-dir` argument pointing to wherever the member stored their credentials during setup. The setup template defines the default path.

If your script needs OAuth, document the first-run flow explicitly. OAuth flows that open a browser won't work in headless agent environments — the member must run the initial authorization manually.

### Dependency management

Include a `requirements.txt` (Python) or equivalent in the `/apps/` directory with pinned version ranges. Don't leave dependency versions unspecified — upstream libraries break.

---

## The External Dependencies Model

External dependencies are systems outside agent-index that your collection needs. `standards.md` requires the `external_dependencies` array in `collection.json`; the first-party collections use the following object schema for each entry:

```json
{
  "system": "Gmail MCP",
  "access_required": "Gmail search and read access (gmail_search, gmail_get_message, gmail_get_thread)",
  "contact": "org admin",
  "required": true
}
```

### Required vs. optional

Mark a dependency as `required: true` only if the collection is non-functional without it. If a feature degrades gracefully (like email-triage falling back from Slack to chat delivery), mark the dependency as `required: false`.

### MCP dependencies

Most external dependencies are MCP servers. Name them by their function ("Gmail MCP", "Slack MCP"), not by their package name. The setup template's Pre-Setup Checks section should validate that required MCP servers are connected before proceeding.

### MCP server launch: dual-path (CLI vs. Cowork)

Agent-index runs in two runtime environments that start MCP servers differently. Any collection that depends on an MCP server (including `agent-index-filesystem`) must account for both paths:

**Claude Code CLI** reads MCP server definitions from `.claude/settings.json` and starts them as child processes. This is the traditional path — declare the server in settings.json with its command and environment variables, and the CLI handles the rest.

**Cowork** does not read MCP server definitions from `.claude/settings.json`. All MCP servers in Cowork are delivered through its plugin system. A Cowork plugin declares MCP servers in a `.mcp.json` file, and Cowork launches them natively. The `${CLAUDE_PLUGIN_ROOT}` variable is available for path resolution within plugins.

For agent-index-core, the `agent-index-filesystem` MCP server uses both paths: `.claude/settings.json` for CLI users, and the `agent-index-filesystem.plugin` (built from `agent-index-core/cowork-plugin/`) for Cowork users. The plugin is included in the bootstrap zip.

**What this means for collection authors:** if your collection bundles its own MCP server (rare — most collections use `aifs_*` or third-party MCP servers), you need to provide both a settings.json entry and a Cowork plugin. If your collection depends on a third-party MCP server (Gmail, Slack, etc.), those are typically already available in both environments — just validate tool availability in your setup template's Pre-Setup Checks.

**Detecting the runtime environment:** check whether expected MCP tools are in the tool list. If tools are absent, guide the member based on context: in Cowork, suggest installing the relevant plugin; in CLI, suggest checking settings.json. The `session-start` and `member-bootstrap` specs in agent-index-core demonstrate this pattern.

**Key Cowork conventions for plugin MCP servers:**
- The user's selected workspace folder is mounted under `$HOME/mnt/{folder-name}/` in the Cowork sandbox
- `$HOME` always resolves to the session root, making `$HOME/mnt/*/` a stable discovery pattern
- Session names change between sessions, so never hardcode a mount path — scan for a known marker file (e.g., `agent-index.json`)
- After plugin installation, the member must restart the Cowork session for the MCP server to start

---

## Upgrade Design

Every collection will eventually need a v2. Plan for it from v1.

### Preserve member work

The Upgrade Behavior section in setup templates exists to guarantee that member customizations survive upgrades. Any parameter a member configured, any training data they accumulated, any preferences they set — all of it must be listed under Preserved Responses.

### The upgrade directory

`/upgrade/` holds migration scripts for MAJOR version boundaries. At v1.0.0, this directory can contain just a README explaining its purpose. When you ship v2.0.0, add a migration script that transforms v1 data to v2 format.

### What triggers a MAJOR version

Per `standards.md`: breaking changes to setup interfaces, parameter schemas, API member interfaces, or removal of API members. In practice, the most common trigger is restructuring the `setup-responses.md` format — if the YAML shape changes and old responses can't be read as-is, that's a MAJOR bump.

---

## Example Data in Documentation

Task and skill markdown files often include example JSON, YAML, or command output. Follow these rules:

### Use RFC 2606 reserved domains

For email examples, always use `example.com`, `example.org`, or `example.net`. Never use real company domains, even obviously fake ones like `company.com` — they might actually resolve.

**Good:** `cfo@example.com`, `notifications@example.org`
**Bad:** `cfo@company.com`, `user@acme-corp.com`

### Use template variables for dates

Hardcoded dates look like stale data. Use `{DATE}` for date fields and `{ISO_TIMESTAMP}` for full timestamps in example JSON:

```json
{
  "date": "{DATE}",
  "last_trained": "{ISO_TIMESTAMP}"
}
```

This makes it clear that the agent should substitute runtime values.

### Keep examples realistic but generic

Example data should demonstrate the feature without implying a specific user or org. The email-triage training skill uses `notifications@github.com` as an example sender — this is fine because it's a real, well-known service that anyone might receive emails from. But it uses `cfo@example.com` for the priority example because "your CFO" is org-specific.

---

## The Directives Pattern

Both tasks and skills include a `Directives` section (sometimes at the end, sometimes integrated into the workflow). Directives are hard rules that override the agent's judgment.

### Task directives

Task directives constrain what the task is allowed to do:

```markdown
## Directives

- Only access the Inbox label. Do not read Sent, Spam, Drafts, or any other folder.
- Do not mark any email as read.
- Do not delete or reply to any email.
- When in doubt, classify as other.
- Always write the run log.
```

These are safety rails. They prevent the agent from doing reasonable-sounding things that would actually cause problems (like marking emails as read, which would hide them from the member).

### Skill directives (guardrails)

Skill guardrails constrain what the skill can modify:

```markdown
### Guardrails

- Never modify the `delivery_method` — that's set during setup
- Never delete the member's training data
- Always confirm destructive operations before executing
```

### Writing good directives

Every directive should be something the agent might plausibly do without the directive. "Do not delete emails" is a good directive because an agent might think archiving means deleting. "Do not format text in Comic Sans" is a bad directive because no agent would do that unprompted.

---

## Error Handling

Every task should have an Error Handling section at the end. Cover at minimum:

1. **Access failures** — what if the external system is unreachable?
2. **Partial failures** — what if some items in a batch fail?
3. **Missing configuration** — what if `setup-responses.md` is missing or incomplete?
4. **Empty input** — what if there's nothing to process?

The pattern across existing collections is: **surface a clear message, suggest a fix, don't abort unless the entire task is impossible.**

```markdown
## Error Handling

- If Gmail access fails: "Email Triage failed: could not access Gmail inbox. Please check permissions."
- If the labeling script fails for individual messages: log the error, continue processing
- If Slack delivery fails: fall back to chat output
- If the inbox has 0 unread emails: deliver the "no high-priority emails" message
- If `setup-responses.md` is missing: halt and instruct the member to run setup
```

---

## ROADMAP.md — Known Bugs, Wishlist, and Future Direction

Every collection should include a `ROADMAP.md` at its root. This file serves three audiences: the collection's developers (what to work on next), other collection authors (what integration points are planned), and the agent itself (what's known to be incomplete or imprecise, so it can set expectations with members).

### Why this matters

Without a roadmap, knowledge about what's broken, what's planned, and what design trade-offs were made lives only in the heads of the people who built the collection (or in their conversation history with Claude). That knowledge is lost when context resets. A roadmap makes it persistent and accessible.

### Recommended sections

**Current State** — Brief summary of what the collection does today and where it sits in its lifecycle.

**Known Limitations** — Things that work but are imprecise, slow, or incomplete. Be specific: "Casual mention detection in Step 5 relies on agent judgment and will produce false positives early on" is useful. "Some features could be improved" is not.

**Known Bugs** — Confirmed defects. Include enough detail to reproduce or understand the impact. "None yet" is a valid entry for a fresh release.

**Wishlist** — Future features organized by target version. Use semantic versioning to signal scope: v1.1 for quality-of-life improvements, v1.2 for integrations, v2.0 for breaking changes or major new capabilities.

**Design Notes** — Decisions about what the collection deliberately *doesn't* do, and why. This prevents future contributors (or the agent) from adding scope that was intentionally excluded. For example: "This collection focuses on response debt, not channel summarization — that's a different problem for a different collection."

### Keep it honest

A roadmap is not marketing material. It should be frank about limitations and realistic about what's planned. The v2.0 wishlist should read like "here's where this could go" not "here's what we're shipping next quarter." Plans change — the roadmap captures intent, not commitments.

---

## Checklist Before Publishing

Use this checklist before submitting a collection to the marketplace:

### Structure (see `standards.md` for authoritative field definitions)
- [ ] `collection.json` has all required fields per `standards.md`
- [ ] Every API member has `.md`, `-setup.md`, and `-manifest.json` in `/api/`
- [ ] `README.md`, `CHANGELOG.md`, and `LICENSE` exist at root
- [ ] `/setup/collection-setup.md` exists
- [ ] `/upgrade/` directory exists (with README if v1.0.0)
- [ ] `ROADMAP.md` exists at root with Known Limitations, Known Bugs, and Wishlist sections

### Metadata
- [ ] `author` field matches your marketplace identity
- [ ] `license` is `open`, `commercial`, a valid SPDX identifier, or `proprietary` (see `standards.md`)
- [ ] `marketplace_url` points to a public, accessible repository
- [ ] `support_url` resolves
- [ ] `category` is from the Category Registry in `standards.md`
- [ ] Version is valid semantic versioning

### Content
- [ ] No user-specific data in any file (email addresses, names, org-specific URLs)
- [ ] Example domains use `example.com` / `example.org` per RFC 2606
- [ ] Example dates use template variables (`{DATE}`, `{ISO_TIMESTAMP}`)
- [ ] All `{variable}` references in workflows are defined in setup templates
- [ ] Manifest `parameter_provenance` covers every parameter in the setup template
- [ ] Manifest and frontmatter metadata are in sync
- [ ] Every workflow read/write on shared data explicitly names the tool (`aifs_read`, `aifs_write`) — no bare "Read" instructions for remote files

### Setup
- [ ] Every parameter has an explicit provenance tier annotation
- [ ] Setup Completion lists every file the setup creates
- [ ] Upgrade Behavior section lists all preserved responses
- [ ] Pre-Setup Checks validate external dependencies before proceeding

### Dependencies
- [ ] External dependencies in `collection.json` use the standard schema (`system`, `access_required`, `contact`, `required`)
- [ ] Required vs. optional is accurately declared
- [ ] Bundled scripts have dependency files (`requirements.txt` or equivalent)
- [ ] Scripts support `--dry-run` and `--credentials-dir`

### Safety
- [ ] `.gitignore` excludes credential files (`credentials.json`, `token.json`)
- [ ] No hardcoded credential paths in scripts
- [ ] Task directives prevent destructive actions (deleting data, marking as read, etc.)
- [ ] Skill guardrails prevent modifying setup-level configuration

---

*This guide is versioned alongside agent-index-core. Contributions and corrections welcome via the agent-index GitHub repository.*
