# Capability Provider Specification

**Status:** Draft
**Version:** 0.1.0
**Last Updated:** 2026-04-02

---

## Overview

Collections often need services that could be fulfilled by different implementations. A project management collection needs to send notifications — but "notifications" could mean Slack, email, Teams, or an internal messaging system depending on the org. Today, collections handle this by hardcoding platform awareness into their own setup and workflows (e.g., Projects asks "which comms platform?" and branches on the answer throughout its tasks).

The capability provider model replaces this with an indirection layer: collections declare abstract capability requirements, other collections register as providers of those capabilities, and consumer collections resolve providers at runtime through a shared registry. This decouples consumers from specific implementations and lets orgs swap providers without reconfiguring every collection that depends on them.

### Design Principles

**Agent-native resolution.** There's no RPC framework, no function dispatch table, no middleware. "Calling a provider" means the agent reads the provider's skill definition and follows its instructions. The registry tells the agent which file to read — the rest is standard agent-index skill execution.

**Multiple providers, explicit bindings.** An org can register multiple collections as providers for the same capability type. Ambiguity is resolved not at the registry level but at the consumer level: consumer collections define named **capability bindings** — specific use cases that get mapped to specific providers during setup. "Notify a member when added to a project" might bind to Slack; "notify a stakeholder when a milestone is reached" might bind to email. The binding configuration uses the same provenance tiers as all other setup parameters (`[org-mandated]`, `[member-overridable]`, etc.).

**Graceful degradation by default.** A missing provider is never fatal. Consumer collections must define fallback behavior when their required capability has no registered provider — log to file, skip the operation, surface a notice, or offer manual alternatives.

---

## Capability Types

A capability type is a named, versioned contract defining a set of operations that providers must implement. Capability types are the interface — they define *what* without prescribing *how*.

### Capability Type Registry

Well-known capability types are maintained in `agent-index-core/capability-types/`. Each type is a JSON file:

```
agent-index-core/
  capability-types/
    communications.json
    document-storage.json
    notifications.json
    ...
```

Collections may also define custom capability types (see Custom Capability Types below), but well-known types provide interoperability guarantees: any consumer coding against `communications@1.x` can work with any provider implementing `communications@1.x`.

### Capability Type Schema

```json
{
  "capability": "communications",
  "version": "1.0.0",
  "description": "Send messages, manage channels, and read message history on a team communication platform.",
  "operations": [
    {
      "name": "send-notification",
      "description": "Send a message to one or more recipients or a channel.",
      "required": true,
      "parameters": {
        "recipients": {
          "type": "array",
          "items": "member_reference",
          "description": "One or more member references (member_hash + display_name). At least one recipient or channel must be specified."
        },
        "channel": {
          "type": "string | null",
          "description": "Channel identifier (e.g., channel name or ID). If provided, message is sent to the channel. If null, sent as direct message to recipients."
        },
        "message": {
          "type": "string",
          "description": "The message content. Plain text. The provider may format for its platform."
        },
        "urgency": {
          "type": "string",
          "enum": ["low", "normal", "high"],
          "default": "normal",
          "description": "Hint to the provider about delivery priority. Interpretation is provider-specific."
        }
      },
      "returns": {
        "sent": "boolean",
        "message_id": "string | null",
        "error": "string | null"
      }
    },
    {
      "name": "create-channel",
      "description": "Create a named channel and optionally invite members.",
      "required": false,
      "parameters": {
        "channel_name": {
          "type": "string",
          "description": "Desired channel name. Provider may normalize (e.g., lowercase, replace spaces)."
        },
        "purpose": {
          "type": "string | null",
          "description": "Channel purpose or description."
        },
        "members": {
          "type": "array",
          "items": "member_reference",
          "description": "Members to invite to the channel."
        },
        "private": {
          "type": "boolean",
          "default": false,
          "description": "Whether the channel should be private."
        }
      },
      "returns": {
        "created": "boolean",
        "channel_id": "string | null",
        "channel_name": "string | null",
        "members_invited": "integer",
        "members_failed": "array",
        "error": "string | null"
      }
    },
    {
      "name": "archive-channel",
      "description": "Archive an existing channel.",
      "required": false,
      "parameters": {
        "channel_id": {
          "type": "string",
          "description": "Channel identifier to archive."
        }
      },
      "returns": {
        "archived": "boolean",
        "error": "string | null"
      }
    },
    {
      "name": "restore-channel",
      "description": "Unarchive a previously archived channel.",
      "required": false,
      "parameters": {
        "channel_id": {
          "type": "string",
          "description": "Channel identifier to restore."
        }
      },
      "returns": {
        "restored": "boolean",
        "error": "string | null"
      }
    },
    {
      "name": "read-channel-history",
      "description": "Read messages from a channel since a given timestamp.",
      "required": false,
      "parameters": {
        "channel_id": {
          "type": "string",
          "description": "Channel to read from."
        },
        "since": {
          "type": "string | null",
          "description": "ISO 8601 timestamp. If null, reads recent messages (provider-defined window)."
        }
      },
      "returns": {
        "messages": "array",
        "has_more": "boolean",
        "error": "string | null"
      }
    },
    {
      "name": "invite-to-channel",
      "description": "Invite members to an existing channel.",
      "required": false,
      "parameters": {
        "channel_id": {
          "type": "string",
          "description": "Channel to invite members to."
        },
        "members": {
          "type": "array",
          "items": "member_reference",
          "description": "Members to invite."
        }
      },
      "returns": {
        "invited": "integer",
        "failed": "array",
        "error": "string | null"
      }
    }
  ]
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `capability` | string | Kebab-case identifier. Must be unique across the capability type registry. |
| `version` | string | Semantic version of the capability type contract. |
| `description` | string | What this capability type represents. |
| `operations` | array | The operations providers may implement. |

Each operation:

| Field | Type | Description |
|---|---|---|
| `name` | string | Kebab-case operation name. Unique within the capability type. |
| `description` | string | What the operation does. |
| `required` | boolean | If `true`, every provider of this capability type must implement this operation. If `false`, providers may omit it. |
| `parameters` | object | Named parameters with type, description, and optional default. Types use a simple type vocabulary: `string`, `boolean`, `integer`, `array`, `object`, `member_reference`, plus `| null` for nullable. |
| `returns` | object | Named return values with types. Providers must return at minimum these fields. |

### Versioning Capability Types

Capability type versions follow semantic versioning:

- **MAJOR**: removing a required operation, changing a required operation's parameter signature in a breaking way, removing a return field from a required operation.
- **MINOR**: adding a new operation (required or optional), adding an optional parameter to an existing operation, adding a return field.
- **PATCH**: documentation or description changes only.

Providers declare which version range they support. Consumers declare which version range they require. The registry validates compatibility at install time.

---

## Provider Declarations

A collection that implements a capability type declares this in `collection.json` via a new `provides` field:

```json
{
  "name": "slack-triage",
  "display_name": "Slack Triage",
  "version": "1.0.0",
  "category": "communication",
  "provides": [
    {
      "capability": "communications",
      "capability_version": "1.0.0",
      "operations": {
        "send-notification": {
          "implemented_by": "slack-send",
          "type": "skill"
        },
        "create-channel": {
          "implemented_by": "slack-channel-create",
          "type": "skill"
        },
        "archive-channel": {
          "implemented_by": "slack-channel-archive",
          "type": "skill"
        },
        "restore-channel": {
          "implemented_by": "slack-channel-restore",
          "type": "skill"
        },
        "read-channel-history": {
          "implemented_by": "slack-channel-read",
          "type": "task"
        },
        "invite-to-channel": {
          "implemented_by": "slack-channel-invite",
          "type": "skill"
        }
      }
    }
  ],
  "api": [
    "slack-triage",
    "slack-triage-config",
    "slack-send",
    "slack-channel-create",
    "slack-channel-archive",
    "slack-channel-restore",
    "slack-channel-read",
    "slack-channel-invite"
  ]
}
```

### Provider Operation Mapping

Each entry in the `operations` map connects a capability operation to a concrete skill or task in the provider collection:

| Field | Type | Description |
|---|---|---|
| `implemented_by` | string | Name of the API member (skill or task) that implements this operation. Must be listed in the collection's `api` array. |
| `type` | string | `"skill"` or `"task"` — the type of the implementing API member. |

The implementing skill or task must accept the parameters defined in the capability type's operation spec. It may accept additional parameters beyond the spec (provider-specific extensions), but the spec parameters must be supported.

### Provider Skills and Tasks

Provider skills/tasks that implement capability operations should follow this convention in their `.md` frontmatter:

```yaml
---
name: slack-send
type: skill
version: 1.0.0
collection: slack-triage
description: Send a message via Slack to a member or channel.
implements:
  capability: communications
  operation: send-notification
  capability_version: ">=1.0.0"
---
```

The `implements` frontmatter block makes it self-documenting which capability operation this skill fulfills. This is informational — the binding source of truth is `collection.json`.

### Partial Providers

A provider is not required to implement every optional operation. If the email-triage collection provides `communications` but only implements `send-notification`, it declares only that operation:

```json
{
  "provides": [
    {
      "capability": "communications",
      "capability_version": "1.0.0",
      "operations": {
        "send-notification": {
          "implemented_by": "email-send",
          "type": "skill"
        }
      }
    }
  ]
}
```

Consumers that need `create-channel` would not be satisfied by this provider. The registry validates this at install time (see Install-Time Validation).

---

## Consumer Declarations

A collection that needs a capability declares this in `collection.json` via a new `requires` field:

```json
{
  "name": "projects",
  "display_name": "Projects",
  "version": "4.0.0",
  "category": "project-management",
  "requires": [
    {
      "capability": "communications",
      "capability_version": ">=1.0.0",
      "required_operations": ["send-notification"],
      "optional_operations": ["create-channel", "archive-channel", "restore-channel", "read-channel-history", "invite-to-channel"],
      "required": false,
      "fallback": "skip_with_notice"
    }
  ]
}
```

### Consumer Requirement Fields

| Field | Type | Description |
|---|---|---|
| `capability` | string | The capability type being required. |
| `capability_version` | string | SemVer range (e.g., `">=1.0.0"`, `"^1.0.0"`, `"1.x"`). |
| `required_operations` | array | Operations the consumer must be able to call. Provider must implement all of these. |
| `optional_operations` | array | Operations the consumer will use if available, but can work without. |
| `required` | boolean | If `true`, the collection cannot function without this capability. If `false`, the collection works in a reduced mode without it. |
| `fallback` | string | Behavior when no provider is registered. One of: `"skip_with_notice"` (silently skip with a log note), `"prompt_manual"` (ask the member to perform the action manually), `"error"` (halt the task with a clear error). Only meaningful when `required: false`. |

### Consumer Behavior: Feature Gating

When a consumer declares a requirement with `required: false`, its skills and tasks must conditionally enable features based on provider availability. The Projects collection is a good example:

- If at least one `communications` provider is registered and any implements `create-channel`: offer channel creation during project creation.
- If providers are registered but none implement `create-channel`: skip channel creation, but still offer `send-notification` for project alerts.
- If no `communications` provider is registered: skip all comms features, note in project creation that "notifications are not configured — install a communications collection to enable project alerts."

This replaces the current pattern where Projects hardcodes `comms_channel_enabled`, `comms_platform`, and platform-specific branching throughout its tasks. Instead, the task reads the provider registry at runtime and adapts.

### Capability Bindings

Consumer collections define **capability bindings** — named use cases that connect a specific action within the collection to a specific registered provider. Bindings are the routing layer: they answer "when I need to do X, which provider should I use?"

Bindings are declared in the consumer collection's setup template (not in `collection.json`) because they are configuration, not structural metadata. The `collection.json` `requires` section declares *what* the collection needs; bindings configure *which provider handles which use case*.

#### Binding Declaration in Setup Templates

Consumer setup templates define bindings as setup parameters with standard provenance tiers:

```markdown
### Capability Bindings: Communications

These settings control how this collection sends notifications. They only
appear if at least one communications provider is registered.

**member-alert-provider** [org-mandated]
- Description: Which communications provider to use when alerting project
  members (e.g., added to project, assigned an action item, unblocked).
- Ask: "Which provider should be used to alert project members about
  assignments and updates?"
- Available: {list registered communications providers}
- Default: {first registered provider}

**stakeholder-notification-provider** [member-overridable]
- Description: Which communications provider to use when notifying
  stakeholders (e.g., milestone reached, status report ready).
- Ask: "Which provider should be used for stakeholder notifications?"
- Available: {list registered communications providers that implement send-notification}
- Default: {org default, or first registered provider}

**channel-provider** [org-mandated]
- Description: Which communications provider to use for project channel
  operations (create, archive, monitor).
- Ask: "Which provider should handle project channels?"
- Available: {list registered communications providers that implement create-channel}
- Default: {first provider implementing create-channel, or null if none}
- Note: Only providers that support channel operations are shown.
```

#### Binding Storage

Bindings are stored in a dedicated `capability-bindings.json` file in the member's local workspace for the collection. This keeps bindings separate from general setup responses, making resolution fast (the agent reads one small JSON file) and validation straightforward.

**File location:** `members/{member_hash}/collections/{collection_name}/capability-bindings.json`

```json
{
  "version": "1.0.0",
  "collection": "projects",
  "last_updated": "2026-04-01",
  "bindings": {
    "member-alert-provider": {
      "capability": "communications",
      "provider_collection": "slack-triage",
      "operation_subset": ["send-notification"],
      "provenance": "org-mandated"
    },
    "stakeholder-notification-provider": {
      "capability": "communications",
      "provider_collection": "email-triage",
      "operation_subset": ["send-notification"],
      "provenance": "member-overridable"
    },
    "channel-provider": {
      "capability": "communications",
      "provider_collection": "slack-triage",
      "operation_subset": ["create-channel", "archive-channel", "restore-channel", "read-channel-history", "invite-to-channel"],
      "provenance": "org-mandated"
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `version` | string | Schema version for the bindings file format. |
| `collection` | string | The consumer collection these bindings belong to. |
| `last_updated` | string | ISO date when bindings were last modified. |
| `bindings` | object | Map of binding names to binding configurations. |

Each binding:

| Field | Type | Description |
|---|---|---|
| `capability` | string | The capability type this binding draws from. |
| `provider_collection` | string | The registered provider collection bound to this use case. |
| `operation_subset` | array | Which operations from the capability type this binding uses. |
| `provenance` | string | The provenance tier that governed this binding's configuration. |

#### Binding Resolution at Runtime

When a task needs to invoke a capability operation, it reads the relevant binding from `capability-bindings.json` to determine which provider to use. This replaces the single-lookup model with a binding-lookup model:

1. Determine which binding applies to the current action (e.g., "I'm alerting a project member" → `member-alert-provider`).
2. Read `capability-bindings.json` → `bindings` → `{binding_name}` → get `provider_collection`.
3. Proceed with standard provider resolution (read provider's `collection.json`, find `implemented_by`, read and execute the skill).

If a binding references a provider that has been deregistered since setup, the task falls back to the collection's declared fallback behavior and surfaces a notice: "The communications provider `{provider_collection}` is no longer registered. Re-run setup to choose a new provider, or perform this action manually."

#### Progressive Disclosure for Bindings

Binding questions use the same progressive disclosure pattern as other setup parameters:

- **One provider registered for the capability:** No binding question is asked. The single provider is used for all bindings automatically. Setup records the binding silently.
- **Multiple providers registered:** Binding questions appear, one per named use case. The admin or member chooses which provider handles which use case.
- **No providers registered:** No binding questions appear. The collection operates in reduced mode per its fallback declaration.

This means a collection installed in an org with one Slack provider and no email provider has the same simple setup experience as before — the binding layer is invisible until it's useful.

---

## The Provider Registry

Registered providers are stored in `org-config.json` under a new `capability_providers` section. Each capability type maps to an **array** of registered providers. This is org-level, admin-controlled configuration.

```json
{
  "capability_providers": {
    "communications": {
      "providers": [
        {
          "provider_collection": "slack-triage",
          "capability_version": "1.0.0",
          "registered_date": "2026-04-01",
          "registered_by": "a7f3b2c1d4e5f698",
          "operations_available": [
            "send-notification",
            "create-channel",
            "archive-channel",
            "restore-channel",
            "read-channel-history",
            "invite-to-channel"
          ],
          "provider_config": {
            "default_urgency_mapping": {
              "high": "direct_message",
              "normal": "channel",
              "low": "channel"
            }
          }
        },
        {
          "provider_collection": "email-triage",
          "capability_version": "1.0.0",
          "registered_date": "2026-04-01",
          "registered_by": "a7f3b2c1d4e5f698",
          "operations_available": [
            "send-notification"
          ],
          "provider_config": {
            "sender_name": "Project Updates",
            "sender_email": "projects@example.com"
          }
        }
      ]
    },
    "document-storage": {
      "providers": [
        {
          "provider_collection": "drive-connector",
          "capability_version": "1.0.0",
          "registered_date": "2026-04-01",
          "registered_by": "a7f3b2c1d4e5f698",
          "operations_available": [
            "store-document",
            "retrieve-document",
            "list-documents"
          ],
          "provider_config": {}
        }
      ]
    }
  }
}
```

### Registry Fields

Each capability type entry contains:

| Field | Type | Description |
|---|---|---|
| `providers` | array | Ordered list of registered providers for this capability type. |

Each provider entry:

| Field | Type | Description |
|---|---|---|
| `provider_collection` | string | Name of the installed collection providing this capability. |
| `capability_version` | string | The capability type version the provider implements. |
| `registered_date` | string | ISO date when the provider was registered. |
| `registered_by` | string | `member_hash` of the admin who registered the provider. |
| `operations_available` | array | List of operations the provider implements. Copied from the provider's `collection.json` at registration time. |
| `provider_config` | object | Provider-specific configuration set during registration. Schema is defined by the provider, not the capability type. |

### Registration Lifecycle

**Auto-registration on install:** When a collection with a `provides` declaration is installed, the install workflow asks the admin: "This collection provides the `{capability}` capability. Register it as a `{capability}` provider?" If accepted, the provider is appended to the `providers` array in `org-config.json`.

**Addition alongside existing providers:** If providers are already registered for a capability type and a new collection is installed that also provides it, the install workflow surfaces: "Your org already has {N} registered `{capability}` provider(s): {provider_list}. Would you like to also register `{new_collection}`?" The new provider is added to the array. Consumer collections that use capability bindings will need to be re-configured (or will auto-bind if this is the only provider supporting a needed operation).

**Deregistration on removal:** When a provider collection is removed from the org, it is removed from the relevant `providers` array. The removal workflow identifies consumer collections with bindings to this provider: "Removing `{collection}` will deregister it as a `{capability}` provider. These collections have bindings to it: {consumer_list}. They will need to re-bind to another provider or will fall back to reduced functionality."

**Manual management via `edit-org`:** Admins can add, remove, or reorder providers at any time through the `edit-org` skill.

### Provider-Specific Configuration

The `provider_config` section allows providers to expose configuration that's specific to their implementation. For a Slack provider, this might include default channel naming rules or urgency-to-delivery mappings. For an email provider, it might include the sender address or template.

Provider-specific config is set during registration (prompted by the provider's setup interview) and stored in the registry. Consumer collections never read `provider_config` directly — they pass parameters through the standard capability interface and let the provider interpret them using its own config.

### Binding vs. Registry: Separation of Concerns

The registry answers: "What providers are available for this capability type?"
The bindings (in consumer `capability-bindings.json`) answer: "Which provider does this collection use for this specific use case?"

This separation means:
- An admin can register a new provider without immediately reconfiguring every consumer collection.
- A consumer collection can be reconfigured (re-bound) without changing the registry.
- Members can override bindings (where provenance allows) without affecting other members or the org registry.

---

## Runtime Resolution

When a consumer task needs to invoke a capability operation, it follows a binding-first resolution sequence. This entire flow is agent-native — the agent reads files and follows instructions, with no infrastructure beyond the filesystem.

### Resolution Sequence

```
1. Read the consumer's capability-bindings.json → bindings → {binding_name}
2. Extract provider_collection from the binding
3. If binding references a provider that is no longer registered:
   → Surface notice, execute fallback behavior
4. Read provider's collection.json from /{provider_collection}/collection.json
5. Look up the operation in provides → operations → find implemented_by
6. Read the implementing skill/task .md from /{provider_collection}/api/{implemented_by}.md
7. Execute the skill/task with the capability operation's parameters
8. Interpret the return values per the capability type's return schema
```

If the consumer has not run setup yet (no bindings exist), fall back to checking `org-config.json` → `capability_providers` → `{capability_type}` → `providers`. If exactly one provider exists, use it directly. If multiple exist, surface a notice asking the member to run setup. If none exist, execute the fallback behavior.

### Resolution in Skill/Task Instructions

Consumer skills and tasks encode the resolution pattern in their markdown instructions. Here is how a Projects task would invoke notifications using bindings:

```markdown
### Notify Project Members

When a decision is recorded and team notification is appropriate:

1. Read the member's `capability-bindings.json` and check
   `bindings.member-alert-provider`.

2. **If no binding exists** (setup not run or no communications provider was
   registered at setup time): Surface to the member: "Project notifications
   aren't configured. Run setup to configure a communications provider, or
   install one from the marketplace." Continue the task — notification is
   not blocking.

3. **If a binding exists:** Extract `provider_collection` (e.g., `slack-triage`).

4. **Validate the provider is still registered:** Read `org-config.json` via
   `aifs_read` and check that `provider_collection` appears in
   `capability_providers.communications.providers`. If the provider has been
   deregistered since setup: surface "The communications provider
   `{provider_collection}` is no longer available. Re-run setup to choose a
   new provider." Continue without notification.

5. Read the provider collection's `collection.json` from
   `/{provider_collection}/collection.json` via `aifs_read`. Find the
   `provides` entry for `communications`. Look up `send-notification` in
   the `operations` map to get `implemented_by` and `type`.

6. Read the implementing skill/task definition from
   `/{provider_collection}/api/{implemented_by}.md` via `aifs_read`.

7. Execute the skill with these parameters:
   - `recipients`: the project members to notify (from the project's member list)
   - `channel`: the project's channel_id (if the project has one), otherwise null
   - `message`: "📋 Decision recorded: '{decision_statement}' — decided by {decider}."
   - `urgency`: "normal"

8. If the provider returns `sent: false`, note the failure to the member but do not
   block the task. The decision is still recorded regardless of notification outcome.
```

### Mixed-Provider Example

Here is how a Projects task uses different bindings for different actions within the same workflow:

```markdown
### Post-Milestone Notifications

When a milestone is marked complete:

1. **Alert project members** (binding: `member-alert-provider`):
   Resolve the `member-alert-provider` binding. Execute `send-notification`
   with the bound provider:
   - `recipients`: all project members
   - `message`: "🎯 Milestone '{milestone_name}' is complete."
   - `urgency`: "normal"

2. **Notify stakeholders** (binding: `stakeholder-notification-provider`):
   Resolve the `stakeholder-notification-provider` binding. This may be a
   different provider (e.g., email instead of Slack). Execute
   `send-notification` with the bound provider:
   - `recipients`: project stakeholders (from project.md stakeholder list)
   - `message`: "Milestone '{milestone_name}' for project '{project_name}'
     has been completed. A status update is available for review."
   - `urgency`: "high"

Each binding resolves independently. The member-alert may go through Slack
while the stakeholder notification goes through email. If either binding is
missing or the provider is unavailable, that notification is skipped with a
notice — the other notification still proceeds.
```

### Resolution Helper Pattern

To avoid repeating the resolution boilerplate in every skill/task, consumer collections can define an internal helper. This is a non-API markdown file that other skills/tasks in the collection reference:

```
/{collection-name}/
  /internal/
    resolve-capability.md    ← shared resolution instructions
```

```markdown
# Resolve Capability Provider

This is an internal reference used by other skills and tasks in this collection.
Do not expose as an API member.

## Resolution Steps

When a skill or task in this collection needs to invoke a capability operation:

1. Read the member's `capability-bindings.json` (local file at
   `members/{member_hash}/collections/{collection_name}/capability-bindings.json`)
   → `bindings` → `{binding_name}`.
2. If no bindings file exists or binding is absent: check `org-config.json` →
   `capability_providers` → `{capability_type}` → `providers`.
   - If no providers: return `{ available: false, reason: "no_provider" }`.
   - If exactly one provider: use it (auto-bind).
   - If multiple providers: return `{ available: false, reason: "binding_required" }`.
3. Extract `provider_collection` from the binding.
4. Validate the provider is still registered in `org-config.json`.
   If not: return `{ available: false, reason: "provider_deregistered" }`.
5. Read `/{provider_collection}/collection.json` (remote, via `aifs_read`) →
   `provides` → find the capability entry → `operations` → `{operation_name}`
   → get `implemented_by`.
6. If the operation is not in the provider's operations map:
   return `{ available: false, reason: "operation_not_supported" }`.
7. Return `{ available: true, provider_collection, implemented_by, type }`.

The calling skill/task then reads and executes the implementing skill/task.
```

Consumer skills reference this with: "Follow the resolution steps in `/internal/resolve-capability.md` for binding `member-alert-provider`, operation `send-notification`."

---

## Install-Time Validation

The marketplace install workflow validates capability requirements and provider declarations before completing installation.

### Installing a Consumer

When installing a collection that has `requires` entries:

1. For each requirement where `required: true`:
   - Check `org-config.json` → `capability_providers` for the capability type.
   - If no providers are registered: warn the admin. "This collection requires a `{capability}` provider but none is registered. The collection will not function correctly until a provider is installed."
   - If providers exist: check that at least one provider implements all `required_operations`. If no single provider covers all required operations: warn. "No registered `{capability}` provider implements all required operations. Missing: `{missing_operations}`."

2. For each requirement where `required: false`:
   - Check if any providers exist. If not: inform (not warn). "This collection can use a `{capability}` provider for additional features. No provider is currently registered — these features will be disabled."
   - If providers exist: list them and note which optional operations are covered across the registered providers.

3. Never block installation based on missing providers. Always install and let the collection degrade gracefully.

4. If multiple providers are registered for a required capability: prompt the admin to configure bindings now or defer to member setup. "Multiple `{capability}` providers are registered: {provider_list}. You can configure which provider handles each use case now, or let members configure this during their setup."

### Installing a Provider

When installing a collection that has `provides` entries:

1. For each capability provided:
   - Check if the capability type exists in the well-known registry (`agent-index-core/capability-types/`). If not, check if it's a custom type defined by the collection.
   - Validate that all `required: true` operations from the capability type are present in the provider's `operations` map.

2. Register the provider: append to the `providers` array for the capability type. If this is the first provider for this type, auto-registration is straightforward. If other providers already exist, inform the admin: "`{new_collection}` has been registered alongside {existing_list} as a `{capability}` provider."

3. After install, check if any installed consumer collections have unmet `requires` for this capability type or have bindings that could benefit from the new provider. Surface: "The following collections use `{capability}`: {consumer_list}. If they have multiple use cases, members can now choose between {provider_list} during setup."

### Removing a Provider

When removing a collection that is a registered provider:

1. Identify all consumer collections with capability bindings pointing to this provider.
2. Surface: "Removing `{collection}` will deregister it as a `{capability}` provider. These collections have bindings to it: {consumer_list}. They will need to re-bind to another provider or will fall back to reduced functionality."
3. If other providers remain for the same capability type: "Other `{capability}` providers are still registered: {remaining_list}. Affected collections can be re-bound to those."
4. On confirmation: remove the provider from the `providers` array. Consumer bindings referencing this provider become stale and trigger re-bind prompts on next run.

---

## Collection Setup Integration

The capability provider model integrates with the existing setup interview system. Here's how each tier is affected.

### Provider Setup

When a provider collection is installed and registered, its `collection-setup.md` may include provider-specific configuration that flows into `provider_config` in the registry. Example for a Slack provider:

```markdown
### Capability Provider Configuration

These settings apply because this collection is registered as a
communications provider. Other collections that bind to this provider
for notifications or channel operations will use these defaults.

**default_notification_channel** [org-mandated]
- Description: Default Slack channel for org-wide notifications when no
  project-specific channel exists.
- Ask: "What Slack channel should be used for general notifications?"
- Default: `#general`

**urgency_mapping** [org-mandated]
- Description: How urgency levels map to Slack delivery.
- Ask: "How should different urgency levels be delivered?"
  - `high` → direct message (default)
  - `normal` → channel post (default)
  - `low` → channel post, no @mention (default)
```

### Consumer Setup Simplification

The biggest benefit: consumer collections no longer need to ask platform-specific questions. Projects today asks about `comms_platform`, `comms_channel_naming_template`, `slack_user_token_path`, etc. With the provider model, Projects only needs:

```markdown
### Notifications [org-mandated]

**notifications_enabled**
- Description: Whether project events trigger notifications via
  registered communications providers.
- Ask: "Would you like project events (decisions, new members, status
  changes) to trigger notifications?"
- If yes → proceed to capability binding configuration
  (see Capability Bindings section above)
- If no → skip
- Note: Requires at least one registered communications provider. If none
  is registered, notifications are silently skipped.
```

All platform-specific configuration lives in the provider's setup, not the consumer's. The consumer only configures *what* triggers notifications, *when*, and *which provider handles each use case* — never the platform-specific *how*.

When an org has a single communications provider, the binding setup is invisible (auto-bound). When an org has multiple providers, the binding questions appear — using standard provenance tiers so the admin can mandate certain bindings while letting members choose others.

---

## Update Log Integration

New operation types for the update log (`/shared/updates/update-log.json`):

**`provider-register`** — A capability provider was registered.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"provider-register"` |
| `capability` | string | Capability type name |
| `provider_collection` | string | Collection registered as provider |
| `capability_version` | string | Version of the capability contract |
| `provider_count` | integer | Total number of providers now registered for this capability type |

**`provider-deregister`** — A capability provider was deregistered.

| Field | Type | Description |
|---|---|---|
| `type` | string | `"provider-deregister"` |
| `capability` | string | Capability type name |
| `provider_collection` | string | Collection that was deregistered |
| `reason` | string | `"collection-removed"` or `"manual"` |
| `provider_count` | integer | Total number of providers remaining for this capability type |
| `affected_bindings` | array | List of `{ consumer_collection, binding_name }` objects for bindings that referenced this provider |

---

## Custom Capability Types

Collections may define capability types that don't exist in the well-known registry. This supports domain-specific extension without waiting for core registry additions.

A custom capability type definition is a JSON file in the provider collection:

```
/{collection-name}/
  /capability-types/
    my-custom-capability.json
```

The schema is identical to well-known types. The namespace is the collection name: consumers reference it as `{collection-name}:my-custom-capability` to distinguish from well-known types. Example:

```json
{
  "name": "projects",
  "requires": [
    {
      "capability": "acme-hr:employee-lookup",
      "capability_version": ">=1.0.0",
      "required_operations": ["find-employee"],
      "optional_operations": ["get-department"],
      "required": false,
      "fallback": "prompt_manual"
    }
  ]
}
```

Custom capability types can be promoted to well-known types through the normal agent-index-core contribution process.

---

## Marketplace Directory Integration

The `marketplace-directory.json` gains two new optional fields per collection entry:

```json
{
  "name": "slack-triage",
  "provides_capabilities": ["communications"],
  "requires_capabilities": []
},
{
  "name": "projects",
  "provides_capabilities": [],
  "requires_capabilities": [
    {
      "capability": "communications",
      "required": false
    }
  ]
}
```

This lets the marketplace discovery UI surface information like: "Projects works best with a communications provider. Compatible collections: Slack Triage, Email Triage." The `list-marketplace-collections` task can present these relationships during browsing.

---

## Migration Path: Projects v3 → v4

The Projects collection is the canonical migration example. Here's how the transition would work.

### What Changes

**Removed from Projects `collection.json`:**
- The `external_dependencies` entries for Slack/Teams/Discord
- All platform-specific comms configuration

**Added to Projects `collection.json`:**
```json
"requires": [
  {
    "capability": "communications",
    "capability_version": ">=1.0.0",
    "required_operations": ["send-notification"],
    "optional_operations": [
      "create-channel",
      "archive-channel",
      "restore-channel",
      "read-channel-history",
      "invite-to-channel"
    ],
    "required": false,
    "fallback": "skip_with_notice"
  }
]
```

**Removed from Projects `collection-setup.md`:**
- `comms_platform`
- `comms_channel_naming_template`
- `comms_channel_enforcement`
- `comms_channel_archive_on_project_archive`
- `slack_user_token_path`

**Simplified in Projects `collection-setup.md`:**
- `comms_channel_enabled` → `notifications_enabled` (boolean, org-mandated)
- Channel-specific questions replaced by: "do you want notifications?" and "do you want project channels?" (if any provider supports it)
- New capability binding parameters added: `member-alert-provider`, `stakeholder-notification-provider`, `channel-provider` (see Capability Bindings section)
- Binding questions only appear if multiple communications providers are registered; with a single provider, bindings are auto-configured

**Changed in task/skill .md files:**
- All hardcoded `comms_platform` branching replaced by capability resolution
- Platform-specific tool invocations (`slack_send_message`, etc.) replaced by provider skill invocation
- `create-channel.py` and related scripts removed from Projects — they belong in the Slack provider

### Upgrade Script (v3 → v4)

```markdown
# Projects v3 → v4 Upgrade

## Migration Steps

1. Read existing `collection-setup-responses.md` for comms configuration.
2. If `comms_channel_enabled` was `true`:
   - Check if the org has a registered `communications` provider.
   - If yes: map existing settings to provider-aware settings.
     Set `notifications_enabled: true`, `project_channels_enabled: true`.
   - If no: inform admin that a communications collection needs to be
     installed to restore comms functionality. Set `notifications_enabled: true`,
     `project_channels_enabled: true` — they'll activate once a provider is
     registered.
3. Remove deprecated parameters from responses.
4. Existing project records with `comms_channel` data are preserved as-is.
   The channel_id and channel_name remain valid — only the invocation path
   for channel operations changes.

## Preserved Responses
- All non-comms parameters
- `notifications_enabled` (mapped from `comms_channel_enabled`)

## Reset on Upgrade
- `comms_platform` (now provider-determined)
- `comms_channel_naming_template` (now provider-determined)
- `slack_user_token_path` (now provider-determined)

## Requires Member Attention
- Members with Slack user tokens: token path is now managed by the
  communications provider, not Projects. Members may need to re-run
  the provider's setup.
```

---

## Well-Known Capability Types (Initial Set)

The following types are proposed for the initial registry. Each would get a full JSON definition file.

| Capability | Key Operations | Likely Providers |
|---|---|---|
| `communications` | send-notification, create-channel, archive-channel, read-channel-history, invite-to-channel | Slack Triage, Email Triage, Teams connector |
| `notifications` | send-notification (subset of communications — for collections that only need one-way messaging, no channels) | Any communications provider, plus lightweight webhook-based providers |
| `document-storage` | store-document, retrieve-document, list-documents, delete-document | Drive connector, OneDrive connector, S3 connector |
| `calendar` | create-event, list-events, update-event, delete-event | Google Calendar connector, Outlook connector |
| `identity-lookup` | find-member, get-member-details, list-members | HRIS collections, directory service connectors |

### Relationship Between `communications` and `notifications`

`notifications` contains only `send-notification`, which is also present in `communications`. However, the two types are **fully independent** — there is no implicit inheritance. A collection that provides `communications` does not automatically provide `notifications`. If a provider wants to satisfy both, it must explicitly declare both in its `provides` array.

This keeps the registry simple (no inheritance chains to reason about) and makes provider capabilities fully explicit. A Slack Triage collection that wants to serve both consumers requiring `communications` and those requiring only `notifications` declares:

```json
"provides": [
  {
    "capability": "communications",
    "capability_version": "1.0.0",
    "operations": { ... }
  },
  {
    "capability": "notifications",
    "capability_version": "1.0.0",
    "operations": {
      "send-notification": {
        "implemented_by": "slack-send",
        "type": "skill"
      }
    }
  }
]
```

Lightweight consumers (like a collection that only needs to send alerts) declare `requires: notifications`. Full-featured consumers (like Projects with channels) declare `requires: communications`.

---

## Open Questions

1. **Binding fallback chains.** Should a binding support a fallback provider? (e.g., "try Slack, if unavailable, fall back to email.") This is useful for resilience but adds complexity to the resolution path. Recommendation: defer to a future version. For now, bindings point to a single provider and use the collection's declared fallback if that provider is unavailable.

2. **Provider health checks.** Should the registry track whether a provider's external dependencies are working? (e.g., "Slack MCP is connected.") Or is this purely runtime — providers return errors and consumers handle them? Recommendation: runtime. Health checks add state management complexity.

3. **Cross-org provider sharing.** If an org has multiple agent-index deployments, can they share provider registrations? Recommendation: out of scope for v1. Each org-config is independent.

4. **Capability type governance.** Who can add well-known types? Recommendation: same process as category additions — proposed via GitHub issue, reviewed by agent-index team.

5. **Provider quality signals.** Should the marketplace surface which operations a provider implements? (e.g., "Slack Triage: 6/6 communications operations. Email Triage: 1/6.") Recommendation: yes, this helps admins choose between providers when configuring bindings.

6. **Binding inheritance.** When a new provider is added to an org, should existing consumer collections automatically pick it up for unbound use cases? Or should bindings only change through explicit re-configuration? Recommendation: new providers are available for binding but never auto-assigned to existing bindings. New consumer setups will see all available providers.

7. **Member-level provider preferences.** Should members be able to set a default "preferred provider" for a capability type that applies across all their collections? (e.g., "I prefer Slack for all communications.") Or should each collection's bindings be independent? Recommendation: explore in a future version. For now, bindings are per-collection.

---

## Integration Notes

When this spec is finalized:

1. **`standards.md`** gains: `provides` and `requires` as optional `collection.json` fields, the two new update log operation types (`provider-register`, `provider-deregister`), and a "Capability Provider Requirements" section covering validation rules.
2. **`collection-authoring-guide.md`** gains: a "Designing for Capability Providers" section covering when to consume vs. provide, writing capability bindings in setup templates, the resolution helper pattern, and migration guidance.
3. **`collection.json` schema**: `provides` and `requires` are optional arrays (empty array or absent means "no capabilities provided/required"). Existing collections remain valid without them.

*This specification is a draft companion to `standards.md`. When finalized, the normative requirements will be integrated into `standards.md` and the guidance patterns into `collection-authoring-guide.md`.*
