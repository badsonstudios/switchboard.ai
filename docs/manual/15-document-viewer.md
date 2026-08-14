# Reading files in the app

> Status: draft

Your agent writes Markdown all day — progress notes, plans, findings, hand-off
summaries, review reports. The document viewer lets you *read* those files
inside switchboard.ai, properly rendered, instead of alt-tabbing to an editor
and squinting at a wall of `**`, `|` and backticks.

It opens any text file too, with syntax colouring, and it is **read-only** on
purpose. switchboard.ai is not an editor and is not becoming one.

<!-- screenshot: PROGRESS.md open in the viewer, rendered, with the outline on the left -->

## Opening a file

Two ways today:

1. **The command list** — press `Ctrl+Shift+P` (`Cmd+Shift+P` on a Mac), type
   "open file", and pick **Open file…**. Choose a file in the dialog that
   appears.
2. **The Changes tab** — each row in the file list on the left has a small **↗**
   at its right-hand end. Click it to open that file in the viewer. (Clicking
   the row itself still shows the diff, which is a different question: the diff
   shows what changed, the viewer shows what the file says now.)

Files inside a folder you already have a session open in can be opened
directly. Anything else has to come through **Open file…** — that dialog is how
you tell switchboard.ai it may read a file, and it will not go looking anywhere
you have not pointed it.

The viewer opens **beside** your sessions, in its own part of the workspace —
never as a tab on top of a session card. Reading a file never costs you sight of
the agent that wrote it.

## One viewer, not thirty tabs

Open a second file and it appears **in the same panel**, replacing the first.
Glance at six files in a row and you still have one document panel, not six.

That is deliberate. Most of the time you want to read something, take the point,
and move on — and an editor that leaves a tab behind for every one of those
turns into a mess you have to clean up.

When you want to *keep* a document — say `PROGRESS.md` open while you read the
plan file next to it — click the **📌** in its header:

- The pinned document stops moving. The next file you open gets a **new panel**
  of its own, and that new one becomes the replaceable one.
- Click **📌** again to unpin. That document becomes the replaceable one again,
  and whatever was replaceable before it is kept instead — there is only ever
  one "next file goes here" slot, and unpinning is how you move it.
- Closing a document panel is the normal tab **✕**. Nothing is remembered; a
  viewer is a way of looking at a file, not a thing you own.

Opening a file that is **already** open just brings it to the front. It doesn't
open twice and it doesn't spend your one replaceable slot.

## Reading on a second monitor

The **⤢** next to the pin moves the document into **its own window**, which you
can drag to another monitor and leave there. It is the same window trick a
session card does.

- The same **⤢** in that window puts the document back into the main window.
- So does simply closing the window — nothing is lost either way.
- Popping a document out does **not** pin it. If you want it to stay put on that
  second monitor, pin it as well; otherwise the next file you open replaces it,
  which is often exactly what you want from a reference window.
- Opening a file while a *session* is popped out — or while a *document* window
  is the one you last clicked — still puts the new document in the main window's
  document area. Files do not land in windows by accident.
- And the other way round: starting a **new session** never lands it on top of
  the document you are reading. It opens beside it.

## Where a document came from

Open a file from a session's **Changes** tab and the viewer wears that session's
colour down its left edge, with a small **↳ name** chip in the header naming the
session.

That is a label, not a leash. The document is not part of the session:

- it never appears in the sessions list on the left;
- it is never one of the sessions waiting for you in the attention queue;
- **Close all sessions** does not close it;
- and it stays open after the session it came from is closed — at which point
  the chip goes away, because there is nothing left for it to point at.

Files opened from **Open file…** have no chip at all — they came from you, not
from a session.

## Rendered or source

Markdown files open **rendered**. Everything else opens as **source**.

The `Rendered | Source` buttons at the top of the panel switch between them, and
each view remembers where you had scrolled to, so flipping back and forth
doesn't lose your place. For a file that isn't Markdown, **Rendered** is greyed
out — there is nothing to render.

What you get in the rendered view:

- **Tables**, which scroll sideways on their own if they're wide, instead of
  making the whole page scroll.
- **Task lists** — `- [ ]` and `- [x]` become real (non-clickable) checkboxes.
- **Code blocks** with the language named and a **Copy** button, for when the
  agent has just handed you a command.
- **An outline** down the left of long documents. Click a heading to jump.
- **Front matter** (the `---` block some files start with) folded into a small
  chip you can expand, rather than dumped at the top as a line of noise.
- **Links that work.** A link to another file in a folder you have a session
  open in opens *in the viewer* — use the `‹` and `›` buttons to go back and
  forward, like a browser. A web link opens in your normal browser.

  One catch: a file you opened with **Open file…** grants access to *that file
  only*. Links out of it to its neighbours are refused, because you told
  switchboard.ai it could read one file, not a folder. Pick the neighbour the
  same way, or open a session in that folder.

## It follows the file

This is the reason the viewer exists rather than a Markdown preview you could
get anywhere: **an open document updates itself.**

Leave `PROGRESS.md` open in the viewer while an agent rewrites it and you watch
it change — no reopening, no refresh button. Three things worth knowing:

- **You keep your place.** The document re-renders where you were scrolled to,
  not back at the top. You can read the middle of a file that is being rewritten
  around you.
- **A burst of writes is one update.** An agent saving a file usually writes it
  several times in a second. The viewer waits for the writing to settle rather
  than flickering through every intermediate version. A file being written
  continuously updates about once a second; one that is written and left alone
  updates immediately.
- **If the file is deleted**, a strip appears at the top saying so, and the last
  version switchboard.ai read stays on screen. You are not thrown back to an
  error page and you do not lose what you were reading. If the file comes back —
  a `git checkout`, a rename that lands — the strip disappears and the document
  updates again.

It works in **Source** view as well, and there too you keep your scroll position.

## Finding text

With a rendered document on screen, press `Ctrl+F` (`Cmd+F` on a Mac). A small
find bar appears above the document; type, and matches light up. `Enter` goes to
the next one, `Shift+Enter` the previous, `Esc` closes it.

The search only ever looks at the document in front of you — never at other
panels.

In **Source** view, use the editor's own find box (also `Ctrl+F`).

## Files it won't show you

PDFs, images, archives, executables, video, audio — anything that isn't text —
get a small card naming the file, its type and its size, with two buttons:

- **Open externally** hands the file to whatever app you normally use for it.
- **Reveal in folder** shows it in Explorer / Finder / your file manager.

Those two buttons are in the header of *every* document too, so getting a file
into your own tools is always one click away.

## Good to know

- **Nothing is ever saved from here.** The viewer cannot edit, and there is no
  setting that makes it. Use your editor.
- **Images in a document are not loaded.** A picture in a Markdown file shows as
  a small chip with its name. For a picture hosted on the web, the chip has an
  **Open in browser** button. This is deliberate: switchboard.ai never makes a
  network request on your behalf, and an image in a file someone else wrote is
  the easiest possible way to find out that you read it.
- **A document is shown in your theme, not its own.** Markdown files can contain
  raw HTML, and that HTML can carry styling of its own. The viewer ignores it, so
  a document can't place something over the app's controls, hide text under it,
  or paint itself a colour you didn't pick. The document's own formatting —
  headings, tables, task lists, code blocks — is untouched.
- **Very large files are cut short.** Above about 2 MB you get the beginning of
  the file and a note saying how much is missing. Open it externally to read the
  rest.
- **Files that aren't UTF-8.** UTF-16 files that start with a byte-order mark
  (which is how Notepad and PowerShell write them) are read correctly, and the
  header says so. One written without that marker can't be told apart from a
  binary file, so it gets the "open externally" card.
- **The viewer is not a session.** It doesn't appear in the sidebar, it doesn't
  count towards anything, and closing sessions doesn't close it.
- **A document stops updating if the session it came from is closed** and the
  file was inside that session's folder. Nothing disappears — you keep reading
  what is on screen — but switchboard.ai may no longer look at that folder, so
  it stops following the file. To get it live again, close the document panel
  and open the file afresh (through a session in that folder, or **Open
  file…**); bringing the existing panel back to the front is not enough.
- **Open documents are not restored when you restart.** Your sessions come back
  exactly as you left them; the documents you were reading do not. Reopening one
  is two clicks, and reopening six you had finished with is a chore. Remembering
  them is planned for later.

## If something goes wrong

- **"switchboard.ai only opens files inside a session's folder…"** — you asked
  for a file outside every open session's folder. Use **Open file…** from the
  command list and pick it, which grants access to that one file.
- **"That file isn't there any more."** — it was deleted or renamed after you
  opened it.
- **The document looks like a wall of symbols** — you're in **Source** view.
  Click **Rendered**.
- **A link did nothing when I clicked it** — links using anything other than
  `http`, `https`, `mailto`, or a path to another file in the project are
  ignored on purpose. A document you didn't write should not be able to make the
  app do things.
