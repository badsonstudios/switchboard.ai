# #776 — what a repository can make us run, and what actually stops it

**Probes:** `spike/probes/776/probe-filter-mitigations.mjs` (round 1),
`probe-round2.mjs` (round 2's two blockers), `probe-round3.mjs` (round 3's).
**Measured on:** git 2.51.0.windows.2, win32, 2026-09-12.
**Predecessor:** `spike/probes/772/probe-config-exec.mjs`, which found the hole.

> **Three rounds, and each one found the previous round's hole living inside
> the previous round's remedy.** Round 1's fallback was bypassable. Round 2's
> submodule enumeration — added to close round 1's submodule gap — was
> bypassable twice over. That pattern is the most useful thing in this note.

`GitService` runs `git` against session folders — the Changes pane's `status`
whenever a card is shown or a turn ends, and since #764 the bus's diff against a
folder **another agent controls**. #764 closed `diff.external` with
`--no-ext-diff`; #772's probe found the same class still open through
`core.fsmonitor` and clean filters.

**Round 1 answered the questions #772 left and got the shape of the fix wrong.**
The review's round 2 found that the fallback it chose was bypassable and that a
whole vector needing no config file at all had been missed. Both are recorded
here because the wrong answer is the more useful half of the note.

## A. What executes during our reads

| vector | `rev-parse` | `diff-index` (bus) | `status` (pane) | `show HEAD:<p>` (Monaco) |
|---|---|---|---|---|
| `core.fsmonitor` | did **not** run | **RAN** | **RAN** | — |
| clean filter | — | **RAN** | **RAN** | did **not** run |
| `filter.<n>.process` | — | **RAN** | **RAN** | — |
| a filter via `.git/info/attributes` | — | **RAN** | **RAN** | — |
| a filter via `core.attributesFile` | — | **RAN** | **RAN** | — |
| **`.git/hooks/post-index-change`** | — | did **not** run | **RAN** | — |
| **a SUBMODULE's own config** | — | **RAN** | **RAN** | — |
| smudge filter | — | — | — | did **not** run |

Five things #772 did not know:

- **`filter.<n>.process` is a live vector** — and it is the variant
  `git lfs install` actually configures, so it is the one a real repository is
  most likely to have and an attacker most likely to copy.
- **A hook needs no config file at all.** `status` refreshes the index for a
  stat-dirty file, writes it, and fires `post-index-change`. That is a single
  written file — no `.git/config` edit, no `.gitattributes` — and on Windows
  not even an execute bit. `diff-index` does not refresh, so it is `status`
  only. Of the four hooks tried, only `post-index-change` fired.
- **A submodule's own config counts.** Reading a superproject recurses into each
  initialised submodule and runs drivers from `.git/modules/<name>/config` — a
  plain file, writable in any repository that *already* has a submodule, with no
  `git submodule add` needed. Its hooks fire too.
- **`fileVersions` is clear, re-measured against all three driver kinds.**
  `git show HEAD:<path>` ran neither a clean, a smudge nor a `process` filter,
  and did not run `core.fsmonitor` either — so the Monaco diff pane was never a
  way in, and it is the one read that carries no config guard. `rev-parse` is
  clear too.
- **The attribute can come from three places**, not one — see B1.

All the filter vectors need a file that is **stat-dirty and content-clean** —
mtime moved, bytes unchanged, which is what a formatter or an editor leaves
behind. With different *content* git compares sizes and never hashes, so the
filter never runs; that is the trap in writing a test for this.

> **A local-config trap for anyone re-running these probes on this machine.**
> The dev box has a **global `core.hooksPath`**, which sends git looking
> somewhere else entirely and makes `.git/hooks/post-index-change` appear not to
> fire. The probes run hermetically (`GIT_CONFIG_GLOBAL` at an empty file,
> `GIT_CONFIG_NOSYSTEM=1`) and see it; a casual `git status` at a prompt does
> not. The test suite pins `core.hooksPath` in the repo it builds for the same
> reason — otherwise the control could not fail.

## B. Off switches

| candidate | stops | survives `required = true` |
|---|---|---|
| `-c core.fsmonitor=false` | fsmonitor, incl. in submodules | n/a |
| `GIT_CONFIG_KEY_<n>` / `VALUE_<n>` | any named driver, incl. in submodules | no — git fails |
| `-c filter.<n>.clean=` | the same, when the name has no `=` | no — git fails |
| `GIT_OPTIONAL_LOCKS=0` | `post-index-change`, incl. in submodules | n/a |
| `-c core.hooksPath=<absolute empty dir>` | the same | n/a |
| `--attr-source=<empty tree>` | **only the working-tree `.gitattributes`** | yes |
| `--ignore-submodules=all` | the submodule vectors | n/a |

### B1. `--attr-source` is not a blanket switch, and round 1 shipped it as one

```
--attr-source vs .gitattributes (in the working tree)   suppressed
--attr-source vs .git/info/attributes                   *** RAN — NOT SUPPRESSED ***
--attr-source vs core.attributesFile -> a file in repo  *** RAN — NOT SUPPRESSED ***
THE SHIPPED FALLBACK, end to end                        *** BYPASSED ***
```

It replaces only the *worktree/index* source of `.gitattributes`;
`.git/info/attributes` and `core.attributesFile` are read independently, and
both are files an edit-only agent can write. Round 1 used it as the all-or-
nothing escape hatch for a driver name it could not quote — and that branch
*discarded* the precise overrides it had already built, so **one unquotable name
turned the whole guard off**. Bypassed on the first try.

The lesson is the general one: a fallback nobody has tried to defeat is a
guess wearing a docstring. `EMPTY_TREE`'s comment now says what it is not.

### B2. The environment beats the command line

`-c key=value` parses on the **first `=`**, and a git subsection name may
contain one. Given `[filter "x.clean=touch pwned"]` the key is
`filter.x.clean=touch pwned.clean`, and `-c <key>=` sets **`filter.x.clean`** to
`touch pwned.clean=` — the mitigation becoming the exploit.

`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` (git ≥ 2.31)
carry the halves in separate variables, so **every key is expressible**, at the
same highest precedence, and propagating into submodules exactly as `-c` does
(all measured). That removes the reason the unquotable-name fallback existed,
which removes the fallback, which removes the bypass.

## C. What switching it off costs

The LFS shape — index holds a short pointer, working tree holds the real
content, the clean filter is the only reason they agree:

```
LFS-shaped repo, filter on                clean (right)
LFS-shaped repo, filter neutralised       MODIFIED (wrong)
LFS-shaped repo, --attr-source=<empty>    MODIFIED (wrong)
required=true, filter neutralised         git FAILED  (fatal: clean filter 'fake' failed)
plain repo, status ± core.fsmonitor=false byte-identical
plain repo, status ± GIT_OPTIONAL_LOCKS=0 byte-identical
```

**So the halves get different answers.** `core.fsmonitor` and
`GIT_OPTIONAL_LOCKS` are free — output byte-identical. Clean filters carry
*meaning*: turning them off changes what "modified" is, and a blanket switch
would hand a language model a diff claiming every binary in the repository had
changed. That is the confident wrong answer this query path exists to avoid, so
a blanket switch cannot be the default.

`--ignore-submodules=all` was rejected for the same reason: measured, a dirty
submodule went from one changed entry to zero. Hiding somebody's changes is
worse than reading their config slowly.

## D. Telling a repo-authored driver from a real one

`git config --list --show-scope -z`:

```
scopes seen (global lfs + local evil)   global:filter.lfs.clean | global:filter.lfs.required | local:filter.evil.clean
after include.path -> .git/extra.cfg    ... | local:filter.evil.clean | local:filter.sneaky.clean
after --worktree filter.wt.clean        ... | worktree:filter.wt.clean
shadowed driver, restored global value  local cmd blocked, status clean (right)
```

- **Scope is a usable discriminator.** `git lfs install` writes **global**; an
  agent that can only write inside its session folder reaches **local**,
  **worktree**, or a submodule's config.
- **`include.path` does not escape it** — a local config including
  `.git/extra.cfg` reports the included keys as `local` too. Asking git beats
  parsing `.git/config` ourselves, which would have missed this.
- **Shadowing is repairable**: when a repo redefines a global driver, forcing
  the global *value* blocks the local command and keeps the status correct.
- The trusted side is the **allow-list**, so `command`, `submodule`, `unknown`
  and anything a later git invents guard rather than pass.

## E. Round 3 — how the submodule enumeration was walked around, twice

Round 2 closed the submodule gap by finding each submodule's git directory
itself and reading the config file. Both halves of that were wrong.

```
enumeration sees the driver, as shipped     *** NO — HIDDEN ***
enumeration sees it with --includes         yes
CONTROL: unguarded status runs it?          RAN
guarded status with the driver hidden       *** RAN — BYPASS ***
guarded diff-index (the bus path)           *** RAN — BYPASS ***
```

**`git config --file X --list` defaults to `--no-includes`.** git's documented
behaviour is that includes are followed when searching all files and *not* when
one file is named. So two lines in `.git/modules/<name>/config` —
`[include] path = hidden.cfg` — hide the driver from the enumeration while git
expands it during the read. `--includes` fixes it, and is now on every
config read we make.

```
CONTROL: unguarded status runs it?          RAN
.git/modules still holds anything?          (empty)
guarded status, redirected gitdir           *** RAN — BYPASS ***
gitlinks from the index                     sub
  git -C sub config sees filter.z?          YES
```

**`sub/.git` is a plain text file, and an edit-only agent can repoint it.** Move
the submodule's git directory into an ordinary working-tree folder and an
enumeration that opens `<gitdir>/modules/<name>` by name finds an empty
directory. The lesson is the one the earlier `.gitmodules` gate should already
have taught: **ask git where the submodule is, do not work it out.** The index
says what a gitlink is (`ls-files --stage`, mode `160000`) and `git -C <path>
config` then resolves whatever `.git` file, `core.worktree` or nesting git
itself would use. That deleted the directory walk, the two-roots special case
for linked worktrees, the symlink check and the `.gitmodules` gate in one move —
and it returns real *scopes*, so a globally-installed driver inside a submodule
stays trusted instead of being neutralised.

**A probe that reported "held" for the wrong reason.** The first run of
`probe-round3.mjs` said both bypasses were blocked. They were not: it wrote
config values containing `"` with `fs.appendFileSync`, and git's config parser
strips those quotes, so the command it built could never run. **The control
caught it** — "CONTROL: unguarded status runs it? *** did not run — probe is
inert ***". Every trial in these probes now has one.

### Two more from round 3

- **`GIT_CONFIG_KEY_<n>` is git ≥ 2.31**, and the fallback branch above exists
  because Ubuntu 20.04 ships 2.25.1 (Debian 11: 2.30.2). Those gits ignore the
  variables entirely and run the driver, silently. The capability is now asked
  of git **behaviourally** — set a probe key in the environment, ask git to read
  it back — rather than by parsing `--version`, and a `no` refuses the read.
  It is only asked when there is something to guard, so nearly nobody pays.
- **`-c` beats `GIT_CONFIG_KEY_<n>`** (measured), and `GIT_CONFIG_PARAMETERS` is
  how a parent git passes its `-c` down. Nothing a repository controls can set
  it, so this was not a live hole, but "the highest precedence git has" has to
  be true for the guard to mean anything: that variable is now dropped from the
  environment we hand git.

## What shipped

1. On **every** invocation: `-c core.fsmonitor=false`,
   `-c core.hooksPath=<an empty directory we create>`, and
   `GIT_OPTIONAL_LOCKS=0` in the environment.
2. On `status` and `diff-index`: `GIT_CONFIG_KEY_<n>`/`VALUE_<n>` neutralising
   every `filter.<n>.{clean,smudge,process}` defined outside `global`/`system`,
   restored to the trusted value where there is one. Names come from this
   repository's config and, recursively, from **every populated submodule's**,
   found through the index rather than guessed at.
3. **A config we could not read, or a git that ignores the overrides, means we
   do not run the read.** There is no partial guard to fall back to (B1), so
   "we could not find out" refuses: `diff` throws with a reason, `status`
   reports no repository.

`--show-scope` is git ≥ 2.26, so an unreadable scoped listing first retries the
repo-writable scopes by name with options that have existed for ever.

### Costs, measured

Each git invocation is ~12–14 ms. A repository with no submodules adds two to
`status` (`config --list`, `ls-files --stage`) and none of the rest, because the
capability probe only runs when a repo-authored driver was actually found.
Each populated submodule adds one more. `status` runs on card-show and on
turn-end, not on a timer, so there is no cache.

**The budget bounds the guard, not the status.** `status` itself stays
unbounded, as it always was: a genuinely enormous repository, or a cold network
drive, can legitimately take a long time, and killing it would report *"Not a
git repository"* for a repository that is merely slow. The bus's `diff` makes
the opposite trade on purpose, and says so.

## Residual, and the boundary this does not move

The threat model is #764's: an agent allowed to **edit files** but not to **run
commands**. It is same-user and local — nothing here is an OS privilege
boundary, and an agent that can already run commands gains nothing from any of
this. What it protects is switchboard's own boundary: one session's folder is
not another session's execution context.

Known residuals, none of which this closes:

- **It is TOCTOU by construction.** We read the config, then run git. An agent
  writing in a loop can add a driver in the window between the two. Nothing
  short of a single-invocation blanket switch closes that, and B1 is why there
  is no sound blanket switch to reach for.
- **A `filter` attribute has at least three sources** — the working tree's
  `.gitattributes`, `.git/info/attributes`, and `core.attributesFile` — which is
  why the guard neutralises the *driver* and never tries to suppress the
  attribute. If a fourth is ever added, the driver is still the choke point.
- **An old-style embedded submodule** (`sub/.git` a real directory rather than a
  file) is handled by the same `git -C` question, but was not reachable to
  measure: modern git will not create one.
- **The scope discriminator assumes the global config is out of reach.** An
  agent whose edit permission is not scoped to its project folder can write
  `~/.gitconfig` and define a "trusted" driver.
- **`core.worktree` in local scope** points `status`/`diff` at an arbitrary
  directory. Not execution, but it lets a repository make the bus attribute
  another folder's changes to this session.
- **The one legitimate configuration this breaks** is `git lfs install --local`
  on a machine with no global LFS: the driver is repo-authored, has no trusted
  value to restore, and is `required`, so git refuses the read. Pinned by a
  test; `git lfs install` without `--local` is the fix.
- **A failed `status` still reports "Not a git repository"**, which is a lie for
  every failure and not only this one. Pre-existing, filed separately.
