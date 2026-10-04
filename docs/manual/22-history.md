<p align="right"><a href="contents.md">☰ Contents</a></p>

# History

> Status: draft — the tab works and this page describes what it does. The
> Pull/Push buttons on the incoming and outgoing rows are still to come.
>
> TODO: screenshots · right-click operations on a commit.

## What it is

Every session's card has a **History** tab beside **Changes** and **Files**. It
shows the commits in that session's project: what each one was called, who made
it, when, how many lines it touched, and which branches and tags point at it.

Before this it was there but greyed out, with nothing behind it.

## The top line

| What you see | What it means |
|---|---|
| **⑂ main** | the branch this project currently has checked out |
| **Detached HEAD** | you are not on a branch at all — see below, this one matters |
| The search box | filters the commits already on screen |
| **50 commits** | how many are loaded; with a filter on it reads **3 of 50** |

**"Detached HEAD" is worth stopping for.** It means the project is sitting on a
specific commit rather than on a branch — usually because something checked out
a commit, a tag, or a half-finished rebase. Commits made in that state belong to
no branch, so they are easy to lose. switchboard says so plainly rather than
leaving you to notice that the branch name is missing.

## The graph down the left

Each row has a coloured dot, and lines joining the dots. That is the shape of your
project's history:

- **A straight vertical line** is one line of work carrying on.
- **A line splitting into two**, read downwards, is a branch starting.
- **Two lines joining into one dot**, read downwards, is where those branches came
  from — the commit they both grew out of.
- **A hollow dot** is a merge: a commit with more than one parent.
- **The colour identifies the column, not the branch.** Six colours, reused left to
  right. It is there so your eye can follow one line down the page, not so you can
  tell `main` from `feature/x` by its colour — branch names are the chips on the
  rows.
- **A line that stops at the bottom of the list** does not mean the history ends.
  It means the list does; press **Show 50 more**.
- **A line that stops at a dot with nothing below it** is the project's very first
  commit. That one really is the end.

**The graph is drawn over all the commits that are loaded, not over the ones your
filter leaves on screen.** So with a filter on, you will see gaps in the lines.
That is honest rather than broken: the alternative is redrawing a different shape
of history for every search, which would show branches joining commits they never
came from.

**A very wide history shares the last column.** The gutter can draw six lines side
by side; a project with more branches open at once than that puts the extras in the
last column, and the row says so when you hover it. It is rare — one or two columns
is normal, even in a busy project — because the graph reuses a column the moment a
branch is merged.

## What a row tells you

| Part of the row | What it is |
|---|---|
| The message | the commit's first line — what the author called it |
| Chips | branches, tags and remote branches pointing at this commit |
| **⑃** | this is a merge |
| The name | who wrote it |
| **+412 −57** | lines added and removed across the whole commit |
| `a3f91c2b` | the commit's identifier, shortened |
| **14m** | how long ago |

Hover a row to see the full commit message. Hover the time to see the exact
date.

**A branch chip and a tag chip look different, and that matters.** A branch and a
tag can have the same name — `release` as a branch and `release` as a tag are two
different things, possibly pointing at two different commits. switchboard asks
git for the long form of every name so it can tell them apart. The branch you
currently have checked out is marked.

## Opening a commit

Click a commit row and it expands to show what that commit changed: one line per
file, with a letter for what happened to it and the lines added and removed.

- **Click a file** and its diff for *that commit* opens in its own panel — the
  file as it was before, beside the file as it was after. That is a different
  thing from the Changes tab's diff, which is about what has not been committed
  yet, so the two open as separate panels and neither replaces the other.
- **One commit at a time.** Opening another closes the first. The file list is a
  glance, not something to compare side by side — that is what the panels are for,
  and you can have as many of those open as you like.
- **A renamed file** shows its new name, and hovering tells you the old one.
- **A file with no line count** — a binary, or a commit that only changed a
  file's permissions — shows no number rather than a zero.
- **The project's very first commit** lists every file in it as an addition. There
  is nothing before it to compare against, so that is simply what it is.
- **An empty commit** says *"This commit changed no files"* rather than showing an
  empty space, which would look like something that failed to load.

## Commits to pull, commits to push

If the branch you are on tracks a branch on a remote, two rows can appear above
the list:

- **↓ 1 commit to pull** — the remote has work you do not have yet.
- **↑ 3 commits to push** — you have work the remote does not have yet.

**They are counts, not buttons, and that is deliberate for now.** Pull and Push
arrive with the rest of the branch and sync controls. A button that looks live
and does nothing is worse than no button, so until those work the rows say only
what is true.

Neither row appears if your branch is level with the remote, and neither appears
if your branch does not track a remote branch at all. Those are two different
situations that happen to look the same here.

## Searching

The search box filters what is already loaded — it does not go back to git, so it
is instant. It matches:

- the commit message's first line,
- the author's name,
- the start of the commit's identifier (paste a short or long hash),
- a branch or tag name, for "which commit is `v0.8.3`".

**It does not search the whole commit message.** In a project whose commit bodies
run to paragraphs, a full-text search matches nearly everything, and a filter
that matches everything is no better than a broken one.

## One file's history

On the **Changes** tab, every row has a small clock button (**⏱**) that appears
when you hover over it. Click it and switchboard switches you to this tab and
shows only the commits that touched that file.

You will see a chip at the top of the tab naming the file, like
`… src/main/git/git-service.ts`, with an **✕** on it. The ✕ is the only way back
to the whole history — a filtered list that did not say it was filtered would
look like a project with four commits in it.

A few things worth knowing about it:

- **It follows renames.** If the file used to be called something else, the
  commits from before the rename are in the list too. This is git's own
  rename-following, and it is a guess rather than a record — git compares file
  contents to decide, so a file that was rewritten in the same commit it was
  renamed in can break the chain.
- **The counts are the whole commit's, not the file's.** A row saying `+120 −4`
  means that commit changed 120 lines across everything it touched. Expand the
  row to see the file's own numbers.
- **It is per card.** Two cards can be pinned to two different files at once, and
  the pin is forgotten if the session's folder changes.
- **Searching still works** and applies on top of the filter.
- **A brand-new file has no history, and the tab says so by name.** Git has
  nothing to tell you about a file it has never seen, so you get *"No commits have
  touched …"* rather than a bare "nothing here".
- **A few filenames cannot be filtered on, and switchboard tells you instead of
  guessing.** A name starting with a colon means something special to git, so
  rather than quietly show you a different answer, the tab says it won't filter by
  that name and shows the whole history. You will only ever see this on a Mac or
  on Linux — Windows does not allow those names.

## It loads in pages

The tab asks git for fifty commits at a time and offers **Show 50 more** at the
bottom. On a project with a thousand commits, asking for all of them takes about
three seconds; fifty takes well under one.

That is a measured trade, not a guess: almost all of the time is git working out
the line counts, which it does by comparing every commit against the one before
it.

**It refreshes when you come back to the tab.** Nothing watches the repository in
the background, so if a session commits something while you are reading the
conversation, switch to another tab and back to see it.

## Things git does that look like bugs and are not

- **The oldest commit in a project shows every file as new.** It is: the first
  commit has nothing before it to compare against, so every line in it counts as
  an addition. Git has no other answer to give.
- **A commit can show no line counts at all.** An empty commit — one made
  deliberately with no file changes, which some release workflows do — has no
  numbers, and switchboard shows nothing rather than a zero it made up.
- **A merge shows the changes it brought in.** The counts on a merge are measured
  against the branch you were on, so they tell you what arrived.
- **The list is not in strict date order.** Commits are ordered so a branch's
  commits stay together, which is what makes the shape of the history readable. A
  commit made on a side branch last Tuesday appears with its branch, not among
  Tuesday's other commits.
- **A commit can have no message.** Git allows it. The row says *(no message)*
  rather than being blank, because a blank row looks like a bug.

## When it cannot read the history

The tab says so in git's own words, the same way the **Changes** tab does — see
[Changes & git](08-changes-and-git.md), "When the tab says it couldn't read your
project's git", for the list of reasons and what to do about each. Two answers
here are **not** errors:

- **This project has no commits yet.** A folder where `git init` has been run and
  nothing else. It is a repository; it just has no history.
- **Not a git repository.** A folder that is not under version control.

As everywhere else in switchboard, a failure here costs you the history and
nothing else: the session keeps running and the other tabs keep working.

## Good to know

- **switchboard will not run a program your project asks it to.** A git
  repository can be configured to launch a command of its choosing when its
  history is read — normally to check signatures. switchboard declines all of
  that while drawing this tab, because a session that can edit files should not be
  able to get the app to run something on its behalf. See the same note on the
  [Changes & git](08-changes-and-git.md) page; it applies here too, and this tab
  found a new way it could have happened.
- **The author name on a row is the name the project supplies.** Git lets a
  project map one name onto another, so treat it as a label rather than as proof
  of who did something.

---

[← Back to Contents](contents.md)
