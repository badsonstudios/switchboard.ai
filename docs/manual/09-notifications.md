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

Closing a session clears its entries.

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
