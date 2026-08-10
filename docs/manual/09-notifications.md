# Notifications & events

> Status: draft

The point of switchboard is knowing *which* session needs you without being
nagged about the ones that don't.

## The Events panel

Down the right-hand side: one entry per session, showing its latest state —
never a scrolling log you have to keep up with. Each entry shows the session's
name and task label, so you know what it is without decoding an ID.

- **Click an entry** to jump straight to that session.
- **✕** dismisses it.
- Entries read **needs permission**, **needs input**, **crashed**, or **Done.**
  A finished session relaxes from **Done.** to **Ready** once you've looked at
  it.
- When nothing is outstanding it says **Nothing needs you right now**.

Closing a session clears its entries. So does starting it again: a **crashed**
entry goes as soon as a fresh session takes its place, whether you restarted it
yourself or just came back to the card.

## The panel is a to-do list, in order

Entries aren't listed newest-first — they're listed **in the order you should
deal with them**:

1. **Needs permission** — Claude is blocked on your answer.
2. **Needs input** — Claude has asked you something.
3. **Crashed** — the session died.
4. **Done.** — finished, and you haven't looked yet.

Within each group, whoever has been waiting longest is higher up. Sessions
you've already reviewed (**Ready**) sink to the bottom and fade back — they're
history at that point, not work.

The entry marked **next** is where **`Ctrl+Space`** will take you; press it
again and the marker moves down to the following one. Clicking an entry counts
the same way, so the shortcut won't bounce you back to something you just
opened. See [Keyboard & commands](06-keyboard.md) for the full walk-through.

### A session you've told to stay quiet

If you've set a session's interrupt setting to **Never jump, skip the queue**
([Organizing your workspace](07-workspace.md#when-a-session-interrupts-you)),
its entries still appear in this panel — the panel is the log — but it is never
marked **next** and `Ctrl+Space` walks straight past it. That's the difference
between the log and the to-do list.

## The lamp strip

Across the top of the window, under the title bar, there's a thin row of
**lamps** — one per session, always there.

Each lamp is a small dot plus the session's name, and the dot is colored by what
that session is doing right now:

| The lamp | It means |
|---|---|
| a hollow ring, name in grey | calm — working, idle, or suspended |
| a **filled** dot, name in bold and tinted | it needs you |

The filled-versus-hollow difference is deliberate: you can read the strip
without relying on the color at all. At the right-hand end it totals things up
— **"2 need you"**, or **"all calm"** when nothing is outstanding.

**Click any lamp to jump to that session.** If you'd hidden its card, clicking
the lamp brings it back to exactly where it was. If the session is in its own
pop-out window, clicking the lamp raises that window rather than pulling the
card back into the main one.

The strip never goes away. Hide the sessions list, switch a card to its
Terminal, take a card out of the workspace entirely — the lamps stay put. It's
the one place that always shows you every session you have, so you never have to
wonder whether something is out of sight and shouting.

### The lamp that called you stays lit

When you press **`Ctrl+Space`** to jump to whatever needs you next, you arrive
at a session — but which one was it? By the time the screen has changed, the
thing that told you is gone.

So it isn't. The lamp you were just sent to gets a **ring around it for about a
second and a half** after you land, then quietly fades out. Long enough to see
where you were sent, short enough not to become part of the furniture.

The second and a half is counted **from the moment the ring is actually on your
screen**, not from the moment you pressed the key. If the machine is busy and
the window takes a while to catch up, you still get the full beat once it does —
you never arrive to find that the thing meant to show you where you are has
already come and gone. A ring that hasn't appeared yet waits for the window to
come back rather than counting down behind your back; once it's up, it fades on
its own schedule like anything else.

Nothing on the strip blinks or animates for attention. It's a readout, not an
alarm.

## What you'll hear and see

By default, when a session needs permission, needs input, finishes, or crashes:

- **A sound plays.**
- **An entry appears in Events.**
- **The taskbar icon flashes** — but only if the switchboard window is in the
  background. It stops as soon as you come back.

**Desktop pop-up notifications are off by default.** The sound plus the Events
panel is the calm default; pop-ups are opt-in.

Turn the whole lot off with the **🔔 / 🔕** chip in the title bar.

## Good to know

- Notifications never interrupt a session. If notifying fails for any reason,
  the session carries on regardless.

TODO: quiet hours are supported internally but have no settings screen yet.
TODO: per-session "notify when done", Events filters, and the rules engine
(sounds per session, phone push, webhooks) are planned, not shipped.
