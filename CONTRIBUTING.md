# Contributing to agent-index

**This document is written for the Cowork agent assisting a contributor.** It is the canonical contribution guide for all Agent Index Inc source repositories; other repos carry a short pointer to this file rather than their own copy, so there is one place to change.

If you are a person reading this: you do not need to learn git. Ask your agent to make the change and it will hand you scripts to run and text to paste. The rest of this document tells your agent how to do that properly.

It assumes you are an Agent Index Inc contributor. It does not assume your access is uniform across the repos, or that a team-level grant has reached the repo you are trying to change — see **Setup**. It is not for customer orgs: nothing here describes how to use agent-index, only how to change its source.

---

## Operating model

Contributors here are not necessarily engineers. **The agent never asks the contributor to compose, reason about, or improvise a git command.** The agent generates a complete, runnable script; the contributor runs it natively and pastes the output back.

This is the same generator pattern the `release` and `clone-script-generator` tasks already use, and for the same reason. `standards.md` § Release procedure states it directly:

> The agent never pushes or tags. `git push`/`git tag` run natively on the admin's host, where credentials and a clean working tree are. Agent-side git over a synced/mounted filesystem produces torn commits.

and

> Agent-side git is read-only via `git show`. Never `git checkout`/`git switch`/`git stash`/`git add` from the sandbox: those take the index lock and write torn files back through the mount, and can collide with the user's native git session.

So the division is fixed:

| Who | Does what |
|---|---|
| **The agent** | Writes and edits file contents. Generates scripts. Writes the commit message and PR text. Read-only git: `log` and `show` freely; `status` and `diff` only with `--no-optional-locks`. |
| **You, natively** | Anything that writes the index or refs: `switch`, `branch`, `add`, `commit`, `push`. And `fetch`, which writes refs and objects. And opening the pull request. |

The contributor's entire job is: run script, paste output, run script, paste output, click link, paste text.

**"Read-only" is not lock-free, and this is the part that bites.** `git status` and `git diff` refresh the index as a side effect, and refreshing takes `.git/index.lock` — so an agent-side command that changes no file can still leave a lock behind, because over a mount it frequently cannot remove what it created (`Operation not permitted` on unlink). Observed three times in six days: a zero-byte `index.lock` left by a process that died at the end of a session blocked `git switch` four days later; a plain agent-side `git status` planted another one that the sandbox could not clear; and an agent-side `git fetch` left a zero-byte `.git/objects/maintenance.lock`.

So prefer `git log` and `git show`, which never take the lock, and prefix the other two: `git --no-optional-locks status`. If you find a zero-byte lock file anywhere under `.git` — `index.lock`, `objects/maintenance.lock` — or hit `Unable to create '.git/index.lock'`, delete it natively, after confirming no git process of your own is actually running.

**And `--no-optional-locks` does not cover everything.** The flag governs the optional index refresh that `status` and `diff` perform; it says nothing about the background maintenance that `git fetch` schedules, which takes `.git/objects/maintenance.lock`. An agent-side `git fetch upstream --tags` left one behind with the flag in effect. `fetch` is not read-only in any case — it writes refs and objects — so it belongs in the native column with the rest; it is called out because it reads like an innocent network command. As a backstop for whatever else schedules maintenance, the generated prep script sets `git config maintenance.auto false` in the clone.

---

## Setup

**Check what access you actually have before planning a branch.** Repo visibility and push rights are two separate questions, and neither follows from being in the GitHub org.

- `agent-index-core` and `agent-index-marketplace-developer` are **public** — cloning them needs no grant at all.
- `agent-index-meta-docs` is **private**, and readable through org membership.
- Org membership is read-level. It does not carry push access.

**Two working routes. Establish which one is yours first.**

*Fork route (assume this unless you have confirmed otherwise).* If GitHub shows you no Settings tab and no "New branch" control on the repo, and refuses the web edit route with "you're not able to edit this repository directly — you need to fork it and propose your changes from there instead", you do not have push access. Fork, clone your fork, and add the canonical repo as `upstream`. Your branches push to `origin` (your fork); pull requests are opened against `agent-index:main`.

**Create the fork on GitHub before you touch any remote.** `git remote add` writes a line of local config and validates nothing — it succeeds against a URL that does not exist yet. Nothing looks wrong until `git push`, which fails with `remote: Repository not found` against a URL that reads as perfectly correct, several steps after the actual mistake.

If you already cloned the canonical repo before establishing that you have no push access, you do not need a second clone. Fork on GitHub, then rename the remotes in place:

```
git remote rename origin upstream
git remote add origin https://github.com/<your-user>/<repo>.git
git fetch upstream
```

*Topic-branch route.* If you do have push access to the canonical repo, clone it directly and push topic branches to it. Everything below works the same; substitute `origin` for `upstream` when syncing.

Do not assume the topic-branch route because a team grant exists on paper. A team-level Write grant has been observed not to reach the repo — the fork route was the one that worked. If you find your access differs from what you were told, report it where the work is tracked rather than absorbing it.

**Clone somewhere separate from your agent-index install.** Use a distinct working folder — a `dev_source` beside your `dev_install`, for example. The install tree is managed by `apply-updates`; mixing a contribution clone into it creates real confusion about which copy is authoritative. Then connect that folder to Cowork so the agent can read and write files in it.

**Leave line-ending settings alone.** Every repo commits a `.gitattributes` (`* text=auto eol=lf`) precisely so that a checkout is byte-identical on every platform. Do not set `core.autocrlf`, and never include a line-ending normalisation in a content commit.

That second point is not hypothetical. Commit `88d18e2` in `agent-index-meta-docs` normalised line endings across five files and changed **zero** content lines. Because git then reported all five as modified that day, every one of them looked newer than the live rulebook, and readers were pointed at documents two quarters out of date. A single whitespace commit caused a documentation failure that took an audit to unpick.

---

## The four phases

### Phase 1 — Prepare (generated script)

The agent generates `pr-prep-<topic>.ps1`. It clones or refreshes the target repo **and** `agent-index-marketplace-developer` (needed for the preflight CLI), verifies the tree is clean, and creates the branch.

```powershell
# pr-prep-<topic>.ps1  — safe to re-run
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root     = '<CONTRIBUTOR_DEV_SOURCE>'          # e.g. C:\Users\<you>\agent-index\dev_source
$Branch   = '<BRANCH>'                          # e.g. docs/claude-md-id-anchors
$Upstream = '<UPSTREAM_REMOTE>'                 # 'upstream' on the fork route, 'origin' on the topic-branch route
$Repos    = @(
  @{ Name='agent-index-core';                  Url='<ORIGIN_URL_FOR_THIS_CONTRIBUTOR>';                                   Branch=$Branch }
  @{ Name='agent-index-marketplace-developer'; Url='https://github.com/agent-index/agent-index-marketplace-developer.git'; Branch=$null }
)

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Write-Host "===== PR-PREP BEGIN ====="
Write-Host ("root:     " + $Root)
Write-Host ("git:      " + (git --version))
Write-Host ("branch:   " + $Branch)
Write-Host ("upstream: " + $Upstream)

foreach ($r in $Repos) {
  $Dir = Join-Path $Root $r.Name
  Write-Host ""
  Write-Host ("----- " + $r.Name + " -----")

  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "exists -> fetching"
    git -C $Dir fetch $Upstream --prune 2>&1 | Out-Host
  } else {
    Write-Host "cloning"
    git clone $r.Url $Dir 2>&1 | Out-Host
  }

  # background maintenance schedules a lock the sandbox often cannot clear
  git -C $Dir config maintenance.auto false 2>&1 | Out-Host

  # clear any zero-byte locks left by an earlier agent-side command
  foreach ($lock in @('.git\index.lock','.git\objects\maintenance.lock')) {
    $p = Join-Path $Dir $lock
    if ((Test-Path $p) -and ((Get-Item $p).Length -eq 0)) { Write-Host ("removing stale " + $lock); Remove-Item $p -Force }
  }

  git -C $Dir switch main 2>&1 | Out-Host
  git -C $Dir pull $Upstream main 2>&1 | Out-Host

  $dirty = git -C $Dir --no-optional-locks status --porcelain
  if ($dirty) {
    Write-Host "!! WORKING TREE NOT CLEAN — STOP AND REPORT THIS"
    Write-Host $dirty
  } else {
    Write-Host "tree clean"
  }

  if ($r.Branch) {
    $exists = git -C $Dir branch --list $r.Branch
    if ($exists) { git -C $Dir switch $r.Branch 2>&1 | Out-Host }
    else         { git -C $Dir switch -c $r.Branch 2>&1 | Out-Host }
    Write-Host ("on branch: " + (git -C $Dir rev-parse --abbrev-ref HEAD))
  }
}
Write-Host ""
Write-Host "===== PR-PREP END ====="
Write-Host "Copy everything between BEGIN and END and paste it back to your agent."
```

**The clean-tree check is not decoration.** If it reports the whole tree as modified, your git is rewriting line endings on checkout. Every diff produced from that clone will be wrong. Stop and fix the cause; do not proceed.

### Phase 2 — Edit (agent, no script)

The agent edits files in the clone directly, using file tools only. No git. The clone must be connected to Cowork for this; if it is not, say so and stop rather than improvising.

### Phase 3 — Submit (generated script)

The agent writes the commit message to `<Root>\.commit-msg.txt` — outside the repo, so it is never committed — then generates `pr-submit-<topic>.ps1`.

```powershell
# pr-submit-<topic>.ps1  — aborts before committing if preflight fails
$ErrorActionPreference = 'Continue'

$Root    = '<CONTRIBUTOR_DEV_SOURCE>'
$Dir     = Join-Path $Root '<REPO>'
$Dev     = Join-Path $Root 'agent-index-marketplace-developer'
$Branch  = '<BRANCH>'
$MsgFile = Join-Path $Root '.commit-msg.txt'
$Paths   = @('<PATH1>','<PATH2>')               # explicit, never -A and never .

Write-Host "===== PR-SUBMIT BEGIN ====="

$cur = git -C $Dir rev-parse --abbrev-ref HEAD
Write-Host ("branch: " + $cur)
if ($cur -ne $Branch) { Write-Host "!! WRONG BRANCH — expected $Branch. STOPPING."; Write-Host "===== PR-SUBMIT END ====="; exit 1 }
if ($cur -eq 'main')  { Write-Host "!! ON MAIN — STOPPING."; Write-Host "===== PR-SUBMIT END ====="; exit 1 }

Write-Host ""; Write-Host "----- changes -----"
git -C $Dir --no-optional-locks status --short 2>&1 | Out-Host
git -C $Dir --no-optional-locks diff --stat 2>&1 | Out-Host

Write-Host ""; Write-Host "----- preflight (hard gate) -----"
bash "$Dev/lib/preflight-cli.sh" --collection "$Dir" 2>&1 | Out-Host
$pf = $LASTEXITCODE
Write-Host ("preflight exit: " + $pf)
if ($pf -ne 0) { Write-Host "!! PREFLIGHT FAILED — NOTHING COMMITTED. Paste this back to your agent."; Write-Host "===== PR-SUBMIT END ====="; exit 1 }

Write-Host ""; Write-Host "----- staging -----"
foreach ($p in $Paths) { git -C $Dir add -- $p 2>&1 | Out-Host }
git -C $Dir --no-optional-locks diff --cached --stat 2>&1 | Out-Host

git -C $Dir commit -F $MsgFile 2>&1 | Out-Host
git -C $Dir push -u origin $Branch 2>&1 | Out-Host

Write-Host ""
Write-Host "Open this link to create the pull request:"
Write-Host ("https://github.com/agent-index/<REPO>/compare/main...<HEAD_SPEC>?expand=1")
Write-Host "===== PR-SUBMIT END ====="
Write-Host "Copy everything between BEGIN and END and paste it back to your agent."
```

On the fork route `<HEAD_SPEC>` is `<your-user>:<branch>`; on the topic-branch route it is just `<branch>`.

The CLI covers only the **structural subset** of `@ai:preflight` — see *Before you open it* below. A clean CLI run is a floor, not a clearance.

### Phase 4 — Open the pull request (agent supplies text)

The script prints the compare link. The agent gives the contributor the **title** and the **complete body** to paste. The contributor should never have to compose PR text.

---

## Script conventions

Every generated script must:

- Print a `===== NAME BEGIN =====` / `===== NAME END =====` block and close by telling the contributor to paste it back. That block is how the agent learns what happened.
- Be safe to re-run. Fetch-or-clone, switch-or-create, clear stale zero-byte locks.
- Use explicit paths in `git add`. **Never `-A`, never `.`** — a wildcard stage is how unrelated files end up in a reviewed change.
- Show the change before making it: `status --short`, then `diff --stat`, then `diff --cached --stat`, all with `--no-optional-locks`.
- Abort loudly and commit nothing when a gate fails. Never continue past a failure "to be helpful".
- Be PowerShell on Windows, bash on macOS or Linux. Detect; do not assume.

Never put in a generated script: `git tag`, a push to `main`, `--force`, or any edit to a version field.

**Reference sequence.** This is what the scripts encode; it is here so the agent can generate correctly and the contributor can follow along, not as something to type by hand:

```
git switch main
git pull upstream main          # or `git pull` on the topic-branch route
git switch -c docs/<short-topic>

# agent edits the files

git --no-optional-locks diff    # read it before committing
git add <specific paths>        # name the paths; never `git add -A`
git commit
git push -u origin docs/<short-topic>
```

### Branch names

`docs/<topic>`, `fix/<topic>`, `chore/<topic>`, `feat/<topic>`. Short and specific: `docs/claude-md-id-anchors`, not `docs/updates`.

Most contributions here are documentation, which is why the first three cover nearly everything. Use `feat/` when the change adds behaviour rather than editing prose — a new preflight check, a new task step. The prefix is a hint to the reviewer about what kind of reading the diff needs, not a taxonomy worth arguing over.

---

## Scope

- **One concern per pull request.** There is no CI here — review is a human reading a diff, so the diff has to be holdable in one head.
- **No drive-by fixes.** Spotted an unrelated typo? Note it in the PR body or file it. Do not include it.
- **No reformatting, reflowing, or whitespace churn.** See `88d18e2` above.

### What is yours, and what is the maintainer's

Your pull request changes **content only**. The following are release actions and belong to the maintainer:

- Version bumps, including `collection.json`
- Tags
- Publishing to the backend and republishing `/shared/dist/`

If your change implies a version bump, say so explicitly in the PR body and let the maintainer set the number in the release commit. Do not set it yourself: a number chosen in a feature branch and a number chosen at release time drift apart, and the changelog ends up describing a version that was never issued.

**A document's own `Version:` field is a version bump. A version named in prose is content.** Correcting "Current version: 3.11.2" in a roadmap's body to the version that actually shipped is a factual fix and belongs in your pull request; incrementing the `Version:` header of the document you are editing is a release action and does not. When a change set asks for both, do the first, leave the second, and say so in the body.

**Never commit a placeholder where a date belongs.** Change sets written ahead of a release may specify `Last updated: {RELEASE_DATE}`, and a pull request cannot know a release date. Put the date you opened the pull request, and ask the maintainer in the body to move it to the real release date in the release commit. Committing the literal placeholder is worse, and leaving a date you know to be false defeats the fix.

### Before you open it

Run `@ai:preflight` if you have the developer collection installed. It is a hard gate at release time regardless — better it fails for you now than for the maintainer mid-release. The collection being installed for the org does not mean it is installed for you; check rather than assume, and report it if it does not resolve.

There is also a mechanical CLI covering the structural subset of those checks: `lib/preflight-cli.sh`, in the **`agent-index-marketplace-developer`** repo — not in this one, and not shipped with the installed collection either, which carries only `skill/` and `task/`. Using it means cloning that repo (it is public) and invoking it against the collection under test:

```
bash ../agent-index-marketplace-developer/lib/preflight-cli.sh --collection .
```

Exit codes: `0` pass, `1` errors, `2` invocation problem. Always name the repo when citing this file. An unqualified `lib/preflight-cli.sh` reads as a path in whichever repo the reader is standing in, and it does not exist in this one — which has already cost one contributor an hour.

**The two are not interchangeable, whatever `standards.md` currently says.** The CLI is a strict subset: it will exit 0 on a tree where the agent task reports errors, because the checks that need agent reasoning are not in it. Treat a clean CLI run as a floor.

---

## Writing the pull request

With no CI, the body is the only evidence a reviewer gets. Cover:

- **What** changes, in a sentence or two.
- **Why** — the finding, bug id, or decision it addresses.
- **Evidence** — what you verified and how. Say what you measured rather than what you believe.
- **What is deliberately not included** — the scope edges. This is often the most useful section, because it tells the reviewer what *not* to assume you fixed.
- **Open questions** — anything the maintainer must decide before merge.
- **Implied version bump**, if any.

### When a large diff is unavoidable

Some changes cannot be small — a character-encoding repair touches every affected line. In that case the diff is not reviewable and pretending otherwise wastes everyone's time. Instead:

1. State the transformation precisely — the exact substitutions, the exact count.
2. Provide a reproduction: applying those substitutions to the original file yields your file byte for byte.
3. Say plainly in the body: **review the proof, not the diff.**
4. Give an acceptance test the reviewer can run themselves.

**Make the proof executable, not narrated.** A described transformation still asks the reviewer to take your arithmetic on faith. A script they can run against a clean checkout — one that re-derives the result, writes nothing, and exits non-zero on any failed assertion — is a stronger check than reading the diff could ever be, because it is total: it proves nothing *else* changed. Post it as the first comment on the pull request.

A reviewer can verify a transformation in a minute. They cannot verify four hundred changed lines at all, and asking them to will produce either a rubber stamp or a bounce.

---

## Review feedback

Feedback is another turn of the same loop: the agent edits the files, then generates `pr-amend-<topic>.ps1` — same shape as submit, with `git commit -F` and a plain `git push` (the branch already tracks). Never a force push; never a rebase the contributor has to resolve.

---

## Protections in force

On `main`: a pull request is required, with one approval. Force pushes are blocked. Deletions are restricted.

On release tags (`v*`): creation, update and deletion are restricted.

Repository admins bypass both, so the maintainer's release script — which commits, pushes and tags directly — continues to work. That bypass is why the maintainer cannot test these protections themselves; a direct push always succeeds for them.

**A contributor without push access cannot test them either**, and this is worth stating plainly because it looks like a passing test. On the fork route a direct push to `main` is refused for lack of permission, before any ruleset is consulted. The refusal proves nothing about the protections. Only a contributor who *has* push access and is *not* an admin can confirm they hold. Until someone in that position has tried it, treat the rulesets as configured but unverified.

If you ever find a direct push to `main` succeeding for you, stop and report it immediately.

Published tags are never moved or deleted. They are the contract between a release and the distribution layer: the clone scripts and `/shared/dist/manifest.json` pin to exact tags. If a re-cut is genuinely needed, a new tag is issued.

---

## Merged is not shipped

Members read from the org's backend, not from GitHub. Nothing you merge reaches anyone until the maintainer cuts a release: version bump, tag, preflight, the generated push script, then the backend publish and the `/shared/dist/` republish.

So a merged pull request is **staged**, not live. Do not describe merged work as shipped, and expect a lag between the two.

---

## If this document is wrong

Say so — in the pull request that trips over it, or wherever the work is tracked. A contribution process that is wrong and unreported is worse than one that is wrong and known.

---

## Appendix: pointer file for other repos

Every other repo carries this as its `CONTRIBUTING.md`, and nothing more:

```markdown
# Contributing

Contribution guidelines for all Agent Index Inc repositories are maintained in one place:

**https://github.com/agent-index/agent-index-core/blob/main/CONTRIBUTING.md**

Please read that before opening a pull request here.
```
