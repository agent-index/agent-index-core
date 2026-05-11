---
title: Pin Binary Version
slug: pin-binary-version
name: pin-binary-version
version: 1.0.0
collection: agent-index-core
type: task
admin_only: true
inputs:
  binary_name:
    type: string
    description: Name of the binary to pin (e.g. "permission-helper-go"). Must match an entry in infrastructure-directory.json -> binaries[].
    required: true
  version:
    type: string
    description: Target version. Must match a published version in the directory's platforms array. Use "latest" to track the directory's current_version.
    required: true
  policy:
    type: string
    description: One of "pinned" (use exactly this version), "min" (use this version or any newer), "latest" (track the directory's current_version). Default is "pinned".
    required: false
    default: pinned
  remove:
    type: boolean
    description: If true, remove the binary from org-config.json -> binaries{} (i.e., un-pin). Members will stop downloading/updating it on apply-updates.
    required: false
    default: false
description: Set or remove the org-level pin for a registered binary tool. Members converge to the org-pinned version on next apply-updates.
---

## About This Task

Org admins use this task to control which version of a native binary tool the org runs. Pinning is convergent: members will be prompted on next `@ai:apply-updates` to install/upgrade/downgrade their local binary to match the pin.

This is the only task that writes to `org-config.json` → `binaries{}`. Other tasks (`apply-updates`, `check-updates`) only read it.

### Why pin?

1. **Stability** — pin to a tested version. New releases get evaluated by the admin before rolling them out org-wide.
2. **Rollback** — if a new version turns out to have a bug, change the pin to a prior version. Members downgrade on next apply-updates.
3. **Floor** — `policy: min` lets the org establish a minimum version while letting members run newer if they want.

### Inputs and validation

- `binary_name` must match an entry in `infrastructure-directory.json` → `binaries[].name`. Otherwise: error.
- `version` must be a string. If `version == "latest"`, the pin records `version: <directory's current_version>` and `policy: latest`. Otherwise it must match a version that has at least one published `platforms[]` entry (so members can actually download it).
- `version` must be ≥ the directory's `min_required_version`. The min_required_version is a security floor — admins cannot pin below it.
- `policy` defaults to `pinned`. Other values: `latest`, `min`.

## Workflow

### Step 1: Identity and Permission Check

Resolve the running member's `member_hash`. Read `org-config.json` → `admins[]`. If the member is not in the admins list, refuse:

> Only org admins can pin binary versions. Run `@ai:check-updates` to see what's available.

### Step 2: Load Inputs and Directory

Read the `infrastructure-directory.json` URL from `agent-index.json` → `infrastructure_directory_url`. Fetch and parse. If unreachable, surface:

> Could not reach the infrastructure directory at `<url>`. Network issue, or the URL is misconfigured. Cannot validate the requested pin. Try again later.

Locate the binary entry in the directory's `binaries[]` array by name. If not found:

> Binary `<name>` is not declared in the infrastructure directory. Available binaries: `<list>`. (If you expect to find it, check the directory URL is current and reachable.)

### Step 3: Validate the Requested Version

If `remove == true`, skip ahead to Step 5.

Resolve the requested version:

- If `version == "latest"`: target = `directory_entry.current_version`, policy = `latest`.
- Otherwise: target = `version` literal.

Validate:

1. Target version must be ≥ `directory_entry.min_required_version`. If not:
   > Cannot pin to `<version>` — directory's required floor is `<min>`. Pick a version at or above the floor.

2. Target version must have at least one published binary in the directory's `platforms[]` array. (Practically: search for any platform entry whose `filename` template substituted with `{version} = <target>` resolves to a known release asset.)
   If the directory has no platforms recorded for this version, surface:
   > No published binaries for `<name>` version `<version>`. Available versions: `<list of known versions from directory>`.

   (Implementation detail: the directory currently records only `current_version` per binary, plus min_required_version. If pinning to a non-current version, the admin should make sure release assets exist on the binaries repo for the requested version. A future directory schema may publish `version_history[]` for richer validation; for now, the only "validated" version is `current_version`. Until then, we accept the admin's input on faith but warn:
   > Note: directory only records the current_version. The pin will be honored, but apply-updates will fail if the requested version's release assets aren't published.)

### Step 4: Confirm with Admin

Surface the resulting change for confirmation:

> About to pin `<binary_name>` to version `<version>` with policy `<policy>` for the org. Members will converge to this version on their next `@ai:apply-updates` (upgrade or downgrade as needed). Confirm? [Y/N]

On `N`: abort, no changes written.

### Step 5: Write to org-config.json

Read `org-config.json` from remote via `aifs_read("/org-config.json")`. Mutate:

- If `remove == true`: delete `binaries[binary_name]` if present. If the key was already absent, surface "Already not pinned." and exit.
- Otherwise: set `binaries[binary_name]` to:
  ```json
  {
    "version": "<target>",
    "policy": "<policy>",
    "pinned_by": "<member_hash>",
    "pinned_date": "<today, YYYY-MM-DD>"
  }
  ```

Write back via `aifs_write`.

### Step 6: Surface Result

> Pinned `<binary_name>` to `<version>` (`<policy>`). Members will pick this up on next `@ai:apply-updates`. To roll back later, run `@ai:pin-binary-version <name> <prior-version>`.

If `remove == true`:

> Removed pin for `<binary_name>`. Members will no longer auto-install or update this binary. Their existing local copies remain in place.

## Failure modes

- **Unreachable directory:** abort. Cannot validate the requested pin without it.
- **Binary not in directory:** abort. The org cannot pin a binary the registry doesn't know about.
- **Below `min_required_version`:** abort. Security floor.
- **`org-config.json` write conflict:** retry once. If still failing, abort with the conflict detail.

## Related capabilities

- `check-updates` — surfaces current local vs pinned vs directory current state for all registered binaries.
- `apply-updates` — Phase 1 step 7 reads the pin and prompts the user to download/install matching the target.
