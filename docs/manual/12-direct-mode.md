# 12 — Direct mode (beta)

There are two ways switchboard can talk to Claude Code. This page explains what
the second one is, why you might want it, and what you give up.

**Short version:** Direct mode fixes permission prompts that currently escape
into the terminal and ask you twice. It costs you the terminal itself. It's off
by default and you switch it on per session.

> **Where this is going.** Direct mode is intended to become the *only* mode.
> Once it's been properly tested in real use, Terminal mode will be removed, not
> kept as an option. Nothing is being taken away yet — Terminal mode is still the
> default and still fully works — but if you're deciding where to invest your
> habits, invest them here. The list under **What you give up** is the list of
> things that will need a real replacement or an honest goodbye.

---

## The problem it solves

Sometimes Claude asks to edit a file inside a project's own `.claude` folder —
its settings, its hooks, a script it keeps there.

In the normal mode, that goes wrong in a specific and annoying way:

1. Switchboard shows you the approval bar.
2. You click **Allow**.
3. A few seconds later, Claude asks you *again* — in the Terminal tab.

Your first answer was thrown away. Claude Code guards its own `.claude` folder
at a level that sits above the mechanism switchboard normally uses to answer,
so the answer never counted. (This is deliberate on Claude Code's part — the
rules live in that folder, so a rule that granted write access to it would be a
way around itself.)

In **Direct mode**, Claude hands switchboard that decision properly. You answer
once, in this window, and it's honoured. You'll also see Claude's own
explanation of *why* it's asking, which the normal mode never receives.

## Turning it on

1. Open the **⋯** menu on the session's header.
2. Click **Transport: Terminal — switch to Direct (beta)**. The first half tells
   you what the session is on now; the second half is what the click does.
3. If the session is running, the menu says *"Saved. This session is still
   running on the old one."* and offers **Restart session now**. Click it.

Restarting keeps the session card and its history — it just stops the CLI and
starts it again in the new mode. If you'd rather not restart right now, leave
it: the change is already saved and applies whenever the session next starts.

**Don't close the card to force a restart.** Closing a card (the ✕) forgets it
entirely, including this setting — use **Restart session now** instead.

The choice is remembered per session, so a session you set to Direct stays that
way. Every session starts on Terminal unless you change it. (This works the same
way as the autonomy setting: chosen now, applied at the next start.)

## What you give up

**The Terminal tab stops working for that session** — there's no terminal to
show, and the tab says so. That means you lose:

- **Ctrl-R history search** and **vim mode**
- The interactive pickers for **`/resume`**, **`/rewind`** and reviewing a pull
  request from the command line
- Anything else that only exists as a full-screen terminal interface

Everything else works the same. Your conversation still appears in the Session
view, prompts still go in the same box, slash commands still work, and your
usage figures and file changes are unaffected.

## What it doesn't change

- **Nothing about your Claude subscription.** Direct mode uses the same
  installed `claude` command and the same login. No API key, no extra cost.
- **Your conversation history.** It's still written to disk in the same place,
  so resuming a session works exactly as before.
- **Any other session.** The setting is per session. You can run one session in
  Direct mode and leave the rest alone.

## Why it's marked beta

Some parts of Claude Code have no equivalent outside a terminal yet — plan-mode
approval and multiple-choice questions are the two being looked at. "Beta" means
those are still being worked out, **not** that Direct mode is an experiment that
might be withdrawn: it's the mode that's staying.

For now, Terminal mode remains the default and the safe fallback, and it's the
right choice for a session where you actually rely on the terminal — Ctrl-R
history, vim mode, or a command that opens its own picker. Use Direct mode
everywhere else, and tell us what breaks: that feedback is the gate on removing
Terminal mode.

## Known gap: some commands show nothing

Commands that Claude Code answers *itself* rather than by asking Claude —
**`/usage`**, **`/cost`**, **`/context`** — currently produce no visible output
in the Session view. The command does run; there's just nothing on screen.

This isn't really a Direct-mode fault: the output has always been missing from
the Session view, and in Terminal mode you'd see it in the Terminal tab instead.
Direct mode removed the place it was hiding. It's being fixed as part of the
next piece of work on the Session view.

Commands that go to Claude — your own skills and project commands, anything that
produces a reply — are unaffected, and so is `/clear`.

## If something looks wrong

- **The Terminal tab is empty and says there's no terminal.** That's correct
  for a Direct-mode session. Switch back via the ⋯ menu if you need it.
- **You switched and nothing changed.** The change applies at the *next* start.
  Use **Restart session now** in the same menu — closing the card instead will
  forget the setting along with the card.

See also: [04 — Approvals & autonomy](04-approvals-and-autonomy.md) ·
[11 — Troubleshooting](11-troubleshooting.md)
