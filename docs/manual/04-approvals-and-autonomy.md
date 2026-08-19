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
- **Allow all (this session)** — stop asking for this session. It means it:
  from that click on, switchboard answers for you the moment Claude asks.
  Nothing appears on screen, nothing beeps, the taskbar doesn't flash, and no
  entry lands in the Events drawer. It also keeps working with the window
  minimised or closed — the answer is given inside switchboard, not by the part
  of it you can see. Resets when the session restarts.
- **Deny** — refuse. Claude is told you made the call deliberately, and that it
  should stop rather than look for another way round. It won't retry the same
  thing or reach for a different tool to get there anyway — it comes back and
  asks what you'd like instead.

If several requests pile up, they queue: the bar shows **+2 more waiting** and
advances as you answer. The card surfaces its Session tab automatically when a
request arrives, even if you were looking at the Terminal.

**You can also answer without coming back at all.** If desktop pop-ups are on
and you're in another app, the pop-up for a permission request carries **Allow**
and **Deny** of its own, and it names what it would allow. Answering it here or
there is the same decision — whichever you use, the other goes away. See
[Notifications › Answering a permission from the pop-up
itself](09-notifications.md#answering-a-permission-from-the-pop-up-itself),
which also covers what each operating system can actually put on a pop-up.

## When Claude asks you a question

Sometimes Claude doesn't want permission — it wants an answer. "Which of these
three approaches should I take?", "which of these files did you mean?" When that
happens you get a panel in the same place as the review bar, just above the
prompt box, with the question written out and its answers as a list you can
click.

- **Round buttons mean pick one.** Clicking a different answer replaces your
  first choice.
- **Square boxes mean pick as many as you like.** Click each one you want;
  click again to un-pick.
- **There is always an "Other".** Tick it and a text box opens where you can
  type your own answer in your own words. Use it whenever none of the offered
  answers is right — Claude reads what you typed exactly as if it had offered it
  as an option, and it's the honest way to say "none of these, here's what I
  actually want".

Claude can ask more than one question at once. They're all shown stacked, each
with its own tick in the corner once it's answered, and **Send answer** stays
greyed out until every one of them has an answer. Hovering it tells you why.

**Don't answer** sends your refusal back. That's a real answer and a safe one:
Claude is told you declined, and it will usually just ask again in ordinary
conversation rather than getting stuck.

Take your time over it — **a question waits as long as you need.** Unlike a
permission request, which switchboard declines for you after five minutes, a
question has no time limit at all while switchboard is open: walk away, come
back tomorrow, and it is still there waiting. Your half-finished answer also
survives leaving the panel:
switch to **Changes** to look at the diff first, come back, and your ticks and
anything you typed are still there.

### Everything works from the keyboard

Tab into the list, **Up** and **Down** move between the answers of one question,
**Space** or **Enter** picks the one you're on. Tab moves on to the next
question, and to the buttons. If you're typing in an "Other" box, **Enter**
sends the whole thing once everything is answered.

### Two things worth knowing

- **"Allow all (this session)" does not answer questions.** It's a standing yes
  to *tool use*, not a standing yes to *you*. Questions always wait for a real
  person, even in a session where you've turned everything else off.
- **Terminal-mode sessions keep their questions in the terminal.** Claude Code
  draws the question there itself, and switchboard can't reach into it — so
  you'll find it on the **Terminal** tab rather than as a panel. Switch the
  session to [Direct mode](12-direct-mode.md) to get the clickable panel.

## When several sessions ask the same thing

Run a few sessions on the same job and they tend to hit the same wall at the
same moment — all of them wanting to run `npm test`, all of them stopped.

When **two or more sessions are waiting on exactly the same request**,
switchboard puts it on one card just above the workspace instead of making you
visit each session in turn. The card says how many sessions are asking, what
they want to run, and lists them by name:

- **Allow in all N sessions** / **Deny in all N sessions** — one click, every
  session on the card answered.
- Each session also gets its own **Allow** and **Deny** next to its name, so
  you can say yes to one and no to another. Answering one leaves the rest
  exactly as they were: still waiting, still yours to decide.

While a request is on the grouped card, it is not also shown in its own
session's review bar — one question, one place to answer it. Answer or decline
one session's copy and, if that leaves only one session still asking, the card
goes away and the last question returns to that session's own bar.

Things worth knowing:

- **"Exactly the same" means exactly.** Same tool, same arguments, character
  for character. `rm -rf build` and `rm -rf /` are not the same request and
  will never share a card. Two sessions editing "the same file" in two
  different project folders are asking about two different paths, so they get
  asked separately too. The bias is deliberate: being asked twice is a small
  annoyance, and one click approving something you did not read is not.
- **One card at a time.** If a second, different group forms while a card is
  up, those sessions keep asking in their own cards until the first card is
  answered. A session that joins the group *while it is on screen* is asking
  the identical question, so it simply joins the count.
- **There is no "allow all" on the grouped card.** Every button answers only
  the requests listed on it. Standing permission is still a per-session choice,
  from that session's own bar.

A request belongs to the session that asked it. If that session ends — you hit
**Restart**, you close a popped-out window and it suspends, or it exits on its
own — anything still waiting in its bar goes with it. There is nothing left to
answer, so switchboard drops the question rather than showing it to whatever
runs on the card next.

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
- **Nothing is ever auto-approved by switchboard.** The only thing that answers
  *allow* without showing you the question is **Allow all (this session)**, and
  that is you having answered it in advance. Everything else, if it can't reach
  you, is handled by one of the two rules below — and neither of them says yes.
- **If switchboard can't reach you, it stops asking.** When does that happen?
  On **macOS**, closing the window leaves your sessions running in the
  background. On any platform, switchboard's display can crash while the
  sessions underneath it keep running. (On **Windows and Linux** closing the
  window quits switchboard, so only the crash case applies.) There is also a
  **five-minute limit** on any single request: one left unanswered that long
  counts as unreachable too. (A *question* — the kind with clickable answers —
  has no time limit at all; it waits for you. See [When Claude asks you a
  question](#when-claude-asks-you-a-question).)

  What happens next depends on which mode the session is in:

  - **Terminal mode** — the question falls through to Claude Code's own prompt
    in the **Terminal** tab, and is waiting for you there. Reopen the window and
    new approvals come back to the card.
  - **[Direct mode](12-direct-mode.md)** — there is no terminal prompt behind
    it. Claude Code is waiting on switchboard and on nothing else, so leaving
    the question unanswered would leave the session stuck for ever. Switchboard
    **declines** it instead, and tells Claude plainly that nobody was available
    rather than that it was blocked — so it stops and asks again rather than
    hunting for a way round. You'll see it come back as a normal request the
    next time you're there. If you want a session to keep going while you're
    away, turn on **Allow all (this session)** before you leave.
- **A question can't outlive the session that asked it.** If a session dies
  while an approval is on screen, the question dies with it — nothing is left
  waiting on an answer that can no longer go anywhere. Starting the card again
  clears the bar and begins fresh.
- **full-auto** is shown in red as a reminder.
