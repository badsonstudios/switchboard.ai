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

**When you've scrolled away, a `↓ Jump to latest` button appears** just above
the prompt box. Scrolling up — with the wheel, or by walking the conversation
with the arrow keys — deliberately unsticks the view so that new output can't
drag you off what you're reading, and that button is how you stick it back on:
one click and the view is at the newest message and following again. It only
shows while there's somewhere to go, so a conversation short enough to fit never
has one. Scrolling all the way back down by hand does exactly the same thing.

From the keyboard it's one `Tab` from the conversation (press `Esc` first if
you're walking the boxes) and one `Shift+Tab` from the prompt box — see
[Reading the conversation with the keyboard](06-keyboard.md#reading-the-conversation-with-the-keyboard).

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

### …without the mouse

Every box, every **IN** / **OUT** section and every folded prompt can be opened
from the keyboard. `Tab` into the conversation, then `↑` and `↓` walk between
the things that open, and `Enter` opens the one you're on. Full instructions:
[Reading the conversation with the keyboard](06-keyboard.md#reading-the-conversation-with-the-keyboard).

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
- The box grows to fit what you have written — including long text that wraps
  onto several lines by itself, so a pasted paragraph is never half-hidden. It
  stops growing at twelve lines and scrolls inside itself after that, and it
  shrinks back down as you delete.
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

Note that **searching ignores this setting** — `Ctrl+F` looks at everything,
including the tool output **quiet** is hiding and the thinking **normal**
hides, and jumping to a match unfolds it. See
[Finding something in a session](16-find.md).

## The Terminal tab

The real Claude Code interface, available as the last tab on a session running
in **Terminal mode**. It's the same session — not a copy — so
anything switchboard can't handle finishes here. You'll be sent here on purpose
for things like the model picker.

On a session running in [**Direct mode**](12-direct-mode.md) — which is how new
sessions start — there is no terminal at all, and the tab says so: *"No terminal
for this session."* Nothing else in the window will offer to open one. Put the
session on Terminal mode from the ⋯ menu if you want the tab back.

**When something can only be answered in the terminal, the Session tab says
so** — a coloured bar across the bottom, in the same place the approval bar
appears, with an **Open Terminal** button.

> **Terminal mode only.** A session on [Direct mode](12-direct-mode.md) has no
> terminal, so it never shows this bar and never offers an **Open Terminal**
> button. Claude hands those decisions to switchboard properly there, and you
> answer them right here in the approval bar.

You'll see it in three situations:

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
Terminal and the session carries on. Answering these inside the Session view is
planned, not built — and in Direct mode the first of the three already is.

## Changes and History

**Changes** shows the files this session has modified — see
[Changes & git](08-changes-and-git.md). **History** is coming later.

## Good to know

- The Session tab is fully interactive; you never *have* to use the Terminal.
- Very long prompts and skill payloads collapse to a summary — click the
  summary line to expand it, and click it again to fold it back. Once it's
  open, clicking the text itself does nothing, so you can select a line out of
  it without it disappearing.
- The boxes and the margin dots are drawn from your theme, so they stay legible
  whichever one you're on.
