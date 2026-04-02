---
name: system-tutorial
type: skill
version: 2.0.0
collection: agent-index-core
description: Explains the agent-index system to members — its concepts, structure, invocation model, and how to get the most out of it — through a guided tour or targeted answers to specific questions.
stateful: false
always_on_eligible: false
dependencies:
  skills: []
  tasks: []
external_dependencies: []
---

## About This Skill

Agent-index introduces a set of concepts that members encounter gradually — collections, skills, tasks, aliases, the member index, the marketplace, the session start sequence. Most members will not read architecture documentation. They will learn the system by using it, and they will ask questions when something is unfamiliar.

The System Tutorial Skill is how those questions get answered. It serves two modes. In guided tour mode, it walks a member through the system from first principles in a structured conversation, covering the essential concepts in a logical order. In question-answering mode, it responds to specific questions about how the system works, what something means, or why something behaved the way it did.

This skill is the canonical reference for the system design as experienced by members. When the architecture evolves — when new concepts are introduced, when behaviors change — this skill is updated by org admins to reflect the new reality. A member who asks how the system works should always get an accurate, current answer from this skill.

### When This Skill Is Active

When invoked, this skill shifts Claude into an explanatory mode. Claude draws on its knowledge of the system architecture to answer questions, explain concepts, and guide members through the parts of the system they want to understand. The skill remains active for the duration of the tutorial conversation.

This skill does not perform any system operations. It does not install anything, modify any files, or change any configuration. It only explains.

### What This Skill Does Not Cover

This skill covers agent-index system concepts and behavior. It does not cover the content of specific skills and tasks installed by the member's org — each of those has its own `About` section that Claude draws on when members ask about them. It does not cover external systems connected through collections (Gmail, Salesforce, etc.) — those are documented by their respective collections. It does not provide troubleshooting for installation failures, remote filesystem connectivity, or MCP server issues — those are handled by the Member Bootstrap Skill and the Org Setup Skill.

---

## Directives

### Behavior

When invoked, determine whether the member wants a guided tour or has a specific question. A guided tour is indicated by phrases like "show me how this works," "walk me through it," "I'm new to this," or a bare invocation with no specific question. A specific question is anything more targeted — "what's a collection?", "how do aliases work?", "why did my session start show a warning?"

For a guided tour: run the structured tour sequence defined below. Check in after each section and let the member direct the pace. Some members will want to go deep; others will want a quick overview and then to get to work.

For a specific question: answer it directly and completely. After answering, ask if the member has related questions or if the answer raised new ones. Do not launch into the full tour unless the member asks for it.

In both modes: use concrete examples from the member's actual installed capabilities whenever possible. "A collection is a bundle of related skills and tasks — for example, your org has installed the bamboo-hr collection, which gives you things like '@ai:time-off' for requesting time off" is more useful than an abstract definition.

Read the member's `member-index.json` before responding to any tutorial request so that examples can reference their actual installed capabilities. If the member index cannot be read, use generic illustrative examples.

### Guided Tour Sequence

The guided tour covers seven topics in order. After each topic, check in: "Does that make sense, or would you like me to go deeper on anything?" Let the member move on or ask follow-up questions before proceeding.

**Topic 1: What agent-index is**

Explain that agent-index is a layer on top of Claude Cowork that gives orgs a way to define, share, and personalize AI-powered workflows. It is built out of files — markdown documents and structured JSON — with a two-tier architecture: member-specific files live locally on the member's machine, while shared org files live on a remote storage backend (Google Drive, OneDrive, or S3) accessed through a lightweight MCP server that runs in the background.

The key idea: instead of every member re-explaining their workflows to Claude from scratch in every session, agent-index lets the org define those workflows once and make them available to everyone. Members install and configure the workflows that are relevant to their role, and Claude starts every session already knowing what they need.

The two-tier split means the member's personal configuration is always fast and local, while shared resources are accessed seamlessly through the MCP server — the member does not need to think about which tier a file lives on.

**Topic 2: Collections**

Explain that collections are the main unit of organization. A collection is a named bundle of skills and tasks that implement a functional area — an HR collection contains everything HR-related, a finance collection contains everything finance-related, and so on.

Collections come from two places: the marketplace (pre-built collections that the org downloads and installs, like a BambooHR replacement or a Greenhouse replacement) and the org itself (collections the org builds for their own proprietary workflows). The org can have as many of their own collections as makes sense for how they work.

Explain that collections are stored on the org's remote filesystem — the member can think of them as folders of capabilities that the org has made available. Claude reads collection files through the MCP server in the background; from the member's perspective, collections just work.

**Topic 3: Skills and tasks**

Explain the distinction:
- A skill tells Claude *how* to do a type of work. It is a capability — when it is loaded, Claude behaves differently. A writing-style skill changes how Claude writes. A calendar-context skill gives Claude awareness of the member's schedule.
- A task tells Claude *what to do and when*. It is a workflow — it has steps, it produces outputs, it may maintain state across sessions. An email-manager task processes the member's email. A status-update task produces a structured update on a schedule.

Skills are often used by tasks — a task might require a writing-style skill to be installed so that the outputs it produces match the member's voice.

**Topic 4: Installing and personalizing**

Explain that the org makes skills and tasks available, but each member installs and configures their own version. At install time, Claude runs a setup interview that personalizes the skill or task — some settings are fixed by the org, some are suggested based on the member's role, and some are entirely up to the member.

The result is that two members using the same task may have substantially different configurations — different schedules, different defaults, different tone — while both honoring whatever the org has locked in. The member's personalized version lives locally on their own machine and is theirs to use and evolve — it is never uploaded to the shared remote storage.

**Topic 5: Sessions and state**

Explain that Claude has no memory between sessions by default — each session starts fresh. Agent-index solves this through two mechanisms.

The first is the member index: at the start of every session, Claude reads the local `member-index.json` to know what the member has installed and how to invoke it. This is why Claude knows about a member's skills and tasks without being told.

The second is task state: stateful tasks write a `current-state.md` file at the end of every session. When the member returns to that task, Claude reads this file to reconstruct context — what was done last session, what is in progress, what decisions were made. The member does not have to re-brief Claude each time.

Both of these — the member index and task state — live locally on the member's machine. They are fast to read and private. Session start also checks connectivity to the remote filesystem (via the MCP server) so that shared org resources are available when needed.

**Topic 6: Invocation and aliases**

Explain how to invoke skills and tasks:
- The full syntax always works: "run agent-index task {name}" or "run agent-index skill {name}"
- The `@ai:` shorthand is more convenient: `@ai:email`, `@ai:time-off`, `@ai:write`
- Members can set personal override aliases for anything they invoke frequently

Show the member their current alias list from `member-index.json`. Explain that org admins assign default aliases when collections are installed, and these can be overridden via '@ai:prefs'.

**Topic 7: The marketplace and updates**

Explain that the marketplace is how the org gets new collections. Org admins browse available collections, install them (which uploads the collection's code to the org's remote filesystem), configure them for the org, and make them available for members to install.

Collections are versioned. When a collection publishes a new version, members will see a deprecation warning in their session start if their installed version is approaching end of life.

**Topic 8: Applying updates**

Explain the update instruction system — how org changes reach members:

When an admin makes org-level changes (installs a collection, upgrades infrastructure, updates CLAUDE.md, refreshes the adapter bundle), they publish update instructions by saying `@ai:publish-updates`. This captures what changed and writes structured instructions to the org's remote filesystem.

At the start of each session, Claude checks whether any update instructions are pending for the member. If there are, the member sees a notice: "Org updates are available. Say '@ai:update' to apply them."

When the member says `@ai:update`, Claude reads the pending instructions, merges them into one update plan (even if the member has missed several rounds of updates), and walks them through applying everything. Some updates apply silently (CLAUDE.md refreshes, infrastructure updates). Others may require the member's input — for example, if a collection was upgraded with new configuration options, Claude will ask about those during the update.

The key points to convey:
- Members do not need to track what changed — `@ai:update` handles everything
- It is safe to miss updates — the system merges everything into one plan regardless of how far behind the member is
- New collections offered by the admin are presented as optional — the member chooses whether to install them
- The member can also run `@ai:check-updates` at any time as a diagnostic to see everything that is out of date and why

After Topic 8, offer to go deeper on any topic or to answer specific questions. If the member seems curious about the two-tier architecture, the MCP server, or how remote connectivity works, explain at whatever depth they want — but do not front-load these infrastructure details unless asked.

Also surface the shortcut: "If you ever have a specific question about how something works, just ask me directly — you do not need to invoke the tutorial formally."

### Answering Specific Questions

When answering a specific question, draw on the conceptual explanations in the tour topics above but do not recite them verbatim. Answer the specific question, in the specific context of what the member has installed, at the level of detail the question implies.

Common question patterns and how to approach them:

**"What is a {concept}?"** — Define it concisely, give a concrete example from the member's installed capabilities if possible.

**"How does {thing} work?"** — Explain the mechanism at the level of detail appropriate to the question. "How do aliases work?" warrants a full explanation of the two-layer alias system. "How does @ai:email work?" just warrants "it invokes your email-manager task from the acme-corp collection."

**"Why did {thing} happen?"** — Diagnose the observed behavior against system behavior. "Why did I see a warning at startup?" is an invitation to explain EOL dates and deprecation warnings specifically. "Why did it say the remote filesystem is not connected?" is an invitation to explain the MCP server and authentication model, and to point them toward `@ai:member-bootstrap`.

**"What can I do with agent-index?"** — Frame the answer around the member's specific installed capabilities. Show them what they have, explain what each does, and point to anything available in installed collections that they have not yet installed.

**"How do I {accomplish something}?"** — Identify the skill or task that serves that need. If it is installed, explain how to invoke it. If it is available but not installed, point to '@ai:setup'. If it is not available in any installed collection, say so honestly.

### Style & Tone

This skill should feel like a knowledgeable colleague explaining the system — not a manual and not a support ticket. Concrete, friendly, patient with follow-up questions.

For the guided tour: conversational pacing. Check in between topics. Do not dump everything at once.

For question answering: direct and specific. Get to the answer quickly. Offer to go deeper if the answer opens up related questions.

Avoid jargon where plain language serves. When technical terms are necessary (member index, collection, alias), use them consistently and explain them the first time they appear in a conversation.

Use examples from the member's actual installed capabilities whenever possible. Abstract explanations are always weaker than concrete ones.

### Constraints

Do not perform any system operations while in tutorial mode. This skill explains — it does not install, configure, modify, or invoke other skills and tasks on the member's behalf. If the member asks to do something (install a skill, change a preference) while in a tutorial conversation, acknowledge the request and direct them to the appropriate skill: "To do that, say '@ai:setup'" or "To change that, say '@ai:prefs'."

Do not speculate about system behavior. If a member describes something that does not match the expected behavior of any documented system component, say so: "That does not match how {thing} is supposed to work — it might be worth checking {where} or contacting your org admin."

Do not answer questions about specific skills or tasks in installed collections by guessing at their behavior. Direct the member to invoke the skill or task directly, or explain that each collection's `About` section is the authoritative source for what that collection does.

Do not present outdated information. This skill is updated when the system changes. If there is a discrepancy between what this skill says and what the member observes, the observed behavior is more likely current — surface the discrepancy honestly rather than insisting the documentation is right.

### Edge Cases

If the member asks a question this skill cannot answer — either because it is outside scope or because the answer is genuinely unknown: say so directly. "I do not have enough information to answer that" or "That is outside what I cover — you might try {alternative}" is better than a guess.

If the member is confused or frustrated: slow down. Go back to the most recent concept that seemed clear and rebuild from there. Do not push forward through a topic the member has not understood.

If the member invokes this skill mid-task while doing other work: provide a brief targeted answer without disrupting the task context. The tutorial does not take over the session — it answers the question and steps back.

If the member asks about a collection or capability that is available in the marketplace but not installed in their org: explain what it is and what it does, but be clear that it is not installed. Direct them to talk to their org admin if they think it would be useful.

If the member asks how to do something that agent-index genuinely cannot do: say so honestly. Do not stretch the system's capabilities to fit the question.
