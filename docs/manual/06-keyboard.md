# Keyboard & commands

> Status: draft

switchboard has application-wide keyboard shortcuts for the things you do
constantly: moving between sessions, opening and closing them, and hiding
chrome. They exist so a workspace with eight sessions doesn't turn into eight
mouse trips.

On a Mac, use **⌘** everywhere this page says **Ctrl**.

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
away from the text box first, and the shortcuts come back.

**The Terminal tab is absolute.** switchboard never intercepts a key there,
ever, because that's the real Claude Code and it should get everything you
press — shortcuts included.

## Good to know

- Shortcuts that need a focused session do nothing when no session is focused.
- `Ctrl+W` closes the focused **session**, not the window. switchboard
  deliberately doesn't put "close window" or "reload" on a shortcut — either
  one would take down every session you have open. Close the window with its
  own **✕** when you mean it.
- Hiding the Sessions list never removes anything: every session stays
  reachable by number, by next/previous, and from the title bar button.
- **Popped-out sessions:** shortcuts work in the main switchboard window. A
  session you've popped out into its own window doesn't listen for them — that
  window is just the session. Jumping to a popped-out session by number still
  works and brings its window to the front.

## If something goes wrong

- **A shortcut does nothing** — check where your cursor is. If it's in the
  prompt box or the Terminal, switchboard is deliberately staying out of the
  way. Click on the session's header or a tab first.
- **`Ctrl+1` went to the wrong session** — the numbers follow the Sessions list
  from the top, including sessions nested inside groups (even collapsed ones),
  not the order the tabs happen to sit in.
- **A shortcut did nothing in a popped-out window** — that's expected; click
  back to the main switchboard window first.
- **The Sessions list vanished** — you probably pressed `Ctrl+B`. Press it
  again, or click **▤ rail** in the title bar.

<!-- TODO: the command palette (a searchable list of every command, with its
shortcut) and the "jump to whatever needs me next" key are still being built —
this page gets them when they ship. -->
