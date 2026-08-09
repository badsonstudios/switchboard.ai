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

Click a file to see it side by side, before and after.

When there's nothing to show you'll see **Working tree clean**, or **Not a git
repository** if that's the situation.

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
  anything. Git is yours to drive, in the Terminal or wherever you normally do
  it.
- The diff reflects what's on disk right now, including changes you made
  yourself outside the app.
