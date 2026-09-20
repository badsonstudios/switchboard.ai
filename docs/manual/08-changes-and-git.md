# Changes & git

> Status: draft

## The branch line

Each card header shows where the session's folder stands in git: the branch
name (**⎇ main**), how many files have changed (**·3 changed**), and how many
commits you're ahead of the remote (**↑2**). It updates as Claude works.

If the folder isn't a git repository, the line simply doesn't appear.

## The Changes tab

Open the **Changes** tab on a card to see what this session has actually done
to your files: a list of changed files with a badge for each —

| Badge | Meaning |
|---|---|
| **A** | New file |
| **M** | Modified |
| **S** | Staged |
| **SM** | Staged, with further unstaged changes |

Click a file to see it before and after.

**It remembers where you were.** Leave the Changes tab for the conversation and
come back, and it reopens on the same file, at the same line —
you do not have to find your place again. If that file has stopped being a
change while you were away, because you committed or discarded it, the tab
opens clean instead of showing you a blank comparison. This lasts for as long
as the app is running; a restart starts fresh.

When there's nothing to show you'll see **Working tree clean**, or **Not a git
repository** if that's the situation.

## Side by side, or inline

Above the diff there's a pair of buttons: **Side by side** shows the old file
and the new one in two columns; **Inline** stacks the changes in a single
column, with removed lines above the ones that replaced them.

Side by side is the default. Your choice applies to every Changes tab — this
session's and every other one's, including any in a popped-out window — and
it's remembered, so the app comes back the way you left it. You can also
change it from the command palette (**Ctrl+K** / **⌘K**) with *Toggle
side-by-side / inline diff*.

One exception, and only for genuinely tiny panes: squeeze the Changes tab below
about 400 pixels and two columns would hold roughly 18 characters each, which
isn't a diff. Below that width it's drawn inline whatever you chose, and the
tab tells you so — *Too narrow for two columns*. The button stays selected;
widen the card, hide the sessions rail with **Ctrl+B**, or pop the session out
into its own window, and the second column comes back on its own.

## Syntax colouring

Code in the diff is coloured for its language, worked out from the file's name
— `.ts`, `.py`, `.rs`, `.go`, `.md`, `Dockerfile` and around a hundred other
names and extensions between them. Colours follow the app's light or dark
setting, and switch with it.

A file switchboard doesn't recognise is shown as plain text rather than
coloured wrongly, so an unfamiliar extension costs you colour, never accuracy.
For the same reason a few extensions it *could* guess at are left plain
deliberately — `.m` is Objective-C about as often as it's MATLAB, so it stays
uncoloured rather than being coloured wrong half the time.

A few languages borrow a near neighbour's rules, the two you'll notice being
**JSON** (coloured as JavaScript, which agrees with it on everything JSON has)
and **TOML** (coloured as INI).

This is colouring only — no squiggly error underlines, no hovers, no
autocomplete. The Changes tab is for reading what happened, not for editing,
and warnings about half-finished work in progress would be noise.

The app's four themes collapse to two here: **daylight** gives the diff its
light colours and the other three give it dark ones. A palette tuned to
**high-contrast** specifically is a later change.

## Good to know

- switchboard **shows** you changes — it doesn't commit, push, stage, or revert
  anything. Git is yours to drive, wherever you normally do it.
- The diff reflects what's on disk right now, including changes you made
  yourself outside the app.
- **switchboard ignores instructions a project leaves for it to run a program.**
  A git repository can be set up to run a command of its choosing whenever
  anything reads its files — normally to speed up very large projects, or to
  handle big binary files — and it can leave scripts in a hidden folder that git
  runs for the same reason. switchboard reads your projects constantly to draw
  this tab, so it declines all of that: a session that can edit files shouldn't
  be able to get the app to run something for it. Handlers you installed
  yourself, **Git Large File Storage** being the common one, keep working
  exactly as before — only ones written into the project folder itself are
  skipped, and this covers a project's sub-projects too.

  The one setup this can't help: if you turned on Large File Storage **for a
  single project only** (`git lfs install --local`) and never installed it for
  your account, switchboard won't be able to read that project's changes — the
  tab tells you so, and quotes what git said. Running `git lfs install` once,
  without `--local`, fixes it for good.

## When the tab says it couldn't read your project's git

Most of the time the Changes tab has three things to say: your changed files,
**Working tree clean**, or **Not a git repository** for a folder that simply
isn't under version control. A fourth message means something went wrong:

> switchboard couldn't read this project's git — *…*

The part after the dash is the reason, and usually it's git's own words. Some
you might see:

- **git could not be started** — git isn't installed, or isn't somewhere the app
  can find it.
- **that folder no longer exists** — the session's project folder has been
  moved, deleted, or is on a drive that isn't connected.
- **detected dubious ownership…** — git refuses to touch a repository owned by a
  different user account, which on Windows usually means the folder was created
  by an installer, a different login, or an elevated command prompt. Tell git the
  folder is fine with `git config --global --add safe.directory <the folder>`.
- **git could not enumerate this repository's own configuration** — the project's
  git settings can't be read at all, which usually means a damaged checkout.
- **this git is too old…** — git needs to be version 2.31 or newer for the
  safety rule described above. Upgrading git fixes it.
- **switchboard could not check whether this git applies its safety overrides**
  — that check didn't finish in time, usually a very slow or network drive.
  This one often clears by itself; switch away from the tab and back.

The point of this message is that it is *not* **Not a git repository**. Until
now every one of these failures said that instead, which is a confident claim
about your project that happened to be false — and one that reads as "switchboard
has lost my work" when the real problem is a disconnected drive.

Nothing else in the app changes when this happens: the session keeps running,
and the git line on the session's card simply goes quiet rather than showing you
a branch and a change count it couldn't actually check.
