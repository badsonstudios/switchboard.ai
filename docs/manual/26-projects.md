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
that (for example `switchboard-worktrees\MyRepo\feat-login`). Change it for
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

When Switchboard removes a worktree it made (for example **Discard worktree**),
it unlinks shared folders first, so the real `node_modules` in your main folder
is never touched.

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

## Coming next

- **Finishing a worktree:** update it from main, push it and open a pull
  request, and remove it safely. Until then, remove a finished worktree with
  `git worktree remove` in a terminal (unlink any shared folder inside it first).
- **Line counts per worktree** on the card.

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
