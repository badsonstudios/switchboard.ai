# 12 — Direct mode (beta)

There are two ways switchboard can talk to Claude Code. This page explains what
the second one is, why you might want it, and what you give up.

**Short version:** Direct mode fixes permission prompts that currently escape
into the terminal and ask you twice. It costs you the terminal itself. It's off
by default and you switch it on per session.

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
2. Click **Transport: Terminal** to switch it to **Transport: Direct (beta)**.
3. **Stop and restart the session.** The change applies the next time the
   session starts — a session that's already running can't switch mid-flight,
   and switchboard will tell you so rather than pretending.

The choice is remembered per session, so a session you set to Direct stays that
way next time you open it. Every session starts on Terminal unless you change
it.

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
approval and multiple-choice questions are the two being looked at. Until those
are settled, Direct mode is the right choice for a session where the `.claude`
double-prompt annoys you, and the wrong one for a session where you rely on the
terminal.

If you're not sure, leave it on Terminal. Nothing is missing there except the
one bug above.

## If something looks wrong

- **The Terminal tab is empty and says there's no terminal.** That's correct
  for a Direct-mode session. Switch back via the ⋯ menu if you need it.
- **The ⋯ menu refuses to switch.** The session is still running. Stop it
  first.
- **You switched and nothing changed.** The change applies at the *next* start.
  Stop the session and start it again.

See also: [04 — Approvals & autonomy](04-approvals-and-autonomy.md) ·
[11 — Troubleshooting](11-troubleshooting.md)
