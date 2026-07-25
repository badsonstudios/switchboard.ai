# Slash commands

> Status: draft

Claude Code's slash commands work from switchboard's prompt box, with
autocomplete.

## Autocomplete

Type **`/`** at the start of a line and a list appears:

- **↑ / ↓** to move through it.
- **Enter** or **Tab** to insert the highlighted command.
- **Esc** to dismiss.

The list covers Claude Code's built-in commands *and* your own — project
commands and skills from the folder this session is running in, plus your
personal ones. Each row is tagged with where it came from: **CLI**,
**project**, **user**, or **skill**.

A `/` typed mid-sentence is just a slash; the list only opens at the start of a
line, and it never submits your prompt while it's open.

## Clearing and compacting

The **⋯** menu in the card header has two shortcuts:

- **Clear conversation** — starts the context over. It asks first, since this
  can't be undone. Afterwards the Session tab shows a
  **"Conversation cleared — context starts fresh"** divider so you know it took.
- **Compact conversation** — has Claude summarize the conversation so far to
  free up context.

Both simply type the real `/clear` and `/compact` into the session — the same
thing you'd do by hand.

## Good to know

- Commands that open their own picker (`/model`, `/mcp` and friends) finish in
  the **Terminal** tab. switchboard sends the command; you make the choice
  there.
- The ⋯ menu is greyed out while a session is still starting, or once it has
  ended — with a note saying which.
- `/clear` gives no visible reply from Claude Code itself. That's expected; the
  divider in the Session tab is your confirmation.
