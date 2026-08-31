# Contributing to agent-index

This is the canonical contribution guide for all Agent Index Inc source repositories. Other repos carry a short pointer to this file rather than their own copy, so there is one place to change.

It assumes you are an Agent Index Inc contributor. It does not assume your access is uniform across the repos, or that a team-level grant has reached the repo you are trying to change — see **Setup**. It is not for customer orgs: nothing here describes how to use agent-index, only how to change its source.

---

## The one rule that is different here

**Git commands that write run in your own terminal. Never in the agent.**

`standards.md` § Release procedure states it directly:

> The agent never pushes or tags. `git push`/`git tag` run natively on the admin's host, where credentials and a clean working tree are. Agent-side git over a synced/mounted filesystem produces torn commits.

and

> Agent-side git is read-only via `git show`. Never `git checkout`/`git switch`/`git stash`/`git add` from the sandbox: those take the index lock and write torn files back through the mount, and can collide with the user's native git session.

So:

| Who | Does what |
|---|---|
| **The agent** | Writes and edits file contents. Read-only git: `log`, `show`, `diff`, `status`. |
| **You, natively** | Anything that writes the index or refs: `switch`, `branch`, `add`, `commit`, `push`. And opening the pull request. |

This is the same boundary the `release` and `clone-script-generator` tasks already use: the agent gets the content exactly right, the human with credentials and a clean tree runs the commands. Do not work around it. A torn commit costs far more than the minutes it saves.

---

## Setup

**Check what access you actually have before planning a branch.** Repo visibility and push rights are two separate questions, and neither follows from being in the GitHub org.

- `agent-index-core` and `agent-index-marketplace-developer` are **public** — cloning them needs no grant at all.
- `agent-index-meta-docs` is **private**, and readable through org membership.
- Org membership is read-level. It does not carry push access.

**Two working routes. Establish which one is yours first.**

*Fork route (assume this unless you have confirmed otherwise).* If GitHub shows you no Settings tab and no "New branch" control on the repo, and refuses the web edit route with "you're not able to edit this repository directly — you need to fork it and propose your changes from there instead", you do not have push access. Fork, clone your fork, and add the canonical repo as `upstream`:

```
git clone https://github.com/<your-user>/agent-index-core.git
cd agent-index-core
git remote add upstream https://github.com/agent-index/agent-index-core.git
git fetch upstream
```

Your branches push to `origin` (your fork); pull requests are opened against `agent-index:main`.

*Topic-branch route.* If you do have push access to the canonical repo, clone it directly and push topic branches to it. Everything below works the same; substitute `origin` for `upstream` when syncing.

Do not assume the topic-branch route because a team grant exists on paper. A team-level Write grant has been observed not to reach the repo — the fork route was the one that worked. If you find your access differs from what you were told, report it where the work is tracked rather than absorbing it.

**Clone somewhere separate from your agent-index install.** Use a distinct working folder — a `dev_source` beside your `dev_install`, for example. The install tree is managed by `apply-updates`; mixing a contribution clone into it creates real confusion about which copy is authoritative. Then connect that folder to Cowork so the agent can read and write files in it.

**Leave line-ending settings alone.** Every repo commits a `.gitattributes` (`* text=auto eol=lf`) precisely so that a checkout is byte-identical on every platform. Do not set `core.autocrlf`, and never include a line-ending normalisation in a content commit.

That second point is not hypothetical. Commit `88d18e2` in `agent-index-meta-docs` normalised line endings across five files and changed **zero** content lines. Because git then reported all five as modified that day, every one of them looked newer than the live rulebook, and readers were pointed at documents two quarters out of date. A single whitespace commit caused a documentation failure that took an audit to unpick.

**Check your fresh clone is clean.** `git status` should report nothing modified. If it reports the whole tree as changed, stop — that is the line-endings condition above, and every diff you produce will be wrong.

---

## Making a change

```
git switch main
git pull upstream main          # or `git pull` on the topic-branch route
git switch -c docs/<short-topic>

# agent edits the files

git diff                        # read it yourself before committing
git add <specific paths>        # name the paths; never `git add -A`
git commit
git push -u origin docs/<short-topic>
```

Then open a pull request against `agent-index:main`.

### Branch names

`docs/<topic>`, `fix/<topic>`, `chore/<topic>`. Short and specific: `docs/claude-md-id-anchors`, not `docs/updates`.

### Scope

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

A reviewer can verify a transformation in a minute. They cannot verify four hundred changed lines at all, and asking them to will produce either a rubber stamp or a bounce.

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

It is new, and it was written before anyone had followed it. Say so — in the pull request that trips over it, or wherever the work is tracked. A contribution process that is wrong and unreported is worse than one that is wrong and known.

---

## Appendix: pointer file for other repos

Every other repo carries this as its `CONTRIBUTING.md`, and nothing more:

```markdown
# Contributing

Contribution guidelines for all Agent Index Inc repositories are maintained in one place:

**https://github.com/agent-index/agent-index-core/blob/main/CONTRIBUTING.md**

Please read that before opening a pull request here.
```
