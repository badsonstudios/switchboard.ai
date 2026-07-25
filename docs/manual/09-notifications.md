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
