# E24 — Git v2: design record

> **Status:** design, not yet filed as issues. Drawn 2026-10-02 at the owner's
> request: *"I want to get the Git implementation working much better… the
> History tab's not working… the changes tab works, but everything's kind of just
> smashed together."*
>
> **Mockup:** `mockups/git-v2.html` — open it in a browser; it has a theme
> toggle and nine screens, and every screen below names the one it corresponds to.
>
> **Parent:** `docs/plans/06-phase-3-ide.md` → **E24, the write half of git**
> (the phase's spine) and **E25**'s VCS-decorations half. DESIGN §5.7 is the
> feature source.

---

## 1. What is actually on screen today

Read off the code, not off the docs.

| Surface | State |
|---|---|
| `GitService` (`src/main/git/git-service.ts`, 918 lines) | `root()`, `status()`, `diff()`, `fileVersions()`. **That is the entire git API.** Hardened well: spawn budgets, `killTree`, `repo-config-guard`, a plumbing `diff` that never takes `index.lock`. |
| IPC (`src/preload/index.ts:1083`) | `git.status`, `git.fileVersions`. Two channels, both `git.read`. `diff()` is not exposed to the renderer at all — it exists for the bus tool. |
| Changes tab (`DiffPane.tsx`, 473 lines) | One flat 200px file list + a Monaco diff + a side-by-side/inline toggle. |
| History tab (`extensibility/panels.tsx:160`) | `enabled: () => false`, `render: () => null`. **A placeholder. There is no `git log` anywhere in the codebase.** |
| Files tab | `FileTree`, read-only, **no VCS decorations** (§5.7 names this as the remaining half). |

### 1.1 Two documents claim a feature that does not exist

Both of these say the log shipped:

- `docs/DESIGN.md` §5.7 as-built note (the 2026-09-25 audit): *"Shipped: …
  and the **History** tab's read-only log."*
- `docs/plans/06-phase-3-ide.md` E24: *"Everything shipped so far is git's READ
  half (status, diff, **log**)."*

Neither is true, and the second inherited the error from the first. The owner
found it by using the app. Worth recording as the same class of failure the audit
itself was created to catch — and the fix is two lines, in the same PR as the
first History work item.

### 1.2 Why "everything's smashed together" is the right diagnosis

Four concrete causes, in weight order:

1. **No resource groups.** Staged, unstaged, untracked and conflicted files are
   one undifferentiated list. The only differentiator is a three-letter word chip
   (`mod` / `staged` / `both` / `new`) in 9px mono.
2. **The path truncates the wrong end.** Rows render the full relative path with
   `text-overflow: ellipsis`, so in a 200px rail
   `src/renderer/src/components/FeedView.tsx` and `…FeedView.test.tsx` are the
   same string. The identifying part of a path is its tail, and the rail cuts the
   tail off.
3. **Nowhere to put a diff but inside the tab.** Card tabs are mutually
   exclusive, so reading a diff costs you sight of the conversation that produced
   it — and the pane then self-reports `tooNarrow` and silently drops to inline
   (`diff-layout.ts`), which is #532's whole story.
4. **The header says nothing.** `GitStatus` already carries `branch`, `ahead` and
   `behind`. **No consumer reads any of the three.**

---

## 2. Research

### 2.1 VS Code's Git extension — read on this machine

`C:\Users\dheinz\AppData\Local\Programs\Microsoft VS Code\df53daabb1\resources\app\extensions\git\`
(`package.json` 93 KB readable; `dist/main.js` 757 KB minified). This is a
*different* bundle from the Claude Code extension in
`docs/reference-implementations.md` §1 — and it has been **added there as §4**,
because it is the same kind of asset: a known-correct implementation of contracts
we are about to guess at, for the *other* CLI we shell out to.

**183 commands. 46 per-file menu entries, 19 per-group, 9 per-commit.** The
information architecture, not the code, is what is worth taking:

| VS Code concept | Contribution point | What we take |
|---|---|---|
| Resource groups | `scmResourceGroup` ∈ `merge` / `index` / `workingTree` / `untracked` | **The single biggest fix.** Four collapsible sections, each with its own count and its own group actions. Screen 1. |
| Row label + description | basename as label, directory dimmed after it | Reverses which end truncates. Screen 1. |
| Hover-only inline actions | `inline@1` open, `inline@2` stage/discard | Row stays readable at rest; stats and actions share one slot. Screen 1. |
| Group actions | `stageAll` / `cleanAll` / `unstageAll` / `viewChanges` | Three buttons per group header. Screen 1. |
| Multi-file diff editor | `git.viewChanges`, `multiDiffEditor/resource/title` | **We have no equivalent.** All changes in one scroll, per-file sticky header + stage button. Screen 5. |
| Gutter hunk staging | `diffEditor/gutter/hunk` → `git.diff.stageHunk` | Screen 8. |
| Selection staging | `diffEditor/gutter/selection` → `git.diff.stageSelection` | Screen 8. |
| History item model | `provideHistoryItems` | `{id, parentIds, subject, message, author, authorEmail, displayId, timestamp, statistics{files,insertions,deletions}, references[]}` — exactly what a lane renderer needs. Screen 6. |
| Incoming / outgoing | `scm/history/title`, `scmCurrentHistoryItemRefHasRemote` | Expandable rows with Pull/Push on them. Screen 6. |
| Expand-a-commit-in-place | `provideHistoryItemChanges(id, parentId)` | Screen 7. |
| Timeline | `timeline/item/context` | ⏱ per-file history as a row action. Screen 7. |
| Artifacts view | `scm/artifact/context` (26 entries: branches, tags, stashes, **worktrees**) | Not in v2's scope, but it is where worktree flows will want to live. |

**The one contract to copy verbatim**, from `dist/main.js`:

```
git log --format=%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B -z \
        --shortstat --diff-merges=first-parent
```

`-z` NUL-frames the records. That is not a nicety: a commit body may contain
newlines — *this repo's bodies are nothing but newlines* — so records cannot be
split on one. `--shortstat` trails **after** the NUL. VS Code's own record regex
is `/([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)(?:\n((?:.*)files? changed(?:.*))$)?/gm`
and `--decorate=full --topo-order --stdin` (refnames on stdin) is how it draws
more than one branch in one graph.

Two edge cases it handles that are easy to get wrong, with silent failure modes:

- **Root commits** diff against the empty tree
  (`hash-object -t tree /dev/null` → `4b825dc642cb6eb9a060e54bf8d69288fbee4904`).
  Get it wrong and the first commit shows an empty diff with no explanation.
- **Commit messages go in on stdin** (`commit --file=-`), never `-m`. A
  multi-line body with quotes in it is a Windows quoting bug waiting to happen.

### 2.2 Libraries — and the decision not to take one

| Candidate | Verdict |
|---|---|
| `simple-git` (11.1M wk) | **No.** A thin wrapper over the same binary we already spawn, which would replace a wrapper that does budget-kill, tree-kill and config-guard with one that does none of them. |
| `isomorphic-git` (1.1M wk) | **No.** Buys browser portability we will never use; slower and less complete on large repos. |
| `nodegit` (40K wk) | **No.** Native libgit2 bindings with documented Electron memory leaks. |
| `dugite` (GitHub Desktop's pinned binary) | **No.** Violates subscription-first/local-first in spirit — we already require `claude` and `git` on PATH. |
| `diff2html` / `react-diff-view` / `@git-diff-view` | **No.** All render a unified diff to HTML. We already have **Monaco** — the component VS Code itself uses — in the entry chunk, with word-level diff, synchronised scroll, a real find (§5.31) and the folding the multi-file view needs. |
| Graph lanes (`dagre`, `d3-dag`) | **No.** General DAG layout is the wrong shape. A git lane allocator is a topological walk with a lane-reservation scheme — ~200 lines of pure function + SVG, testable, no dependency. (The same conclusion GitLane and gowit reached independently in 2026.) |

**So: keep shelling out to system `git` through the existing `GitService`.** Steal
command *shapes* from VS Code, not a dependency. This is also what DESIGN §5.7
already specifies and what the host-don't-reimplement constraint requires.

### 2.3 What the rest of the field does that we should note

- **VS Code 1.93+** folded the commit graph into the Source Control view, so Git
  Graph as a separate extension is no longer the default answer.
- **GitLens 18.0 (May 2026)** redesigned the graph around *inspection* — commit
  details, comparisons and working-change management pulled into the graph
  itself rather than into side panels. 18.2 added **a per-worktree pill for
  worktrees with uncommitted changes or unpushed commits.** For an orchestrator
  running three worktrees that is the single most useful thing a graph can say,
  and it is screen 6's `⑂ sb-wt-2` chip.

---

## 3. The structural decision

**A diff becomes a dock panel, not a tab body.**

This is the change that unlocks the owner's pop-out request and fixes cause 3 at
the same time, and it costs almost nothing because the pattern is already proved:

- `lib/document-panels.ts` mints `doc-<n>` panels in the document area, with an
  open/focus registry keyed on a normalised path.
- Those panels are dockview panels, so **dockview's popout group already gives
  them their own OS window** — `popout-bounds.ts`, `popout-geometry.ts`,
  `app:popoutGeometryChanged` and the window-state persistence are all built and
  shipped.
- `closableDocuments()` already encodes "popped-out ones are spared by bulk
  close", with the reasoning written down.

So v2 adds a diff panel family that mirrors all of it:

```
openDiff({ folder, path, left, right, sessionId })  →  gitdiff-<n>
```

> **⚠️ AMENDED AS BUILT (item 5, 2026-10-02): THE PREFIX IS `gitdiff-`, NOT
> `diff-`, AND THIS PARAGRAPH SAID `diff-` BECAUSE THE DESIGN PASS DID NOT KNOW
> THE NAME WAS TAKEN.** `SessionGrid`'s existing `openDiff` controller verb already
> mints `diff-<cardId>` — #504's "the whole Changes tab, relocated into the
> document area" — and **three** things read that prefix, all of which would have
> been confused: `documentHomeGroup` excludes groups containing `/^(session|diff)-/`
> from being the document area (so the new panels would have been barred from the
> area they open into), the colour-scheme heal loop matches it, and a
> "is the active panel a diff?" question would have claimed an open Changes tab.
>
> A fourth, found only in review: **`isDerivedPanelId` is `/^(diff|doc)-/` and is
> ANCHORED**, so a `gitdiff-` panel was not "derived" and therefore survived a
> relaunch it was never meant to survive — after which the registry's `seq`
> restarted at 0, `addPanel` threw on an id dockview already had, and the first ⧉
> after every restart silently did nothing.
>
> This amendment exists because §1.1 of this very document is about two files
> claiming a feature that did not exist. A design record that still named the wrong
> prefix would hand items 9 and 10 the same mistake.
>
> **Also as built:** the component is `GitDiffView`, not `DiffPanel` — `SessionGrid`
> already has a local `DiffPanel` (the `diff-<cardId>` wrapper), and two things of
> that name is how a reader edits the wrong file.
>
> **And one promise is only half kept.** "The find-surface publication (§5.31)…
> moves into the panel body intact" is true of the Changes tab and only half true
> of the panel: `MonacoDiff` publishes a surface under the panel's own slot, and
> nothing reads it, because `Ctrl+F`'s route runs through `activeCardId` /
> `activeDocumentId` and both know only `session-` and `doc-` panels. Find in a
> popped-out diff is therefore inert. Filed as a follow-up rather than bolted on:
> the publication and the slot separation are the halves that must not be added
> later, and they are in.

keyed on `folder + path + left..right`, so asking twice focuses the panel you
already have. Three shapes of diff panel, one family:

1. **one file, working tree vs index/HEAD** (screens 3, 4)
2. **all changes, stacked** (screen 5) — `left..right` is a range, `path` absent
3. **one file at a commit**, `sha^..sha` (screen 7)

Popping out is then dockview's native "Move to New Window" plus one explicit ⧉
button on the diff toolbar for discoverability, and ⇤ to send it home. The
Changes tab **keeps** an in-place preview (◫) — ⧉ is the escalation, not the only
route.

**What this does not change:** `DiffPane`'s Monaco wiring, the find-surface
publication (§5.31), `diff-places` scroll memory, the theme handling or the
narrow-pane verdict. All of it moves into the panel body intact.

---

## 4. Work breakdown

Sized against the code. Items marked **[W]** need the new `git.write` capability;
everything else is `git.read`.

### Layer 1 — the read half, finished (no new capability)

| # | Item | Notes |
|---|---|---|
| 1 | **`git log` in `GitService`** + `git:log` IPC | The format above, NUL-framed, `--shortstat`. A parser with its own unit tests over fixture bytes, including: body with blank lines, merge commit (2 parents), root commit, `%D` empty, CRLF. Carries the DESIGN §5.7 / E24 doc correction (§1.1). |
| 2 | **History tab** — rows, refs chips, search, incoming/outgoing | Screen 6 minus lanes. Flip `enabled` to `!!ctx.folder`. |
| 3 | **Commit graph lanes** — pure `commits[] → {lane, edges[]}` allocator + SVG | Screen 6. Pure function, tested at width (≥5 lanes), not just lane 1. |
| 4 | **Commit detail + file list, expand in place** | Screen 7. `diff --numstat --name-status -z <parent> <sha>`, empty-tree fallback. |
| 5 | **`diff-` panel family** + ⧉ pop out + ⇤ return | Screens 3, 4. The structural item; everything visual above can land before it, nothing after it can. |
| 6 | **Changes tab → source-control sidebar** | Screen 1: resource groups, name-first rows, status letters, hover actions, filter box, branch/ahead-behind header, totals bar. `rev-list --left-right --count @{u}...HEAD` populates the two fields nothing currently fills. |
| 7 | **Per-file `+/−`** | `diff --numstat` + `diff --cached --numstat`, merged per path. Binary reports `-`. |
| 8 | **Tree mode** with compressed single-child folders | Screen 2. `FileTree`'s model may be reusable — check before writing a second one. |
| 9 | **All-changes multi-file panel** | Screen 5, with the ~400-line collapse budget. |
| 10 | **File history (⏱)** | `log --follow -- <path>`. Opens as a `diff-` panel per commit. |
| 11 | **VCS decorations on the Files tab** | E25's remaining half, and it must read the **same** status source as screen 1 or the two tabs will disagree. |

### Layer 2 — the write half **[W]**

| # | Item | Notes |
|---|---|---|
| 12 | **`git.write` capability** + stage / unstage / discard per file and per group | Discard is destructive: confirm, naming the file count. |
| 13 | **Commit box** — one commit path, not two | E24's own rule. `commit --file=-`. Amend / sign-off / no-verify behind ⋯, never a second primary button. |
| 14 | **Hunk + selection staging** | Screen 8. `apply --cached --unidiff-zero -` over a synthesised one-hunk patch on stdin. Never touches the worktree. A refusal leaves the index untouched and quotes git. |
| 15 | **Branch / sync surface** | Pull, push, fetch, checkout, create branch from the graph. |

### Layer 3 — the orchestrator's git (E24 proper)

Unchanged from the plan file, and **still gated on the OQ #9 spike**: worktree
create/merge-back with a review step, one-click squash-merge + update-from-main,
cross-session same-repo conflict warnings (screen 2's ribbon), port/resource
conflict Feed warnings.

### Suggested order

Layer 1 items **1 → 2 → 3** first: they are the dead tab, they are
self-contained, and they need no new capability or write path. Then **5** (the
panel family), because it is the structural item the pop-out ask depends on and
nothing else blocks it. Then **6 → 7** together — regrouping the sidebar without
per-file stats leaves an empty slot in every row. **8, 9, 10, 11** interleave.
Layer 2 after the owner's decision in §6. Layer 3 stays behind the spike.

---

## 5. Litmus check (PHILOSOPHY §4)

- **Does it host rather than reimplement?** Yes — every operation is the real
  `git` binary, and the diff body is the editor VS Code itself uses. The only
  thing we draw ourselves is the lane geometry, which no CLI offers.
- **Would a new user guess it?** Screens 1 and 6 are the shapes every git GUI
  uses. The ⧉ is the same affordance the document viewer already has.
- **Does it fail open?** Every read degrades to "we could not find out" with
  git's own reason (the `unreadable` discipline `status()` already has). Every
  write either happens completely or not at all.
- **Does it earn its surface?** The History tab already exists in the strip and is
  dead; this makes it honest. The Changes tab is not a new surface, it is the
  same one legible.

---

## 6. Decisions

**Settled by the owner 2026-10-02, at the end of the research pass:**

1. **Scope: layers 1 and 2 together.** ~15 work items. The reasoning that
   decided it is worth keeping, because it governs every row in screen 1: *a row
   with a `＋` that does nothing is worse than a row with no `＋`.* The sidebar's
   hover actions are drawn, so they must work. Layer 3 still waits on the OQ #9
   spike.
2. **Editable diff: not built, decided later.** §5.7 keeps listing it as
   table-stakes and it stays listed and unbuilt, with the reason recorded here:
   hunk + selection staging (item 14) covers most of what it is for, and an
   editable working-tree pane means owning the case where a live agent writes the
   same file mid-edit — file-watch reconciliation, a dirty indicator, and a
   both-sides-changed policy. Real complexity for a narrow win, and it is a
   decision that should be taken on its own evidence rather than inside a
   fifteen-item epic.

### Still open

3. **Does the graph go in the card, or does it also get a dock panel?** A graph
   wants width. Drawn in the card for v2; a `diff-`-style `graph-` panel is a
   one-line follow-up if it feels cramped.
4. **Phase/epic placement.** Layer 1 is arguably E25's half (read surfaces) and
   layer 2/3 is E24. Filing them as one epic keeps the sidebar's actions from
   being designed twice.
