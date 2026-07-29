# Keyboard & commands

> Status: draft

switchboard has application-wide keyboard shortcuts for the things you do
constantly: moving between sessions, opening and closing them, and hiding
chrome. They exist so a workspace with eight sessions doesn't turn into eight
mouse trips.

On a Mac, use **⌘** everywhere this page says **Ctrl**.

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
| `Ctrl+N` | New session — opens the folder picker |
| `Ctrl+W` | Close the focused session (asks first) |
| ``Ctrl+` `` | Switch the focused session between its Session and Terminal views |
| `Ctrl+Shift+O` | Pop the focused session out into its own window, or dock it back |
| `Ctrl+Shift+P` | Open the command palette |
| `Ctrl+Space` | Go to the next session that needs you |

`Ctrl+W` asks before it closes, because closing a session ends it and removes
its card — the same confirmation you get from the tab's **✕**.

``Ctrl+` `` is a toggle: press it once to look at the Terminal, press it again
to go straight back to the Session view.

Two more live in the palette without a shortcut of their own: **Toggle Changes
view**, and **Hide session (keeps it running)** — which takes the focused
session's card out of the workspace without ending it. Click the session in the
Sessions list to bring it back where it was; see
[Organizing your workspace](07-workspace.md).

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

**The Terminal tab is absolute.** switchboard never intercepts a key there,
ever, because that's the real Claude Code and it should get everything you
press — shortcuts included, the command palette included. From the Terminal,
reach the palette with the **▸ commands** button in the title bar.

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
  way. Click on the session's header or a tab first.
- **`Ctrl+1` went to the wrong session** — the numbers follow the Sessions list
  from the top, including sessions nested inside groups (even collapsed ones),
  not the order the tabs happen to sit in.
- **The Sessions list vanished** — you probably pressed `Ctrl+B`. Press it
  again, or click **▤ rail** in the title bar.
- **You can't remember a shortcut** — you don't have to. Open the command
  palette and read them off the list.
- **`Ctrl+Space` didn't move** — either nothing is waiting on you (check the
  Events panel: if it's empty, there's nowhere to go), or your cursor is in the
  Terminal or the prompt box, where switchboard keeps its hands off. From the
  Terminal, click an Events row or use **▸ commands** in the title bar.
