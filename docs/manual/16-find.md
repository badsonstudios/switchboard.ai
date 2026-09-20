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

**The list only ever opens when you ask for it.** The bar is the whole
interaction — type, read the count, step with `Enter` and `Shift+Enter`, close
with `Esc` — and nothing appears over your conversation unless you press `▸`.
If the match you've stepped onto happens to be one switchboard can't scroll to,
the bar says so in a quiet line underneath the count, and leaves the pane alone.

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

## One place, one count

A session has one searchable record: the **conversation**, which switchboard
reads from the session's transcript file — everything, from the first prompt
onward. The `3 of 14` beside the box is your position in it.

A session used to have a second, much shallower record as well — the last 5,000
lines the terminal had printed — reported as its own group beside the
conversation. The Terminal tab has been removed, so there is nothing else to
count and the bar shows a single number.

## Other tabs

`Ctrl+F` works from any tab and always searches every part of the session it
can. The tab you're on decides two things: where it starts, and whether it
hands off entirely.

- **Session** — the conversation search described above.
- **Changes** — hands you straight to the diff editor's own find, which is the
  full-featured one (regular expressions, replace, match marks down the
  scrollbar). Our bar gets out of the way rather than putting a second, worse
  find on top of a good one. Nothing else is searched while you're on this tab.

## Documents

A [document tab](15-document-viewer.md) gets the same `Ctrl+F` — press it with
one in front of you and the bar opens over that document. It behaves exactly as
it does over a session: type, `Enter` and `Shift+Enter` step, matches are
highlighted where they are, the count says "3 of 12", `Esc` closes it and takes
the highlights with it.

Two things are different, and both follow from a document not being a session:

- **Only the document is searched.** There's no session behind a document tab —
  it's a file on disk — so there is no Session group, just the one count.
- **Source view hands off**, like the Changes tab does. Any file that isn't
  Markdown opens in the editor, and so does Markdown when you press **Source**;
  `Ctrl+F` there opens the editor's own find box.

This works in a popped-out document window too — the bar opens in that window,
where the document is.

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
  (click it). `Ctrl+Shift+P` → **Find in session** always works.
- **"Nothing to search yet"** — the session hasn't written anything down. That
  happens before the first prompt; ask it something and try again.
- **"This match is earlier than the conversation on screen"** — that one match
  is real and its snippet is accurate, but switchboard can't tell where on
  screen it belongs, so it won't guess. Press `▸` to read it in the list, or
  step past it to the next one. It's about the single match you're on, not
  about the session: the matches either side of it usually jump perfectly well.
  A resumed session is the common cause, because the conversation replayed into
  the view is older than the transcript being written now.
- **"These matches can be read here, but this session can't be scrolled to
  them"** — the same thing about the session as a whole, which is now rare: it
  takes a session where switchboard can't identify a single match. Clearing a
  session can cause it, and it usually clears itself as the conversation moves
  on.
- **The search stopped early** — a very large session hit a time limit. What's
  shown is real, just not all of it; a narrower term will finish.
