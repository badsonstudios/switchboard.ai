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
**Open changes**, **Rename**, **Close session**, and
[what this session does when you submit a prompt](#changing-it).

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
- **Set what its sessions do on submit:** the **⬍** on the group header —
  see [Getting out of the way by itself](#getting-out-of-the-way-by-itself).
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

## Getting a session out of the way

A session you're not watching right now doesn't have to take up space. Every
session sits on a **ladder** with four rungs, and you can move it down a rung at
a time as it needs less of your attention — and back up again in one click.

| Rung | What you see | Space it takes |
|---|---|---|
| **Expanded** | the full card, where you put it | its own spot in the grid |
| **Collapsed** | one slim row in the **Collapsed** strip near the top | almost none |
| **Tabbed** | stacked as a tab with the other tabbed sessions | shares one spot |
| **Hidden** | nothing but its row in the Sessions list | none at all |

**None of these stops anything.** At every rung the session keeps working, its
conversation is untouched, and it stays in the Sessions list on the left with
its status indicator. Only the card changes. Closing a session is a completely
separate thing — it's the **✕**, and it asks first.

### Moving up and down

- **Down a rung:** `Ctrl+Shift+↓`, or the **▁** button in the card's header
  (which collapses it straight away).
- **Up a rung:** `Ctrl+Shift+↑`.
- **Straight to a rung:** open the command palette (`Ctrl+Shift+P`) and run
  **Collapse session to a strip**, **Stack session with the tabbed sessions**,
  **Expand session to its full card**, or **Hide session (keeps it running)**.

The two shortcuts act on the session you're currently *in*, so they work from
the **Expanded** and **Tabbed** rungs — the two where the session still has a
card to be focused. Once a session is collapsed or hidden it isn't focused any
more, so bring it back with a click (its row in the Collapsed strip, the
Sessions list, or its lamp) and carry on from there. Nothing becomes
unreachable: the palette can put any focused session on any rung by name.

The **Collapsed** strip appears near the top of the window only when something
is actually collapsed, and disappears again when nothing is. Each row shows the
session's color, its name and what it's doing. Click a row to bring that session
straight back.

### Coming back

Click a session anywhere and it returns: its row in the Sessions list, its row
in the Collapsed strip, its lamp in
[the strip along the top](09-notifications.md#the-lamp-strip), or its entry in
Events. It comes back to the **exact spot it left** — the same position among
its neighbours, on the same view tab you had open, and if it was in its own
window, back into one. If the layout around it has changed enough that its old
spot no longer exists, it comes back into the main grid rather than nowhere.

**A session that needs you comes back on its own.** If it asks permission, asks
a question, or finishes while it's collapsed, tabbed or hidden, its card
reappears in its old spot without you doing anything.

It reappears *without stealing your place*. Whatever you were typing in stays
focused — the returning card waits for you rather than grabbing the screen. Its
lamp and the Events list are what tell you it's waiting.

Where a session sits on the ladder is remembered across restarts: sessions come
back collapsed, tabbed or hidden exactly as you left them. One thing
deliberately doesn't carry over — sessions that were *already* waiting on you
when you quit stay where you put them at the next launch, instead of the
workspace unfolding itself the moment it opens.

## Getting out of the way by itself

Most of the time you don't move a session down the ladder because you decided
to — you move it because you just gave it something to do and you're going to
go look at something else. So switchboard can do that part for you, if you ask
it to.

**Out of the box it doesn't.** Send a prompt and the card stays exactly where it
is, so you can watch the turn come in. Turn one of the other two settings on and
sending a prompt gets that card out of your way by itself:

| Setting | When you submit a prompt |
|---|---|
| **Keep visible** | nothing happens — the card stays exactly where it is *(default)* |
| **Collapse on submit** | the card becomes a row in the Collapsed strip |
| **Hide on submit** | the card leaves the workspace entirely |

With either of those on, the session keeps running and **its card comes straight
back to the spot it left** when it finishes, asks a question, or asks permission
— the same reappearance described under *Coming back* above.

**Collapse on submit** hands the space to the sessions you're still looking at
while leaving a row you can see and click. **Hide on submit** is the tidiest and
the least forgiving: the session vanishes from the workspace and lives only in
the Sessions list, its lamp and Events — until it needs you, at which point it
comes back like everything else. It suits running six or seven agents at once.
**Keep visible** is the default because watching your first prompt actually run
matters more than the space it takes.

### Changing it

- **For everything:** the **⬍** chip in the title bar. Click it to cycle through
  the three; the label always says which one you're on.
- **For one session:** right-click its row in the Sessions list. The **ON
  SUBMIT** section at the bottom of the menu has all three, plus **Follow the
  default** — which is how you go back to whatever the global setting is,
  including after you change it later.
- **For a group:** the **⬍** button on the group header cycles that group's
  setting. It's dimmed while the group is just following the default. (Only on
  groups *you* made — [automatic groups](#automatic-groups) have nothing to
  configure, which is why they have no buttons at all.)
- **From the keyboard:** the command palette (`Ctrl+Shift+P`) has all of them,
  at all three levels — search for *on submit*. (The group entries act on
  whichever session you're currently in, so they still work with the Sessions
  list hidden.)

The most specific setting wins: a session's own choice beats its group's, which
beats the global one. All of it is remembered across restarts.

### What it won't do

- **It won't touch a session you've popped out into its own window.** Putting a
  session on a second monitor is a stronger statement than a global default, and
  closing that window on every prompt would be obnoxious. Collapse it by hand if
  you want to.
- **It won't push a session further down than it already is.** If a session is
  already collapsed, submitting from it doesn't then hide it.
- **It won't move a session that's waiting on you.** If a session is holding a
  permission or has asked you a question, its card stays where it is when you
  type at it — the one card that needs you is the one card this never takes
  away.
- **It only sees prompts you send from the composer.** If you type directly into
  a session's Terminal tab, that's between you and the CLI — switchboard isn't
  reading your keystrokes, so it can't know you submitted anything.
- **It isn't triggered by the ⋯ menu.** Running `/compact` or `/clear` from the
  session controls isn't "submitting a prompt", and the workspace folding away
  because you picked a menu item would be baffling.

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

## When your workspace can't be saved

Everything on this page is kept in one file, and switchboard writes it as you
go. Occasionally it won't — and when that happens it says so in plain words
across the top of the window, in a strip you can't dismiss: **nothing in this
workspace will be saved**, because its file was written by a newer version of
switchboard.

This happens when you've gone **back to an older version of switchboard** after
using a newer one: a newer version can put things in that file that an older one
has never heard of. Rather than quietly rewriting it and deleting those, the
older version reads what it recognizes, shows you your sessions, and then
refuses to write the file at all.

**What still works:** everything. Your sessions run normally, you can open new
ones, rearrange cards, make groups — none of it is blocked.

**What doesn't:** none of it survives. Not the layout, not new groups, not the
sessions you opened, not settings like the theme. When you quit, the file on
disk is exactly as it was, so the next launch brings back the workspace from
before, not the one you just built. That's the trade the banner is warning you
about: the file is safe, this session's work on it is not.

**What to do:** go back to the newer version of switchboard, and the banner is
gone — it saves again as normal.

If you'd rather stay on the older version and are happy to lose that layout,
close switchboard and move its `workspace.json` somewhere else — the next launch
starts fresh, with an empty workspace it *can* save. On Windows it's in
`%APPDATA%\switchboard`, on macOS `~/Library/Application Support/switchboard`,
and on Linux `~/.config/switchboard`. Move it, don't delete it: it's the only
copy of the layout the newer version had.

## Good to know

- Everything in this page persists across restarts: layout, groups, collapse
  state, the width of the sessions list, pop-out positions, where each session
  sits on the ladder, each card's view tab, and focus.
- The only thing that moves in the sessions list is the working ring. Nothing
  blinks or pulses — if something has caught your eye there, it's because a
  session genuinely changed state.
