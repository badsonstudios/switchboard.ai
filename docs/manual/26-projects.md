<p align="right"><a href="contents.md">☰ Contents</a></p>

# Projects: one repo, many pieces of work

> Status: draft (step 1 of 4; see "Coming next")

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
  - **FOUND** marks a worktree made outside Switchboard.
  - **⊕** starts a new session in that worktree's folder.
- **The sessions in each worktree**, exactly as they look anywhere else in the
  list. You can drag them to reorder them within their worktree.

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

- **Making a new worktree from the card** (a new branch in its own folder, set
  up and ready, with a session in it).
- **Finishing one:** update it from main, push it and open a pull request, and
  remove it safely.

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
