---
name: author-collection
type: task
version: 2.1.0
collection: agent-index-core
description: Guided workflow for creating a new agent-index collection from scratch — scaffolds directory structure, generates all required files, and ensures standards compliance.
stateful: false
produces_artifacts: true
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
reads_from: null
writes_to: null
---

## About This Task

Creating an agent-index collection requires coordinating many files — collection.json, collection-setup.md, API definition files with proper frontmatter, companion setup and manifest files, README, CHANGELOG — all following specific conventions and standards. Getting any of these wrong means the collection won't install cleanly or behave predictably.

This task walks an author through the entire process conversationally. Claude asks what the collection does, what skills and tasks it needs, and generates every file with correct structure, frontmatter, cross-references, and naming conventions. The author focuses on describing what the collection should do; Claude handles the standards compliance.

The result is a complete, standards-compliant collection directory ready for testing, org deployment, or marketplace submission.

### Inputs

The author's description of what the collection should do, what workflows it supports, and what skills and tasks it needs. This can be as rough as a paragraph or as detailed as a full specification. Claude adapts to the level of detail provided.

Optionally, the author may specify:
- Whether this is an org collection (private) or marketplace collection (public)
- A target directory for the output
- An existing partial collection to complete

### Outputs

A complete collection directory with all required files:
- `collection.json`
- `README.md`
- `CHANGELOG.md`
- `/setup/collection-setup.md`
- `/api/{name}.md` for each skill and task
- `/api/{name}-setup.md` for each skill and task (stub)
- `/api/{name}-manifest.json` for each skill and task (stub)
- `/upgrade/` directory (empty at v1.0.0)

### Cadence & Triggers

On demand. Invoked when an author wants to create a new collection.

---

## Workflow

### Step 1: Understand the Collection

Ask the author to describe the collection. What problem does it solve? Who uses it? What are the main workflows?

If the author provides a rough description, ask targeted follow-up questions to clarify:
- What are the distinct capabilities (skills and tasks) this collection needs?
- Does the collection require any external systems (email, APIs, web access)?
- Is there org-level configuration an admin would need to set up?
- Does the collection involve shared data between members (stored on the remote filesystem), or is it purely personal (local only)?

If the author provides a detailed specification, confirm understanding and move forward.

Do not ask all questions at once. Have a natural conversation. Two to three exchanges should be enough for most collections.

**On success:** Proceed to Step 2 with a clear picture of what the collection does and what API members it needs.

---

### Step 2: Determine Collection Metadata

Based on the conversation, determine or confirm with the author:

**Collection name** — kebab-case, lowercase. Must not start with `agent-index-` (reserved for official collections). Must be globally unique. Suggest a name based on the description and confirm.

**Display name** — human-readable version of the collection name.

**Category** — select from the category registry:

| Category | Description |
|---|---|
| `infrastructure` | Core system components (reserved for agent-index-core and agent-index-marketplace) |
| `project-management` | Project tracking, planning, and coordination |
| `hris` | Human resources information systems |
| `ats` | Applicant tracking and recruiting |
| `crm` | Customer relationship management |
| `finance` | Finance, accounting, and expense management |
| `communication` | Email, messaging, and notification workflows |
| `document-management` | Document creation, storage, and lifecycle |
| `reporting` | Analytics, dashboards, and reporting workflows |
| `developer-tools` | Engineering and development workflows |
| `sales` | Sales process and pipeline management |
| `marketing` | Marketing workflows and content management |
| `customer-success` | Customer support and success workflows |
| `productivity` | General productivity and personal workflow tools |
| `strategy` | Strategy development and competitive intelligence |
| `personal-productivity` | Personal capture, task management, and workflow tools |

If the collection doesn't fit any category, note that the author can propose a new category via the agent-index GitHub repository. For now, choose the closest fit.

**Description** — one sentence, plain language. Should complete the sentence "This collection..."

**Author** — person or organization name.

**License** — `open`, `commercial`, or an SPDX identifier.

**Dependencies** — other collections this collection depends on. Empty array for most collections.

**External dependencies** — external systems required (email, APIs, web services). For each: system name, access required, whether required or optional.

Present the proposed metadata to the author for confirmation before proceeding.

**On success:** Proceed to Step 3 with confirmed metadata.

---

### Step 3: Design the API

For each skill and task the collection needs, determine:

**Name** — kebab-case, unique within the collection.

**Type** — skill (behavioral mode) or task (produces output or modifies state).

**Description** — one sentence describing what it does.

**Key frontmatter decisions:**
- For skills: `stateful`, `always_on_eligible`
- For tasks: `stateful`, `produces_artifacts`, `produces_shared_artifacts`, `reads_from`, `writes_to` (these declare remote filesystem paths under `/shared/` — set to `null` if the task does not access shared data)

**Dependencies** — does this skill or task require other skills or tasks to be installed?

**External dependencies** — does this skill or task require external system access?

Present the full API plan to the author:

> **Proposed API ({N} members):**
>
> | Name | Type | Description |
> |---|---|---|
> | {name} | {skill/task} | {description} |
> | ... | ... | ... |

Confirm before proceeding. The author may want to add, remove, rename, or restructure.

**On success:** Proceed to Step 4 with a confirmed API plan.

---

### Step 4: Design the Collection Setup

Determine what org-level configuration the collection needs. These become the parameters in `collection-setup.md` — the interview an org admin goes through when installing the collection.

Common org-level parameters include:
- Shared data paths (paths under `/shared/` on the remote filesystem where the collection stores shared artifacts)
- Default values that apply across all members
- Feature flags (which capabilities are enabled org-wide)
- External system configuration
- Privacy and sharing defaults

For each parameter:
- Name
- Description (what it controls)
- Default value and why
- Accepted values
- Which skills/tasks use this value

If the collection has no org-level configuration needed, create a minimal collection-setup.md that confirms installation with no parameters.

**On success:** Proceed to Step 5.

---

### Step 5: Design Directory Structure

Agent-index uses a two-tier filesystem. Design both tiers as applicable:

**Local directory structure** — member-specific data stored on the member's machine under `/members/{member_hash}/{collection-name}/`. This is accessed via native Read/Write/Edit tools and is private to each member.

Common local patterns:

**Registry pattern** (used by capture, strategy):
```
/{collection-name}/
  {registry-file}.json          ← master data file
  /state/
    current-context.md          ← rolling context
```

**Entity pattern** (used by projects, strategy):
```
/{collection-name}/
  /{entity-slug}/
    {entity-main-file}.md       ← primary document
    {supporting-data}.json      ← structured data
    /sub-directory/              ← related artifacts
```

**Hybrid** — many collections use both patterns.

**Remote directory structure** — if the collection has `produces_shared_artifacts: true` on any task, design the shared data layout under `/shared/` on the remote filesystem. This is accessed via `aifs_read`/`aifs_write`/`aifs_list` MCP tools and is visible to all org members.

Common remote patterns:

**Per-member artifacts** (reports, submissions attributed to a specific member):
```
/shared/members/artifacts/{member_hash}/
  {filename}.md
```

**Collection-scoped shared data** (project definitions, shared configs):
```
/shared/{collection-name}/
  /{entity-slug}/
    {entity-main-file}.md
```

If the collection has no shared artifacts (`produces_shared_artifacts: false` on all tasks), skip the remote directory design.

Present the proposed directory structure(s) and confirm with the author.

**On success:** Proceed to Step 6.

---

### Step 6: Write API Definition Files

For each skill and task in the confirmed API plan, generate the full definition file following agent-index file format standards.

**For skills**, use this structure:
```markdown
---
name: {skill-name}
type: skill
version: 1.0.0
collection: {collection-name}
description: {one sentence}
stateful: {true|false}
always_on_eligible: {true|false}
dependencies:
  skills: []
  tasks: []
external_dependencies: []
---

## About This Skill

{2-5 paragraphs explaining what this skill does, when it activates, how it behaves}

### When This Skill Is Active

{Observable behavior change}

### What This Skill Does Not Cover

{Explicit scope boundaries}

---

## Directives

### Behavior

{How Claude behaves when this skill is active}

### Constraints

{Hard rules}

### Edge Cases

{Non-obvious handling}
```

**For tasks**, use this structure:
```markdown
---
name: {task-name}
type: task
version: 1.0.0
collection: {collection-name}
description: {one sentence}
stateful: {true|false}
produces_artifacts: {true|false}
produces_shared_artifacts: {true|false}
dependencies:
  skills: []
  tasks: []
external_dependencies: []
reads_from: null                    # remote path under /shared/ this task reads, or null
writes_to: null                     # remote path under /shared/ this task writes, or null
---

## About This Task

{2-5 paragraphs explaining what problem this solves and what the member gets}

### Inputs

{Required and optional inputs}

### Outputs

{What the task produces — files, display, state changes}

### Cadence & Triggers

{How often, what prompts a run}

---

## Workflow

### Step 1: {Title}

{What Claude does}

---

### Step 2: {Title}

{What Claude does}

---

{Continue for all steps}

---

## Directives

### Behavior

{Standing rules for Claude throughout this task}

### Constraints

{Hard rules and boundaries}

### Edge Cases

{Non-obvious handling}
```

Write the full content for each API member. The content should be substantive — not placeholder text. Claude should draft real workflow steps, real behavioral directives, and real edge cases based on the collection design discussed in Steps 1–5.

For tasks that access shared data (`produces_shared_artifacts: true` or non-null `reads_from`/`writes_to`): workflow steps that read or write shared files must use the `aifs_*` MCP tools (`aifs_read`, `aifs_write`, `aifs_list`, etc.) — not native file tools. Local member data continues to use native Read/Write/Edit. Make sure the workflow steps specify which tier each file operation targets.

After writing each file, briefly summarize what was written and move to the next.

**On success:** Proceed to Step 7 after all API members are written.

---

### Step 7: Generate Companion Files

For each API member, generate stub companion files:

**Setup template** (`{name}-setup.md`):
```markdown
---
name: {name}-setup
type: setup
version: 1.0.0
collection: {collection-name}
description: Setup interview for {name}
target: {name}
target_type: {skill|task}
upgrade_compatible: true
---

## Setup Overview

{1-2 sentences about what this setup configures}

---

## Pre-Setup Checks

- Member has {collection-name} collection installed → proceed with org setup if not

---

## Parameters

{Parameters organized by level: org-mandated, role-suggested, member-overridable, member-defined}

---

## Setup Completion

1. Write all collected parameter values to `setup-responses.md`
2. Generate the personalized installed instance
3. Write the installed instance to `/members/{member_hash}/{skills|tasks}/{name}/`
4. Write manifest.json
5. Register entry in `member-index.json`
6. Confirm completion to member

---

## Upgrade Behavior

### Preserved Responses
{All parameters by default at v1.0.0}

### Reset on Upgrade
None at v1.0.0.

### Requires Member Attention
None at v1.0.0.

### Migration Notes
None at v1.0.0.
```

**Manifest template** (`{name}-manifest.json`):
```json
{
  "name": "{name}",
  "type": "{skill|task}",
  "version": "1.0.0",
  "collection": "{collection-name}",
  "parameters": {}
}
```

These are stubs — they provide the correct structure but may need refinement as the collection matures. Note this to the author.

**On success:** Proceed to Step 8.

---

### Step 8: Generate Collection-Level Files

Write the remaining required files:

**`collection.json`** — populated with all confirmed metadata and the API array.

**`setup/collection-setup.md`** — populated with the org-level parameters designed in Step 4.

**`README.md`** — include:
- Plain-language description of what the collection does
- Core concepts (if the collection has unique terminology)
- API table with one-line descriptions
- Directory structure (member-level)
- Prerequisites
- Version reference to CHANGELOG.md

**`CHANGELOG.md`**:
```markdown
# Changelog

## [1.0.0] — {today's date}

### Added
- Initial release
- {List each API member with a one-line description}
```

**`/upgrade/`** — create empty directory (nothing to upgrade at v1.0.0).

**On success:** Proceed to Step 9.

---

### Step 9: Validate and Summarize

Run through the validation checklist (the same checks `validate-collection` would perform):

- [ ] `collection.json` present and all required fields populated
- [ ] Every name in `api[]` has a corresponding `.md` file in `/api/`
- [ ] Every `.md` file has valid frontmatter with all required fields for its type
- [ ] `name` in frontmatter matches filename for every file
- [ ] `collection` field matches collection name in every file
- [ ] Every API member has a `-setup.md` companion file
- [ ] Every API member has a `-manifest.json` companion file
- [ ] `collection-setup.md` present in `/setup/`
- [ ] `README.md` present
- [ ] `CHANGELOG.md` present
- [ ] `/upgrade/` directory present
- [ ] No `# NOTE:` authoring comments remaining in any file
- [ ] Collection name is kebab-case and does not start with `agent-index-`
- [ ] Category is valid

Present the validation results. If anything fails, fix it.

Then present the final summary:

> **Collection created: {display_name}**
>
> Location: {path}
> Version: 1.0.0
> Category: {category}
> API members: {N} ({M} skills, {P} tasks)
>
> | Name | Type | Description |
> |---|---|---|
> | ... | ... | ... |
>
> Next steps:
> - Test the collection by installing it in a dev org
> - Refine API definitions based on testing
> - Run `@ai:validate-collection` to check standards compliance
> - When ready, submit to the marketplace (if public) or deploy to your org (if private)

**On success:** Task complete.

---

## Directives

### Behavior

The authoring workflow should feel collaborative, not bureaucratic. Claude is a co-designer, not a form processor. When the author describes what they want, Claude should contribute ideas — suggest API members the author might not have thought of, propose directory structures that fit the use case, identify edge cases worth handling.

At the same time, Claude should not overwhelm the author with decisions. Make sensible defaults, explain them briefly, and let the author override. Most collections can be authored in 10–15 minutes of conversation.

When writing API definition files, write substantive content. The workflow steps, behavioral directives, and edge cases should be real and useful — not generic placeholders. Claude has context from the design conversation and should use it.

### Constraints

Never create files outside the designated output directory.

Never modify existing collections — this task creates new collections only. To modify an existing collection, use the collection's own editing workflows.

Never skip the validation step. Every collection must pass validation before the task completes.

The `infrastructure` category is reserved for agent-index-core and agent-index-marketplace. Do not allow authors to use it.

Collection names starting with `agent-index-` are reserved for official collections. Do not allow external authors to use this prefix.

### Edge Cases

If the author wants to resume a partially created collection: read the existing files, determine what's missing, and pick up from the appropriate step.

If the author describes something that would be better served by extending an existing collection rather than creating a new one: mention this as an option. Don't block the new collection — just surface the alternative.

If the author wants a collection with no API members (roles only): this is valid. Skip Steps 3, 6, and 7. The collection will have `"api": []` in collection.json.

If the author describes external dependencies that aren't yet available in the org: create the collection with the dependencies declared. They'll be surfaced as informational notices at install time.

If the collection needs a tutorial skill: suggest adding one based on the pattern established by existing collections (projects-tutorial, strategy-tutorial, capture-tutorial). A tutorial skill is a guided tour of the collection's concepts and workflows — it explains but does not perform operations.
