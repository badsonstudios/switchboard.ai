<p align="right"><a href="contents.md">☰ Contents</a></p>

# The Files tab

> Status: draft

Every session works in a folder. The **Files** tab shows you what's in it.

## Git badges

A file that git has something to say about carries a letter on the right of its
row: **M** modified, **A** added, **D** deleted, **R** renamed, **U** untracked,
**!** in conflict — the same letters the [Changes](08-changes-and-git.md) tab
uses.

**A folder gets a badge too, for what is inside it**, drawn dimmer and meaning
"something under here changed". Without that, a change three folders deep would
be invisible until you had expanded your way down to it — and this tree starts
collapsed. A folder shows the most important thing beneath it: a conflict beats a
deletion, which beats a modification, which beats an addition.

**The two tabs cannot disagree.** The badges here and the rows in the Changes tab
come from one reading of your project, not two — so a file is never modified in
one tab and clean in the other.

They refresh when you come back to the tab, along with the file list, for the same
reason: nothing watches your folder in the background. A folder that is not a git
repository simply has no badges.

## Opening it

Click **Files** in the row of tabs along the top of a session card — it sits
between **Changes** and **History**. You can also type "Toggle Files view" into
the command palette (`Ctrl+Shift+P`).

If a session has no folder, the tab is still there but greyed out. There's
nothing to browse.

## Getting around

The tab shows the session's folder, one level at a time:

- **Click a folder** to open it. Click it again to close it. Nothing is read
  until you ask for it, so opening a huge project is instant.
- **Click a file** to open it in the reader, in the same place a file opens from
  anywhere else in the app. See [Reading files in the app](15-document-viewer.md)
  for what the reader can and can't show you.
- **The keyboard works too.** Tab into the list, then use ↑ and ↓ to move, → to
  open a folder, ← to close it, and Enter to open a file.

The folder's full path is at the top left, in case you've forgotten which
project this card is.

## What refreshes, and when

This is worth knowing, because it's the thing that surprises people:

**The list does not update by itself while you're looking at it.** If Claude
creates a file while the tab is open, it won't appear on its own.

Two things do refresh it:

1. **The Refresh button**, top right of the tab. Re-reads the folder you're in
   and every folder you've got open.
2. **Coming back to the tab.** Switch to the Session view and back, and the list
   is re-read for you.

So the usual rhythm — let it work, come back, look — gives you a current list
without you doing anything. It's only if you sit on the tab watching that you
need to press Refresh.

## Things you'll see in the list

| What it says | What it means |
|---|---|
| **Reading…** | The folder is being read. Usually gone before you notice. |
| **Nothing in this folder** | The folder is genuinely empty. |
| **Only the first 500 entries are shown** | The folder has more files than the app will list at once. This is on purpose: some folders (`node_modules`, build output, log directories) hold tens of thousands of files, and reading all of them to show you a screenful would make the app stutter. |
| **link** beside a name | A shortcut — a symlink or a Windows junction. The app doesn't follow shortcuts, so this one can't be opened or opened into from here. |
| A message about a folder it wouldn't read | Something's changed since the list was made: the folder's gone, or it's outside the session's folder. The reason is spelled out on the row. |

A couple of deliberate omissions:

- **`.git` isn't listed.** It's thousands of machine-written files and none of
  them are your project. The git story lives in
  [Changes & git](08-changes-and-git.md) instead.
- **Hidden files *are* listed.** `.claude`, `.github`, `.env.example` and friends
  all show up, because in an agent's project folder those are often the most
  interesting files there.

## What it won't do

The Files tab is for looking and opening. It won't rename, delete, move, or
create anything, and you can't drag a file out of it. Use your own file manager
or ask Claude.

## What it can't reach

The list is confined to the session's own folder. You can't browse up out of it,
and typing a path somewhere else won't get you there — the app checks every
request against the folder the session was opened in, and checks it against
where a path *really* leads rather than how it's spelled. That's also why
shortcuts aren't followed: a shortcut inside your project can point anywhere on
the machine, and the app would rather show you it exists than open it.

---

[← Back to Contents](contents.md)
