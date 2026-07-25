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

`Ctrl+W` asks before it closes, because closing a session ends it and removes
its card — the same confirmation you get from the tab's **✕**.

``Ctrl+` `` is a toggle: press it once to look at the Terminal, press it again
to go straight back to the Session view.

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
- **Popped-out sessions** listen for shortcuts too. Because everything a
  command touches lives in the main switchboard window, running one from a
  popped-out window brings that window to the front. Ordinary typing in a
  popped-out session never does — only a shortcut that actually did something.
- Jumping to a popped-out session by number brings its own window forward.

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

<!-- TODO: the "jump to whatever needs me next" key is still being built — this
page gets it when it ships. -->
