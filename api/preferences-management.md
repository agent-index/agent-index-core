---
name: preferences-management
type: skill
version: 3.0.1
collection: agent-index-core
description: Enables members to configure, review, and update their agent-index session preferences, invocation aliases, and natural-language routing phrases through natural language without editing configuration files directly.
stateful: true
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
---

## About This Skill

Every member's agent-index session is shaped by a small set of preferences — which skills load automatically, how verbose the session start summary is, how task state is loaded, and what aliases invoke installed capabilities. The Preferences Management Skill is how members establish and maintain those preferences without ever touching a configuration file directly.

This skill serves two distinct moments in a member's lifecycle. The first is onboarding, where it runs a guided setup interview that establishes baseline preferences before any skills or tasks are installed. The second is ongoing maintenance, where it responds to natural language requests to view, update, or reset any preference at any time.

The skill owns the member's `preferences.md`, the `alias` and `alias_override` fields within `member-index.json`, and the member's routing phrases in `routing.json`. It reads them, interprets natural language requests against them, makes targeted updates, and confirms what changed. Members never need to know the file structure — they interact with their preferences the same way they interact with everything else in agent-index: by telling Claude what they want.

### When This Skill Is Active

When invoked, this skill shifts Claude into a preferences management mode. Claude reads the current state of the member's preferences and alias registry, interprets the member's request, proposes a specific change, confirms it with the member, and writes the update. For multi-step operations like the initial setup interview, Claude conducts a structured conversation collecting all needed values before writing anything.

Outside of explicit invocation, this skill is not active. It does not monitor or intercept preference-related statements during normal work sessions — a member saying "I prefer shorter emails" while running the email-manager task is not a trigger for this skill.

### What This Skill Does Not Cover

This skill manages session behavior preferences, invocation aliases, and routing phrases only. It does not install or uninstall skills and tasks — that is the Org Setup Skill. It does not configure task-specific parameters — those are managed by each task's own setup. It does not manage org-level or collection-level configuration — that is the marketplace and collection setup flow.

---

## Directives

### Behavior

When invoked, read the current state of `preferences.md` and the alias fields in `member-index.json` before responding to any request — and `routing.json` as well when the request is about routing phrases. Always operate from the current state of these files — never from a cached or assumed state.

Interpret natural language requests for preference changes broadly and charitably. Members will not use field names or technical syntax. "Make the startup message shorter" maps to `session_summary_verbosity: brief`. "Load my email task automatically" maps to adding `email-manager` to `eager_loading_exceptions`. Translate intent to the correct field and value, show the member what you're about to change, confirm, then write.

For alias requests, determine whether the member is setting a new alias, replacing an existing one, or removing one. Always show the current state before proposing a change. After writing, confirm the effective alias and remind the member of the full `run agent-index` syntax as a permanent fallback.

Never write to `preferences.md` or `member-index.json` without explicit member confirmation of the specific change. Propose first, confirm, then write. The exception is the initial setup interview — at the end of a complete interview, confirm the full set of values together before writing.

After any write, read the file back and confirm the value was written correctly before telling the member the update is complete.

### Initial Setup Interview

The initial setup interview is a structured conversation conducted during onboarding, before any skills or tasks are installed. It establishes the baseline `preferences.md` and initializes the alias section of `member-index.json` (which will be empty at this point — aliases are added as capabilities are installed).

Conduct the interview conversationally — not as a form. Ask one question at a time. Explain what each preference controls in plain language before asking for the member's choice. Offer the default as a starting point; most members will accept defaults and that is the right outcome.

Interview sequence:

**1. Session summary verbosity**
Explain: "When you start a new session, I can give you a quick summary of what's loaded and any notices, or I can stay quiet unless there's something you need to know. There's also a middle option with more detail."
Ask: "Which would you prefer — a brief summary, a detailed summary, or silent unless there's a notice?"
Map to: `session_summary_verbosity: brief | detailed | silent`
Default: `brief`

**2. Task state loading**
Explain: "When you have tasks installed, I can either wait for you to open a task before loading its context, or I can load everything at the start of every session."
Ask: "Would you like task context to load on demand as you work, or all at once when your session starts?"
Map to: `task_state_loading: lazy | eager`
Default: `lazy`

**3. Eager loading exceptions** (only if task_state_loading is lazy)
Explain: "Even with on-demand loading, you can specify certain tasks that should always load their context at session start — useful for tasks you work on every day."
Ask: "Are there any tasks you'd like to always load at startup? You can add more later, so it's fine to skip this for now."
Map to: `eager_loading_exceptions: [{task-name}, ...]`
Default: `[]`
If member skips: record as empty array, move on without pressing.

**4. Deprecation warning threshold**
Explain: "I'll warn you when any of your installed skills or tasks are approaching their end-of-life date. You can set how far in advance you want to be warned."
Ask: "How many days in advance would you like end-of-life warnings? 60 days is the default."
Map to: `deprecation_warning_threshold: {N}`
Default: `60`
Accepted values: any positive integer. If member says something like "as early as possible," use 90. If "last minute," use 14.

<!-- Removed (core 3.x, bug 20260617-8d20ea22-deadsyncpref): the "Filesystem sync staleness warning" (`filesystem_sync_staleness_warning`) preference. It was never consumed by any task or hook — vestigial from the pre-remote-filesystem mounted-shared-drive model. The on-demand-executor model has no local mount to go stale (every aifs call hits remote fresh). Do not re-ask it. Existing preferences.md files may still carry the key; it is inert and can be left or pruned. -->

At the end of the interview, present a plain-language summary of all four values and ask the member to confirm before writing. Write all values to `preferences.md` in a single operation.

### Alias Management

Alias management operates in response to natural language requests during ongoing use. Common patterns and how to handle them:

**"Add an alias"**
Determine which installed skill or task the member means. Look it up in `member-index.json`. Confirm the current `alias` (org default) and `alias_override` (if set). Propose writing the new value to `alias_override`. Confirm, write, confirm back.

**"Show me my aliases"**
Read all entries from `member-index.json`. Present a clean list: name, collection, org-assigned alias, and override alias if set. Highlight which alias is currently effective (override takes precedence). Do not show file paths or technical fields.

**"Remove an alias override"**
Set `alias_override` to `null` for the named entry. The org-assigned `alias` becomes the effective alias again. Confirm before writing.

**"What does @ai:X map to?"**
Look up the alias in the member index. Report: the skill or task name, its collection, and what it does (from the skill/task description field).

**Alias collision on add:**
If the member attempts to set an alias that is already in use by another entry (either as `alias` or `alias_override`), surface the collision:
> "That alias is already used by {other-skill-or-task-name}. If you assign it here, the previous assignment will be ambiguous. Would you like to reassign it, choose a different alias, or leave things as they are?"
Do not write until the collision is resolved.

### Routing Phrase Management

The member's routing phrases live in `members/{member_hash}/profile/routing.json`. Each mapping is `{phrase, capability, collection, description, source, active}`. `source` is `collection-default` (placed by `apply-updates` from a collection's declared triggers) or `member-custom` (set or changed by the member through this skill). `active: false` is a recorded choice: the phrase never routes.

How routing *uses* these mappings (precedence, matching, collisions) belongs to the session-start routing step, not to this skill. This section covers how this skill **changes** them so that each change survives the next update.

The rule that matters: **`apply-updates` merges collection defaults by exact phrase.** A default phrase that is missing from the file is added back on the next update. A default phrase marked `member-custom` is left alone. Every operation below follows from that.

**"Show my phrases" / "edit my routing"**
List active mappings grouped by collection and capability, showing the phrases for each. Mark the ones the member has customized. Mention how many phrases are switched off, and show them only if asked. Use capability names and descriptions, not file fields.

**"Add a phrase"** (e.g. "make 'what's on deck' open my daily view")
1. Resolve the target to an installed capability in `member-index.json`. If it isn't installed, say so and stop.
2. **Check switched-off mappings first.** If a mapping with the same phrase exists with `active: false`, do not add a second row. Switch that row back on and point it at the target: set `active: true`, `source: member-custom`, and its `capability` and `collection`. Confirm with the member as for any change ("'{phrase}' is switched off at the moment. I'll switch it back on and point it at {capability}."), then go to Writing. Compare case-insensitively and ignoring punctuation, as below.
3. Check the phrase against existing active mappings, comparing case-insensitively and ignoring punctuation:
   - **Same phrase, different capability:** surface it. "That phrase already opens {capability}. Change it to {new}, or pick a different phrase?" Do not write until resolved.
   - **Overlap** (the new phrase is contained in, or contains, an active phrase for a different capability): say so. Routing picks the more specific phrase, so both keep working, but the member should know.
4. Write a new mapping with `source: member-custom`, `active: true`.

**"Change where a phrase goes"**
Update `capability` and `collection` on the mapping, and set `source: member-custom`. A changed default must be marked custom, or the next update could set it back.

**"Change a phrase's wording"**
- For a `member-custom` mapping: edit `phrase` in place.
- For a `collection-default` mapping: **do not edit the text.** Set the original to `active: false` and `source: member-custom`, then add the new wording as a new `member-custom` mapping to the same capability. If the default's text were edited, the next update would find the original wording missing and add it back.

**"Delete a phrase" / "stop using this phrase"**
First decide whether the phrase is one of a collection's defaults. `source` alone can't tell you: a default whose target or wording the member changed is marked `member-custom` too.
- `source: collection-default`: it is a default.
- `source: member-custom`: check the phrase against the declared triggers of every collection the member has installed (from `member-index.json`), read from each `collection.json` by id, the same way Reset does. Start with the collection the mapping names, and stop at the first match. It is a default if any collection declares it. Checking only the named collection is not enough: "change where a phrase goes" can move a default to a capability in another collection, so a phrase that now names capture may be one of projects' defaults, and the next projects update would add it back. If any collection's triggers can't be read and no match was found in the ones that could, treat it as a default.

Then:
- **A default:** set `active: false` and `source: member-custom`. **Never remove the row.** A removed default comes back with the next update, so a deletion that isn't recorded doesn't last.
- **Not a default** (the member added it, and the collection's triggers were read and don't include it): remove the row.

When the triggers can't be read, switching off is the safe choice. A switched-off row that turns out not to be a default does no harm. A removed row that turns out to be a default comes back on the next update.

**"Reset"** (one phrase, one collection, or all)
Read the collection's current declared triggers from its `collection.json`. Read it by id, the way CLAUDE.md § "How to execute a skill or task" reads collection files. Then:
- For each default phrase in scope: restore it with the collection's current `capability`, set `source: collection-default` and `active: true`.
- Remove `member-custom` rows in scope that are not collection defaults. Before resetting, list exactly what will be removed and what will be restored.
- If the collection's `collection.json` can't be read, say so and do not reset. Never guess defaults.

**Writing.** Confirm the specific change before writing. Change only the mappings in question; never rewrite unrelated mappings. Update `last_updated`. Read the file back and confirm the change before reporting success. Same discipline as `preferences.md`.

### Ongoing Preference Updates

For any preference update request outside of the initial interview:

1. Identify the specific preference field being requested
2. Read the current value from `preferences.md`
3. Confirm what the member wants to change it to
4. Write the specific field only — never rewrite the entire file
5. Confirm the change is in effect

Common natural language patterns and their mappings:

| Member says | Field | Action |
|---|---|---|
| "Make startup quieter / less verbose" | `session_summary_verbosity` | Set to `brief` or `silent` |
| "Give me more detail at startup" | `session_summary_verbosity` | Set to `detailed` |
| "Always load my {task} context" | `eager_loading_exceptions` | Add task to list |
| "Stop auto-loading {task}" | `eager_loading_exceptions` | Remove task from list |
| "Warn me earlier about expiring skills" | `deprecation_warning_threshold` | Increase value |
| "Show me my preferences" | — | Read and display all fields in plain language |
| "Reset my preferences to defaults" | — | Full reset flow (see Constraints) |
| "Show my phrases" / "edit my routing" / "add / change / delete / reset a phrase" | `routing.json` | See Routing Phrase Management |

### Reviewing Preferences

When a member asks to see their preferences, present all fields in plain language — not as raw YAML. Use natural descriptions:

> **Session startup:** Brief summary
> **Task state loading:** On demand (email-manager loads automatically)
> **End-of-life warnings:** 60 days in advance

Include the alias registry as a separate block if the member asks for it, or as part of a full preferences review.

### Style & Tone

This skill operates in a conversational, low-friction register. Preferences are administrative — keep the interaction efficient. Confirm changes concisely. Do not over-explain.

For the initial setup interview, a slightly warmer tone is appropriate — many members will be new to the system. Explain each preference in terms of the experience it produces, not the technical field it sets.

For alias management, be precise. Aliases have exact values — show them exactly, confirm them exactly, write them exactly.

### Constraints

Never write to `preferences.md`, `member-index.json` or `routing.json` without explicit member confirmation of the specific proposed change.

Never rewrite the entire `preferences.md` file for a single-field update. Write targeted field updates only. This prevents accidentally overwriting fields the member has not touched.

Never remove a routing mapping that is one of a collection's defaults — switch it off (`active: false`, `source: member-custom`) instead. Never mark a mapping `collection-default` unless it was restored from the collection's current triggers by a reset.

Never modify the `alias` field in a `member-index.json` entry — that is the org-assigned default and is set by the installer. Only `alias_override` is member-editable.

Never remove an installed skill or task entry from `member-index.json`. This skill manages aliases and preferences only. Capability management is the Org Setup Skill's domain.

For a full preferences reset to defaults, require explicit confirmation with the specific list of values that will be reset. Never reset silently. Announce: "This will reset all your preferences to defaults. Here's what that means: {list each field and its new default value}. Confirm?"

Never conduct the initial setup interview if `preferences.md` already exists with populated values — the member has already completed setup. Treat an invocation in that case as an ongoing update request, not a fresh interview.

### Edge Cases

If `preferences.md` exists but is missing specific fields: treat missing fields as using system defaults. Do not fail. When a member asks to view preferences, show the effective value (default) for missing fields and note that it is using the default. When a member updates a missing field, add it.

If `member-index.json` has no installed entries when alias management is requested: inform the member that no capabilities are installed yet and aliases will be available after installation via '@ai:setup'.

If a member asks to set an alias to the full `run agent-index` syntax (e.g., "make `run agent-index task email-manager` my alias"): explain that the full syntax is always available as a fallback and does not need to be assigned as an alias. Offer to set a shorter alias instead.

If the member's requested alias value contains spaces, path separators, or quotes: explain that aliases must be single tokens without spaces or special characters (other than `:` and `~` which are conventional). Suggest a corrected form.

If `member-index.json` cannot be read during alias management: check `aifs_auth_status()`. If `authenticated: false`, attempt automatic re-authentication via `aifs_authenticate` and retry. If re-auth fails or the file is still unreadable: surface the error, explain that alias management is unavailable until the file is accessible, and suggest '@ai:member-bootstrap' to troubleshoot if this appears to be a workspace or connectivity issue.

If `routing.json` does not exist: **do not create it.** `apply-updates` populates collection defaults only when it initializes a file that doesn't exist yet. A file created here with only the member's custom phrase would stop the defaults from ever being added. Tell the member: "Your routing phrases haven't been set up yet — say '@ai:update' and they will be. Then I can add yours."

If `routing.json` exists but cannot be parsed: do not write to it. Surface the problem and suggest reporting it with '@ai:report-bug'. Never overwrite an unreadable file with a fresh one; that would discard the member's customizations.

If a member asks to manage preferences for another member: this skill manages the current member's preferences only. Org-wide defaults are managed through collection setup, not through this skill.
