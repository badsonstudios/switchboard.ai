# Sessions

> Status: draft

A **session** is one Claude Code conversation working in one project folder.
Each one gets a card in the middle of the window and a row in the Sessions list
on the left.

## Starting a session

Three ways, all equivalent:

- Click **+ session** and pick a folder.
- Drag a folder from your file manager onto the window.
- Click the **⊕** on a group header to start one inside that group (see
  [Organizing your workspace](07-workspace.md)).

If you open a second session in a folder you already have open, switchboard
adds a number to the name so you can tell them apart.

## Naming and labelling

- **Rename:** double-click the session's row in the left-hand list, type, press
  Enter. `Esc` leaves the name as it was. So does pressing Enter on an empty
  field — a session always has a name, so clearing the box is treated as
  "never mind" rather than as a new, blank name. Spaces at either end are
  trimmed off.
- **Very long names** are shortened with an `…` in the card's header, the same
  way they already were in the sessions list, so the status pill and the window
  buttons beside the name stay where you left them. Double-click the row to see
  the whole name in the rename box.
- **Task label:** click **+ task label** in the card header to note what this
  session is *for* ("fix the login bug"). It shows up in the sessions list and
  in Events, which is what makes a wall of sessions readable.
- Each session also gets a color and a short badge automatically, so you can
  recognize it without reading. The color is the stripe down the left edge of
  the card header, the dot in the sessions list — and the dot on the card's own
  **tab**. The badge is a two- or three-letter note of what the project is
  written in (`TS`, `PY`, `RS`), and it sits next to the name in those same
  places. Both are picked for you when the session starts and stay the same for
  that session, including across restarts, so "the orange one" keeps meaning the
  same session all day.

  With several cards docked side by side, the tabs are usually all you can see
  of the ones you are not looking at — so the color and badge there are what let
  you pick the right tab without reading every name. A session that has not been
  given a color yet shows a plain grey dot.

## Status at a glance

Every session shows one of these:

| Status | Meaning |
|---|---|
| **starting** | Claude Code is booting up |
| **working** | Claude is doing something — a wide "Claude is working" strip appears above the prompt box |
| **needs you** | Waiting on a permission decision |
| **needs input** | Waiting for you to answer something |
| **idle** | Ready for your next prompt |
| **done** | Finished its turn |
| **crashed** | Ended unexpectedly |
| **suspended** | Kept, but not currently running |

## Leaving and coming back

Sessions survive restarts. When you reopen switchboard, the cards are back
where you left them, and each one picks up its conversation the first time you
look at it — you'll see "Resuming…" briefly, and the full history appears in
the Session tab.

A **suspended** session is one whose pop-out window you closed. The card stays,
with a **Resume** button. Nothing is lost.

Click **Resume** and the session comes back straight away — and so does the
rest of the app's picture of it: its row in the Sessions list and its lamp in
[the strip along the top](09-notifications.md#the-lamp-strip) both stop saying
"suspended" the moment it restarts, without you clicking anything else.

## Restarting a dead session

If a session ends or crashes, the card stays put and shows **Session ended**
with two buttons: **Restart** starts it again in the same folder, **Close**
removes the card. Nothing vanishes on its own.

A session that never got going gets its **own** panel, not this one: it reads
**Session didn't start**, and the button says **Try again** rather than
**Restart** — nothing ran, so there is nothing to restart and no exit code to
report. The usual cause is that the folder the card was opened on has been
renamed, deleted, or is on a drive that isn't plugged in. See
[a card that says "Session didn't start"](11-troubleshooting.md#sessions) for
what to check.

## Pinning a session you always want to find

Some sessions are the ones you keep coming back to all day. Pin one and
switchboard stops letting anything shuffle it out from under you.

Right-click a session in the Sessions list and choose **Pin session** (or press
**`Ctrl+Alt+P`** while you're in it, or find **Pin / unpin session** in the
command palette). A 📌 appears on its row. The same gesture unpins it.

A pinned session:

- **sorts to the top** of the list, so it's always in the same place. If the
  session belongs to a group, it sorts to the top *of that group* — pinning
  promotes it, it never pulls it out of the group you filed it under, and it
  never reorders the sessions around it. On a workspace with no groups, which
  is the usual one, that means the top of the list outright — and since the
  list is what `Ctrl+1`…`Ctrl+9` counts against, your pinned session becomes
  `Ctrl+1`.
- **is never folded away.** When a pile of idle sessions collapses into a
  single "4 idle sessions" row, the pinned one keeps its own row.
- **is never minimized behind your back.** If you've turned on
  [auto-collapse or auto-hide](07-workspace.md), a pinned session ignores it
  and stays put when you send a prompt.
- **survives Close all sessions.** See below.

Pinning is *protection*, not a size. It doesn't force the session to stay big:
you can still collapse it, tab it, hide it, or let a layout mode fold it into a
strip. What pinning promises is that it will still be there, and still where
you left it in the list.

## Closing a session

Click the **✕** on the card's tab. Because this ends the session *and* forgets
it, switchboard asks you to confirm first. A closed session does not come back
next launch.

### Closing all of them at once

The command palette has **Close all sessions (keeps pinned ones)**. It asks
once — not once per session — and tells you how many it's about to close and
how many pinned ones it's keeping. Pinned sessions are left running.

There's deliberately no shortcut for it: closing everything is not something
you should be able to do by mistyping a chord.

## Good to know

- Quitting the app while sessions are mid-task pops up a warning listing them,
  with **Quit anyway** and **Cancel**. Cancel is the default.
- Closing a session clears its entries from Events.
