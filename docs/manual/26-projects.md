<p align="right"><a href="contents.md">☰ Contents</a></p>

# Projects: one repo, many pieces of work

> Status: draft (step 2 of 4; see "Coming next")

A **project** is a git repository you open once. Switchboard lists the repo's
**worktrees** (each one a branch checked out in its own folder) and, under each
worktree, the sessions working in it. That way you can see at a glance which
session is working on which branch, and two sessions never have to share one
folder.

## Opening a project

1. In the Sessions list, click **+ project** (or press `Ctrl+Shift+P` and type
   "Open project").
2. Click **Browse…** and pick the repo's folder (any folder inside it works).
3. The dialog lists the worktrees it found. Worktrees you made yourself with
   `git worktree add` are listed too.
4. Change the name if you like, then click **Open project**.

Opening a project starts no session. Sessions already open in that repo move
under the project in the list; they keep running.

## What the project card shows

- **The header:** the project's name and colour, how many worktrees and sessions
  it has, and how many of them need you. Click the dot to change the colour;
  double-click the name to rename it.
- **One section per worktree**, named after its branch:
  - **PRIMARY** marks the repo's main folder.
  - **FOUND** marks a worktree made outside Switchboard. Worktrees Switchboard
    made itself don't have it.
  - **⊕** starts a new session in that worktree's folder.
  - **⋯** ▸ **Open folder in editor** opens that worktree in your editor (the
    one chosen in Settings ▸ General ▸ Editor).
- **The sessions in each worktree**, exactly as they look anywhere else in the
  list. You can drag them to reorder them within their worktree.

## Making a new worktree

1. Click the **＋** in the project's header (or press `Ctrl+Shift+N`; it uses the
   project of the session you're in, or your first project).
2. Under **What's it for?**, say what the work is. That becomes the session's
   name, and suggests a branch name.
3. Check the **Branch** and **Start from**:
   - A new branch name makes a new branch, starting from **Start from** (by
     default the repo's main branch on its remote, such as `origin/main`).
   - The name of a branch that already exists checks that branch out as it is.
   - A branch that is already checked out in another worktree can't be used
     (git allows one folder per branch).
4. Click **Create & start** (or press `Ctrl+Enter`).

The dialog closes straight away. The new worktree appears at the bottom of the
project card with a progress bar while it is built, and its session starts in it
when it is ready. You can keep working in other sessions meanwhile. If
something goes wrong, the card says what, and nothing else is affected:

- **Couldn't create it** — git refused (its own words are shown). Nothing was
  left behind. Click **Dismiss**.
- **Setup failed** — the worktree is there, but the setup command (see below)
  failed. Choose **Start session anyway**, **Keep, no session**, or **Discard
  worktree** (which removes the folder and the brand-new branch).
- A line like **Not copied** or **Not shared** means one copy or share step was
  skipped; the rest went ahead.

### Where worktrees go

New worktrees go in one folder **outside** the repo, so they never show up as
new files in your main folder. By default that is `switchboard-worktrees` in
your home folder, with one folder per repo inside it, and one per branch inside
that (for example `switchboard-worktrees\MyRepo\feat-login`). If you pick the
folder that holds the repo itself (say `C:\Projects` for `C:\Projects\MyRepo`),
worktrees go in `C:\Projects\MyRepo.worktrees` so they stay out of the repo.
Change it for
every project in **Settings ▸ General ▸ Worktree folder**, or for one project in
its settings.

## Project settings

Open them from the project's **⋯** ▸ **Project settings…** (or the link in the
new-worktree dialog). A new worktree has only the files git tracks; these three
steps fill in the rest:

1. **Copy into each new worktree** — small files each worktree should have its
   own copy of, such as `.env`. One per line, written relative to the repo.
2. **Share between worktrees (link, don't copy)** — big folders git ignores,
   such as `node_modules`, linked from the main folder instead of copied. Only
   folders git ignores can be shared; anything else is refused and the dialog
   says so. It's off by default because a branch that changes its dependencies
   would change them for every worktree sharing the folder.
3. **Then run** — a command run in the new folder before the session starts,
   such as `npm ci`. The new-worktree dialog has a box to skip it for a quick
   look.

You can also set where new worktrees start from and where they go. Settings are
saved in the app, not in the repo.

Whenever Switchboard removes a worktree (**Discard worktree**, or **Remove
worktree…** below), it unlinks shared folders first, so the real `node_modules`
in your main folder is never touched.

## When a folder is already in use

If you start an ordinary session (with **+ session**, `Ctrl+N`, or by dropping a
folder on the window) in a folder another running session is already using,
Switchboard asks first: two sessions in one folder can switch branches or
overwrite files under each other. You see which session is there, its branch and
how many files it has changed, and choose:

- **New worktree…** — opens the new-worktree dialog for that repo (opening it as
  a project if it isn't one yet). Nothing is made until you click **Create &
  start**.
- **Share folder** — start the session there anyway. Fine for questions and
  reading.

Tick **Don't ask again** to remember your answer, or set it in **Settings ▸
General ▸ When a folder is already in use** (Ask / Always share the folder /
Always offer a new worktree). Starting a session from a worktree's **⊕**, a
group's **⊕**, or **Duplicate** never asks: those already say "here".

## Finishing a worktree

A worktree's **⋯** menu carries the end of its life. Beside each worktree's
branch the card shows where it stands against main: **↑2 ↓3** means two commits
that aren't on main yet and three on main that this worktree doesn't have, and
**+120 −8** is the lines it changes (counting what isn't committed yet). Hover
for the same in words. The numbers are refreshed whenever you switch back to the
app.

### Update from main

**Update from main** (it shows how many commits behind you are) brings main's
new commits into the worktree's branch. Switchboard fetches first when the repo
has a remote, then **merges** main in. It merges rather than rebases so a branch
you have already pushed, or opened a pull request for, never needs a force-push.

- **Changes that aren't committed** stop it before anything happens, and the
  dialog lists the files. Commit them (or ask the session to), then try again.
  Nothing is stashed for you.
- **If both sides changed the same lines,** git stops half-way and Switchboard
  leaves the folder exactly like that, so nothing is lost. The dialog lists the
  files and offers three ways on:
  - **Ask *session* to resolve** sends the worktree's session a message naming
    the files and asking it to resolve them, run the tests and commit the merge.
  - **Abort the update** puts the worktree back exactly as it was.
  - **I'll do it myself** just closes the dialog. The merge stays in progress
    until you finish it (resolve, then commit) or run `git merge --abort`.

Switchboard never resolves a conflict for you.

### Push & open pull request…

A pull request is how a worktree's work gets into main. **Push & open pull
request…** pushes the branch and opens a pull request into main with the GitHub
CLI (`gh`). The title starts as what you said the worktree was for (or its
session's name), and the description lists the worktree's sessions and what each
is working on. Edit both, and tick **Open as a draft** if it isn't ready for
review. GitHub opens in your browser when it's done.

- If a pull request is already open for that branch, the dialog says so and
  offers **Open it** instead of making a second one.
- If `gh` isn't installed or isn't signed in, the dialog says which (run
  `gh auth login` in a terminal), and nothing is pushed.

### Merge into main locally

Only for a repo with **no remote** (nowhere to push a pull request to): **Merge
into main locally** merges the branch into main in the main folder, after you
confirm. The main folder has to be on main with nothing uncommitted. If the two
branches conflict, nothing is merged and the main folder is left as it was;
update the worktree from main, resolve it there, then try again.

### Remove worktree…

**Remove worktree…** asks once and tells you what you would lose:

- **Files changed but not committed** are listed, and the button becomes
  **Remove anyway**. Those changes are lost if you go ahead.
- If the branch has **commits that aren't on main** and no merged pull request,
  it says so and **Keep the branch** is ticked: the folder goes, the commits
  stay, and you can check the branch out again later. Untick it to delete the
  branch too. A branch whose pull request was merged starts unticked.
- **Open sessions in the worktree are closed first.** Their conversations stay
  in History (Claude Code keeps them, and Switchboard never deletes them).
- **Linked folders such as `node_modules` are unlinked before anything is
  deleted,** so the real folder in your main folder is never touched.

If a different checkout has appeared at that folder since, Switchboard refuses
and removes nothing. The main folder can't be removed.

A worktree you delete outside the app (in a terminal or Explorer) drops off the
card the next time it's read.

## Hiding and removing

- **Hide a worktree:** its **⋯** ▸ **Hide this worktree**. Only an empty worktree
  that isn't the main folder can be hidden. Bring them back from the project's
  **⋯** ▸ **Show hidden worktrees**.
- **Remove a project:** its **⋯** ▸ **Remove project from the list**. This only
  takes the card away. No session stops, nothing on disk changes, and its
  sessions go back to where they were in the list (including any group you had
  put them in).

## Good to know

- **A project wins over groups.** A session in a project's repo is shown in the
  project, even if you put it in a group. Remove the project and it goes back
  to its group. While it is in a project, **Move to group** is not offered and
  dragging it onto a group does nothing, because the project decides where it
  sits.
- **Worktrees are read fresh** when the app starts and whenever you switch back
  to it, so a worktree you add or remove in a terminal shows up then.
- **One card per repo.** Opening a repo that is already a project just says so.
- **Projects are saved with your workspace**, not in the repo.

## If something goes wrong

- **"This folder isn't in a git repository"** — pick the repo's folder (or a
  folder inside it). A plain folder can still be used for an ordinary session.
- **"Can't read this repo's worktrees right now"** — git couldn't answer (the
  repo moved, or git isn't installed). The card still lists its sessions; it
  will try again when you switch back to the app.
- **A session isn't under the project** — it is in a different repo, or its
  folder isn't a git repo. Sessions in a project are found by their folder.

---

[← Back to Contents](contents.md)
