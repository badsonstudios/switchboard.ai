# Organizing your workspace

> Status: draft

## The Sessions list

Down the left edge: every session you have, sorted into groups. It's built to
answer two questions without you having to read it properly — *what group is
this session in*, and *which sessions are waiting on me*.

Each session is one row: a colored bar down its left edge (that stripe is the
session's identity — the same color follows it onto its card), its name, and
underneath, whatever it's currently doing. On the right of the row, a **✕** to
close it and a small indicator of its state:

| You see | It means |
|---|---|
| a spinning ring | working — nothing needed from you |
| **?** | it asked you a question |
| **!** | it wants permission to do something |
| **✓** | it finished, and you haven't looked yet |
| **–** | idle |
| **✕** | it crashed |

**When a session needs you, the row says so in words.** It tints itself in the
status color, thickens its edge bar, bolds the name, and replaces the "what
it's doing" line with the actual ask — *Asked you a question*, *Wants
permission to run*, *Finished — review changes*, *Crashed — needs restart*.
Calm sessions stay plain and quiet. That contrast is the whole point: you
should be able to spot the ones that need you from across the room.

Each group header counts its own waiting sessions (**"2 need you"**, or
**"calm"** when none are), and the bar at the bottom of the list totals them
for the whole workspace.

Click a row to jump to that session. Double-click to rename it. Right-click for
**Open changes**, **Rename** and **Close session**.

Sessions that are suspended or not currently on screen still appear here — the
list is the complete inventory.

**Resize it** by dragging the right edge of the list. The width is remembered.
To hide it entirely, press `Ctrl+B`.

## Groups

Groups are folders for sessions, and they stay put even when empty. Each one is
a card with its own color and a **colored dot** beside its name.

- **Make one:** click **+ group**.
- **Rename:** double-click its name.
- **Recolor:** click its colored dot to cycle through the palette.
- **Collapse:** click the header.
- **Add sessions:** drag a session row **anywhere onto the group card** — the
  header, a session already in it, or the empty space inside. The card lights
  up in the group's color to show where the session will land. Its window moves
  to sit alongside its new siblings.
- **Remove a session:** drag it onto empty space in the list, outside any group.
- **Start a session directly inside one:** click the **⊕** on the group header.
- **Delete:** the **✕** on the header. The sessions inside are kept — they just
  become ungrouped.

## Automatic groups

Sessions in the same repository or folder also cluster on their own, with no
setup. These look deliberately different from the groups you make: a **solid
folder icon**, a tinted card, and the word **AUTO** in the header. No dot, and
no **⊕** or **✕** — there's nothing to configure.

**You can't drag a session into an automatic group,** and it will show you a
"no drop" cursor if you try. That isn't a bug: membership is worked out from
where the session's folder is, so there's nothing a drop could change. To move
a session, drop it on one of *your* groups, or on empty space to ungroup it.

An automatic group disappears on its own when it's down to one session, and
putting a session into a real group always wins over the automatic clustering.

Anything else collects in **Ungrouped** at the bottom — no icon, because it's
an absence rather than a thing. You *can* drop onto it, which ungroups.

(If you haven't made any groups at all, there's no heading anywhere — the
sessions are simply the list.)

## Pop-out windows

Click **⤢** in a card header to tear that session into its own window — useful
for a second monitor. The session keeps running throughout; nothing restarts.

- Click **⤡** to dock it back into the main window.
- **Closing the pop-out window** instead *suspends* the session: the card
  returns to the main window with a **Resume** button, and the conversation is
  kept.

Window positions are remembered. If a monitor is missing at startup,
switchboard rescues any windows that were on it rather than losing them
off-screen — and when that monitor comes back, Events offers a one-click
**Restore** to put the layout back the way it was. It never moves your windows
without asking.

## Rearranging cards

Drag a card's tab to split the grid, stack cards as tabs, or reorder them. The
arrangement is saved and restored next launch, along with which session you had
focused and which tab it was showing.

## When you have more tabs than fit

They wrap onto another row, so every session stays visible and one click away.
That's the default, on purpose: a session you can't see is a session you forget
about.

If you'd rather keep the tabs to a single row, open the command palette
(`Ctrl+Shift+P`) and run **Toggle tabs on multiple rows**. In single-row mode
the tabs that don't fit go behind a **⌄ N** button at the right of the strip —
click it for a list of the hidden ones, and click any entry to jump to it. Your
choice is remembered.

## Good to know

- Everything in this page persists across restarts: layout, groups, collapse
  state, the width of the sessions list, pop-out positions, and focus.
- The only thing that moves in the sessions list is the working ring. Nothing
  blinks or pulses — if something has caught your eye there, it's because a
  session genuinely changed state.
