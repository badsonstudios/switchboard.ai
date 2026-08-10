# 12 — Direct mode (beta)

There are two ways switchboard can talk to Claude Code. This page explains what
the newer one is, why it's now what you get, and what you give up.

**Short version:** Direct mode fixes permission prompts that used to escape into
the terminal and ask you twice. It costs you the terminal itself. **Every new
session starts in Direct mode**, and you can put an individual session back on
Terminal if you need one.

> **Where this is going.** Direct mode is intended to become the *only* mode.
> Once it's been properly tested in real use, Terminal mode will be removed, not
> kept as an option. Making it the default is that test: it's how the mode gets
> used in real work rather than by people who went looking for it. Nothing is
> being taken away yet — Terminal mode still fully works and is one menu click
> away — but if you're deciding where to invest your habits, invest them here.
> The list under **What you give up** is the list of things that will need a
> real replacement or an honest goodbye.

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

## You already have it

New sessions start in Direct mode. There's nothing to switch on, and the sign
you're in it is the Terminal tab: it says *"No terminal for this session."*

To check which mode a session is on, open the **⋯** menu on its header. The
entry reads **Transport: _current mode_ — switch to _the other one_** — the
first half is what the session is on now, the second half is what the click
would do.

## Switching a session (either way)

1. Open the **⋯** menu on the session's header.
2. Click **Transport: … — switch to …**.
3. If the session is running, the menu says *"Saved. This session is still
   running on the old one."* and offers **Restart session now**. Click it.

Restarting keeps the session card and its history — it just stops the CLI and
starts it again in the new mode. If you'd rather not restart right now, leave
it: the change is already saved and applies whenever the session next starts.

**Don't close the card to force a restart.** Closing a card (the ✕) forgets it
entirely, including this setting — use **Restart session now** instead.

The choice is remembered per session, so a session you put on Terminal stays on
Terminal — through a restart and through closing and reopening the app. Only
sessions that have never been switched follow the default. (This works the same
way as the autonomy setting: chosen now, applied at the next start.)

> **If you were already using switchboard before this changed:** a session you
> had explicitly set — to either mode — keeps exactly what you set. A session
> you never touched was never "on Terminal" so much as "on whatever the default
> was", and the default is now Direct, so those sessions move. If one of them
> was one you relied on the terminal for, put it back with the menu above; that
> choice then sticks.

## What you give up

**The Terminal tab stops working for that session** — there's no terminal to
show, and the tab says so. That means you lose:

- **Ctrl-R history search** and **vim mode**
- The interactive pickers for **`/resume`**, **`/rewind`** and reviewing a pull
  request from the command line
- Anything else that only exists as a full-screen terminal interface

**And the folder-trust question is never asked.** If you've turned auto-trust
off (**🔒 ask trust** in the title bar — see [Settings](10-settings.md#trusting-folders)),
a Terminal-mode session shows you Claude Code's trust prompt for a new folder
and waits. A Direct-mode session doesn't: Claude Code raises no trust question
at all outside its own terminal, so it just runs in the folder. Nothing hangs
and nothing is hidden from you — but if being asked matters for a folder, open
it once in Terminal mode.

Everything else works the same — better, in a couple of places. Your
conversation still appears in the Session view (and arrives faster; see
[Replies arrive as they're written](#replies-arrive-as-theyre-written)), prompts
still go in the same box, slash commands still work, and your usage figures and
file changes are unaffected.

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

Terminal mode remains the safe fallback, and it's still the right choice for a
session where you actually rely on the terminal — Ctrl-R history, vim mode, or a
command that opens its own picker. Put those sessions back on it. Everywhere
else, stay on Direct and tell us what breaks: that feedback is the gate on
removing Terminal mode.

## Fixed: `/usage`, `/cost` and `/context` now show their output

Commands that Claude Code answers *itself* rather than by asking Claude —
**`/usage`**, **`/cost`**, **`/context`** — used to produce no visible output in
the Session view at all. The command ran; there was simply nothing on screen.

They now print their output into the Session view like any other reply, in both
modes. (It was never really a Direct-mode fault — the output had always been
missing from the Session view, and in Terminal mode you'd see it in the Terminal
tab instead, so Direct mode only removed the place it was hiding.)

## Replies arrive as they're written

In Direct mode Claude's reply appears **a word at a time**, with a small block
cursor at the end while it's still being written — the same way it looks in the
terminal. In Terminal mode the Session view instead waits for each message to be
finished and written to disk, so replies land in chunks a moment behind.

Nothing else about the Session view changes: prompts, file edits, commands,
thinking and checklists all look and behave exactly the same in either mode.

## If something looks wrong

- **The Terminal tab is empty and says there's no terminal.** That's correct
  for a Direct-mode session, which is what a new session is. Switch it to
  Terminal via the ⋯ menu if you need one.
- **A card said it needed permission and there was nothing to answer.** Fixed.
  In Direct mode every real permission request arrives with an **Allow / Deny**
  bar attached to it, so the amber "needs permission" badge is now only ever
  shown when there is a question on screen waiting for you. Claude Code also
  sends a slower, vaguer nudge of its own a few seconds behind — sometimes after
  you'd already answered — and switchboard used to believe it. In Direct mode it
  no longer does.
- **You switched and nothing changed.** The change applies at the *next* start.
  Use **Restart session now** in the same menu — closing the card instead will
  forget the setting along with the card.
- **Claude says a request was declined and you never saw it.** Nobody could be
  asked — the window was closed or its display crashed while the session kept
  running, or the question sat unanswered for five minutes. In Direct mode there
  is no terminal prompt behind switchboard to catch it, so declining is the only
  answer that doesn't leave the session stuck for ever. Tell Claude to carry on
  and it will ask again. See
  [Approvals & autonomy](04-approvals-and-autonomy.md#good-to-know).
- **You want a session to keep working while you're away.** Turn on **Allow all
  (this session)** before you leave. In Direct mode that's answered inside
  switchboard rather than on screen, so gated calls go through with the window
  closed — and with no beep and no taskbar flash while you're at the keyboard
  either.

See also: [04 — Approvals & autonomy](04-approvals-and-autonomy.md) ·
[11 — Troubleshooting](11-troubleshooting.md)
