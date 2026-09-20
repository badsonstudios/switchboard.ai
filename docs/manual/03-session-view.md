# The session view

> Status: draft

Each card has three tabs: **Session**, **Changes**, and **History**. Session is
the one you'll live in.

## The Session tab

This is the conversation, rendered to be read rather than scrolled past:

- **Your prompts** appear as tinted boxes. Each one starts a new turn, and the
  conversation says so: a full-width rule with **NEW PROMPT** under it, with a
  gap above. It's there so you can scroll a long session and find where each
  exchange began without reading a word of it.
- **Claude's replies** are formatted text, with no marker in the left margin —
  they're the answer, not something that happened, so they sit clean.
- **Anything Claude *did*** — running a command, editing a file, reading
  something, updating its checklist — is a **bordered box** with a small dot in
  the margin beside it. The boxes are what you scan for when you want to know
  what a session has been up to.
- **File edits** show the filename, a `+3 / -1 lines` summary, and the changed
  lines in red and green.
- **Commands** show what was run and why, with **IN** and **OUT** sections you
  can expand separately.
- **Thinking** collapses to "Thought for 4s" — expand if you care.
- **Checklists** from Claude's own task tracking render as `[x]` / `[~]` / `[ ]`.
- **Local commands** — `/usage`, `/cost`, `/context` and the like, which Claude
  Code answers itself — print their output here too.
- **A slash command you ran** collapses to a single line showing the command and
  what you gave it — `/next-item 818` rather than just `/next-item`. Click it to
  see the whole thing. If what you gave it was long (a whole briefing pasted in,
  say), the line is shortened with an `…`; the full text is inside.

The view stays pinned to the newest message, including when you switch back to
a session you'd left. Scroll up freely; it won't yank you back.

That holds across the things that move a card around, too: quitting and
reopening switchboard, clicking a session in the sidebar, and dragging cards
into a different arrangement all leave each conversation showing its latest
message rather than its first. The one thing that doesn't put you at the
bottom is scrolling up yourself — which is the point, and which the button
below undoes.

**When you've scrolled away, a `↓ Jump to latest` button appears** just above
the prompt box. Scrolling up — with the wheel, or by walking the conversation
with the arrow keys — deliberately unsticks the view so that new output can't
drag you off what you're reading, and that button is how you stick it back on:
one click and the view is at the newest message and following again. It only
shows while there's somewhere to go, so a conversation short enough to fit never
has one. Scrolling all the way back down by hand does exactly the same thing.

From the keyboard it's one `Tab` from the conversation (press `Esc` first if
you're walking the boxes) and one `Shift+Tab` from the prompt box — see
[Reading the conversation with the keyboard](06-keyboard.md#reading-the-conversation-with-the-keyboard).

**Replies stream in a word at a time**, with a small block cursor on the end
while Claude is still writing — see [Direct mode](12-direct-mode.md).

**A reply is formatted while it arrives, not after it finishes.** Headings,
bold, bullet lists, tables and code blocks all appear as Claude writes them, so
a long answer reads like an answer the whole way down instead of showing you
raw `##` and `**` markers and then rearranging itself at the end.

Two things about that are worth knowing, because both are deliberate:

- **Some text briefly restyles itself as Claude types.** A word can appear
  plain for an instant and then turn bold once the closing `**` arrives, and a
  line that becomes a table header sits as ordinary text until the row beneath
  it shows up. That settling is unavoidable — half a sentence genuinely is
  ambiguous — and it stops as soon as the syntax is complete.
- **Code blocks get their Copy button when the reply ends**, not while it is
  still being written. The code itself appears as it arrives; only the button
  waits. That's on purpose: copying a command that is still half-written would
  put half a command on your clipboard with nothing to tell you so.

### Expanding a box

**Click anywhere on a box to open or close it.** You don't have to hit the
title — the whole rectangle is the target. On a command box that shows you the
full command and its full output in one click.

Two things deliberately *don't* fold the box away:

- The small **▸ IN** / **▸ OUT** arrows inside a command box, and the diff panes
  inside an edit box. Those control just their own section, so you can open the
  output without the command, or scroll a long diff in peace.
- **Selecting text.** Dragging to highlight a file path or a line of output
  leaves the box exactly as it was, so you can copy it without it disappearing.

Checklist boxes have nothing to expand — they're already showing everything —
so clicking one does nothing.

### Copying code out of a session

**Code blocks in an answer have a small header with a Copy button on the
right.** Click it and the whole block is on your clipboard — exactly the text,
with no line numbers or extra spacing. The button says **Copied** for a moment
so you know it worked. The language of the block, if the answer said what it
was, sits on the left of the same strip.

**Command boxes get one too, once they're open.** Open a command box and each
**IN** and **OUT** section gets its own Copy button at the right — **IN** copies
the command, **OUT** copies the whole output, including the lines below the one
the collapsed box was showing you. A closed section has no button: there is
nothing on screen yet to copy.

Copying never folds the box away, and the buttons are reachable from the
keyboard along with everything else (below). It works in a popped-out card too.

The document viewer has had the same button on its code blocks since it
shipped — it's the same affordance in both places, on purpose.

### Opening a link a session gives you

**Click a link in an answer and it opens in your normal web browser.** It never
opens inside switchboard.ai — the app doesn't turn into a web page, and you
don't lose the session you were reading. It works in a popped-out card too.

Only ordinary web links work: `http`, `https` and `mailto` addresses. Anything
else in a link — a scheme that would run a program, open a file on your disk, or
launch another app — does **nothing at all** when clicked, and isn't painted as
a link in the first place: it reads as the plain words it always was. That's
deliberate:
the text of an answer is written by whatever the session was reading, so a link
in it is not automatically something worth trusting, and "nothing happened" is
the right answer for anything that isn't plainly a web page.

Two other things a link in an answer can't do, for the same reason: a link to a
file path (`./notes.md`) doesn't open anything from the conversation — open it
in the [document viewer](15-document-viewer.md) instead, where links between
files do work — and a link that just points at a spot in a page (`#somewhere`)
does nothing, because a conversation isn't a document with places to jump to.

### …without the mouse

Every box, every **IN** / **OUT** section and every folded prompt can be opened
from the keyboard. `Tab` into the conversation, then `↑` and `↓` walk between
the things that open — and the Copy buttons on code — and `Enter` opens or
presses the one you're on. Full instructions:
[Reading the conversation with the keyboard](06-keyboard.md#reading-the-conversation-with-the-keyboard).

## When the Session tab has nothing in it

An empty Session tab is usually normal, so it tells you which kind of empty it
is rather than leaving you guessing:

- **"No conversation yet"** — the session is up and waiting. Claude Code
  doesn't start writing a conversation until you send your first prompt, so a
  card you've just opened sits here, however long you leave it. Nothing is
  wrong.
- **"Looking for this session's transcript…"** — you've sent something and
  switchboard is matching the conversation to this card. It normally passes in
  a moment.
- **"Couldn't find this session's transcript"** — shown in red, and the only
  one that means something is actually wrong. It tells you where it looked and
  what it found. **Your session is unaffected**, and you don't need to go
  anywhere to keep working: its replies come straight into this window
  ([Direct mode](12-direct-mode.md)) rather than being read out of that file,
  and the status on the card header tells you what it's doing. The missing file
  only costs you usage totals and picking the conversation back up next time you
  open switchboard.

  See [Troubleshooting](11-troubleshooting.md).

If you have two cards open on the *same folder*, expect the second one to spend
a little longer on "Looking for…" — switchboard waits until it can tell the two
conversations apart rather than guessing and showing you the wrong one.

## Talking to the session

The box at the bottom sends straight to the real Claude Code session:

- **Enter** sends. **Shift+Enter** starts a new line.
- The box grows to fit what you have written — including long text that wraps
  onto several lines by itself, so a pasted paragraph is never half-hidden. It
  stops growing at twelve lines and scrolls inside itself after that, and it
  shrinks back down as you delete.
- While Claude is working, the send button becomes a **■ stop** button, which
  interrupts the current turn.
- Typing `/` at the start of a line opens command autocomplete — see
  [Slash commands](05-slash-commands.md).
- Typing **`@`** opens a list of your other open sessions, anywhere in your
  message — "take `@TradingApp`'s fix and apply it here". Each row shows the
  session's name, its folder and its colour, and a session whose process has
  ended is marked **exited** (you can still refer to it). Keep typing to narrow
  the list. **Tab** (or a click) always puts `@SessionName` into your message.
  **Enter** does too when the name *starts* with what you typed, or when you've
  moved to a row with the arrow keys — but if you've typed the whole name,
  Enter sends, and if what you typed only appears somewhere *inside* a name,
  Enter sends your text exactly as written rather than swapping in a name you
  didn't pick. **Esc** closes the list for that `@` until you start a new one.
  The session you're typing in isn't listed. The list only opens while you're
  typing at the end of the `@`-word, so clicking into a name you already wrote
  and pressing Enter just sends. An `@` inside ordinary text, like an email
  address, opens nothing and stays exactly as you typed it.
- **A mention brings that session's recent work with it.** When you send
  "take `@TradingApp`'s fix and apply it here", switchboard.ai looks up
  TradingApp's recent conversation and puts it in front of your message, marked
  as coming from TradingApp. In what's sent, your `@TradingApp` becomes
  `"TradingApp" (session)` — the rest of your words are unchanged. (Claude would
  otherwise read `@TradingApp` as a *file* called TradingApp.) You'll see all of
  it in your turn in the conversation, so nothing is added behind your back.
  Very long messages and tool output are shortened, and only the most recent
  part of the conversation comes along. If you mention several sessions at once
  and the total is too long, the ones you mentioned first come along and a line
  in your message says which were left out.
  - An `@` that doesn't match an open session, an email address, an `@` inside
    `` `code` `` or a code block, or the session you're typing in, is sent
    exactly as you typed it.
  - If two open sessions have the **same name**, nothing is sent: a note under
    the box lists both, with their folders, and your message stays in the box.
    Rename one, or use the session's id in place of the name.
  - If the lookup itself fails, your message is still sent as you typed it, and
    a note under the box says the other session's work didn't go with it.

Under the box is a row showing this session's **autonomy mode** (click to
cycle) and the **model** it's running — click that to switch it, or see
[Choosing a model](18-model.md).

**A prompt you haven't sent yet is kept.** Start writing, then switch that card
to the Changes tab and back, pop it out into its own window, dock it back, or
quit switchboard entirely — the words are still in the box when you return to
it. Each session keeps its own; sending clears it. If you empty the box, nothing
is kept, and a draft is forgotten when you close the session for good. A session
you left suspended gets its draft back when it resumes.

**Files you attached are kept too, with one limit.** Any chips above the box
come back with the words for as long as switchboard.ai is running — moving
between tabs, popping the card out, docking it back. They do **not** survive
quitting the app, because their contents are never written to disk (see
[Attaching files](#attaching-files-paste-a-picture-or-drag-anything-in) below).
If you quit with files attached, the next launch gives you your words back and a
line under the box naming the files it could not restore, so you can attach them
again. It never empties itself quietly.

### Right-click menus

**Right-click in the prompt box** for **Cut**, **Copy**, **Paste** and **Select
All**. Items that would do nothing are greyed out — Cut and Copy with nothing
selected, Paste with an empty clipboard. Pasting from the menu is the same as
pressing Ctrl+V, pictures included: a screenshot pasted this way becomes the
same chip described below.

**Right-click text you've selected in the conversation** — or in a document —
for **Copy**. There is no Cut or Paste there: it isn't text you can edit.

The menus work in popped-out session windows too.

### Attaching files: paste a picture, or drag anything in

Two ways to send Claude a file along with your question.

**Paste a picture.** Copy an image — a screenshot, something from Paint, a
diagram from a web page — and press **Ctrl+V** in the prompt box.

**Drag files in.** Drag one or more files from Explorer (or Finder) onto the
prompt box. A dashed outline appears saying *"Drop files to attach them to your
prompt"*; let go and they attach.

Either way, a small chip appears above the box with the file's name and size —
and, for a picture, a thumbnail of it. Type your question next to it and press
Enter.

**Afterwards, the conversation remembers.** The chips clear the moment you send
— so the prompt in your session picks up a small line saying what rode with it:
*1 image attached*, or *2 images and 1 file attached*. Scrolling back a week
later, that line is what tells you Claude's reply was about a screenshot you can
no longer see. A picture sent with **nothing typed** gets an entry of its own,
rather than the reply appearing out of nowhere. The count comes from the message
that actually went to Claude, so it is never a guess — but it is only a count:
file names are not shown, and switchboard.ai keeps no copy of the files to show
you (see below).

#### What happens to each kind of file

Claude reads different files in different ways, and switchboard.ai sends each
one in the form Claude understands best:

| You attached | What Claude gets |
|---|---|
| A picture — PNG, JPEG, GIF or WebP | The image itself. Claude looks at it. |
| Text and source files — `.md`, `.txt`, `.ts`, `.py`, `.json`, `.log`, `.csv`, `LICENSE`, `Makefile`, `.gitignore` and a hundred-odd others | The **contents of the file**, exactly as written, labelled with its name. Claude reads it like a document, not like a path it has to go and open. |
| A PDF | The whole document. Claude reads it. |
| An SVG | Its source code, which Claude reads better than a picture of it. |

The full list of file types is the same one the official Claude Code extension
for VS Code uses, so anything that works there works here.

Nothing is uploaded anywhere and no copy is left on disk — the file's contents
travel with your prompt and nowhere else. That is a deliberate choice and it has
one visible consequence: **attached files do not survive quitting the app.** An
unsent prompt's words are saved (they are small, and retyping them is the
expensive part); a screenshot's pixels are not, because saving them would mean
leaving a copy of whatever you pasted sitting in switchboard.ai's own folder
until something got round to deleting it. Within a single run the chips are kept
through everything — tab switches, pop-outs, docking back. Across a restart they
are not, and the composer tells you which ones it lost:

> Not restored: diagram.png, server.log. Your typed prompt is kept when
> switchboard.ai restarts; attached files are not, because no copy of them is
> ever left on disk. Attach them again.

#### The rules

- **The ✕ on the chip removes it** before you send. Nothing is sent until you
  press Enter.
- You can attach **up to eight files** to one prompt, mixing kinds freely — a
  screenshot and two source files in the same question is fine.
- **They stay in the order you gave them**, so "compare the first with the
  second" means what it says.
- **A file on its own is a valid prompt** — the send button lights up even with
  nothing typed.
- **If your clipboard has text *and* a picture** — copying a range of
  spreadsheet cells does this — you get both: the text lands in the box and the
  picture attaches beside it.
- **Pasting ordinary text is exactly as it always was.** Nothing about this
  changes it.
- **Dragging files anywhere else in the window is unchanged.** Dropping a
  *folder* on the app still opens it as a new session; only a drop that lands
  on the prompt box itself becomes an attachment.

#### When it can't

It tells you, under the box, rather than failing quietly:

| What you did | What you'll see under the box |
|---|---|
| Attached a very large file | "That file is too big to send" — about 3.8 MB for a picture or PDF, 5 MB for a text file |
| Attached more than eight | "You can attach up to 8 files to one prompt" |
| Attached a type Claude can't read — a video, an `.exe`, a `.zip` | It names what does work, and tells you to put the file's full path in the prompt instead, which Claude can then open itself |
| Dropped a **folder** on the prompt box | "Folders cannot be attached to a prompt." Drop it outside the prompt box to open it as a session, or drop the files inside it |
| Attached an empty file | It says there is nothing to send |
| Quit with files attached | "Not restored: …", naming them. Your typed words are still there; attach the files again |

If a prompt with an attachment can't be sent — the session stopped, say —
**nothing is cleared**. Your words and your files stay right where they are, and
a line under the box tells you it didn't go.

## How much detail you see

Three settings, top of the Session tab:

| Setting | Shows |
|---|---|
| **quiet** | Just your prompts and Claude's replies |
| **normal** | Prose plus tool activity — the default |
| **firehose** | Everything, including thinking and sub-agent chatter |

Switch any time; it applies instantly and is remembered per session.

Note that **searching ignores this setting** — `Ctrl+F` looks at everything,
including the tool output **quiet** is hiding and the thinking **normal**
hides, and jumping to a match unfolds it. See
[Finding something in a session](16-find.md).

## When a session sends out helpers

Claude can hand a piece of work to a **sub-agent** — a helper that goes off,
does one job, and reports back. A session often runs several at once.

Their work appears in the conversation indented behind a dashed line, and each
stretch of it opens with a small grey caption saying which helper is talking:

> Subagent · code-reviewer

That caption is the thing to look for when two helpers are working at the same
time. Their replies arrive mixed together, in whatever order they finish, so
without it you'd be reading two conversations as one. Every time the speaker
changes, a new caption appears — including when a helper you saw earlier comes
back.

If two helpers are doing the **same kind of job**, they'll have the same name.
Then the caption adds a short code so you can still tell them apart:

> Subagent · deep-research-specialist · aaaaaa

The code is just an identifier; it means nothing on its own, and it only shows
up when there's an actual clash.

**Two things worth knowing:**

- Sub-agent work doesn't appear in the conversation yet — that's still to come.
- A conversation recorded by an older version of Claude Code may show the
  indented work with a plain **Subagent** caption and no name. There is nothing
  wrong; that recording simply doesn't say who was speaking.

Set the detail level to **quiet** if you'd rather not see helper chatter at
all — it hides their work along with the captions.

## Tokens and cost

Along the right-hand end of the card header, beside the branch name, a session
shows what it has used: tokens in (`↑`), tokens out (`↓`), tokens read back
from the cache (`⛁`), and a dollar figure.

When the model thinks before it answers, the tokens-out figure is followed by a
fainter one: `↓ 4.2k (2.9k thinking)`. That is how much of the output was the
model working things through rather than writing the reply you read. It is
already **inside** the tokens-out number — the session did not use 4.2k plus
2.9k — and hovering it shows the share as a percentage. It doesn't appear until
a session has actually done some thinking, and conversations recorded by
versions of Claude Code older than 2.1.233 never show it, because they didn't
record it. Unlike the other counts, the thinking figure can read a little
**low** — never high: a conversation you started on an older version and carried
on after updating only counts the thinking recorded since.

**The token counts closely match Claude Code's own count** — typically to
within a percent or two — including the work done by any helper agents the
session starts, which are counted as part of it. What they can't include is
background work Claude Code does with a lighter model and never writes down (for
example, naming the conversation), so where they differ they usually read a
little **low**.

**The dollar figure has two versions, and the card tells you which one you're
looking at.**

- **While a session is running** you see something like `~$3.20`. The tilde
  means switchboard worked it out itself, from published per-model prices. It
  is an **under**-estimate on purpose: some cached content is billed at two
  different rates and the session's own records don't say which applies, so
  switchboard always assumes the cheaper one. Hover for the full explanation.
- **Once a session has ended**, the tilde disappears and the figure becomes
  Claude Code's own — `$3.61`. Claude Code writes its exact accounting out when
  it closes, and switchboard reads it and replaces its own guess. This is the
  number to trust.
- **Occasionally you'll see a `≥`**, as in `≥$3.61`. That means Claude Code
  used a model it couldn't price, so even its own total is short. The real
  figure is at least that much.

Two things worth knowing:

- **The exact figure only arrives when Claude Code closes itself.** It doesn't
  write its accounting out until it exits, so there's no way to get the real
  number mid-session — a session you leave open keeps showing the estimate
  indefinitely, and that's expected rather than a fault. It also has to be
  Claude Code's own decision to stop, and switchboard has no way to ask it to —
  there is no longer a terminal to type `/exit` into. Restarting or closing the
  session from switchboard shuts the transcript down first and leaves the
  estimate standing.
- **You are billed by your subscription, not per token.** The dollar figure is
  there to give the token counts a sense of scale and to let you compare
  sessions against each other — it is not a bill.

Clearing a session's conversation resets all of this to zero, including the
cost, because it's a new conversation. And reopening a conversation you'd
finished puts the `~` estimate back as soon as it does any more work — the exact
figure it was showing was the total as of last time, and it stops being the
whole story the moment the session spends again.

## What happened to the Terminal tab

Cards used to have a fourth tab showing the real Claude Code terminal. **It has
been removed.** Sessions talk to Claude Code directly — see
[Direct mode](12-direct-mode.md) — and the things that used to send you to the
terminal now happen where you already are: permission requests arrive as a bar
in the Session tab, and `/model` and `/mcp` have panels of their own.

If you had a session set to Terminal mode, it moves to Direct the next time
switchboard starts. Your conversation and its history are untouched.

What genuinely went with it: **Ctrl-R history search**, **vim mode**, and
anything else that only exists as a full-screen terminal interface. If you rely
on those, run `claude` yourself in a terminal for that piece of work.

## Changes and History

**Changes** shows the files this session has modified — see
[Changes & git](08-changes-and-git.md). **History** is coming later.

## Good to know

- The Session tab is fully interactive; you never *have* to use the Terminal.
- Very long prompts and skill payloads collapse to a summary — click the
  summary line to expand it, and click it again to fold it back. Once it's
  open, clicking the text itself does nothing, so you can select a line out of
  it without it disappearing.
- The boxes and the margin dots are drawn from your theme, so they stay legible
  whichever one you're on.
