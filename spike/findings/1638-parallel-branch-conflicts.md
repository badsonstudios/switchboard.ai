# #1638: how often parallel branches conflicted, read off real history

**Date:** 2026-11-22 · **Repo:** `badsonstudios/switchboard.ai`, merged PRs #9–#1642 · **Instead of:** a live "7-8 parallel branches" spike

## Question

`/orchestrate` has run 2-3 AI workers at once, each in its own worktree and
branch, each opening a PR that is squash-merged on green CI. `main` is strict
up-to-date, so every merge puts the other open PRs BEHIND. How often did
updating a branch from `main` conflict, in which files, what did resolving
take, and what does that say about an "Update from main" action on a worktree?

## Method

- **Replay (all history).** One paginated GraphQL query (`gh api graphql
  --paginate`) gave 875 merged PRs with merge commit `S`, its parent `P` and
  the parent `B0` of the PR's first commit. For the 717 `feature/` `docs/`
  `fix/` PRs that could be read, `git merge-tree --write-tree --merge-base=P B0 S`
  re-applies the PR's final change onto the base it was written on; a conflict
  there means updating from `main` would have conflicted. Blind spot: a branch
  that was **rebased** has `B0` = its last base, so it reads as "current".
- **Update traces.** Same query: commits named `Merge … main …` inside a PR
  (140 PRs) and `HeadRefForcePushedEvent`s (59 PRs, 72 events).
- **Run logs.** `PROGRESS.md` grepped for conflict / update-branch / rebase /
  force-with-lease / kept both / adjacent (83 "conflict" hits in 22,883 lines);
  per-PR rows of the eight runs 2026-10-18 → 10-27 counted by hand.
- **Rules.** `.claude/skills/orchestrate/SKILL.md` (train procedure) and two
  memory notes (adjacent docs rows; strict merge policy).
- Not done: no per-PR timeline loop, no PR-comment search; numbers below are
  from the bulk query plus the written logs.

## Findings

**1. Most PRs never needed an update; of those that did, about one in five
conflicted (replay), but in the rebase era it was most of them (logs).**

| Measure | Count |
|---|---|
| PRs analysed by replay | 717 |
| `main` had not moved since the branch's (last) base | 557 (78%) |
| `main` moved under the branch (median 2 commits, max 41) | 160 |
| … and the update would conflict | **30 (19% of 160)**; all `feature/`, 0 of 208 `docs/` |
| PRs carrying a merge-from-main commit / a force-push | 140 / 59 (lower bounds) |
| Oct 18-27, eight runs, 43 feature PRs: conflict-resolving rebases logged | **~28, every one docs** |

By era: PRs <#900 (August, trains and serial bumps) 29 of 123 moved conflicted;
#900-#1299 0 of 6; #1300+ the replay sees 1 of 31 but the logs see ~28, because
the runs had switched to rebase + `--force-with-lease`, which erases the
evidence the replay reads. Clean updates were common too: #1412's
update-branch "was clean"; #1528-#1583 carry merge-from-main commits and all
replay clean.

**2. Conflicting files, ranked (replay, 30 conflicted PRs; logs agree on the top two):**

| # | File | PRs | Kind |
|---|---|---|---|
| 1 | `CHANGELOG.md` | 12 (+ most of the ~28 logged) | append under `— unreleased` |
| 2 | `docs/plans/dogfood-testing.md` | 10 (+ most of the ~28) | append UNTESTED rows |
| 3 | `PROGRESS.md` | 8 | append run notes (gone since one writer owns it) |
| 4 | `docs/manual/06-keyboard.md` | 4 | adjacent sections |
| 5 | `SessionGrid.tsx`, `App.tsx`, `tokens.drift.test.ts` | 3 each | code |
| 6 | `ipc.test.ts`, `SessionsRail.tsx`, `session-store.test.ts`, `en.json` | 2 each | code / locale |

15 of the 30 were docs-only; 15 touched code or tests. **Every code conflict is
in August-or-earlier history** (#177-#728) or in a stacked train (E40), never in
the Oct-Nov two-worker runs.

**3. What resolving took.**

- **Docs rows (the normal case).** `gh pr update-branch` refuses ("Cannot update
  PR branch due to conflicts"); the orchestrator rebases in an idle worktree,
  checks `--diff-filter=U` lists only the docs files, keeps both blocks (HEAD
  first), runs the 60 changelog tests, `--force-with-lease`, and waits for a
  fresh CI run (~22 min Windows e2e). Example: run 2026-10-23/24, eight PRs,
  "eight docs hand-rebases … both kept every time"; #1441 alone needed three.
  The trap even here: bullets kept under the wrong `###` section twice (#491,
  #674), and one 2026-10-24 rebase left a duplicate section heading.
- **Code needing real thought.** Train 2026-08-20 (#641, 12 PRs): 10 tracker
  conflicts plus `EventsPanel` #556×#539 and `SessionGrid` #546×#494, where the
  resolution had to prove one prune predicate "equivalent-and-wider". Train
  2026-08-13 (#456): `ipc.test.ts` unions, a manual page-number collision, and
  #429×#452 moving the same notifier. E40 train #1322 (2026-10-16): stacked
  user-facing PRs collided in `index.ts`/`ipc.ts`, `contributions.ts`, `en.json`.
- **Clean is not safe.** #674 renamed the i18n catalog; #686's tests still
  imported the old path and git reported **no conflict**. Order and a grep,
  not the merge, caught it.
- **A conflicted PR gets no CI.** #437 sat checkless for hours: GitHub creates
  no `pull_request` run for a `CONFLICTING` PR, and three kicks chased an
  imagined Actions stall.
- **Cost of serial updating.** Run 6's serial bump chain burned ~17 CI runs /
  ~5 hours, which is why the skill now batches user-facing PRs into a train.

## What it means for "Update from main"

1. **Merge `main` into the worktree branch by default, not rebase.** The branch
   is usually pushed and often has a PR; a rebase rewrites it and forces a
   force-push, which the orchestrator only did by hand with `--force-with-lease`
   after checking the conflict set. A merge never rewrites, conflicts once
   (not per commit), and is what `gh pr update-branch` does. Offer rebase only
   for a branch with no upstream, as an explicit second choice.
2. **Expect docs, plan for code.** In this repo's steady state the conflicts
   are adjacent appends to changelogs and trackers; code conflicts appear when
   branches stack or a wide mechanical change lands. Never auto-resolve either:
   "keep both" put bullets in the wrong section twice here.
3. **On conflict, stop and leave the repo visibly mid-merge** (`MERGE_HEAD`,
   files in the Changes tab's merge group, which already sorts first), say
   which files, and offer: hand it to the worktree's AI session with the file
   list and both sides' intent, open the files, or abort (`git merge --abort`).
   This matches the Pull button's `--ff-only` rule (E24 #1052): no one-click
   action starts something with no surface to finish it.
4. **After a clean merge, say tests have not run.** #674 shows a clean merge
   can still break the build.
5. **Show "N behind main" before the user asks.** 22% of PRs had `main` move
   under them; the strict-up-to-date policy made that a merge blocker.

## Limits

- The replay is blind to rebased branches, so it undercounts Oct-Nov; the ~28
  figure for that era is hand-counted from run logs, not measured.
- Train members merged via a merge commit (two parents) were skipped (91 PRs);
  their conflicts are known only from the run logs.
- Replay asks "would the final change conflict", not "did the worker hit
  exactly this"; an intermediate update may have conflicted differently.
- This is one repo, 2-3 workers at once, with heavy shared docs. A user's
  repo without an append-only changelog will see fewer docs conflicts.
