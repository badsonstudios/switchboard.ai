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
| **not started** | Nothing ever ran in this card — see below |

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

Either way the card keeps its **header** — the session's name, its colour and
badge, the same strip every other card wears. A card that never started shows the
words *not started* there. Until recently that one card had no header at all,
which made it the only thing on screen you could not tell apart from another one
like it.

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
  One caveat once the list has group cards in it — whether you made them or
  switchboard did, since two sessions in one repo
  [group themselves](07-workspace.md): a pinned session sticks to the top *while
  its group card is on screen*. Scroll past the whole card and its pinned
  sessions go with it, because pinning promotes a session inside its group rather
  than lifting it out of it. With no groups at all there's no caveat: it's on
  screen wherever you scroll to.
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

## Sessions can see each other

Every session you open can find out about the others. You don't switch anything
on and there's nothing to configure — ask a session about another one in plain
English and it can go and look.

There are three things a session can find out:

- **Which sessions are open** — their names, the folder each one is working in,
  and whether it's busy, waiting or finished.
- **What another session has been doing** — the recent part of its
  conversation, including the prose it wrote and the tools it ran.
- **What another session has changed** — the edits it has made in its own
  project folder that aren't committed yet, as a diff.

So you can say things like *"what has Homebrew been working on?"* or *"look at
the changes PropaneMon made and tell me if they'd break my build"*, and the
session goes and reads it rather than making you copy anything across.

Name the other session the way it's named on its tab. If two sessions happen to
share a name — two checkouts of the same repo is the usual way that happens —
you'll be told they're ambiguous and shown both, rather than being given a
confident answer about the wrong one.

**What it deliberately can't do:**

- **Reading never changes anything.** Looking at another session doesn't touch
  its files or its conversation. Sending it a message is the one exception, and
  it has its own rules — see [Sessions can message each
  other](#sessions-can-message-each-other) below.
- **It reads recent work, not everything.** Conversations get very long, and
  handing one session another's entire history would fill up its head and leave
  no room to think. So you get the recent end, and the session is told plainly
  that there was more.
- **Very long individual messages are shortened**, and a huge diff is cut off.
  A session is always warned that shortening can happen, so it doesn't mistake
  a clipped tool output for the whole story — though for that particular kind of
  clipping it can't be told exactly where. When *earlier activity* is dropped,
  or a diff is cut, it is told outright.
- **Brand-new files that have never been added to git don't show up** in a diff
  — that's how git itself works, and the session is reminded of it.
- **A session can have at most four of these requests going at once.** One
  session normally asks one thing at a time; it takes several helpers working in
  parallel to hit this. The fifth is turned away with a note to wait for one to
  finish, rather than piling work onto the app while you're using it.
- **A look at another session's changes gives up after ten seconds** and says
  so. That only happens on an enormous change set or a disk that has stopped
  responding.

If a session says it can't reach switchboard, look at the **switchboard** row
in that session's `/mcp` panel — see
[MCP servers](17-mcp-servers.md#the-switchboard-server). Everything else in the
session keeps working normally either way; this is an extra, and it never gets
in the way of the work.

## Sessions can message each other

A session can also **send a message to another one** — to pass on something it
found, ask a question, or hand over a piece of work. You can ask for it in plain
English (*"tell PropaneMon the regulator is the fault"*), or a session may
decide to do it on its own.

**By default, nothing is sent without you.** The message lands in the other
session's prompt box as a highlighted block that says **From @** and the name of
the session that wrote it. It just sits there until you decide:

- **Press Enter** to send it. Anything you've typed in the box goes along with
  it, after the message — so you can add *"do this, but skip the second part"*.
  The session that receives it is told the message came from another session and
  that you passed it on.
- **Click the ×** on the block to throw it away. Nothing is sent.

This is on purpose. Two sessions that could make each other act without you
could keep answering each other for ever, spending your usage while nobody is
watching. Needing your Enter is what stops that.

A few details keep that Enter honest:

- A message that appears **a moment before** you press Enter on your own prompt
  isn't sent with it — you haven't read it yet. It stays in the box for your
  next Enter.
- If what you typed is a **slash command** (like `/compact`), the command goes
  on its own and the messages stay waiting.
- Messages can't contain hidden control characters — the kind that could type
  extra keys into a Terminal-mode session or make text display differently from
  what is actually sent. A session that tries is told to send plain text.

### How you know one is waiting

You don't have to be looking at a session to find out it has a message.

- **The sessions list on the left** shows a small number on that session's row —
  whether the session is open, collapsed, hidden, or showing its Terminal or
  Changes tab.
- **The group heading** shows a "waiting" count too, so a collapsed group still
  tells you there's something inside it.
- **The session's own Session tab** shows the same number when the session is
  open but you're on one of its other tabs.

(If you've hidden the sessions list altogether, none of these are on screen —
open it again to see them.)

They all disappear when the messages do — sent or thrown away.

A message from another session **never** flashes, makes a sound, or pulls the
session in front of what you're doing. Those are reserved for a session that
needs *you* — a question, or a permission. Another session leaving you a note
can wait until you look. It also means no session can make your screen jump by
messaging one of your other sessions.

A session can have up to 10 messages waiting; after that, the sender is told to
wait until you've dealt with them.

### Letting a session take messages without asking

For a deliberate pipeline — one session hands finished work to the next — you
can let a session take messages straight away. Open that session's **⋯** menu
and tick **Accept messages from other sessions automatically**. It's off for
every session until you turn it on, and it stays on across restarts.

Even when it's on, a message is held for you instead of sent when:

- the session is in **Terminal mode** — switchboard doesn't type into a terminal
  on its own, in case something on screen would take the keystrokes;
- the session is **waiting on you** — asking a question or wanting a permission;
- it has already taken **5 messages in the last 10 minutes** — so two sessions
  that both have it turned on can't keep messaging each other in a loop.

A message sent automatically is marked that way, so the session receiving it
knows nobody reviewed it.

### What the sending session is told

The sending session always finds out what happened: whether the message is
waiting for you, was sent, or couldn't be delivered (the other session has
ended, was closed while the message was on its way, or there's no window open
to show it). It's told not to wait for a reply
— nothing comes back automatically. If you want the answer, look at the other
session, or ask the first one to read what the other has been doing.

## Good to know

- Quitting the app while sessions are mid-task pops up a warning listing them,
  with **Quit anyway** and **Cancel**. Cancel is the default.
- Closing a session clears its entries from Events.
