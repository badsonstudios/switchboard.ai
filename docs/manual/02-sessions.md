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

Every new session starts in [**Direct mode**](12-direct-mode.md): switchboard
talks to Claude Code without a terminal, so permission requests are answered
here in the card instead of escaping into a terminal prompt. The trade is that
there's no Terminal tab to use — if a particular session needs one, switch that
session to Terminal mode from its **⋯** menu and the choice sticks.

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
  in Events, which is what makes a wall of sessions readable. If you don't write
  one, it fills itself in — see below.

### The label writes itself

Claude Code gives every conversation a short title of its own — the same thing
you see on the tab in the VS Code extension. If you haven't typed a task label,
switchboard shows that title instead, so a wall of cards reads "Add markdown
preview", "Fix the login redirect", "Review the migration" rather than three
copies of your project's folder name.

Things worth knowing:

- **It usually turns up a turn or two after your first prompt**, not instantly —
  Claude names the conversation once it has something to name. Sometimes much
  later. The space is reserved either way, so nothing on the card jumps when it
  arrives.
- **It keeps up.** Claude sometimes rewords its title as the work becomes
  clearer, and the label follows.
- **Anything you type wins, permanently.** The moment you type a label it is
  yours, and no title from Claude will ever replace it — including after a
  restart.
- **Clearing the box hands it back.** Delete what you typed and press Enter, and
  the label goes back to filling itself in. (Leaving it blank on purpose is not
  the same as never having typed in it — that is why clearing is the way back
  rather than "is it empty?")
- **No title, no label.** If Claude never names the conversation, the card looks
  exactly as it did before this existed: the folder name, and **+ task label**
  waiting for you.
- **It costs nothing.** switchboard is already reading the transcript file; it
  reads one more line out of it. Nothing is sent anywhere, and it does not spend
  a single token of your plan.
- **Other tools may not have it.** This works for any CLI that writes a title of
  its own. One that doesn't simply has no auto label — nothing breaks.

### Turning it off (screen-sharing)

The label is derived from your conversation, so it can put a phrase from your
prompt on screen — on the card, in the sessions list, and in desktop
notifications. If you're presenting or sharing your screen, click the **🏷 auto
labels** chip in the title bar to turn it off.

Off means: every auto-filled label disappears at once, desktop notifications go
back to using the session's name, and no new ones are filled in. **Labels you
typed yourself are never hidden** — those are your words, not Claude's. Click
the chip again and the auto labels come straight back; nothing was thrown away.
- Each session also gets a color and a short badge automatically, so you can
  recognize it without reading. The color is the stripe down the left edge of
  the card header, the dot in the sessions list — and the dot on the card's own
  **tab**. The badge is a two- or three-letter note of what the project is
  written in (`TS`, `Py`, `Rs`), and it sits next to the name in those same
  places — **filled in the session's own color, with dark lettering on top**, so
  it is a second place the color shows up rather than a second thing to read.
  Both are picked for you when the session starts and stay the same for that
  session, including across restarts, so "the orange one" keeps meaning the same
  session all day.

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

The card keeps its **header** the whole time — the session's name, its colour
and badge, and one word for what happened: *crashed*, *done*, or *not started*.
That's not decoration: the header is what you double-click to
[maximize](07-workspace.md#maximize) a session, so a dead card can be enlarged
and put back exactly like a live one.

A session that never got going gets its **own** panel, not this one: it reads
**Session didn't start**, and the button says **Try again** rather than
**Restart** — nothing ran, so there is nothing to restart and no exit code to
report. The usual cause is that the folder the card was opened on has been
renamed, deleted, or is on a drive that isn't plugged in. See
[a card that says "Session didn't start"](11-troubleshooting.md#sessions) for
what to check.

**With a screen reader, these panels are read out when they appear** — you
don't have to be on the card to find out. Each one gives the session's name
first and then what happened, so with several cards up you hear *"trading-app.
Session ended. Exited unexpectedly (code 137)."* rather than an anonymous
"Session ended". The same goes for a card going **suspended**. It's polite
rather than urgent: it waits for a gap instead of cutting across what you were
reading. A card that was already suspended when you reopened switchboard stays
quiet — that's how you left it, not something that just happened.

## Putting sessions in the order you want

The Sessions list starts out in the order you opened things, which is rarely the
order you *think* about them in. Drag a session up or down and it stays where
you put it.

- **With the mouse:** pick up a session's row and drag it over another row in
  the same group. A line shows where it will land — above that row if you're in
  the top half of it, below if you're in the bottom half. Let go.
- **Without the mouse:** right-click the row (or press `Shift+F10` while it's
  focused) and choose **Move up** or **Move down**, under *Order in this group*.
  Or press **`Ctrl+Alt+↑`** / **`Ctrl+Alt+↓`** while you're in the session —
  the same two commands are in the command palette as *Move session up/down in
  its group*.

The order is saved with your workspace, so it's still there next time you open
switchboard. It's also what `Ctrl+1`…`Ctrl+9` counts against, so arranging the
list is a way of choosing which session is `Ctrl+1`.

A few things worth knowing:

- **You're ordering one group at a time.** Dragging a session onto a *different*
  group still means what it always meant — it joins that group. Where it lands
  there is up to you: drag it again once it has arrived. The same goes for the
  **Ungrouped** list, and for the automatic folder groups: each keeps its own
  order.
- **A new session goes to the bottom** of a group you have arranged. Nothing you
  already put in order moves out of the way for it.
- **Pinned sessions still come first.** This is the one rule your arrangement
  doesn't beat: a [pinned](#pinning-a-session-you-always-want-to-find) session
  stays at the top of its group. You can reorder freely among the pinned ones
  and freely among the rest, but you can't drag an ordinary session above a
  pinned one — it stops just underneath, and **Move up** goes grey at that
  point. If you want it higher, unpin the one above it.
- **Nothing reorders itself.** A session needing your attention gets loud — a
  tinted row, a colored bar, a place in the `Ctrl+Space` queue — but it does not
  jump the list. Where you put a session is where it stays.

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
  never reorders the sessions around it — including an order you arranged
  yourself, which it sits on top of rather than scrambling. On a workspace with
  no groups, which
  is the usual one, that means the top of the list outright — and since the
  list is what `Ctrl+1`…`Ctrl+9` counts against, your pinned session becomes
  `Ctrl+1`.
- **doesn't scroll away.** Once you have more sessions than fit, the list
  scrolls — and a pinned session stays parked at the top of it while the others
  slide underneath. Pin two and they park as a pair, in the order they're in.
  One caveat if you use groups: a pinned session sticks to the top *while its
  group is on screen*. Scroll past the whole group card and its pinned sessions
  go with it, because pinning promotes a session inside its group rather than
  lifting it out of it. On a workspace with no groups — the usual one — there's
  no caveat: it's on screen wherever you scroll to.
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
