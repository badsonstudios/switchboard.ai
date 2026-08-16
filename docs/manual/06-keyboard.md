# Keyboard & commands

> Status: draft

switchboard has application-wide keyboard shortcuts for the things you do
constantly: moving between sessions, opening and closing them, and hiding
chrome. They exist so a workspace with eight sessions doesn't turn into eight
mouse trips.

On a Mac, use **⌘** everywhere this page says **Ctrl**.

## Find something in a session

Press **`Ctrl+F`** to search the session you're looking at. Type, and `Enter` /
`Shift+Enter` step through the matches; a count sits beside the box; `Esc`
closes it and puts your cursor back.

It searches the *whole* session, including the parts scrolled out of memory and
the tool output your detail level is hiding, and jumping to a match opens
whatever was folded over it. On the **Changes** tab the same key opens the diff
editor's own find. Full details: [Finding something in a session](16-find.md).

## The command palette — everything, in one list

Press **`Ctrl+Shift+P`** (or click **▸ commands** in the title bar) to open the
command palette: a searchable list of everything switchboard can do, each with
its shortcut shown next to it. Start typing to narrow it down, `↑`/`↓` to move,
`Enter` to run, `Esc` to close.

You don't have to type a command's name exactly — initials work, so `cs` finds
**Close session**.

The palette also lists your open sessions by name, so **Go to trading-app** is
a couple of keystrokes even when you can't remember which number it is.

Commands that aren't available right now still appear, greyed out, with the
reason beside them — "No session is focused", say. Nothing is ever hidden from
you; the palette is the map of what exists.

It's also the answer to "what was that shortcut again?" — you never need to
memorize this page.

## Go to whatever needs you next

Press **`Ctrl+Space`** to jump to the next session that's waiting on you. Press
it again for the one after that. With seven or eight sessions running, this —
not hunting through the grid — is how you work: it's an inbox, and you're
clearing it.

It goes in order of how much the session is holding things up:

1. **Needs permission** — Claude is blocked, waiting for you to allow or deny.
2. **Needs input** — Claude has asked you something.
3. **Crashed** — the session died and needs a restart.
4. **Done** — finished, and you haven't looked at the result yet.

Within each of those, the session that's been waiting longest comes first.

Each press takes you somewhere new rather than dropping you on the same session
twice. When you reach the end, the next press starts again from the top. If
nothing is waiting, `Ctrl+Space` does nothing at all — no jumping to a random
session just because you pressed a key.

A session leaves the queue when it stops needing you: answer its permission
prompt or reply to its question and it's gone from the list. A **Done** session
leaves as soon as you look at it.

The **Events** panel on the right is this same list, in this same order —
whichever row is marked **next** is exactly where `Ctrl+Space` will take you.
Clicking a row there counts as visiting it, so the shortcut won't send you
straight back to it.

When you land, the session's lamp in the strip along the top stays ringed for
about a second and a half — counted from when the ring appears on screen, so a
busy machine delays it rather than eating it — and you can still see *which* one
called you after the screen has changed. See
[the lamp strip](09-notifications.md#the-lamp-strip).

## Moving between sessions

| Shortcut | What it does |
|---|---|
| `Ctrl+1` … `Ctrl+9` | Jump to the 1st … 9th session |
| `Ctrl+PageDown` | Next session |
| `Ctrl+PageUp` | Previous session |

The numbers follow the **Sessions list on the left, top to bottom** — groups
first with their sessions under them, then auto-grouped sessions, then
everything else. Whatever is third in that list is `Ctrl+3`. If you have four
sessions open, `Ctrl+7` does nothing at all.

Collapsing a group hides its rows but doesn't renumber anything: sessions inside
a collapsed group still count, and jumping to one brings it up as usual.

Next and previous wrap around: from the last session, `Ctrl+PageDown` takes you
back to the first.

## Working with the focused session

| Shortcut | What it does |
|---|---|
| `Ctrl+N` | New session — opens the folder picker, in whichever window you press it (see [pop-out windows](07-workspace.md#pop-out-windows)) |
| `Ctrl+W` | Close the focused session (asks first) |
| ``Ctrl+` `` | Switch the focused session between its Session and Terminal views |
| `Ctrl+Shift+O` | Pop the focused session out into its own window, or dock it back |
| `Ctrl+Shift+↓` | Show less of the focused session — one rung down |
| `Ctrl+Shift+↑` | Show more of the focused session — one rung up |
| `Ctrl+Shift+M` | Maximize the focused session, or put the layout back |
| `Ctrl+Alt+P` | Pin or unpin the focused session |
| `Ctrl+Shift+L` | Switch the whole workspace to the next layout: Grid → Focus → Queue |
| `Ctrl+Shift+P` | Open the command palette |
| `Ctrl+Space` | Go to the next session that needs you |
| `Ctrl+E` | Show or hide the Events drawer |

`Ctrl+W` asks before it closes, because closing a session ends it and removes
its card — the same confirmation you get from the tab's **✕**.

`Ctrl+Alt+P` pins the session you're in. A pinned session sorts to the top of
the Sessions list, keeps its own row when idle sessions fold together, is never
minimized behind your back, and is skipped by **Close all sessions** — see
[Pinning a session](02-sessions.md#pinning-a-session-you-always-want-to-find).
It does not force the session to stay expanded; you can still collapse, tab or
hide it yourself.

``Ctrl+` `` is a toggle: press it once to look at the Terminal, press it again
to go straight back to the Session view. On a session in
[Direct mode](12-direct-mode.md) — how new sessions start — the Terminal tab is
there but says there's no terminal, so the toggle still works and there is
simply nothing to see.

`Ctrl+Shift+↓` and `Ctrl+Shift+↑` walk the focused session down and up the
four-rung ladder — full card, slim row, tab, gone. None of them stops the
session. They act on the session you're *in*, so once it's collapsed or hidden
it's a click that brings it back rather than a key; see
[Organizing your workspace](07-workspace.md#getting-a-session-out-of-the-way).

`Ctrl+Shift+M` blows the session you're in up to fill the workspace and folds
everything else into the Collapsed strip; press it again — or double-click the
card's header — and the workspace goes back exactly as it was.
`Ctrl+Shift+L` cycles the three
[layout modes](07-workspace.md#arranging-the-whole-workspace); the palette also
lists each one by name (**Layout: Grid**, **Layout: Focus**, **Layout: Queue**)
so you can go straight to one instead of cycling.

The rest live in the palette without a shortcut of their own: **Toggle Changes
view**; **About this build**, which tells you exactly which version you're
running (see
[Troubleshooting](11-troubleshooting.md#which-version-am-i-running)); and the
four that name a rung outright — **Expand session to its full card**,
**Collapse session to a strip**, **Stack session with the tabbed sessions** and
**Hide session (keeps it running)**.

Search the palette for **on submit** and you also get the eleven entries that set
[what happens to a card when you send it a
prompt](07-workspace.md#getting-out-of-the-way-by-itself) — three for every
session at once, and three plus **follow the default** for both the session
you're in and its group.

Search for **needs you** and you get the nine that set [what a session may do
when it wants your attention](07-workspace.md#when-a-session-interrupts-you) —
four for every session at once, and four plus **follow the default** for the
session you're in.

## Reading the conversation with the keyboard

The conversation in the Session tab is full of things that open: command boxes,
edit boxes, the **IN** and **OUT** sections inside a command box, folded
thinking, and long prompts collapsed to one line. All of them work without the
mouse.

Press **`Tab`** until the conversation gets a highlight around it — from the
prompt box, `Shift+Tab` a couple of times gets you there. A short reminder of
these keys appears in the strip above the conversation while you're in it. Then:

| Key | What it does |
|---|---|
| `↓` | Move to the next control — something that opens, or a Copy button on code |
| `↑` | Move to the previous one |
| `Home` | Jump to the first one in the conversation |
| `End` | Jump to the last one |
| `Enter` or `Space` | Open or close the one you're on — or copy, on a Copy button |
| `Esc` | Step back out to the conversation as a whole |
| `Page Up` / `Page Down` | Scroll, as usual |

Coming in from the top with `↓` starts you at the **beginning** of the
conversation; coming in with `↑` starts you at the **end**, which is usually
what you want — the newest activity is at the bottom.

Whatever you're on is outlined, so you can always see where you are. Pressing
`↓` on the very last one (or `↑` on the very first) scrolls instead of moving,
rather than doing nothing.

**The whole conversation is a single `Tab` stop**, on purpose. A long session
has hundreds of boxes in it, and if each one took its own `Tab` press the prompt
box underneath would be a hundred presses away. So `Tab` gets you *into* the
conversation, the arrows move *within* it, and one more `Tab` takes you out to
the prompt box.

**Getting back to the newest message.** Walking the boxes scrolls the view to
whatever you're on, so after a walk the conversation is no longer stuck to the
bottom and new output won't move you. Two ways back, both keyboard-only:

- `Esc` to step out to the conversation as a whole, then `End` or `Page Down` —
  scrolling all the way to the bottom re-sticks it.
- `Esc`, then one `Tab` onto the **`↓ Jump to latest`** button that appears just
  above the prompt box while you're away from the bottom, and `Enter`. Focus
  comes straight back to the conversation afterwards, so the next `Tab` is the
  prompt box as usual.

Note that `End` *inside* the walk goes to the last **box**, which is not the
same as the end of the conversation — a session whose latest activity is plain
text has no box down there to land on. That's what the button is for.

Screen readers are told the truth about all of this: each opener announces
itself as a button and says whether it's currently open or closed, and reading
the conversation with a screen reader's own navigation keys reaches every one of
them regardless of `Tab`.

**Each conversation is named after its session.** With several cards on screen
there are several conversations, so jumping between regions announces
*"Conversation — my-project"* rather than four things all called
"Conversation" — you can tell which session you've landed in without reading
anything in it. Rename a session and its conversation is renamed with it.

## Working the rest of the window with the keyboard

Everything outside the conversation works from the keyboard too — the Sessions
list, the lamp strip, the tabs across the top of a card, and the Events drawer.
`Tab` moves forward through them, `Shift+Tab` back, and whatever you're on is
outlined so you can always see where you are. `Enter` or `Space` does what
clicking would do.

### The Sessions list

`Tab` walks the list one control at a time, top to bottom:

| What you're on | What the keys do |
|---|---|
| A group's name | `Enter` folds the group shut, `Enter` again opens it |
| The colored dot beside it | `Enter` changes the group's color, one step per press |
| A session's name | `Enter` brings that session up in the grid |
| The **✕** at the end of a row | `Enter` ends the session (it asks first) |
| **+ group** at the top | `Enter` makes a new group |

A session row reads out as its name and its state together — *"trading-app —
Wants permission to run"* — so you don't have to see the little status square
to know what it's asking for. The session you're currently looking at is
announced as the current one.

The right-click menu on a row is on the keyboard too: with a session's name
selected, press **`Shift+F10`** (or the **Menu** key, if your keyboard has one)
and the same menu opens, with the first item already selected. `↑` and `↓` walk
it, `Enter` picks, and `Esc` closes it and puts you back on the row you started
from. That menu is where **Open changes**, **Rename…**, **Pin session** and
**Close session** live, so renaming or pinning a session doesn't need a
double-click. Below them are two labelled groups of radio items — **ON
SUBMIT** and **WHEN IT NEEDS YOU** — which read out as one choice each rather
than as eight loose commands.

#### Moving a session into a group without dragging

Keep walking that menu past **Close session** and you reach **Move to group** —
every group you've made, then **Ungrouped**, with a tick beside the one the
session is in now. `Enter` on any of them moves it, exactly as
[dragging the row onto that group](07-workspace.md#groups) would;
`Enter` on **Ungrouped** takes it out of its group, the same as dropping it on
empty space.

The move is read out when it happens — *"trading-app moved to Backend"* — and
you're left standing on the row in its new home, ready to press `Shift+F10`
again. If the group you moved it into happens to be folded shut, you land on
that group's name instead, which tells you it's closed; `Enter` opens it.

[Automatic groups](07-workspace.md#automatic-groups) aren't on the list. Their
membership is worked out from the session's folder rather than chosen, so there
is nothing there to pick — the same reason you can't drag a session into one.

### The lamp strip

Each lamp along the top is a button: `Tab` reaches it, `Enter` jumps to that
session. Every lamp says its session's name and state, and the one you're
currently on is announced as the current one.

### The tabs on a card

**Session**, **Changes**, **History** and **Terminal** are a proper tab strip,
which means one `Tab` press gets you to it and the arrows move inside it:

| Key | What it does |
|---|---|
| `→` / `←` | Move to the next / previous tab (it wraps around) |
| `Home` / `End` | First / last tab |
| `Enter` or `Space` | Switch to the tab you're on |

Moving with the arrows doesn't switch views — it only moves the highlight — so
you can walk past **Changes** without making it load a diff you didn't want.
Press `Enter` when you get to the one you mean.

Tabs that aren't ready yet stay in the walk and announce themselves as
unavailable, rather than being skipped as though they didn't exist.

**A card also speaks up when its session stops.** If a session ends, refuses to
start, or goes suspended, the card covers itself with a panel — and that panel
is read out when it appears, named after its session, so you learn about it
without being on that card. See
[Restarting a dead session](02-sessions.md#restarting-a-dead-session).

### The Events drawer

The drawer is closed until you open it. **`Ctrl+E`** opens and closes it, and
it's in the command palette as *"Show or hide the events drawer"* — so you never
need the mouse to reach what's inside. Opening it puts your cursor in the
drawer, and closing it puts your cursor back where it was — **`Esc`**,
`Ctrl+E` again, and the palette entry all do that.

It isn't a dialog, so `Tab` walks out of it into the rest of the window as
normal — nothing is trapped.

Inside, each row is a button: `Enter` opens that session, exactly as clicking
the row does, and counts as having visited it so `Ctrl+Space` won't send you
straight back. One more `Tab` reaches that row's **Dismiss** button.

`Ctrl+Space` doesn't need the drawer open at all — it works whether the drawer
is showing or not.

## Hiding the Sessions list

`Ctrl+B` hides and shows the Sessions list on the left, for when you want the
whole window for the session you're in. The **▤ rail** button in the title bar
does the same thing, so you can always get the list back with the mouse. The
choice sticks across restarts.

## The rule that matters

**While you're typing, switchboard keeps its hands off.** In the prompt box or
a rename field, every keystroke goes where you're typing — pressing `1` types a
`1`, and even `Ctrl+1` stays put rather than jumping you somewhere else. Click
away from the text box first, and the shortcuts come back. The one exception is
`Ctrl+Shift+P`, the command palette — it's how you reach everything else, and
it isn't a key you'd ever mean as text.

**The Terminal tab is the CLI's, with exactly two exceptions.** (Only on a
session in Terminal mode — a [Direct mode](12-direct-mode.md) session has no
terminal, so none of this applies and every shortcut keeps working normally.)
Everything you press in the Terminal goes to the real Claude Code — that's the point of it, and
`Ctrl+1`, `Ctrl+B`, `Ctrl+W` and the rest all stand down there.

The two exceptions are the ones you'd otherwise be stranded without:

| Shortcut | Works in the Terminal |
|---|---|
| `Ctrl+Shift+P` | Open the command palette |
| `Ctrl+Space` | Go to the next session that needs you |

Both work from a popped-out session's terminal too. They were picked because
Claude Code doesn't use either one — `Ctrl+Shift+P` never even reaches a
terminal program, and `Ctrl+Space` is a keystroke Claude Code ignores — so
nothing is being taken away from the session you're in. Everything else,
including keys Claude Code does use like `Ctrl+R`, `Ctrl+C` and `Escape`, goes
straight through untouched.

The list is deliberately two long and isn't going to grow much: every shortcut
switchboard claims here is one Claude Code can never receive again. The palette
is on the list precisely so nothing else has to be — from it you can reach every
command, including the ones with no shortcut of their own.

The **▸ commands** button in the title bar still opens the palette with the
mouse, from anywhere.

## Good to know

- Shortcuts that need a focused session do nothing when no session is focused.
- `Ctrl+W` closes the focused **session**, not the window. switchboard
  deliberately doesn't put "close window" or "reload" on a shortcut — either
  one would take down every session you have open. Close the window with its
  own **✕** when you mean it.
- Hiding the Sessions list never removes anything: every session stays
  reachable by number, by next/previous, and from the title bar button.
- **Popped-out sessions** listen for shortcuts too. Most of what a command
  touches lives in the main switchboard window, so running one from a
  popped-out window brings that window to the front. Ordinary typing in a
  popped-out session never does — only a shortcut that actually did something.
- Jumping to a popped-out session — by number or with `Ctrl+Space` — brings
  **its** window forward and leaves it there, rather than pulling the main
  window back over the top of it.

## If something goes wrong

- **A shortcut does nothing** — check where your cursor is. If it's in the
  prompt box or the Terminal, switchboard is deliberately staying out of the
  way; click on the session's header or a tab first. The two that always work
  are `Ctrl+Shift+P` and `Ctrl+Space`.
- **`Ctrl+1` went to the wrong session** — the numbers follow the Sessions list
  from the top, including sessions nested inside groups (even collapsed ones),
  not the order the tabs happen to sit in.
- **The Sessions list vanished** — you probably pressed `Ctrl+B`. Press it
  again, or click **▤ rail** in the title bar.
- **You can't remember a shortcut** — you don't have to. Open the command
  palette and read them off the list.
- **`Ctrl+Space` didn't move** — most likely nothing is waiting on you: check
  the count on the status bar (bottom right), and if it says none, there's
  nowhere to go. It also stands down while you're typing in the prompt box, so
  you don't get yanked away mid-sentence — click out of the box first. It *does*
  work from the Terminal.
- **A shortcut works in the Terminal but you expected it not to (or the other
  way round)** — only `Ctrl+Shift+P` and `Ctrl+Space` work there. Everything
  else belongs to Claude Code.
