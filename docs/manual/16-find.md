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
- **Jumping to a match opens whatever was hiding it.** Land on a match inside a
  collapsed Bash block and the block opens, with the matched line visible.

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

Jumping works the same in **Direct** mode as in Terminal mode. (It didn't
always: until version 0.4.0, Direct sessions could find matches but not scroll
to them, and every row was read-only.)

## Other tabs

`Ctrl+F` follows whichever tab the session is showing.

- **Session** — the full transcript search described above.
- **Changes** — hands you straight to the diff editor's own find, which is the
  full-featured one (regular expressions, replace, match marks down the
  scrollbar). Our bar gets out of the way rather than putting a second, worse
  find on top of a good one.
- **Terminal** — not yet. The bar opens greyed out and tells you so rather
  than quietly searching something else.

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
- **No regular expressions yet.** Deliberate: a badly-shaped pattern can lock
  up the app for minutes, and that's a bigger problem than the feature is
  worth until the search runs somewhere it can be stopped.

## If something goes wrong

- **`Ctrl+F` does nothing** — check that a session card actually has focus
  (click it), and that your cursor isn't inside the terminal. The terminal gets
  every key it can see, by design, so `Ctrl+F` there goes to the program
  running in it.
- **"Nothing to search yet"** — the session hasn't written anything down. That
  happens before the first prompt; ask it something and try again.
- **"These matches can be read here, but this session can't be scrolled to
  them"** — the matches are real and the snippets are accurate, but switchboard
  couldn't line the transcript up with what's on screen for this session, so it
  won't guess where to jump. Read them in the results list. This is uncommon,
  and it means what it says: switchboard would rather show you the text than
  scroll you to a block it isn't sure about. It can happen right after a
  session is cleared or resumed, or if the transcript and the view have drifted
  apart for any other reason — try the search again in a moment.
- **The search stopped early** — a very large session hit a time limit. What's
  shown is real, just not all of it; a narrower term will finish.
