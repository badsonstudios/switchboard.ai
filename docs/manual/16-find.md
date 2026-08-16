# Finding something in a session

> Status: draft

Two hours into a session you know the agent printed a path, or an error, or the
name of a file it edited — and scrolling back for it is a waste of your
afternoon. **`Ctrl+F`** asks instead.

On a Mac, use **⌘** everywhere this page says **Ctrl**.

## Searching the conversation

1. Click the session you want, so it's the one with focus.
2. Press **`Ctrl+F`**. A small find bar appears in the top-right of the card.
   It doesn't push anything around — the conversation stays exactly where it
   was.
3. Type what you're looking for. Results start arriving as you type, and the
   view jumps to the first match.
4. **`Enter`** goes to the next match, **`Shift+Enter`** to the previous one.
   It wraps around at either end.
5. The count next to the box tells you where you are — **`3 of 14`**.
6. **`Esc`** closes the bar and puts your cursor back where it was.

One `Ctrl+F` searches **both** the conversation and the session's terminal —
see [Two places, two counts](#two-places-two-counts) below.

The box has two toggles beside it: **`Aa`** matches case, and **`ab|`** matches
whole words only. Both stay on until you turn them off.

<!-- screenshot: the find bar open over a session, showing "3 of 14" -->

## It searches things you can't see

This is the part worth knowing, because it's what makes the answer
trustworthy.

- **It searches the whole session, not what's on screen.** A long conversation
  keeps only its most recent part loaded — often a bit more than a thousand
  blocks. Find reads the session's own transcript file instead, so a string
  from three hours ago is still found.
- **It ignores your detail level.** If you're on **normal**, thinking is
  hidden; on **quiet**, tool output is hidden — and tool output is exactly
  where error messages live. Find looks at all of it anyway.
- **It ignores folds.** A collapsed tool box, a folded thinking block, a long
  prompt shown as one line — all searched.
- **Jumping to a match opens whatever was hiding it, and highlights the
  match.** Land on a match inside a collapsed Bash block and the block opens,
  with the matched line visible — and the word itself is highlighted, so you
  can see where it is without re-reading the block. The match you're standing
  on is the bright one; the other occurrences on screen get a quieter
  highlight, so you can see at a glance how the word is spread through the
  conversation. Both go the moment you close the bar.

  If the match is buried a long way down a tall block, switchboard scrolls
  again so the highlighted word itself is on screen, not just the top of the
  block it's in.

## The results list

Click the **`▸`** button on the bar to open the list of matches underneath it.
Each row shows the text around the match, with the match itself highlighted,
plus what kind of block it was in and roughly when. Click a row to jump
straight to it.

The list is not just a convenience. Some matches are **earlier than the loaded
view** — further back in the session than the part switchboard is holding in
memory. Those rows say so, and they aren't clickable, because there's nothing
on screen to scroll to. You can still read the match and its surrounding text
right there in the list. Being able to reach hits that no longer exist on
screen is the whole reason the list exists.

Jumping works the same whichever mode the session is in — **Direct** or
**Terminal**.

## Two places, two counts

A session has two records of itself and they are **not the same depth**:

- the **conversation**, which switchboard reads from the session's transcript
  file — that's everything, from the first prompt onward;
- the **terminal**, which is the last **5,000 lines** the program printed. It's
  a scrollback buffer, so older output has already fallen out of it.

One `Ctrl+F` searches both, and the bar reports them **separately**:

```
12 in Session · 3 in Terminal (scrollback only)
```

The words *scrollback only* are there on purpose. If the terminal group says
**0**, that means *not in the last 5,000 lines* — it does **not** mean the text
was never printed. Adding the two numbers together would produce a total that
isn't true of either place, so the bar never shows one. The `3 of 14` count
beside the box is your position **inside one group**; step past the end of a
group with `Enter` and it restarts at `1 of` the next group's own total. The
group you're currently in is the bold one.

The results list is grouped the same way, with a heading over each run of
matches, so a snippet is never attributed to the wrong place.

**A group that can't be searched isn't listed at all**, rather than listed with
a zero. Two cases:

- a session in **Direct mode** has no terminal, so it has no Terminal group;
- a session whose **Terminal tab you have never opened** has no Terminal group
  either. switchboard only keeps the terminal's picture while you are looking
  at it — behind the scenes the output is still being recorded, but this
  window's copy is empty until you open the tab. Showing "0" there would be
  answering a question we hadn't asked. Open the Terminal tab once and the
  group appears.

Same rule after a long time away: what the terminal group searches is what the
terminal held when you last looked at it.

## Other tabs

`Ctrl+F` works from any tab and always searches every part of the session it
can. The tab you're on decides two things: where it starts, and whether it
hands off entirely.

- **Session** and **Terminal** — the grouped search described above, starting
  in whichever of the two you're looking at.
- **Changes** — hands you straight to the diff editor's own find, which is the
  full-featured one (regular expressions, replace, match marks down the
  scrollbar). Our bar gets out of the way rather than putting a second, worse
  find on top of a good one. Nothing else is searched while you're on this tab.

### Finding things in the terminal

A match in the terminal is **highlighted in place** and selected; `Enter` and
`Shift+Enter` scroll the terminal to the next and previous one, reaching back
through the whole scrollback, not just the visible screen.

One catch worth knowing: **`Ctrl+F` pressed while your cursor is inside the
terminal goes to the program running there, not to switchboard.** That's
deliberate — `Ctrl+F` is a real key in the CLI (it pages down), and switchboard
does not take keys away from the program it's hosting. To search from there,
either press `Ctrl+Shift+P` and choose **Find in session**, or click the tab
strip (or the conversation) first and then press `Ctrl+F`. Either way the
terminal's scrollback is searched.

The **whole word** toggle is slightly less thorough in the terminal than in the
conversation: on a line where a partial match comes before a whole-word one
(`needles` before `needle`), the terminal search can miss the later one. This is
a bug in the terminal component we use, not in the search itself; plain and
match-case searches are exact.

## Good to know

- **Your search term is sticky.** Close the bar, switch tabs, come back, press
  `Ctrl+F` again — the term is still there, selected, ready to be typed over.
  It is not saved between launches: nothing keeps a search history.
- **It only ever searches the session you're looking at.** With four cards on
  screen, the same word in the other three is not counted and not found. The
  count you see belongs to one session.
- **It never touches the session.** Searching is read-only and happens
  out of the way of the agent; if it fails, it says so and the session carries
  on untouched.
- **Highlights are never part of what you copy.** Select highlighted text, or
  press **Copy** on a code block that contains a match, and what lands on the
  clipboard is the text as the session wrote it — no markers, no stray
  characters.
- **A few places don't highlight.** Highlights land on the body of a block —
  prose, tool input and output, thinking, prompts. Short composed labels, like
  the one-line summary on a collapsed box, are left alone. The count still
  includes those matches, and jumping still takes you to the right block.
- **No regular expressions yet.** Deliberate: a badly-shaped pattern can lock
  up the app for minutes, and that's a bigger problem than the feature is
  worth until the search runs somewhere it can be stopped.

## If something goes wrong

- **`Ctrl+F` does nothing** — check that a session card actually has focus
  (click it), and that your cursor isn't inside the terminal. The terminal gets
  every key it can see, by design, so `Ctrl+F` there goes to the program
  running in it. `Ctrl+Shift+P` → **Find in session** always works.
- **There's no Terminal group** — open the Terminal tab once (see above), and
  it will be there next time.
- **The terminal group says 0 and you're sure it printed that** — either it was
  more than 5,000 lines ago (that's all the terminal keeps), or it was printed
  since you last looked at the Terminal tab. Open the tab and search again.
  Either way, the Session count is the one that sees everything.
- **"Nothing to search yet"** — the session hasn't written anything down. That
  happens before the first prompt; ask it something and try again.
- **"These matches can be read here, but this session can't be scrolled to
  them"** — the matches are real and the snippets are accurate, but switchboard
  couldn't line the transcript up with what's on screen for this session, so it
  won't guess where to jump. Read them in the results list. This is uncommon,
  and it means what it says: switchboard would rather show you the text than
  scroll you to a block it isn't sure about. Clearing or resuming a session can
  cause it. It usually clears itself as the conversation moves on.
- **The search stopped early** — a very large session hit a time limit. What's
  shown is real, just not all of it; a narrower term will finish.
