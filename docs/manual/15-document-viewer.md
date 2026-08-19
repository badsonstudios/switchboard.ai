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

The quickest way in is the **File** menu at the top left — **File › Open File…**
— or **Ctrl+O** from anywhere in the app. The browser starts in the folder of
the session you're looking at, and after that wherever you last browsed to, so
opening a second file from the same place is one click rather than a journey.

The file appears in a document tab **beside** the session you were in: in that
part of the workspace, but never inside the session's own tab strip. Open
another and it joins the first as a second tab.

Two more ways in:

1. **The command list** — press `Ctrl+Shift+P` (`Cmd+Shift+P` on a Mac), type
   "open file", and pick **Open file…**. The same dialog as the File menu.
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

## Every file gets its own tab

Open a second file and it opens **in its own tab**, next to the first. The
document you were reading stays exactly where it was. Open six files and you
have six tabs, all still there.

- **Nothing closes on its own.** A document panel goes away when *you* close it,
  with the normal tab **✕**. That is the only thing that closes one.
- **Opening a file that is already open just brings it to the front** — and if
  it is out in its own window, that window comes forward instead. (One
  exception: if you have followed a *link* inside a document, that panel is
  still filed under the file you originally opened, so asking for the linked
  file by name opens it in a tab of its own.)
- **Each tab keeps your place.** Read halfway down one document, click another
  tab, come back — you are still halfway down, not back at the title.
- **Nothing is remembered between runs.** A viewer is a way of looking at a file, not a thing
  you own — close it and there is nothing left behind.

Earlier versions worked the other way round: there was one "replaceable" viewer
that the next file you opened took over, and a **📌** to keep a document out of
its way. That is gone, pin and all. If you like a tidy tab strip, close the ones
you're done with — the app will not make that decision for you.

## Reading on a second monitor

The **⤢** in the document's header moves it into **its own window**, which you
can drag to another monitor and leave there. It is the same window trick a
session card does.

- The same **⤢** in that window puts the document back into the main window.
- So does simply closing the window — nothing is lost either way.
- A document out on its own monitor stays on what it is showing. Opening more
  files in the main window never touches it.
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

Press `Ctrl+F` (`Cmd+F` on a Mac) with a document tab in front of you. This is
the same find bar the rest of switchboard uses — see
[Finding things](16-find.md) — so it looks and behaves exactly as it does over a
session: type, and matches light up; `Enter` goes to the next one,
`Shift+Enter` the previous; the count reads "3 of 12"; `Esc` closes it and the
highlights go with it. The ▸ button opens a list of every match, if you'd rather
pick one than step through them.

The search only ever looks at the document in front of you — never at another
document, and never at a session. It searches the whole file, including code
blocks, and copying a code block while the bar is open still copies the plain
code, highlights and all left behind.

In **Source** view — which is what you get for any file that isn't Markdown —
`Ctrl+F` hands you to the editor's own find box instead: a fuller one, with
regular expressions and match marks down the scrollbar. Our bar steps out of the
way rather than putting a second, worse find on top of a good one.

It works the same in a popped-out document window. Press `Ctrl+F` there and the
bar opens in *that* window, over the document you're reading.

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
  or paint itself a colour you didn't pick. That covers the older HTML ways of
  doing it as well — `<font color>`, `<hr color>` and their relatives — so
  nothing in a document chooses its own colours, sizes or typefaces. The
  document's own formatting — headings, tables, task lists, code blocks — is
  untouched, column alignment in tables included.
- **A document can't talk to your screen reader either.** The same raw HTML can
  carry accessibility markup — labels, roles, "announce this now" regions — and
  the viewer removes all of it. That markup is invisible on screen, so a
  document could otherwise label something "Cancel" where the page says
  *Approve*, hide a line of text from a screen reader while you can still see
  it, or interrupt whatever switchboard.ai was announcing. Everything a screen
  reader reads in a document is written by switchboard.ai: the headings, tables,
  lists and code blocks the document really contains, plus the viewer's own
  labels for its links, tables and Copy buttons. The same applies to replies in
  the session view.
- **A document can't hide text from you, or take over your Tab key.** Raw HTML
  has several ways to mark something as hidden — or as present but unreadable to
  a screen reader — while leaving it in the file, and the viewer removes all of
  them. It mattered most for code blocks: every code block gets a **Copy**
  button, so a hidden one would have shown you an ordinary code header with a
  Copy button and no code — and copied something you never saw.
  The same removal covers markup that inserts itself into the keyboard Tab
  order: every stop your Tab key lands on is one switchboard.ai put there —
  including a document's own links and the scroll box around a wide table, which
  the viewer makes reachable on purpose. This applies to replies in the session view as well.
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
