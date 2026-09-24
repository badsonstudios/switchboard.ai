# Slash commands

> Status: draft

Claude Code's slash commands work from switchboard's prompt box, with
autocomplete.

## Autocomplete

Type **`/`** at the start of a line and a list appears:

- **↑ / ↓** to move through it.
- **Tab** to insert the highlighted command (and a space after it, ready for
  arguments).
- **Enter** to insert it too — *unless you've already typed the whole command*,
  in which case Enter simply **sends** it. Typing `/usage` and pressing Enter
  runs `/usage`; there's nothing left to complete.
- **Esc** to dismiss.

The list covers Claude Code's built-in commands *and* your own — project
commands and skills from the folder this session is running in, plus your
personal ones. Each row is tagged with where it came from: **CLI**,
**project**, **user**, or **skill**.

The same keys work in the **`@`** list of other sessions — see
[Talking to the session](03-session-view.md#talking-to-the-session).

A `/` typed mid-sentence is just a slash; the list only opens at the start of a
line. While it's open it won't submit a *half-typed* command out from under
you — only a complete one, which is what you asked for by typing it in full.

**With a screen reader,** you're told when the list opens and how many commands
are in it, and each ↑ / ↓ reads out the command you've moved to. Your cursor
stays in the prompt box the whole time — the list never takes it — so you can
keep typing to narrow the list down, and Tab or Enter still does what it does
above. The same is true of the **`@`** list of sessions.

## Where the list comes from

In the normal mode, switchboard builds the list itself: a built-in catalogue of
Claude Code's own commands, plus a scan of your project's and your personal
`.claude` folder. It's accurate, but the built-in half is a copy — a command
added in a newer Claude Code won't be in it until switchboard is updated.

In **[Direct mode](12-direct-mode.md)**, Claude Code tells switchboard its real
list instead, so the popup shows exactly what that version of Claude Code
actually accepts — including commands from plugins and anywhere else switchboard
can't see. Two things to expect:

- **The list only arrives after your first prompt in that session.** Claude Code
  says nothing until you talk to it. Until then you get the built-in list, which
  is nearly always the same thing.
- **A few descriptions may be blank.** Claude Code sends the command *names*;
  switchboard fills the descriptions back in from what it knows, and there won't
  be one for a command it has never heard of. The command still works.

If Claude Code's commands change while a session is running — you install a
plugin, say — the next time you open the list it's up to date. (A list that's
already open on screen doesn't change under you.)

## Clearing and compacting

There are two shortcuts for this, and they do exactly the same thing:

- **Clear conversation** — starts the context over. It asks first, since this
  can't be undone. Afterwards the Session tab shows a
  **"Conversation cleared — context starts fresh"** divider so you know it took.
- **Compact conversation** — has Claude summarize the conversation so far to
  free up context.

You'll find both on the row just under the prompt box, beside the autonomy and
model chips, as **Compact** and **Clear** — and in the **⋯** menu in the card
header under their full names. **Clear** asks you to confirm either way; on the
row the question appears in the row itself, and you answer it there.

Both simply send the real `/clear` and `/compact` to the session — the same
thing you'd do by hand, and they work the same in either mode.

## Good to know

- **`/model` and `/mcp` open switchboard's own panels**, in either mode. Type
  either one and you get a picker you can finish in — the model list comes from
  Claude Code itself, and `/mcp` opens the [MCP servers](17-mcp-servers.md)
  panel. Neither needs a terminal any more.
- **Everything else is passed straight through.** A command switchboard has no
  panel for is sent to Claude Code exactly as you typed it, and Claude Code
  answers it however it normally would. Commands it answers itself — `/usage`,
  `/cost`, `/context` — show their output in the Session view.
- **Clear and Compact are greyed out while a session is still starting, or
  once it has ended** — with a note saying which. That's true of both the
  buttons and the ⋯ menu; they're the same two actions, so they're unavailable
  at the same times and for the same reasons.
- On a narrow card the row wraps onto a second line rather than pushing
  anything off the end.
- `/clear` gives no visible reply from Claude Code itself. That's expected; the
  divider in the Session tab is your confirmation.
