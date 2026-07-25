# Keyboard & commands

> Status: stub — the feature isn't built yet

**Today:** switchboard has no application-wide keyboard shortcuts. Everything
is done with the mouse. Inside a session, the keyboard belongs entirely to
Claude Code — the prompt box and the Terminal tab behave exactly as they would
in a terminal, including **Enter** to send and **Shift+Enter** for a new line.

TODO: this page gets written by the command-registry work item. It will cover:

- Jumping between sessions by number, and next/previous.
- Opening, closing, and popping out sessions from the keyboard.
- Hiding the Sessions list.
- The command palette — a searchable list of everything the app can do, with
  each command's shortcut shown next to it.
- The "jump to whatever needs me next" key.

## The rule that will matter

While you're typing — in the prompt box, a rename field, or the Terminal tab —
switchboard keeps its hands off. Every keystroke goes where you're typing.
Shortcuts only fire when you're not typing into something. Pressing `1` in the
prompt box types a `1`; it will never jump you to another session.

The Terminal tab is absolute: switchboard never intercepts a key there, because
that's the real Claude Code and it should get everything.
