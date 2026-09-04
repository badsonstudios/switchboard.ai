# Choosing a model

Every session runs on a model — Opus, Sonnet, Haiku and so on. You can change
which one a session is using without restarting it or losing the conversation.

There are two ways in: a **one-click menu** on the model name itself, and a
fuller **picker** you open by typing a command. They list the same models. The
menu is quicker; the picker asks you to confirm.

## The quick way: click the model name

At the bottom of a session, next to the autonomy chip, there's a small grey
button showing the model that session is running. **Click it.**

A short menu drops open — or opens upward, if the session is near the bottom of
the window — listing the models Claude Code will accept, with a **✓** on the one
you're on. **Click one and it switches straight away.** There's no OK button:
the menu closes, and the name on the button becomes the model you picked.

`Esc`, clicking somewhere else, or clicking the button again all just close the
menu without changing anything. `Tab` closes it too. You can walk it from the
keyboard with the arrow keys.

If the session hasn't answered anything yet, the button reads **model?** — you
can still open it and choose. See *When nothing is ticked* below for why.

One thing it won't do: while a switch is actually going out, the menu stays put
and won't close, and the button won't respond. That's deliberate — if Claude
Code refuses the change, the menu is where you'll be told, so it waits until
there's an answer to give you. It's normally too quick to notice.

## The fuller way: the picker

Type **`/model`** in a session's prompt box and press Enter.

The picker opens listing every model Claude Code will accept, with the name and
short description Claude Code itself gives each one. A **✓** marks the one this
session is running.

The command has to be on its own. `/model sonnet` goes to Claude Code as an
ordinary command, because you've asked it something more specific than "show me
the list".

### Switching

Click a model to select it, then press **OK**.

Clicking on its own doesn't change anything — it just marks your choice. Nothing
is sent to Claude Code until you press OK, which means **Cancel** (or `Esc`, or
clicking outside the picker) leaves the session exactly as it was. There's no
"undo" to hunt for, because nothing happened.

Once you press OK the change takes effect immediately, for **this session
only**, the picker closes, and the conversation carries on where it was. There's
no restart and nothing else to save. You'll see the new model name straight away
on the button along the bottom of the session.

If Claude Code refuses the change, the picker stays open and shows you what it
said, with your choice still selected — so you can try again, pick something
else, or cancel.

It does **not** change what new sessions start on. That's a Claude Code setting,
and switchboard doesn't touch it.

## When nothing is ticked

You'll sometimes open the menu or the picker and see no ✓, with a line
explaining why — and the button at the bottom of the session will read
**model?** rather than a name.

That's not a fault. Claude Code only says which model it's running as part of
replying to you, so a session that hasn't answered anything yet genuinely hasn't
told anyone. switchboard would rather say "not known yet" than tick a likely
guess and be wrong about the one thing you opened this to find out.

Two ways to clear it up: switch to a model (then it's ticked, because you chose
it), or send any prompt and look again.

## In Terminal mode

Both of these are for sessions running in **Direct mode**, which is how sessions
start. A session you've switched to **Terminal** mode has Claude Code's own
`/model` picker available in its Terminal tab, and that one can do a little more
than this — so `/model` there goes straight to Claude Code, as it always has.

On a Terminal-mode session the model name at the bottom is **plain text, not a
button**: switchboard can't change that session's model, so it doesn't pretend
to offer. Hover it and it tells you where the switcher is. If you open the
picker with `/model` on one anyway, that says so too, rather than failing
silently.

The name also goes back to plain text on a session that has **stopped** —
there's nothing running to switch.

## If something goes wrong

| What you see | What it means |
|---|---|
| A message in Claude Code's own words | Claude Code refused the change and said why — usually a model your account can't use |
| "Claude Code didn't answer" | The session was busy or starting up. Try again in a moment |
| "That session has stopped" | The session ended while you had it open |

Whichever way you opened it, a refusal leaves the session exactly as it was and
stays on screen so you can read it — the quick menu holds itself open for that
reason.
