# Choosing a model

Every session runs on a model — Opus, Sonnet, Haiku and so on. You can change
which one a session is using without restarting it or losing the conversation.

## Opening it

Type **`/model`** in a session's prompt box and press Enter.

The picker opens listing every model Claude Code will accept, with the name and
short description Claude Code itself gives each one. A **✓** marks the one this
session is running.

The command has to be on its own. `/model sonnet` goes to Claude Code as an
ordinary command, because you've asked it something more specific than "show me
the list".

## Switching

Click a model. That's it — the change takes effect immediately, for **this
session only**, and the conversation carries on where it was. There's no
restart and nothing to save.

It does **not** change what new sessions start on. That's a Claude Code setting,
and switchboard doesn't touch it.

## When nothing is ticked

You'll sometimes open the picker and see no ✓, with a line explaining why.

That's not a fault. Claude Code only says which model it's running as part of
replying to you, so a session that hasn't answered anything yet genuinely hasn't
told anyone. switchboard would rather say "not known yet" than tick a likely
guess and be wrong about the one thing you opened this to find out.

Two ways to clear it up: pick a model (then it's ticked, because you chose it),
or send any prompt and reopen the picker.

## In Terminal mode

The picker is for sessions running in **Direct mode**, which is how sessions
start. A session you've switched to **Terminal** mode has Claude Code's own
`/model` picker available in its Terminal tab, and that one can do a little more
than this — so `/model` there goes straight to Claude Code, as it always has.

If you open the picker on a Terminal-mode session anyway, it tells you so rather
than failing silently.

## If something goes wrong

| What you see | What it means |
|---|---|
| A message in Claude Code's own words | Claude Code refused the change and said why — usually a model your account can't use |
| "Claude Code didn't answer" | The session was busy or starting up. Try again in a moment |
| "That session has stopped" | The session ended while the picker was open |
