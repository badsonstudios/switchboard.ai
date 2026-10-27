<p align="right"><a href="contents.md">☰ Contents</a></p>

# Switching a session to another AI

> Status: draft

A session can move from one AI to another, for example from Claude Code to
Codex, without opening a new card. The first time you move a card to an AI,
that AI is **handed a summary** of the conversation so far, so it knows what
you were doing. If you move the card back later, the first AI picks up its own
conversation, exactly where it stopped.

## Switching

1. In the session's composer, find the **AI chip**. It sits just before the
   model chip and shows the AI's icon and name, for example **Claude Code**.
2. Click it. The **AI for this session** menu opens. Each AI is listed with
   whether it is logged in, and as which account when it says. The AI the card
   is on now has a tick.
3. Click another AI. The card's session closes and a session on the new AI
   starts in the same card.
4. A line across the conversation marks the switch, for example
   **Claude Code → Codex · 2:41 PM · handed a summary of 14 turns**.

You can also use the keyboard. Tab to the chip and press Enter. The arrow keys
move through the list, Enter picks an AI, and Escape closes the menu.

## What the new AI is told

On a first switch, the new AI's first message is a **summary of the
conversation it did not see**. It is put together from the conversation
itself. No AI writes it, so it costs nothing extra and works even when the
other AI has run out of usage. It holds:

- **the goal**: your first message in the conversation;
- **what you asked for along the way**: your later messages;
- **the plan**: the to-do list, if the AI kept one;
- **the files touched**: which files were read or changed;
- **the recent activity**: the last stretch of the conversation;
- **where it left off**: the last thing the AI said and did;
- **the next step**: the open to-do item, or your last request;
- **what does not carry over**: see below.

The summary also tells the new AI three things plainly:

- **It is picking up someone else's work.** It has seen only the summary, not
  the conversation.
- **Which instruction files apply.** For example, Claude Code reads
  `CLAUDE.md` and Codex reads `AGENTS.md`. If the project has a `CLAUDE.md`,
  the summary says Codex will not read it on its own.
- **Not to start work yet.** It replies with a sentence or two about where
  things stand, then waits for you.

The summary is also on screen. It appears as your first message on the new
AI, folded so it does not fill the view. The new AI's short reply follows it.

## See what it was told

Click **see what it was told** on the switch line. A window opens with the
exact text the new AI was given, character for character.

From the keyboard: Tab into the conversation, use the arrow keys to reach
**see what it was told**, and press Enter. It is one of the stops the arrow
keys visit, like **Show summary** on a compaction line, so it never adds a
Tab press between you and the message box. When the window closes, you are
back on the link and the arrow keys carry on from there.

- **Copy** puts the text on the clipboard.
- **Escape** or **Close** shuts the window.

The text is kept, so it is still there after you restart the app. If it has
been removed, for example because the card was closed and opened again, the
window says **The briefing text is no longer available.**

## The switch line

The line across the conversation says what happened when the card arrived:

- **handed a summary of N turns**, with **see what it was told**: a first
  switch. The new AI was briefed. A faint line above it says how many turns
  happened with the other AI. They are not shown here; switch back to see
  them.
- **picked up where it left off**: you switched back to an AI this card has
  used before. It went back to its own conversation, and nothing was handed
  over.
- **started fresh, no summary**: there was nothing to hand over, for example
  because the other AI had not been asked anything yet.

If a summary could not be made or sent, the line says **could not brief
<AI>; it started without context**. The new AI still starts. Tell it what you
were doing.

## Switching back

Open the menu again and pick the AI you came from. The card goes back to the
conversation it had with that AI. Its history is on screen again, and the AI
carries on as though it had never stopped. Switching back never sends a
summary: that AI already has its own conversation.

Each card keeps one conversation per AI, so you can go back and forth as
often as you like.

**Coming back does not tell the first AI what happened while you were away.**
For example, if Codex changed files, Claude finds the changes on disk but has
not been told about them. Say so in your next message.

## If a turn is running

If the session is in the middle of a turn, or waiting for your answer,
switching would stop it. So the menu asks first: **Switching stops the current
turn. Switch anyway?**

- **Cancel**, Enter or Escape leaves everything as it was. The turn keeps
  running.
- **Switch anyway** stops the turn and switches. The button only becomes
  usable a moment after the question appears, so a stray double-click cannot
  press it.

## What carries over, and what does not

**Carries over:**
- the card itself, with its folder, name, colour and mode;
- on a first switch, the summary described above.

**Does not carry over:**
- **the other AI's memory of the conversation.** The new AI has the summary
  and nothing more. It has not seen the conversation, so check anything that
  matters.
- **MCP servers, permissions and hooks.** These belong to the AI they were
  set up for. The summary tells the new AI so.
- **Instruction files.** Each AI reads its own: Codex reads `AGENTS.md`, and
  Claude reads `CLAUDE.md`. See [Using Codex](23-using-codex.md).
- **Usage.** Usage stays with each AI. The usage line shows the conversation
  the card is in now, and switching back brings back that conversation's
  totals.

## AIs you have not set up

An AI that this computer does not have is listed but greyed, with **set it
up…**. Clicking it, or **Manage AIs…** at the foot of the menu, opens
Settings. An AI whose program could not be found is still offered, marked
"Not found on this computer — it may not start". If it does not start, the
card says so and offers **Switch back to …**.

## Good to know

- **Switching back never makes a new conversation.** The card goes back to the
  one it had. Only the first switch to an AI starts a new one, and that is the
  one that gets the summary.
- **The switch lines are saved.** They are still there after you restart the
  app, and so is what each AI was told.
- **Nothing is deleted.** The conversation you switch away from stays in that
  AI's own history, and the card goes back to it when you switch back.
- **The summary covers the recent part of a long conversation.** A very long
  conversation is summarised from its recent end, and the summary says so.

## If something goes wrong

- **The card says the session did not start after a switch.** That AI could
  not be started here. Press **Switch back to …** to go back to the AI you came
  from, in its own conversation, or **Try again**.
- **Switching back shows an empty conversation.** That AI could not find the
  conversation any more, for example because its history was deleted. The card
  starts a new conversation with it instead.
- **The new AI starts acting on the summary straight away.** The summary asks
  it to wait, but an AI may not listen. Stop it the usual way.

---

[← Back to Contents](contents.md)
