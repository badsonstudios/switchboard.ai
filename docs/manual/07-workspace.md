# Organizing your workspace

> Status: draft

## The Sessions list

Down the left: every session, with its color stripe, status dot, name, and task
label. Click a row to jump to that session. Double-click to rename it.

Sessions that are suspended or not currently on screen still appear here — the
list is the complete inventory.

## Groups

Groups are folders for sessions, and they stay put even when empty.

- **Make one:** click **+ group**. It appears as a named, colored section.
- **Rename:** double-click its name.
- **Recolor:** click its colored dot to cycle through the palette.
- **Collapse:** click the header.
- **Add sessions:** drag a session row onto the group header. Its card moves to
  sit alongside its new siblings.
- **Remove a session:** drag it onto empty space in the list.
- **Start a session directly inside one:** click the **⊕** on the group header.
- **Delete:** the **✕** on the header. The sessions inside are kept — they just
  become ungrouped.

Sessions in the same repository or folder also cluster on their own, in an
italic dashed section labelled with the folder name. That's automatic, needs no
setup, and disappears when it's down to one session. Putting a session in a
real group always wins over the automatic clustering.

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
  state, pop-out positions, and focus.
