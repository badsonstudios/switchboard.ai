# The session view

> Status: draft

Each card has four tabs: **Session**, **Terminal**, **Changes**, and
**History**. Session is the one you'll live in.

## The Session tab

This is the conversation, rendered to be read rather than scrolled past:

- **Your prompts** appear as tinted boxes.
- **Claude's replies** are formatted text, with no marker in the left margin —
  they're the answer, not something that happened, so they sit clean.
- **Anything Claude *did*** — running a command, editing a file, reading
  something, updating its checklist — is a **bordered box** with a small dot in
  the margin beside it. The boxes are what you scan for when you want to know
  what a session has been up to.
- **File edits** show the filename, a `+3 / -1 lines` summary, and the changed
  lines in red and green.
- **Commands** show what was run and why, with **IN** and **OUT** sections you
  can expand separately.
- **Thinking** collapses to "Thought for 4s" — expand if you care.
- **Checklists** from Claude's own task tracking render as `[x]` / `[~]` / `[ ]`.
- **Local commands** — `/usage`, `/cost`, `/context` and the like, which Claude
  Code answers itself — print their output here too.

The view stays pinned to the newest message, including when you switch back to
a session you'd left. Scroll up freely; it won't yank you back.

**In [Direct mode](12-direct-mode.md), replies stream in a word at a time**,
with a small block cursor on the end while Claude is still writing. In Terminal
mode the view waits for each finished message instead, so replies arrive in
chunks a moment behind. The blocks themselves are identical either way — only
how quickly they fill in differs.

### Expanding a box

**Click anywhere on a box to open or close it.** You don't have to hit the
title — the whole rectangle is the target. On a command box that shows you the
full command and its full output in one click.

Two things deliberately *don't* fold the box away:

- The small **▸ IN** / **▸ OUT** arrows inside a command box, and the diff panes
  inside an edit box. Those control just their own section, so you can open the
  output without the command, or scroll a long diff in peace.
- **Selecting text.** Dragging to highlight a file path or a line of output
  leaves the box exactly as it was, so you can copy it without it disappearing.

Checklist boxes have nothing to expand — they're already showing everything —
so clicking one does nothing.

## When the Session tab has nothing in it

An empty Session tab is usually normal, so it tells you which kind of empty it
is rather than leaving you guessing:

- **"No conversation yet"** — the session is up and waiting. Claude Code
  doesn't start writing a conversation until you send your first prompt, so a
  card you've just opened sits here, however long you leave it. Nothing is
  wrong.
- **"Looking for this session's transcript…"** — you've sent something and
  switchboard is matching the conversation to this card. It normally passes in
  a moment.
- **"Couldn't find this session's transcript"** — shown in red, and the only
  one that means something is actually wrong. It tells you where it looked and
  what it found. **Your session is unaffected** — it's still running, and the
  **Terminal** tab shows it exactly as Claude Code renders it. See
  [Troubleshooting](11-troubleshooting.md).

If you have two cards open on the *same folder*, expect the second one to spend
a little longer on "Looking for…" — switchboard waits until it can tell the two
conversations apart rather than guessing and showing you the wrong one.

## Talking to the session

The box at the bottom sends straight to the real Claude Code session:

- **Enter** sends. **Shift+Enter** starts a new line.
- The box grows as you type.
- While Claude is working, the send button becomes a **■ stop** button, which
  interrupts the current turn.
- Typing `/` at the start of a line opens command autocomplete — see
  [Slash commands](05-slash-commands.md).

Under the box is a row showing this session's **autonomy mode** (click to
cycle) and the **model** it last used.

## How much detail you see

Three settings, top of the Session tab:

| Setting | Shows |
|---|---|
| **quiet** | Just your prompts and Claude's replies |
| **normal** | Prose plus tool activity — the default |
| **firehose** | Everything, including thinking and sub-agent chatter |

Switch any time; it applies instantly and is remembered per session.

## The Terminal tab

The real Claude Code interface, always available as the last tab. It's the same
session — not a copy — so anything switchboard can't handle finishes here.
You'll be sent here on purpose for things like the model picker.

**When something can only be answered in the terminal, the Session tab says
so** — a coloured bar across the bottom, in the same place the approval bar
appears, with an **Open Terminal** button. You'll see it in three situations:

- **"Claude is asking permission in the terminal."** Some decisions Claude Code
  always keeps for itself — most commonly edits inside a project's own
  `.claude` folder. switchboard isn't allowed to answer those on your behalf,
  and won't pretend it can.
- **"Claude is waiting for your answer."** A question with a numbered list of
  choices, the kind you pick with the arrow keys.
- **"Claude is showing a start-up dialog."** Trusting a folder, or picking a
  conversation to resume.

For the first two the session also marks itself **needs input** or **needs
permission** and raises an entry in Events, so you can tell at a glance that
it's stopped and waiting rather than still working. (A session still starting
up doesn't raise an Events entry — it hasn't got going yet.) Answer it in the
Terminal
and the session carries on. Answering these
inside the Session view is planned, not built.

## Changes and History

**Changes** shows the files this session has modified — see
[Changes & git](08-changes-and-git.md). **History** is coming later.

## Good to know

- The Session tab is fully interactive; you never *have* to use the Terminal.
- Very long prompts and skill payloads collapse to a summary — click to expand.
- The boxes and the margin dots are drawn from your theme, so they stay legible
  whichever one you're on.
