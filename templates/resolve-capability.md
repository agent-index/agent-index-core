# Resolve Capability Provider

**Template version:** 1.0.0
**Usage:** Copy this file into your collection's `/internal/` directory and customize the collection name. This is an internal reference used by other skills and tasks in your collection. Do not expose as an API member.

---

## How to Reference This File

In your skill or task `.md` files, write instructions like:

> Follow the resolution steps in `/internal/resolve-capability.md` for binding `{binding-name}`, operation `{operation-name}`.

Replace `{binding-name}` with the name of the capability binding defined in your setup template (e.g., `member-alert-provider`). Replace `{operation-name}` with the capability operation to invoke (e.g., `send-notification`).

---

## Resolution Steps

When a skill or task in this collection needs to invoke a capability operation through a named binding:

### Step 1: Read the Binding

Read the member's `capability-bindings.json` from the local workspace:

**Path:** `members/{member_hash}/collections/{collection_name}/capability-bindings.json`

Look up `bindings.{binding_name}`.

### Step 2: Handle Missing Bindings

If `capability-bindings.json` does not exist, or the binding name is not present:

1. Read `org-config.json` via `aifs_read` → check `capability_providers.{capability_type}.providers`.
2. **If no providers array or empty array:** The capability is not available. Execute the fallback behavior declared in `collection.json` `requires` for this capability type:
   - `skip_with_notice`: Log a note to the member ("Notifications are not configured — install a communications collection to enable this feature.") and continue the task.
   - `prompt_manual`: Ask the member to perform the action manually.
   - `error`: Halt the task with a clear error message.
3. **If exactly one provider exists:** Use it directly (auto-bind). Extract `provider_collection` from the single provider entry.
4. **If multiple providers exist:** The binding is required but missing. Surface: "Multiple {capability_type} providers are registered but this collection hasn't been configured to choose between them. Run setup to configure capability bindings." Execute fallback behavior and continue.

### Step 3: Validate the Provider is Still Registered

Read `org-config.json` via `aifs_read` → check `capability_providers.{capability_type}.providers`.

Confirm that the `provider_collection` from the binding appears in the providers array.

**If the provider has been deregistered:** Surface: "The {capability_type} provider `{provider_collection}` is no longer registered. Re-run setup to choose a new provider." Execute fallback behavior and continue.

### Step 4: Resolve the Implementing Skill or Task

Read the provider collection's `collection.json` from `/{provider_collection}/collection.json` via `aifs_read`.

Find the `provides` entry matching `{capability_type}`. Look up `{operation_name}` in the `operations` map. Extract `implemented_by` and `type`.

**If the operation is not in the provider's operations map:** The provider does not support this operation. Surface: "The {capability_type} provider `{provider_collection}` does not support the `{operation_name}` operation." Execute fallback behavior and continue.

### Step 5: Read and Execute the Provider's Skill/Task

Read the implementing skill/task definition from `/{provider_collection}/api/{implemented_by}.md` via `aifs_read`.

Execute the skill/task with the parameters defined by the capability type's operation specification. The calling skill/task provides the concrete values for each parameter.

### Step 6: Handle the Response

Interpret the return values per the capability type's return schema. Check the primary success field (e.g., `sent`, `created`, `archived`).

**If the operation failed** (success field is `false`): Note the failure to the member using the `error` return field. Do not block the calling task unless the operation is critical to the workflow. Most capability operations are best-effort — the calling task should continue regardless of provider failures.

---

## Example: Sending a Notification via Binding

Here is a concrete example of how a Projects task would use this resolution pattern:

```
Action: Notify project members about a new decision.
Binding: member-alert-provider
Operation: send-notification

1. Read capability-bindings.json → bindings.member-alert-provider
   → provider_collection: "slack-triage"

2. Provider is registered in org-config.json → proceed.

3. Read /slack-triage/collection.json → provides → communications
   → operations → send-notification → implemented_by: "slack-send"

4. Read /slack-triage/api/slack-send.md via aifs_read.

5. Execute slack-send with:
   - recipients: [project members from project.md]
   - message: "📋 Decision recorded: 'Adopt React for the frontend' — decided by Sarah Kim."
   - urgency: "normal"

6. Response: { sent: true, message_id: "1234567890.123456" }
   → Note success. Continue task.
```

---

## Customization Notes

When you copy this template into your collection:

1. Replace `{collection_name}` references with your actual collection name.
2. Update the fallback behavior descriptions to match what your collection declares in `collection.json` `requires`.
3. If your collection has multiple capability requirements (e.g., both `communications` and `document-storage`), this single file handles all of them — the binding name and capability type are parameters passed by the calling skill/task.
