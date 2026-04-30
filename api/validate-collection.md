---
name: validate-collection
type: task
version: 3.0.0
collection: agent-index-core
description: Validates an existing collection against agent-index standards — checks file structure, frontmatter, cross-references, naming conventions, and marketplace eligibility.
stateful: false
produces_artifacts: false
produces_shared_artifacts: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
reads_from: null
writes_to: null
---

## About This Task

After creating or modifying a collection, authors need to verify it meets agent-index standards before deploying or submitting to the marketplace. This task reads a collection's files and checks everything — required files present, frontmatter valid, cross-references consistent, naming conventions followed, setup templates complete.

The output is a validation report that clearly identifies what passes, what fails, and what needs attention. For failures, Claude explains what's wrong and how to fix it.

This task is read-only. It examines the collection but does not modify any files.

### Inputs

A path to the collection directory to validate. If not specified, Claude asks the author to identify which collection to validate.

Optionally, the author can request:
- A specific validation scope (e.g., "just check frontmatter" or "only validate collection.json")
- Marketplace-level validation (stricter) vs. org-level validation (more lenient)

### Outputs

A validation report displayed to the author. No files written.

### Cadence & Triggers

On demand. Typically run after creating a collection with `author-collection`, after making edits to a collection, or before submitting to the marketplace.

---

## Workflow

### Step 1: Locate the Collection

If the author specified a path, use it. Otherwise, ask which collection to validate.

Read the collection directory and confirm:
- The directory exists
- `collection.json` is present and readable

If `collection.json` is not found, report immediately: "No `collection.json` found at {path}. This doesn't appear to be an agent-index collection."

**On success:** Proceed to Step 2 with the parsed `collection.json`.

---

### Step 2: Validate Collection Metadata

Check `collection.json` against the required schema.

**Required fields check** — verify every required field is present and non-empty:

| Field | Check |
|---|---|
| `name` | Present, kebab-case, matches directory name |
| `display_name` | Present, non-empty |
| `version` | Present, valid semantic version (MAJOR.MINOR.PATCH) |
| `description` | Present, non-empty |
| `author` | Present, non-empty |
| `license` | Present, one of: `open`, `commercial`, or valid SPDX identifier |
| `category` | Present, valid category from registry |
| `agent_index_min_version` | Present, valid semantic version |
| `api` | Present, is array |
| `dependencies` | Present, is array |
| `external_dependencies` | Present, is array |
| `eol_date` | Present, null or valid ISO date |
| `marketplace_url` | Present, non-empty string |
| `support_url` | Present, non-empty string |

**Naming convention checks:**
- Collection name is kebab-case, lowercase, no special characters except hyphens
- Collection name does not start with `agent-index-` (unless it is an official agent-index collection)
- Collection directory name matches `name` field

**Category validation:**
- Category is in the registered category list
- If not, flag as warning (new categories can be proposed but aren't yet registered)

Record all findings — passes and failures.

**On success:** Proceed to Step 3.

---

### Step 3: Validate Required Files

Check that all required files and directories exist:

| File/Directory | Required | Severity |
|---|---|---|
| `collection.json` | Yes | Error |
| `README.md` | Yes | Error |
| `CHANGELOG.md` | Yes | Error |
| `/api/` directory | Yes | Error (unless `api` array is empty) |
| `/setup/collection-setup.md` | Yes | Error |
| `/upgrade/` directory | Yes | Error |

For each missing required file, record an error.

**On success:** Proceed to Step 4.

---

### Step 4: Validate API Members

For each name listed in the `api` array in `collection.json`:

**File existence:**
- Check that `/api/{name}.md` exists → Error if missing
- Check that `/api/{name}-setup.md` exists → Warning if missing (stubs are acceptable)
- Check that `/api/{name}-manifest.json` exists → Warning if missing (stubs are acceptable)

**Frontmatter validation** for each `/api/{name}.md`:
- Parse YAML frontmatter
- Verify `name` field matches filename (without `.md`) → Error if mismatch
- Verify `collection` field matches collection name → Error if mismatch
- Verify `type` is either `skill` or `task` → Error if invalid

For **skills**, verify required frontmatter fields:
- `name`, `type` (= `skill`), `version`, `collection`, `description`, `stateful`, `always_on_eligible`, `dependencies`, `external_dependencies`

For **tasks**, verify required frontmatter fields:
- `name`, `type` (= `task`), `version`, `collection`, `description`, `stateful`, `produces_artifacts`, `produces_shared_artifacts`, `dependencies`, `external_dependencies`, `reads_from`, `writes_to`

**Body structure validation:**
- Skills must have: `## About This Skill`, `## Directives`
- Tasks must have: `## About This Task`, `## Workflow`, `## Directives`

**Orphan check:**
- Scan `/api/` for `.md` files whose name (minus extension, minus `-setup` and `-manifest` suffixes) is not in the `api` array → Warning for each orphan

**Cross-reference validation:**
- For each API member's `dependencies.skills` and `dependencies.tasks`, verify the referenced skill/task is either in this collection's API or in a declared collection dependency → Warning if unresolvable

**Shared artifact consistency check (tasks only):**
- If `produces_shared_artifacts: true`, verify `writes_to` is not null → Warning if null (task claims to produce shared artifacts but doesn't declare a write path)
- If `writes_to` is non-null, verify `produces_shared_artifacts: true` → Warning if false (task declares a write path but doesn't flag shared artifact production)
- If `reads_from` or `writes_to` is non-null, verify the path starts with `/shared/` → Warning if not (shared paths should be under the `/shared/` namespace on the remote filesystem)

Record all findings.

**On success:** Proceed to Step 5.

---

### Step 5: Validate Setup Templates

**Collection setup** (`/setup/collection-setup.md`):
- Parse frontmatter and verify required fields: `name`, `type` (= `collection-setup`), `version`, `collection`, `description`, `upgrade_compatible`
- Verify `name` follows pattern `{collection-name}-collection-setup`
- Check for `## Setup Completion` section → Warning if missing
- Check for `## Upgrade Behavior` section → Warning if missing

**Per-API-member setup templates** (`/api/{name}-setup.md`):
- For each that exists, parse frontmatter and verify: `name`, `type` (= `setup`), `version`, `collection`, `description`, `target`, `target_type`, `upgrade_compatible`
- Verify `name` follows pattern `{target-name}-setup`
- Verify `target` matches the API member name
- Verify `target_type` matches the API member's actual type (skill or task)
- Check for parameter level annotations (`[org-mandated]`, `[role-suggested]`, `[member-overridable]`, `[member-defined]`) → Warning if no annotations found
- Check for `## Setup Completion` section → Warning if missing
- Check for `## Upgrade Behavior` section → Warning if missing

Record all findings.

**On success:** Proceed to Step 6.

---

### Step 6: Validate Companion Files

**README.md content check:**
- Contains a description of the collection → Warning if under 50 words
- Contains a list or table of API members → Warning if no API member names found in README
- Contains reference to CHANGELOG → Warning if "CHANGELOG" not mentioned

**CHANGELOG.md structure check:**
- Contains at least one version entry → Error if empty
- Most recent version matches `collection.json` version → Warning if mismatch
- Uses expected format: `## [X.Y.Z] — YYYY-MM-DD` → Warning if non-standard

**Authoring artifact check:**
- Scan all `.md` files for remaining `# NOTE:` comments → Warning for each (these are template authoring notes that should be removed before publishing)

Record all findings.

**On success:** Proceed to Step 7.

---

### Step 7: Present Validation Report

Present findings organized by severity:

> **Validation Report: {collection display_name} v{version}**
>
> {if all clear}:
> All checks passed. This collection meets agent-index standards.
>
> {if errors exist}:
> **Errors ({N})** — must fix before install/submission
> {for each error}:
> - {file}: {description of the problem}
>   Fix: {how to resolve}
>
> {if warnings exist}:
> **Warnings ({N})** — should fix, but won't block install
> {for each warning}:
> - {file}: {description of the problem}
>   Suggestion: {how to resolve}
>
> {if info items exist}:
> **Info ({N})**
> {for each info item}:
> - {observation}
>
> **Summary:** {N} errors, {M} warnings, {P} info items
> {if errors}: "Fix the errors above before installing or submitting this collection."
> {if warnings only}: "No blocking issues. Consider addressing the warnings above."
> {if clean}: "This collection is ready for deployment or marketplace submission."

After the report, offer:

> "Want me to fix any of these issues, or would you like to address them yourself?"

If the author asks Claude to fix issues: make the fixes directly (this is the one case where this task writes files). After fixing, re-run validation to confirm.

**On success:** Task complete.

---

## Directives

### Behavior

Validation should be thorough but not pedantic. The goal is catching real problems — missing files, broken cross-references, invalid frontmatter — not enforcing style preferences. When something is technically compliant but could be better, surface it as an info item, not a warning.

Present findings in a scannable format. Authors want to see what's wrong and how to fix it quickly, not read a lengthy analysis.

When offering to fix issues, be specific about what Claude would change. Don't make changes without the author's confirmation.

### Constraints

This task is read-only by default. It never modifies files unless the author explicitly asks Claude to fix reported issues.

Never validate files outside the specified collection directory.

Never report on internal implementation quality (whether the workflow steps are good, whether the directives are comprehensive enough). That's subjective and outside the scope of standards validation.

### Edge Cases

If the collection is a work in progress with only some files present: validate what exists and report what's missing. Don't treat a partial collection as invalid — treat it as incomplete and show what remains.

If the collection uses a category not in the registry: flag as a warning, not an error. New categories can be proposed.

If the collection has files in `/internal/` (private skills/tasks): validate them with the same frontmatter and structure rules as public API members, but don't require them to be listed in the `api` array.

If the author runs validation immediately after `author-collection`: everything should pass (since author-collection generates standards-compliant files). If it doesn't, that's a bug in author-collection worth noting.

If `collection.json` is valid JSON but has extra fields not in the spec: ignore them. The spec defines required fields, not an exclusive schema.
