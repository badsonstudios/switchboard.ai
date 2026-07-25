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

## Good to know

- switchboard **shows** you changes — it doesn't commit, push, stage, or revert
  anything. Git is yours to drive, in the Terminal or wherever you normally do
  it.
- The diff reflects what's on disk right now, including changes you made
  yourself outside the app.
