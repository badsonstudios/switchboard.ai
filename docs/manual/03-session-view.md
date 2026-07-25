# The session view

> Status: draft

Each card has four tabs: **Session**, **Terminal**, **Changes**, and
**History**. Session is the one you'll live in.

## The Session tab

This is the conversation, rendered to be read rather than scrolled past:

- **Your prompts** appear as tinted boxes.
- **Claude's replies** are formatted text.
- **File edits** show the filename, a `+3 / -1 lines` summary, and the changed
  lines in red and green. Click to collapse.
- **Commands** show what was run and why, with **IN** and **OUT** sections you
  can expand separately.
- **Thinking** collapses to "Thought for 4s" — expand if you care.
- **Checklists** from Claude's own task tracking render as `[x]` / `[~]` / `[ ]`.

The view stays pinned to the newest message, including when you switch back to
a session you'd left. Scroll up freely; it won't yank you back.

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
You'll be sent here on purpose for things like the model picker, and a
**continue in Terminal ↗** chip appears whenever a session is waiting on
something only the terminal can answer.

## Changes and History

**Changes** shows the files this session has modified — see
[Changes & git](08-changes-and-git.md). **History** is coming later.

## Good to know

- The Session tab is fully interactive; you never *have* to use the Terminal.
- Very long prompts and skill payloads collapse to a summary — click to expand.
