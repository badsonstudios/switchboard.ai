<p align="right"><a href="contents.md">☰ Contents</a></p>

# Switching a session to another AI

> Status: draft

A session can move from one AI to another, for example from Claude Code to
Codex, without opening a new card. If you move it back later, it picks up the
conversation it had with that AI, exactly where it stopped.

⚠️ **Not all of it is in yet.** You can switch now, and switching back resumes.
You will NOT yet see the new AI being handed a summary of the conversation so
far, and you cannot yet see what it was told. Both come next. Until then, the
first time you switch a card to an AI, that AI starts fresh: tell it what you
were doing.

## Switching

1. In the session's composer, find the **AI chip**. It sits just before the
   model chip and shows the AI's icon and name, for example **Claude Code**.
2. Click it. The **AI for this session** menu opens. Each AI is listed with
   whether it is logged in, and as which account when it says. The AI the card
   is on now has a tick.
3. Click another AI. The card's session closes and a session on the new AI
   starts in the same card.
4. A line across the conversation marks the switch, for example
   **Claude Code → Codex · 2:41 PM**.

You can also use the keyboard. Tab to the chip and press Enter. The arrow keys
move through the list, Enter picks an AI, and Escape closes the menu.

## Switching back

Open the menu again and pick the AI you came from. The card goes back to the
conversation it had with that AI. Its history is on screen again, and the AI
carries on as though it had never stopped. A line marks where you came back.

Each card keeps one conversation per AI, so you can go back and forth as
often as you like. Each AI keeps its own conversation.

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

- **Carries over:** the card itself, its folder, its name, its colour and its
  mode.
- **Does not carry over yet:** the conversation. On a first switch, the new AI
  does not see what the other AI said. A summary for it is coming next.
- **Each AI's own rules apply.** For example, Codex reads a project's
  instructions from `AGENTS.md`, and Claude reads `CLAUDE.md`. See
  [Using Codex](23-using-codex.md).
- **Usage stays with the AI.** The usage line shows the conversation the card
  is in now. Switching back brings back that conversation's totals.

## AIs you have not set up

An AI that this computer does not have is listed but greyed, with **set it
up…**. Clicking it, or **Manage AIs…** at the foot of the menu, opens
Settings. An AI whose program could not be found is still offered, marked
"Not found on this computer — it may not start". If it does not start, the
card says so and offers **Switch back to …**.

## Good to know

- **Switching back never makes a new conversation.** The card goes back to the
  one it had. Only the first switch to an AI starts a new one.
- **The switch lines are saved.** They are still there after you restart the
  app.
- **Nothing is deleted.** The conversation you switch away from stays in that
  AI's own history, and the card goes back to it when you switch back.

## If something goes wrong

- **The card says the session did not start after a switch.** That AI could
  not be started here. Press **Switch back to …** to go back to the AI you came
  from, in its own conversation, or **Try again**.
- **Switching back shows an empty conversation.** That AI could not find the
  conversation any more, for example because its history was deleted. The card
  starts a new conversation with it instead.

---

[← Back to Contents](contents.md)
