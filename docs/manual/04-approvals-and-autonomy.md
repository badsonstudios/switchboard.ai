# Approvals & autonomy

> Status: draft

When Claude wants to run a command or change a file, switchboard can ask you
right inside the session card — no window switching, no hunting for which
terminal is blinking.

## Answering a request

A review bar appears just above the prompt box: **Allow \<tool\>?**, with what
it wants to do — the command, or the before-and-after of a file edit.

Three buttons:

- **Allow** — this one time.
- **Allow all (this session)** — stop asking for this session. Resets when the
  session restarts.
- **Deny** — refuse. Claude is told you made the call deliberately, and that it
  should stop rather than look for another way round. It won't retry the same
  thing or reach for a different tool to get there anyway — it comes back and
  asks what you'd like instead.

If several requests pile up, they queue: the bar shows **+2 more waiting** and
advances as you answer. The card surfaces its Session tab automatically when a
request arrives, even if you were looking at the Terminal.

## Autonomy modes

Each session runs at one of four levels. Click the shield chip under the prompt
box to cycle it.

| Mode | What it stops for |
|---|---|
| **ask** | Commands and file changes both need your OK. The safe default. |
| **plan** | Claude researches and proposes, but writes nothing. |
| **auto-edit** | File edits happen freely; commands and web fetches still ask. |
| **full-auto** | Nothing asks. Use deliberately. |

Under **ask** and **auto-edit**, switchboard also asks before Claude reads
files *outside* the session's folder — mirroring what Claude Code does on its
own.

Changing the mode applies **the next time the session starts or resumes** —
Claude Code can't switch modes mid-flight. The chip in the title bar sets the
mode that *new* sessions start at; each session keeps its own after that.

## Good to know

- **Plan mode never asks in-app, on purpose.** Approving in switchboard would
  override Claude Code's own plan-mode write block, so plan sessions are left
  entirely to the CLI's enforcement.
- **Nothing is ever auto-approved by switchboard.** If it can't ask you — the
  app is closing, something broke, you didn't answer in time — the question
  falls through to Claude Code's own prompt in the **Terminal** tab. You may
  have to look there, but you'll never find something approved behind your back.
- **full-auto** is shown in red as a reminder.
