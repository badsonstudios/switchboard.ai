# Changelog

Every released version of switchboard.ai gets a section here. The release
workflow (P2-E19-02) reads this file for its release notes, and the in-app
update dialog (P2-E19-03) shows those notes to the user — so a section written
carelessly is a section a user reads.

## The version, and how it moves

`package.json`'s `version` field is the **single source of the release
number**, and a human moves it — nothing generates it, and no CI job bumps it.
It is not the same thing as the build identity: see
`src/shared/build-identity.ts` for why the two are deliberately separate.

- **semver = the release number.** Human-bumped, on purpose, when someone
  decides a release is happening.
- **git stamp = the build identity.** SHA + branch + dirty + build time,
  stamped in automatically at build time and shown in About. It answers "which
  bytes am I running?", which a semver cannot.

**While work is landing:** add your entry to the **topmost `— unreleased`
section**, under `Added` / `Changed` / `Fixed` / `Internal` (drop the groups
you do not need). Write it in the user's words, not the issue's.

That section is opened by the *previous* release cut (step 2 below) and its
version number is a **placeholder** — the next cut confirms or corrects it.
There is only ever one: never open a second unreleased section, never add to a
dated one, and never invent a version number to file under while an unreleased
section already exists. Two open sections split the entries between them, and
the cut publishes only the one whose number it lands on — the other vanishes
from the release without anyone noticing. If there is no unreleased section at
all — the last cut skipped step 2 — open one rather than dropping your entry
on the floor, and say so in your PR.

**To cut a release:**

1. Bump `version` in `package.json`. **Pre-1.0 policy (owner, 2026-08-20):
   a release is a PATCH bump by default** (0.8.1, 0.8.2, …) — the numbering
   moves slowly on purpose. A MINOR bump is reserved for a deliberate
   milestone batch the owner names as one, and **1.0 is the release where
   all (or the substantial majority) of the planned feature set is in** —
   nothing before it earns a major. If the
   open unreleased section's placeholder version is not the number you landed
   on, rename its heading to match. Then refresh the lock —
   `npm install --package-lock-only` — so `package-lock.json`'s root and
   `packages.""` versions follow it; the diff should be those lines and
   nothing else. `release-notes.test.js` fails if they disagree (#487): the
   lock sat four releases behind before anyone noticed (#394).
2. Replace that version's `— unreleased` with the release date, and open a new
   `## <next version> — unreleased` section above it. **Always** — not "if work
   continues". That empty section is the only place the next work item is
   allowed to file, so skipping it blocks every item until the following cut.
   Guess the next number; step 1 corrects it. `release-notes.test.js` fails if
   you forget — that is deliberate, and it is why this step is not optional.
3. Commit all three together. The version and its notes arriving in one
   commit is what makes "this tag has no changelog section" a bug worth
   failing a build over — which is exactly what P2-E19-02's workflow does.
4. Tag `v<version>`; the tag must equal `package.json`'s version.

---

## 0.8.3 — unreleased

### Fixed

- **Bringing a session back from a window it had to itself now puts it back
  where it belongs.** Docking a session back with **⤡** when its window held
  nothing else took a different route through the layout than docking one back
  from a shared window, and only the shared route asked where that session had
  actually come from. The two now agree: whichever way you dock a session back,
  it returns to its own spot and keeps running.
- **A session started inside a popped-out window no longer takes over somebody
  else's half of the screen.** A window carries one "way back" — the slot the
  session that opened it came from — and every session in that window used to
  inherit it. So a session you started *inside* the window could arrive home in
  a slot it had never occupied, pushing the layout around. It now lands where a
  brand new session would: beside the sessions already there, never in place of
  one. This holds however the window empties, including closing it from the
  title bar or the taskbar (closing the window still suspends the session, as it
  always has).
- **Expanding a session out of the tab stack puts it back at a usable size.** If
  the slot it remembered had since been left empty by a neighbour popping out,
  the session came back about a pixel wide — present in the layout, invisible on
  screen, reachable only from the sidebar. It now comes back at full size, and
  never on top of a document you have open.
- Dragging a session onto a group in the sidebar no longer moves its card
  off-screen when a group-mate happens to be in a hidden pane.

### Changed

- **A reply or a document can no longer put a name on one of switchboard.ai's
  own controls.** Raw HTML can contain a `<label>`, and a label is not just
  words: it points at a control *anywhere on the page* by its internal name, and
  from then on it is that control's label — a screen reader reads the label's
  words as the control's name, and clicking the words operates the control. So a
  sentence in a reply could make your screen reader announce the *ntfy topic*
  box in Push setup as "Paste your API key here to continue" — words that are
  nowhere on your screen and that switchboard.ai never wrote. Labels are now
  removed from rendered Markdown everywhere: the session feed, the document
  viewer and the release-notes pane you are reading this in. The words inside
  them stay, so you still read everything the reply or the document said, and
  nothing else changes on screen. Alongside it, Push setup, Quiet hours and the
  command palette stopped giving their controls fixed, predictable internal
  names, so there is less for content to aim at even if a label got through.

### Internal

- A refused IPC call can no longer crash the part of the app that asked. The
  broker answers a capability-denied call with a marker object rather than an
  error; forty-one places in the renderer used that marker as if it were the
  real answer — mapping over it, reading fields off it, casting it into a typed
  store — which would have thrown inside a callback nobody catches. Every one
  of them now checks first and falls back to the empty, inert answer that site
  already knows how to draw, and the check is enforced by the unit suite so a
  new one cannot be written. No visible change today: this window holds every
  capability, so nothing here can be refused yet (#650).
- The window's picture of a running session lost the last of its hand-copied
  parts. #590 stopped the main process and the window keeping two separate
  descriptions of a session RECORD; the same thing was still true of the message
  that says a session changed state, of the saved session cards, of the four
  autonomy modes and of the notification settings — each written out twice or
  more, on two sides of a boundary nothing compared. The looseness had a shape:
  a session's state was described as "any text at all" in three of those places,
  so the window could compare it against a state that cannot happen and quietly
  never match. Every one of them is now a single description both sides read, so
  a mismatch stops the build instead of shipping. No visible change (#618).


## 0.8.2 — 2026-08-21

### Changed

- **A reply can no longer put a media player in your conversation.** Raw HTML in
  a Markdown file or an assistant reply could contain `<video>` or `<audio>`,
  and rendered it drew a real player: something that starts fetching as soon as
  it appears, can play on its own, lands under your Tab key, and carries a
  right-click menu with *Download* on it. The document viewer already replaced
  those with a small "media isn't shown here" chip; the session feed had no such
  step, and neither did the release-notes pane you are reading this in. They are
  now removed for every one of those places at once, along with clickable
  regions drawn over a picture and one tag (`<dialog>`) that hid whatever was
  put inside it. Ordinary pictures are untouched. Two consequences worth naming:
  the viewer's "media isn't shown here" chip no longer appears, because there is
  no longer an element left for it to replace, and whatever was written inside
  the `<video>` or `<audio>` tag as a fallback — a line of text, or a download
  link — goes with the tag. Measured before deciding — across
  7,602 recorded transcripts and 1,182 real Markdown files, not one of them used
  any of these tags outside a code block. (#625)

- **You can now answer just some of Claude's questions.** When Claude asks
  several things at once, **Send answer** used to stay greyed out until every
  one of them had an answer — so "I have an opinion about the first, none about
  the second" meant inventing something to say. It now lights up as soon as one
  question is answered, and the ones you leave blank go back to Claude marked as
  **skipped** rather than as answered with nothing. Claude generally notices and
  offers to ask that one again.

  Because a question can be hidden behind a tab, the panel shows what you are
  about to leave out before you send it: the unanswered tab goes dashed and
  struck through, the question itself says *"Not answered — will be sent as
  skipped"*, and the line beside the button changes from *"Still to answer:
  Languages"* to *"Sending now skips: Languages"*. Nothing asks you to confirm —
  skipping is a real answer, and this only makes it a visible one. Sending a
  completely blank answer is still what **Don't answer** is for.

- **You can see where each of your prompts starts.** The conversation already
  drew a line above every prompt you sent, but it was a one-pixel hairline in
  the same grey as everything else — scrolling back through a long session, it
  was easier to lose your place than to find it. That line is now a proper
  break: a full-width rule, a **NEW PROMPT** caption under it, and a real gap
  above, so the turns in a session are something you can scan for rather than
  read for. It stays deliberately colourless in all four themes — a turn
  boundary is part of the furniture, and the colours are reserved for sessions
  that actually want something from you.

### Fixed

- **Docking a session back now puts it where it came from.** Pop a session out
  into its own window and bring it back and it returned to *some* group — often
  whichever one happened to be on screen — rather than the spot on the grid it
  left. The spot it left is still there while it is away (that is how it comes
  back at all), so the session it belonged to went one way and its half of the
  screen stayed empty. Worse when you start a second session inside the pop-out
  window (`＋` in the card header): that new session has never had a place on
  the grid, and when you brought it back it was handed the *first* session's
  empty spot — so the two swapped places, and the one that owned that half of
  the screen was the one that lost it. Every card now remembers its own spot and
  goes back to it, and a session started inside a pop-out comes home where a
  brand new session would: beside what is already there, never on top of a
  document you are reading. (#558)

- **Dismissing an event now clears the "N need you" counts.** The number on the
  Events tab dropped when you dismissed something, but the other three readouts
  did not: the **"N need you"** on the strip across the top of the window, and
  the ones on each group header and at the foot of the Sessions list, all sat
  there on their old total over an Events drawer you had just emptied. They were
  counting something different from what the drawer was listing. Now all four
  count the same thing, so dismissing — or opening a finished session, which is
  what turns **Done.** into **Ready** — drops every one of them at once, and the
  text goes away entirely at zero.
  Dismissing is still not answering: if a session is genuinely still waiting on
  you, its row in the Sessions list goes on saying so in the status color, and
  it will call again if it asks something new. What the ✕ clears is the count,
  not the session's state.

### Internal

- **A refused IPC call can no longer be mistaken for a yes.** The broker answers
  a call the caller is not allowed to make with a small "refused" object rather
  than an error (#346), and an object counts as "true" in JavaScript — so
  nineteen places in the window read *"you may not do that"* as *"done"* and took
  the wrong path in silence. All nineteen now check properly, through one of two
  shared readers, and a scan that runs with the tests fails the build if a new
  one appears. Nothing you can see changes: this window is allowed to make every
  call, so none of those refusals can happen today. It becomes reachable the day
  plugins hold partial permissions. (#440)

## 0.8.1 — 2026-08-20

### Added

- **A visible way to close the Events drawer.** The drawer's only close control
  was the narrow tab on the right edge — which reads as a way *in* — so opening
  it and then hunting for the way back out was easy to do. There is now a **✕**
  in the drawer's own header, next to the word EVENTS. It does exactly what
  `Esc`, `Ctrl+E` and the tab already did, including putting your cursor back
  where it was, and it is the first thing `Tab` reaches inside the drawer.

- **Close all documents, in one go.** Every file you open gets its own tab, so a
  morning's reading can leave a dozen of them in the strip and no way out but a
  dozen clicks. The command palette (`Ctrl+Shift+P`) now has **Close all
  documents (keeps popped-out ones)**: it clears every document tab at once and
  asks nothing first, because a viewer never edits anything. Your sessions and
  their Changes tabs are untouched, and a document you have moved to its own
  window on another monitor is left exactly where you put it.

- **The autonomy chips now say what a mode does.** Hover the shield chip — in
  the title bar, under the prompt box, or the little marker in a card's header —
  and you get a plain description of what will still stop for you in that mode
  and what won't. The one worth reading is **full-auto**: it is Claude Code's
  `bypassPermissions`, the same thing `--dangerously-skip-permissions` turns on,
  and the hover now says so rather than leaving you to find out. The manual's
  [Approvals & autonomy](docs/manual/04-approvals-and-autonomy.md) page carries
  the full version.

- **Put your sessions in the order you want.** The Sessions list was stuck in
  the order you happened to open things in. Drag a session up or down inside its
  group and it stays where you put it — a line shows where it will land — and
  the arrangement comes back next time you open switchboard. Without a mouse:
  **Move up** / **Move down** in the row's right-click menu, or **`Ctrl+Alt+↑`**
  / **`Ctrl+Alt+↓`** while you are in the session. Dragging onto a *different*
  group still means what it always did — it joins that group, and you arrange it
  from there.
  Pinned sessions still come first in their group; that is the one rule your own
  order does not beat. Since the list is what `Ctrl+1`…`Ctrl+9` counts against,
  arranging it is also how you choose which session is `Ctrl+1`.

- **Several questions at once now arrive as tabs.** When Claude asks more than
  one question in a single go, they used to be stacked down one long panel. They
  are now a tab per question, labelled with Claude's own short name for it, so
  you read one question at a time. Every tab shows whether it has been answered —
  a tick or an empty ring, so it is the shape and not only the colour — and while
  **Send answer** is greyed out the panel names the questions still waiting
  ("Still to answer: Languages"). **Left** and **Right** move between the tabs.
  A single question, which is the usual case, has no tabs and looks exactly as
  it did.

### Changed

- **`Ctrl+F` now finds things in a terminal you have never opened.** The Terminal
  group used to be missing entirely until you had visited the tab at least once —
  switchboard only kept the terminal's picture while you were looking at it, so
  there was nothing in this window to search. It now searches the recording
  behind the tab instead, which is complete and current whether or not you have
  ever opened it: a fresh session gets a real Terminal count from the first
  search. Those matches are readable rather than steppable until you open the
  tab, and the bar says so; the count still covers only the last few thousand
  lines, and still says *scrollback only*. (#517)

- **A reply or a document can no longer put a button or a text box in front of
  you.** Raw HTML in Markdown can contain real controls — a button, a text box,
  a dropdown, a multi-line entry box — and rendered in the conversation feed,
  the document viewer or release notes they looked exactly like switchboard.ai's
  own controls, landed under your Tab key, and could ask for things a real part
  of the app never would ("paste your token to continue"). They are now removed
  everywhere the app renders Markdown. The words inside them stay, so you still
  read everything that was said. Three obsolete tags go with them, for the same
  reason this release removes the older HTML ways of colouring text: `<center>`,
  `<marquee>` and `<font>`.
  It also finishes the **"a document can't hide text from you"** promise
  elsewhere in this release. That entry closed the ways markup could hide text
  using an *attribute*; a `<datalist>` did the same thing as a *tag* — anything
  inside one is in the document, in a find, and invisible, including a code
  block whose **Copy** button would still have worked. It is removed too, and
  what was inside it is now simply on screen.
  Two things this deliberately does **not** change: links in a reply are still
  links — Markdown writes those, and they stay reachable by keyboard — and
  Markdown's own **checklists** keep their box. They are drawn with ☐ and ☑
  characters now rather than a real checkbox, which is why they take your
  theme's colour; they were never clickable in the first place. (#612)

- **Quitting with a document open in its own window no longer leaves an empty
  window behind the next time you start up.** switchboard.ai does not reopen
  document viewers across a restart (that is still to come), but it was
  reopening the *window* one had been in and then emptying it — so you could
  come back to a blank second window that belonged to nothing. Now that window
  is simply not reopened. A window that also holds a session is unaffected: it
  comes back with its session, minus the document tab. (#494)

### Fixed

- **Right-click menus now stay on the screen.** A session row's menu drew at
  the pointer and simply ran off the bottom of a short window — on a small
  laptop screen or a half-height window, the lower menu items (including the
  whole focus-stealing section) were unreachable, with no scrollbar and no
  hint anything was missing. The menu now flips above the pointer when there
  is no room below, sits against the edge when neither side fits, and scrolls
  itself if it is taller than the window.
- **The `ask` autonomy mode asks again.** `ask` never told Claude Code which
  permission mode to use — it let the CLI pick its own, and for years the CLI
  picked "stop and ask a person". Recent versions changed that pick: on a Pro,
  Max or Team plan the CLI now starts sessions in **auto** mode, where a second
  model reviews each action instead of you. So a session you had set to `ask`
  was quietly being reviewed by a classifier. switchboard's own approval bar
  hid most of it — that still held every shell command and every edit — but
  anything it does not cover went through without you. `ask` now names the mode
  outright, and a session started at `ask` is back to stopping for you. You may
  see a few more prompts than you did last week; that is the mode doing what its
  name says. Auto mode is still one **Shift+Tab** away inside a session's
  terminal if you want it. (#587)

- **A suspended session can now be maximized by double-clicking it.** A session
  that came back with the app and hasn't been resumed yet drew
  no card header at all, so the double-click that fills the workspace with one
  session had nothing to land on — the keyboard shortcut worked, the mouse did
  not, and the manual had to write the exception down. Its card now keeps a
  header with the session's name, colour, badge and the word *suspended*.
  Maximizing it doesn't wake it up: it stays suspended, with its **Resume**
  button, until you press that. (#216)

- **A document tab's ✕ no longer claims it ends your session.** Every tab in
  the app was labelled "Close (ends the session)" — true of a session card, and
  simply wrong on a document or a Changes tab, neither of which ends anything. A
  document's ✕ now says **Close document** and a Changes tab's says **Close**.

- **A prompt that is just a picture is no longer lost.** An unsent prompt has
  been kept since 0.7.0, but only the words: the files you had attached
  vanished the moment the card was rebuilt — switching it to Terminal and back
  was enough — so a card holding nothing but a pasted screenshot lost the whole
  prompt. The chips now come back with the words. Their contents are still
  never written to disk, so a full restart does drop them; when it does, the
  composer now says which files it lost and asks you to attach them again
  rather than emptying itself in silence.

- **switchboard now tells you when it has moved a card's conversation, and two
  cards can no longer share one.** A card whose conversation had gone missing was
  already being reconnected to the right one automatically, but it said so only
  in the log — so a session that came back somewhere unexpected looked exactly
  like a bug. It now says so in the Events drawer, in a notice you can dismiss.
  A separate old fault could leave two cards pointing at the **same**
  conversation, with both resuming into one transcript; that pair is now
  untangled on the next launch — the card actually in the conversation keeps it
  (or, if both are, the older card does), and the other one starts a new
  conversation. Nothing is deleted doing it: the given-up conversation is still
  recorded on the card that gave it up, no other card can take it, and the manual
  explains how to swap the two back by hand. Both notices stay put until you
  dismiss them, so quitting without opening the drawer can't lose them.

### Internal

- **When a session's CLI dies badly, the log now says what it said on the way
  out.** The stream transport kept the last few KB of the CLI's error output and
  its framing counters, and showed them to nobody. A session whose stderr or
  framing had anything to report now writes one summary line as it ends — exit
  code, the counters, and the tail of what the CLI printed, which is the part
  that a flood of error output used to push out of the log. A healthy session
  still says nothing at all. (#593)
- The fake CLI the automated tests run against now gives every session its own
  conversation id instead of one shared constant, so a test with two sessions is
  two conversations, the way two real sessions are. Nothing changes for anyone using
  switchboard.ai; it removes a state the real CLI cannot produce, which the code
  that repairs and de-duplicates conversation pointers was being handed. (#603)
- **A part of the window that breaks can come back on its own.** The crash
  barrier around each contributed surface (status-bar items, session panels,
  document viewers) used to latch: one error and that piece of the window was
  an empty gap until switchboard was restarted. It now retries the surface on
  its next update, and only gives up — quietly, as before — after three
  failures in a row, so a piece that is genuinely broken cannot spin.
- **A broken conversation block can no longer blank the window.** The crash
  barrier the rest of the window already had now wraps each block in the
  conversation feed too. Before this, a block that failed while being drawn —
  from one malformed line in a transcript — took down the whole switchboard.ai
  window, every session's terminal included; now it leaves a gap where that one
  block would have been, comes back on the next update, and everything else in
  the conversation keeps working. (#594)
- Accessibility markup written by a document or a reply is now removed along
  with everything else the renderer refuses. Nothing in switchboard.ai ever
  acted on it, but a screen reader did — so a file could label a button
  "Cancel" while it said Approve, hide a line of text from the accessibility
  tree while leaving it on screen, or interrupt an announcement the app was
  making. Every accessible name, role and announcement in a rendered document
  or reply is now one switchboard.ai wrote. (#509)
- Finished the job 0.4.0 started: the older HTML ways of styling text — `<font
  color size face>`, `<hr color size>`, `bgcolor`, `background` — are now
  removed everywhere the app renders Markdown (the conversation feed, the
  document viewer, release notes), so "a reply can't repaint itself in colours
  your theme didn't choose" is true without the footnote that used to follow it.
  Four more go with them, and they are not about looks at all: `hidden` and
  `popover`, either of which left text in the document — and in a code block's
  **Copy** button — while taking it off the screen; `inert`, which left it on
  screen while taking it away from a screen reader and the keyboard; and
  `tabindex`, which let content add itself to, or jump the queue in, your Tab
  order. Nothing Markdown itself writes is affected; table alignment is the one
  legacy attribute that stays, because that is how Markdown aligns a column.
  (#466, #598)
- Gave every test that starts a real child process — `git`, or node running one
  of the build scripts — an explicit time limit. They had been running under the
  test runner's five-second default, which is a budget for a pure function and
  not for a test that shells out a dozen times: one of them took 7.1 seconds on
  a busy Windows CI machine and was killed, turning a pull request that had not
  touched it red. Nothing about the tests themselves changed — only the ceiling
  that decides whether a slow machine reports the test's own verdict or an
  opaque timeout. (#512)
- Extracted the Direct-session setup the end-to-end tests open with — make a
  project folder, launch on the default transport, prove it really is Direct,
  drive a turn of tool calls — into one shared helper. Two specs had grown their
  own copy of the same twenty lines and a third was about to; they now call the
  helper instead, so the next test that needs a Direct session starts from a
  single line rather than a copy that can quietly drift. No test's behaviour
  changed. (#497)
- One default for a session's transport, not two. A live session record always
  carries the transport it was spawned on, so the type now says so and the card
  reads main's answer verbatim — the stray `'pty'` fallback that contradicted
  the shared default is gone, with typecheck-level pins on both ends (#445).
- The renderer's picture of a running session is no longer a hand-copied one.
  What the main process sends about a live session and what the window expects
  to receive were two separate declarations that nothing compared, so they had
  quietly stopped matching — the shared description of a session's status said
  "any text at all" rather than the seven states it can actually be in. Both
  sides now read
  one declaration, and a new field has to say whether it is for the window or
  for main before it will compile (#590).
- **Stream-transport diagnostics now reach the log.** Parse failures, overlong
  lines, CLI stderr and dead-pipe writes were produced by the stream-json
  transport and dropped on the floor — nothing subscribed. They are written to
  `switchboard.log` under the `transport` subsystem, throttled so a wedged
  session cannot rotate the rest of the log away. Nothing changes on screen.

## 0.8.0 — 2026-08-19

### Added

- **A File menu, with Open File and Exit.** Opening a file used to be possible
  only from the command palette, which meant knowing it was there at all. There
  is now a **File** menu at the top left, where every desktop app has put one:
  **Open File…** browses for any file and shows it in a document tab, and
  **Exit** quits. The browser starts in the folder of the session you are
  looking at, and after that wherever you last browsed to — so opening a second
  file from the same place is one click, not a journey. **Ctrl+O** does the same
  thing from anywhere in the app, including while you are typing a prompt. Inside
  a session's **Terminal** the key still belongs to Claude Code, which uses it
  for its own transcript view.
- **A file opens next to the session you are in.** Documents used to appear
  wherever the workspace happened to have room. The first one now opens beside
  the session you were looking at, splitting that part of the workspace, and the
  ones after it join it as tabs. It is still never a tab inside the session
  itself — your session tabs stay sessions.

### Fixed

- **A question now waits as long as you need.** Questions used to be declined on
  your behalf after half an hour — so stepping away mid-question and coming back
  to answer it meant your answer went nowhere, and Claude had already been told
  nobody replied. There is no time limit now: a question waits until you answer
  it, for as long as switchboard is open. (Permission requests keep their
  five-minute limit — those are a glance and a click.)
- **A popped-out session comes to the front when you click it.** With a session
  torn off into its own window and that window behind another one, clicking its
  row in the sidebar focused it invisibly — the window stayed buried. It now
  comes forward. Clicking the main switchboard.ai window still leaves your
  popped-out windows exactly where they are: they only come forward when you ask
  for that particular session.
- **The Changes tab comes back to the file you were reading.** Switching a
  session to another tab and back used to return the Changes tab with nothing
  selected at all — you picked your file again and found your place again, every
  time. It now reopens on the same file, at the same line. If that file has
  stopped being a change in the meantime — you committed it, or discarded it —
  the tab opens clean rather than showing you a blank comparison. It remembers
  until you quit, not across a restart.
- **A document keeps your place when you glance at another one.** With two
  documents open side by side as tabs, reading halfway down one and clicking the
  other took you back to the top of the first when you came back. Both now stay
  where you left them.

## 0.7.0 — 2026-08-17

### Added

- **Claude can ask you a question, and you can click the answer.** Sometimes
  Claude doesn't want permission — it wants a decision: *"which of these three
  approaches should I take?"*, *"which file did you mean?"* Until now those
  questions had nowhere to go in a Direct-mode session. They now appear as a
  panel just above the prompt box, in the same place permission requests appear,
  with the question written out and its answers as a list you can click. Round
  buttons mean pick one; square boxes mean pick as many as you like. **There is
  always an "Other"** — tick it and a text box opens where you type your own
  answer in your own words, and Claude reads it exactly as if it had offered it
  as an option, which is what keeps a question with the wrong four choices
  answerable instead of answerable-wrongly. Claude can ask several questions in
  one go: they are shown stacked, each with a tick once it is answered, and
  **Send answer** stays greyed out until every one of them has one. It all works
  from the keyboard — arrow keys move between answers, Space picks, Enter sends.
  **Don't answer** is a real answer too, and a safe one: Claude is told you
  declined and asks again in ordinary conversation rather than getting stuck.
  Take your time — a question waits half an hour rather than a permission
  request's five minutes, and a half-finished answer survives leaving the panel,
  so you can go and read the diff on the **Changes** tab and come back to your
  ticks and your typed text still there.
- Two things it deliberately does not do, both for the same reason — a question
  can only be answered by a person. **"Allow all (this session)" does not answer
  questions**: it is a standing yes to *tool use*, not to *you*, so questions
  still wait even in a session where everything else is automatic. And the
  desktop pop-up for a question carries **no Allow button** — it says what is
  being asked and clicking it brings you to the panel, because a button on a
  pop-up could only ever skip the question, never answer it.
- **Terminal-mode sessions keep their questions in the terminal.** Claude Code
  draws them there itself and switchboard cannot reach in, so you will find
  them on the **Terminal** tab rather than as a panel. Switch a session to
  Direct mode for the clickable version.

### Changed

- **Find is a bar first, not a list.** Ctrl+F used to swing the results list
  open before you had typed anything useful. Now the bar does the ordinary job
  on its own — the match count, Enter and Shift+Enter to walk them — and the
  list stays behind its **▸** until you ask for it.

### Fixed

- **Sessions come back where you left them.** Restarting switchboard used to
  drop every session's conversation at the very top, so the first thing you saw
  was the beginning of a conversation you had been reading the end of. Feeds now
  land at the tail where they belong, and stay put when a panel is dragged to a
  different part of the workspace.
- **Find works in a resumed session.** Resuming a session used to leave its
  search able to list matches but not jump to them, with a notice over the whole
  session saying so. Now each match is resolved on its own: everything from
  after the resume jumps normally, only the older hydrated part of the
  conversation stays unjumpable, and it says so about that one match instead of
  over the whole session.

## 0.6.0 — 2026-08-16

### Added

- **Right-click menus.** Right-clicking anywhere in switchboard used to do
  nothing at all. Now a right-click in the prompt box — or any other text box —
  gives you **Cut, Copy, Paste and Select All**, greyed out when they would do
  nothing (no Cut with nothing selected, no Paste with an empty clipboard).
  Right-clicking text you have selected in a session's conversation, or in a
  document, offers **Copy**. Pasting from the menu works exactly like Ctrl+V,
  pictures included: a screenshot pasted from the menu becomes the same chip
  under the box. Popped-out session windows get the menus too. Right-clicking
  in the **Terminal** tab is left alone deliberately — the terminal has its own
  conventions and they are the CLI's, not ours.
- **Start a new session without leaving a popped-out window.** Tearing a session
  into its own window used to leave you with no way to start another one from
  there: every "new session" control lives in the main window's sidebar, so a
  second monitor meant going back to the first one to ask. A popped-out card's
  header now has a **＋** next to the pop-out button, and **Ctrl+N** works in
  that window too. The new session opens as a tab right beside the one you asked
  from, on the monitor you are already looking at, and the folder picker opens
  over that window instead of dragging the main window in front of you. It is an
  ordinary session in every other way — it gets a row in the Sessions list, it
  can ask for your attention, and **⤡** docks it back into the main window on
  its own. Sessions started from the main window are unchanged: they still open
  there, at full size, and never on top of a document you have open.
- **Quiet hours.** Set two times — press **Ctrl+Shift+P** and type *quiet
  hours*, or use the button in **About** — and between them switchboard will not
  make a noise at you. Pop-ups, session sounds, spoken announcements and phone
  push all stop; your sessions keep running and everything still lands in the
  Events panel, you just are not told about it until the window is over. A
  window that runs past midnight is fine (`22:00` until `07:00` means
  overnight), the times are your machine's clock so they follow you across
  timezones, and daylight saving needs no thought: they mean the numbers on the
  clock on the wall. The dialog's bottom line tells you whether the window is
  open right now and how many notifications it has held, because a feature whose
  whole job is to do nothing is otherwise impossible to trust.
- **Nothing is lost while it is quiet.** Every notification the window holds
  back is written down — what happened, when, which session, and which channels
  were held — and that list survives closing the app. The *missed-events digest*
  that shows it to you on return is the next thing to land; this release is what
  fills it. The list keeps the 200 most recent.

### Changed

- **Every file you open now gets its own tab, and the 📌 is gone.** Opening a
  second document used to *replace* the one you were reading, and the pin was
  how you stopped it. That is over: a new file opens beside the ones already
  open, nothing closes on its own, and a document goes away only when you close
  its tab with the **✕**. Opening a file that is already open still just brings
  its tab to the front. If you liked a tidy tab strip, closing the ones you are
  done with is now your call rather than the app's.
- **Quiet hours no longer silence webhooks.** They used to stop every channel
  including the webhook; now they stop everything aimed at *you* and let the
  webhook through. A webhook goes to a program — usually the very program you
  set up so that something would be watching while you are not — and a
  dashboard or log with a hole in it every night from 22:00 to 07:00 is a broken
  one, in a way whose cause (a notification setting on another screen) is
  miserable to track down. If your webhook really is person-facing — it flashes
  a lamp, it pages you — a rule can be marked to obey quiet hours anyway; see
  the manual. The 🔔 title-bar switch is unchanged and still silences
  everything, webhooks included.
- **A quiet-hours time that switchboard cannot read is now refused** rather than
  stored. A workspace file carrying something like `"10pm"` used to look
  configured while silencing nothing at all.
- **The Events panel is a drawer now, and your sessions get the space back.**
  It used to be a permanent column down the right-hand side, about an inch wide,
  present in every layout whether or not anything was in it. That inch now
  belongs to your sessions — in every layout, all the time. What is left on the
  right edge is a **narrow tab with a number on it**: how many sessions are
  waiting on you. Click it — or press **Ctrl+E**, or find *"Show or hide the
  events drawer"* in the command palette — and the drawer slides out over the
  workspace with exactly what the panel always held: one entry per session, in
  the order you should deal with them. **Esc** closes it and puts your cursor
  back where it was.

  Nothing inside it changed and nothing moved out of it: the same rows with the
  same **✕**, the same click-to-jump, and the same three notices — a new version
  is ready, a monitor came back and your pop-outs can be restored, or Anthropic
  is having an incident. It opens *over* your sessions rather than shoving them
  aside, so glancing at the queue never re-lays-out the window you were reading.
  And it starts closed each time you launch.

  You do not have to open it to know whether it is worth opening. The tab
  carries the count, tints itself with the most urgent thing waiting, and grows
  **a small dot when there is a notice inside** — so an update or an incident
  still catches your eye from behind a closed drawer. If you use a screen
  reader, the tab reads all three out in words, and a notice arriving behind a
  closed drawer is announced when it lands rather than waiting to be found.
- **The status bar now says how many sessions are waiting on you.** Bottom
  right, next to the session count, permanently: *"3 waiting"*. It never needs
  opening and never moves, so the question the Events column used to answer just
  by being there is still answerable with a glance — and it is the same number
  **Ctrl+Space** walks through.

### Fixed

- **`Ctrl+F` now works in a document.** Press it with a document tab in front of
  you and switchboard's find bar opens over that document: type and matches
  light up, `Enter` and `Shift+Enter` step, the count reads "3 of 12", `Esc`
  closes it and takes the highlights with it, and the ▸ button lists every
  match. It was silently doing nothing before. Only the document you are
  reading is searched — never another document, never a session — and it works
  the same in a popped-out document window. Any file that is not Markdown (and
  Markdown under **Source**) hands you to the editor's own find box instead,
  which is the fuller one, exactly as the **Changes** tab does.
- **Find now shows you where the word is.** Stepping through matches in a
  session used to scroll the conversation up and down without highlighting
  anything, so you had to re-read the block to find the word you searched for.
  The match you are standing on is now highlighted brightly, the other
  occurrences on screen get a quieter highlight, and if the match is buried
  a long way down a tall tool output the view scrolls again so the word itself
  is on screen. Closing the bar takes the highlights with it, and they are
  never part of what you copy — selecting highlighted text, or pressing
  **Copy** on a code block containing a match, gives you the text exactly as
  the session wrote it.
- **An update now actually brings the app back.** Installing a release from
  inside switchboard.ai did everything it said it would — downloaded, checked,
  installed — and then left you staring at a closed app, having promised on
  screen that it "will close and reopen on the new version". The update was
  fine; only the reopening was missing. The silent installer is now told to
  relaunch us, so pressing **Update** ends with the app back on your screen on
  the new version, as it always claimed it would.
- **Links in a session's answers open in your browser.** A link in a reply
  looked like a link, went blue like a link, and did absolutely nothing when
  you clicked it — the click was swallowed on the way out and never reached
  anything. Now it opens in your normal web browser, including from a
  popped-out card, and switchboard.ai itself never navigates away from the
  session you were reading. Ordinary web links only (`http`, `https`,
  `mailto`): anything else in a link — a scheme that would run a program or
  open a file off your disk — still does nothing at all, on purpose, because
  the text of an answer is written by whatever the session was reading.
- **A card can no longer forget which conversation it was in.** switchboard
  records a session's conversation the moment Claude Code names one — but Claude
  Code doesn't write that conversation to disk until you actually send
  something. Open a session, close it again without typing, and the card was
  left pointing at a conversation that had never been written down; the next
  launch found nothing there, gave up, and **erased the card's only pointer to
  the conversation it really had**. The same thing happened if the lookup simply
  failed for a moment — one antivirus scan or file-indexer at the wrong instant
  and a working card was reset for good. Both are gone. A card now remembers the
  conversations it has been in, not just the latest one: if the newest has
  nothing on disk it falls back to the one that does, and a lookup that fails is
  treated as "not right now" instead of "gone for ever". Nothing about your
  history is ever deleted on the strength of a failed look.
- **Cards that were already orphaned repair themselves on the next launch.** If
  a card lost its conversation to the bug above, switchboard now notices at
  start-up that its conversation isn't on disk, looks in that project's own
  history for the one it walked away from, and reattaches it — you get your
  session back with its transcript, and the app writes a line in the log saying
  what it reattached and why. It only ever does this for a card that *had* a
  conversation and lost it, it never takes one another card is already in, and
  it never guesses off a folder it couldn't read, and it leaves alone anything
  written to in the last few minutes — that's far more likely to be a `claude`
  session you have open in a terminal than a conversation a card mislaid.
- **A prompt you started writing is no longer thrown away.** Text typed into a
  session's prompt box and not yet sent used to vanish the moment that view went
  away — switching the card to its **Terminal** or **Changes** tab and back, or
  quitting switchboard. It is now kept per session, saved as you type, and it
  comes back: on the Session tab, in a popped-out window and when you dock the
  card back in, and after you quit and reopen — including for a session that was
  suspended and resumes later. Sending the prompt clears it, as you would
  expect, and a box you emptied stores nothing.
- **The Changes tab shows side-by-side diffs again, and now lets you say so.**
  A diff was arriving in one column no matter how much room it had, with no
  visible way to ask for two. The tab had in fact been asking for side-by-side
  all along — Monaco quietly overrides that below 900 pixels of editor width,
  and a Changes tab in a normal window sits just under it, so the override
  fired every time and said nothing. That silent rule is gone. There is now a
  **Side by side / Inline** pair of buttons above the diff, side by side is the
  default, your choice applies to every Changes tab and is remembered across
  restarts, and the command palette has *Toggle side-by-side / inline diff*.
  Genuinely tiny panes — under 400 pixels, where two columns hold about 18
  characters each — still fall back to one column, but the tab says so in
  words, the button stays selected, and the second column returns the moment
  there is room for it.

### Internal

- Fixed the end-to-end test that kept failing on the Windows CI machine and
  nowhere else — five red runs in two days, on branches that had not touched
  anything near it. The tests walk the conversation with the keyboard and then
  expect one more Tab to land in the prompt box, which was true until the
  "↓ Jump to latest" button was added between the two. That button only appears
  when the conversation has scrolled off the bottom *and* is taller than its
  pane — true on the CI machine's small screen, false on a developer's — so the
  Tab landed on the button there and in the prompt box here. The walks now
  expect either order, and a test that states the CI machine's screen size pins
  the two-step one down everywhere.

## 0.5.0 — 2026-08-14

### Added

- **Paste a picture into the prompt box.** Copy a screenshot, something from
  Paint, or an image off a web page, press **Ctrl+V** in a session's prompt
  box, and it attaches as a small chip with a thumbnail — then type your
  question and press Enter, and Claude actually looks at it. The ✕ on the chip
  removes it before you send, several images can ride one prompt, and an image
  on its own is a perfectly good prompt. If your clipboard holds text *and* a
  picture, you get both. Pasting ordinary text is completely unchanged.
  Anything it cannot send it says so about, under the box, before you have
  waited on a reply: an image that is too big, a format Claude cannot read
  (only PNG, JPEG, GIF and WebP work — for anything else, put its file path in
  the prompt), or a session running in **Terminal mode**, where pictures have
  to be pasted into the Terminal tab instead. And if a prompt with a picture
  does not go, nothing is cleared — your words and your image stay where they
  are.
- **Drag files onto the prompt box — not just pictures.** Drag one or more
  files from Explorer onto a session's prompt box and they attach as chips, the
  same ones a pasted picture uses. Markdown, plain text and source files
  (`.md`, `.ts`, `.py`, `.json`, `.log`, `.csv`, `LICENSE`, `Makefile`,
  `.gitignore` and a hundred-odd more), images, SVGs and PDFs all work, and
  each one is sent in the form Claude reads best — a text file arrives as its
  **contents**, labelled with its name, not as a path Claude has to go and open.
  Up to eight per prompt, mixed kinds welcome, in the order you dropped them.
  Anything it cannot use it says so about, under the box: a file too big, a
  type Claude cannot read (it names the file-path escape hatch instead), an
  empty file, or a **folder** — which cannot be attached to a prompt, though
  dropping one anywhere *else* in the window still opens it as a session, as it
  always did.
- **Copy the code a session just gave you.** Code blocks in an answer now carry
  a small header with the language on the left and a **Copy** button on the
  right — one click puts the whole block on your clipboard, exactly as written.
  Open a command box and its **IN** and **OUT** sections get one too: **OUT**
  copies the entire output, not just the line the collapsed box was showing.
  It's the same button the document viewer has always had on its code blocks,
  it's reachable with the arrow keys along with everything else in a
  conversation, and it works in a popped-out card.
- **`Ctrl+F` now searches the session's terminal too, and says which is which.**
  One press searches both the conversation and the terminal's scrollback, and
  the bar reports them as two counts rather than one — "12 in Session · 3 in
  Terminal (scrollback only)". A match in the terminal is highlighted where it
  sits and `Enter` scrolls to it, reaching back through the whole scrollback and
  not just the visible screen. The two numbers are never added together, because
  they are not the same depth: the conversation is the whole session, the
  terminal is the last 5,000 lines. That is why a terminal group showing **0**
  still says "scrollback only" — it means *not in the last 5,000 lines*, not
  *never printed*. `Ctrl+F` pressed with your cursor inside the terminal still
  goes to the program running there, deliberately: it is a real key in the CLI.
  From there, `Ctrl+Shift+P` → **Find in session** opens the bar.
- **An open document updates itself.** Leave a file open in the document
  viewer — a README, a plan, a running log — while a session rewrites it, and
  it re-renders on the spot instead of going stale until you close and reopen
  it. You keep your scroll position, so you can read the middle of a file that
  is being rewritten around you. A burst of writes (which is what one "save"
  from a session usually is) settles into a single update rather than ten, and a
  file that is deleted while you are reading it gets a strip saying so with the
  last version still on screen — not an error page, and not a blank one. If the
  file comes back, so does the live view.
- **Every session can have its own sound, and switchboard can say which one
  wants you.** Turn on **🔊 session sounds** in the title bar and each session
  rings a different short cue instead of everything sharing one beep — so with
  six cards open you can tell which one needs you without looking. Sounds are
  handed out automatically in the order you open sessions; pick a different one
  from a session's **⋯ menu**, where each click plays the next of the eight and
  pins it to that session for good. Turn on **🗣 announce** and it will *say* it
  out loud — *"Add markdown preview needs your input"* — using your computer's
  own voice, with nothing sent anywhere. The voice prefers a session's task
  label and falls back to its title, and it only speaks while you are not in
  switchboard, like the desktop pop-ups. Both are off until you ask for them,
  the cue replaces the beep rather than adding to it, and if a sound cannot be
  played you get the plain beep instead of silence.

### Changed

- **The 🔓 auto-trust / 🔒 ask trust chip is now greyed out when nothing could
  ask you.** Claude Code only ever raises its folder-trust question in Terminal
  mode, so on a workspace where every session is in Direct mode — the default —
  picking **🔒 ask trust** could never actually get you asked. The chip is now
  disabled there, and hovering it says why. Switch any session to Terminal mode
  from its **⋯** menu and the chip comes straight back, including while that
  session is still running and waiting for its restart. Whatever you had chosen
  is kept and still shown: being greyed out takes away the switch, never your
  answer.
- **Direct-mode sessions no longer accept a folder on your behalf.** With
  auto-trust on, switchboard records your acceptance in Claude Code's own
  settings before a session starts — so that the trust prompt never interrupts
  you. It now does that only for Terminal-mode sessions, the only ones Claude
  Code would ever have asked. A Direct session leaves the setting exactly as it
  found it, so a folder you have only ever run in Direct mode still has the
  question waiting the first time you open it in Terminal mode — set the chip to
  **🔒 ask trust** before that first Terminal start if you want to answer it
  yourself, since auto-trust is what answers it otherwise. (Nothing is lost by
  not writing it: measured against claude 2.1.226, an untrusted folder in Direct
  mode runs normally, with your project settings and hooks.)

### Fixed

- **A reply can no longer take over a conversation's own controls.** Replies are
  rendered Markdown, and Markdown can carry raw HTML. If that HTML happened to
  copy the small markers switchboard.ai puts on its own expanders and blocks, the
  app believed them — so a single message could stop the arrow keys moving
  between the real tool blocks below it, put a fake control on the keyboard path,
  or send **Find** to the wrong paragraph and highlight it as the match. Nothing
  a message or a document contains counts as the app's own markup any more, on
  every surface that renders Markdown: the conversation, the document viewer and
  the update notes.
- **Find can now jump in Direct-mode sessions.** Clicking a result in the
  find bar's list scrolls to that match and opens whatever was covering it,
  in every session — Direct mode included, which used to list matches but
  could not take you to them. Matches from further back than the loaded view
  are still list-only and labelled as such, exactly as before.
- **A new session no longer opens into a sliver you cannot see, or on top of the
  file you are reading.** Popping a session into its own window leaves a gap in
  the main window for it to dock back into — and starting a session while every
  card was popped out put the new one into that gap, a couple of dozen pixels
  wide, with only its row in the sessions list to say it existed. It now opens
  at full size in that space instead. It also stays out of the document
  area: with a file open and the session popped out, the new card used to arrive
  as a tab over the document instead of beside it.
- **A Direct session that can't find its transcript no longer sends you to a
  terminal it hasn't got.** When the Session tab gave up looking for a
  conversation file it signed off with "The Terminal tab is unaffected — your
  session is still running there" — which is true in Terminal mode and was
  being said in Direct mode too, where the Terminal tab's entire content is "No
  terminal for this session". Two honest sentences in one window adding up to a
  wild goose chase. A Direct session now gets the sentence that fits it: its
  replies come into that window over its own connection and were never read out
  of that file, the status on the card header says what it's doing, and what
  the missing file actually costs is usage totals and resuming the conversation
  later. Terminal-mode sessions read exactly as before.
- **A `↓ Jump to latest` button, for when the conversation has left you
  behind.** Scrolling up in a session — or walking it with the arrow keys —
  deliberately unsticks the view from the newest message, so that a reply
  arriving mid-read can't drag you off what you were reading. Getting back
  meant scrolling all the way to the bottom by hand, and nothing on screen even
  said the view had stopped following: on a small window, where a single turn
  can be taller than the pane, it was easy to end up parked at the top of a
  session that looked idle and was in fact still talking. A button now appears
  just above the prompt box whenever you're away from the bottom of a
  conversation that has a bottom to be away from — one press and you're back at
  the newest message and following again. It's one `Tab` from the conversation
  and one `Shift+Tab` from the prompt box, and it takes itself away when it has
  nothing to offer.

### Internal

- The end-to-end tests can now run on a second monitor, so a local run stops
  throwing app windows across the screen you are working on: set
  `SWITCHBOARD_E2E_MONITOR=2` (monitor 1 is always your primary one). With it
  unset — and on any machine with a single display, which is every CI runner —
  nothing changes at all. It quietens the screen and not the keyboard: showing
  a window still takes the focus wherever it is.
- Tightened up the housekeeping that clears out the files switchboard writes
  for each session. The startup pass that removes leftover access files now
  checks that a folder's name is one switchboard actually created before it
  deletes anything inside it — previously anything that happened to be sitting
  in that folder was fair game — and it leaves alone anything belonging to a
  session that is running right now, stopping after a couple of seconds if
  there is a large backlog so that starting the app is never held up. And when
  a session fails to start at all, the access it had been granted is now handed
  back immediately instead of being held until you quit. Nothing about this is
  visible while things are working; it is the tidy-up behind the scenes.

## 0.4.0 — 2026-08-13

### Added


- **Answer a permission from the desktop pop-up.** When a session asks
  permission while you are in another app, the pop-up now carries **Allow** and
  **Deny** — press one and the tool runs, or Claude is told no, without
  switchboard ever coming to the front. The pop-up names what it would allow
  ("Allow Bash? npm run build"), not just that something is waiting. Clicking
  the pop-up *body* is never an answer: it brings switchboard forward onto the
  card that is asking. Answer it anywhere else — the approval bar, the Events
  panel, the batch bar — and the pop-up is withdrawn, so a stale **Allow** can
  never sit in your notification centre for a settled question. Buttons on
  notifications are the operating system's to grant: Windows and macOS get
  them (an installed build on Windows, a signed one on macOS); Linux gets the
  click-to-jump path instead. The approval bar in the app is unchanged and is
  always there.

- **A session's task label now fills itself in.** Claude Code gives every
  conversation a short title of its own; if you have not typed a label, the card
  shows that instead — so a screen full of sessions reads "Add markdown
  preview", "Fix the login redirect" rather than three copies of your folder
  name. It usually turns up a turn or two after your first prompt, keeps up when
  Claude rewords it, and rides into desktop notifications ("Add markdown preview
  needs your input"). Anything you type wins permanently, clearing the box hands
  it back, and a conversation Claude never names simply has no label — exactly
  as before. Costs nothing: the transcript was already being read, and no tokens
  are spent.
- **🏷 auto labels** in the title bar turns that off. The label is derived from
  what you asked, so this takes it off the card, out of the sessions list and
  out of notifications in one click — for a screen-share or a demo. Labels you
  typed yourself are never hidden, nothing is deleted, and turning it back on
  restores them instantly.
- **Tell me when *this* one is done.** Each session's ⋯ menu now has a **Notify
  when done** tick-box. Tick it and that session pops up a desktop notification
  when it finishes a turn — only while you're in another window, and only for
  the sessions you asked about. Every other session goes quiet on finishing,
  because a pop-up for every five-second turn is noise. The tick is remembered
  across restarts.
- Notifications are now driven by **rules** — *when [event] in [this session or
  any], and [the window is or isn't in front] → [do something]*. The checkbox
  above is the first one, and the Allow/Deny buttons and the phone push below
  are rules as well — so a per-session sound, or a spoken announcement, can be
  added the same way later rather than each needing a setting of its own.
- **A session can now reach your phone.** Point switchboard at an
  [ntfy](https://ntfy.sh) topic or a [Pushover](https://pushover.net) account
  and it will buzz your phone when a session needs permission, needs input, or
  crashes — but only while you are away from the app, and never at an urgency
  that overrides your phone's do-not-disturb. Set it up with `Ctrl+Shift+P` →
  *phone push*, or from the About panel; there is a **Send test** button so you
  find out it works before you need it to.
- **Webhooks.** The same events can be POSTed as JSON to a URL you own — a
  dashboard, a Slack relay, a home automation. The body is documented in the
  manual and carries the event type, the session and card ids, the title and a
  timestamp, and nothing else: no folder, no file paths, no prompt text. Unlike
  the phone push it fires whatever the window is doing, and includes finished
  turns.
- **Your credentials go into your operating system's credential store** —
  Windows DPAPI, the macOS Keychain, your Linux keyring — never into a
  switchboard file, and never into the logs. switchboard cannot show a saved
  value back to you: the box stays empty and says "saved" instead. Paste a new
  value over it to change it, or press Forget. On a Linux box with no keyring
  it says so and refuses to store anything rather than writing a token to a
  plain file. All of this is off until you set it up, and the app is entirely usable
  with none of it configured — a phone that is off, or a webhook host that has
  gone away, can never hold a session up, and the failure is logged once rather
  than on every event.
- **The app now knows when Anthropic is having a day.** A small dot at the
  right-hand end of the bottom bar reflects Anthropic's public status page —
  green for all clear, amber for degraded, red for an outage, hollow grey when
  it could not find out. Hover it for the page's own summary, any open
  incidents, and when it last checked. Open incidents also appear as a card at
  the top of the Events panel, and disappear when they resolve.
- **"Several sessions just hit errors — this may not be you."** Status pages
  lag reality, so switchboard also watches your own window: when three
  different sessions hit errors within about five minutes, an amber strip says
  so. It clears itself the moment one of them completes normally, and it works
  even with the status check turned off — that half never touches the network.
- **Check provider status** can be turned off in About this build, next to the
  update setting. The check is a plain read of a public page: nothing about
  your sessions, your machine or your work is ever sent.
- **Read a file in the app, rendered.** A new document viewer opens Markdown as
  Markdown — tables, task lists, code blocks with a Copy button, an outline for
  long documents, and links to other files in the project that open right there
  with back and forward. Open one from **Open file…** in the command list
  (`Ctrl+Shift+P`), or by clicking a file's path in the Changes tab. Anything
  that isn't Markdown opens as read-only, syntax-coloured source; the
  `Rendered | Source` buttons switch between them and each keeps its own scroll
  position. `Ctrl+F` finds text in the document you are reading, and nowhere
  else. PDFs, images and other binaries aren't rendered — you get a card naming
  the file with **Open externally** and **Reveal in folder**, which are in the
  header of every document too. The viewer never saves anything, never loads a
  picture from the internet, and only opens files inside a folder you already
  have a session in, or files you picked yourself.
- **One document at a time, unless you say otherwise.** Opening a second file
  reuses the same viewer instead of stacking up tabs — glance at six files and
  you still have one panel, not six. When you want to keep one, click the 📌 in
  its header: that document stays put and the next file you open gets a fresh
  panel of its own. Click 📌 again to hand the slot back.
- **A document can have its own window.** The ⤢ beside the pin moves the
  document you are reading onto its own OS window — a second monitor, your
  reference open beside the work — and the same button puts it back. Closing the
  window puts it back too.
- **A document opened from a session says so.** Open a file from a session's
  Changes tab and the viewer wears that session's colour down its edge with a
  small `↳ name` chip. It is a label, not a leash: the document is not part of
  that session, does not appear in the sessions list, is never picked up by
  **Close all sessions**, and stays open after the session it came from is
  closed.

- When two or more sessions are waiting on **exactly the same** permission
  request, it now appears once, on a single card above the workspace, with
  every session named — answer all of them with one click, or allow one and
  decline another. Requests only share a card when the tool and every argument
  match character for character, so `rm -rf build` and `rm -rf /` are never
  answered together.
- **`Ctrl+F` finds things in a session.** A find bar, the way a browser means
  it: type, `Enter` and `Shift+Enter` to step, a count beside the box, `Esc` to
  close and get your cursor back. It searches the *whole* session rather than
  what happens to be on screen — including the older part a long conversation
  has scrolled out of memory, the tool output your detail level is hiding, and
  anything folded — and jumping to a match opens whatever was covering it.
  Open the results list for the matches with their surrounding text. On the
  **Changes** tab the same key hands you the diff editor's own find rather than
  putting a second, worse one on top of it. Two boundaries worth knowing:
  matches from further back than the loaded view are readable in the list but
  can't be scrolled to, and are labelled as such; and sessions in Direct mode
  currently get the list without the jump, because their conversation and their
  transcript can't yet be lined up. The Terminal tab greys the bar and says so
  instead of pretending.

### Changed

- **Rendered Markdown can no longer position itself over the app.** Anywhere
  the app shows Markdown — the conversation feed, the document viewer, release
  notes — an inline `style` written into the text is now ignored. So a reply or
  a file can't float a box over the app's own controls, hide text underneath
  one, or repaint itself in colours your theme didn't choose. A few older HTML
  tags (`<font color>` and its relatives) can still tint text; shutting those
  down is still to come. Nothing Markdown itself produces changes: tables still
  align, task lists still tick, code blocks are untouched.

### Fixed

- **A reopened session shows its conversation again.** Since 0.3.0, quitting
  switchboard and opening it again left every Direct-mode card looking blank —
  no prompts, no replies, nothing — as though the session had been wiped.
  Nothing ever was: the conversation was on disk the whole time, and Claude
  still remembered every word of it. The Session view now reads that history
  back when a session resumes, so the card comes back with the conversation you
  left in it and your next prompt carries on at the bottom of it. Very long
  conversations show their most recent stretch rather than the entire archive,
  the same as they do while running.
- **The manual was wrong about 🔒 ask trust in Direct mode.** It said you had to
  put a session on Terminal mode to answer Claude Code's folder-trust prompt.
  In fact Claude Code raises no trust question at all in Direct mode — it just
  runs in the folder — so nothing hangs and nothing needs working around. The
  real consequence is the other way round: **ask trust only does anything for
  Terminal-mode sessions.** Settings and Direct mode now say so.
- The ring that shows you which session `Ctrl+Space` just sent you to now lasts
  a second and a half **from the moment it appears on screen**. It used to be
  counted from the keypress, so on a busy machine the whole beat could pass
  before the window caught up and you saw no ring at all.
- **No more ring fireworks after a spell in a pop-out window.** `Ctrl+Space`
  works from a pop-out, but the ring it draws lives on the main window's lamp
  strip — so if that window was behind something, every jump you made while it
  was hidden used to save up its ring and fire them all off the moment you came
  back. Now only the last jump is waiting for you: one ring, on the session you
  actually landed on. A ring that is already **up on screen** is untouched —
  jump to one session, then a moment later to another, and both rings are there
  together, each fading on its own count.
- The little language badge beside a session's name (`TS`, `PY`, `JS`) is now
  filled with the session's own color and lettered in dark, instead of being
  written in that color. On the light theme it was barely visible against the
  card header; it is now readable on every theme and in every session color.
- **The prompt box now grows to fit what you actually pasted.** It used to
  count only the times you pressed Shift+Enter, so a pasted paragraph that
  filled eight lines on screen still sat in a one-line slot with the rest
  hidden. It now grows with the text as it wraps, up to twelve lines, scrolls
  inside itself past that, and shrinks back down as you delete.
- **Sessions no longer leave a folder behind on disk for ever.** Every session
  switchboard starts gets a small private folder to hold the settings file it
  hands the CLI, and nothing ever deleted it — one folder per session you had
  ever started, kept until you reinstalled. They now go when the session ends,
  however it ends, and the ones already piled up from earlier versions are
  cleared out over the next few times you open the app — a day's worth at a
  time, and never more than a couple of seconds of it per launch. Nothing you
  can see changes; you get the disk space back.
- **Opening Changes on a popped-out session no longer buries the diff in that
  session's window.** If a card was in its own pop-out window, "Open changes"
  put the diff inside that window as an extra tab — behind the session you were
  watching, and nowhere near the main window you asked from. It now always
  opens in the main window, the same as a new session does.

### Internal

- The session controls (`/clear`, `/compact`, Stop, and sending a prompt) no
  longer go quiet if the internal call behind them fails outright. They used to
  ask the app to take the message and, if that request *errored* rather than
  answering, do nothing at all and say nothing — the same shape as the Stop
  button that did nothing in Direct mode. They now fall back to the terminal
  route and leave a line in the console explaining why — for a Direct-mode
  session there is no terminal to fall back to, so what changes there is that
  the failure is visible at all rather than silent. Plus the batch of tests
  that pins the transport rules already in place: which transport a session
  ends up on is the provider's answer, not the caller's request; a mistyped
  `SWITCHBOARD_TRANSPORT` warns instead of silently landing on the opposite
  transport; and a card that explicitly chose Terminal still comes back on
  Terminal after a restart.
- A Direct-mode session now learns the conversation id it will resume with
  from the stream itself (`system:init`), instead of only from hook events —
  so "reopen the same conversation after an app restart" no longer depends on
  the hook listener staying alive, which is the path being retired. Nothing
  changes visibly today (measured 2026-08-10: the CLI does still fire hooks in
  Direct mode); this is the groundwork and the coverage. The stream test fake
  now honours `--resume`, and a new end-to-end test relaunches the app and
  proves the conversation continues.
- Where a session's transcripts live is now worked out once and handed to
  everything that reads them — the "can this session resume?" check, the
  watcher, and the replay of a resumed conversation — instead of each deciding
  for itself. Nothing changes for the sessions switchboard runs today; it
  closes the way a future non-Claude agent could have passed the resume check
  and then come back with an empty conversation.

## 0.3.0 — 2026-08-09

### Changed

- **Desktop pop-ups got quieter** — this only affects you if you had turned them
  on. They used to pop for every attention event regardless of what you were
  doing. Now: **needs permission** and **needs input** pop up only while you're
  away from the switchboard window, a **crash** still pops up even if you're
  looking right at it, and **finishing** no longer pops up at all unless you
  tick **Notify when done** on that session. The sound and the Events panel are
  unchanged.
- **New sessions now start in Direct mode** instead of Terminal mode.
  Permission requests — including the `.claude` ones that used to escape into
  the terminal and ask you twice — are answered in the card, and replies arrive
  a word at a time. The trade is that a Direct session has no Terminal tab: if
  a session needs one, switch that session to Terminal from its **⋯** menu and
  it stays there. Sessions you had already switched by hand keep exactly what
  you chose; ones you never touched move to Direct.

### Fixed

- When switchboard can't write its workspace file — a full drive, a permission,
  a backup or anti-virus tool holding the file — a banner now says so and names
  the file, instead of the failure going only to the log. It retries on its own
  and takes the banner back down the moment saving works again.
- A pop-out window that dies without warning — killed from the task bar, force
  closed, or lost with a crash — no longer takes its session with it. The card
  comes back to the main window suspended, with its **Resume** button, exactly
  as it does when you close the window normally; it used to be left in a window
  that no longer existed, visible nowhere.
- Code in the **Changes** tab is now syntax-coloured for its language instead
  of arriving as one undifferentiated wall of text — TypeScript, Python, Rust,
  Go, Markdown, Dockerfiles and around a hundred other names and extensions,
  in both light and dark. Files switchboard doesn't recognise stay plain rather
  than being coloured wrongly. Switching theme with a file open also stops
  blanking the diff.
- The installed app carries about 18 MB less: it had been shipping four
  language-server bundles it could never load.

### Internal

- Every IPC seam — groups, sessions and the capability broker — now refuses a
  call by answering rather than by throwing, so a refusal can be read and
  logged instead of surfacing as an unhandled error.
- A card left sitting on a session that crashed no longer keeps reading the
  disk for it. The transcript watch finishes what it was reading, then stops;
  everything the crashed session said stays on the card exactly as before.
- Once no card is still looking for a conversation to show — every one that was
  looking has said it couldn't find it — switchboard stops rescanning your
  transcripts folder several times a second and settles into an occasional
  check. Anything that could change the answer, from a transcript appearing to
  your next prompt, puts it straight back to looking properly, so a card that
  gave up can still pick a conversation up later on its own. Each card now
  settles down on its own account rather than waiting for every other card to
  give up too: one card still searching no longer keeps its neighbours
  rescanning, and a card you opened and never typed into stops rescanning as
  well, since Claude Code writes nothing for it until your first prompt.
  Prompting it picks straight back up.

## 0.2.0 — 2026-08-09

### Added

- Screen readers now announce a session card's **Session ended**, **Session
  didn't start** and **Session suspended** panels the moment they appear, and
  they say which session it was first — "trading-app. Session ended. Exited
  unexpectedly (code 137)" rather than an anonymous "Session ended" with
  several cards open. It waits for a gap rather than cutting across what you
  were listening to, and a card that was *already* suspended when you reopened
  switchboard stays quiet — that is how you left it, not news. Nothing on
  screen changed.

### Changed

- The app calls itself **switchboard.ai** everywhere you read its name: the
  window title, desktop notifications, the Start-menu and desktop shortcuts,
  and the Add/Remove Programs entry. The program file, the installer's
  filename and your existing settings folder are deliberately unchanged, so
  nothing you already have installed moves.

### Fixed

- A session card that never got going now says **Session didn't start**,
  explains the usual cause, points at the log line with the exact reason, and
  offers **Try again**. It used to claim "Session ended — Exited unexpectedly
  (code -1)": three things that had not happened and an exit code the app
  invented because it had nowhere to get one. Any card whose folder has been
  renamed, deleted, or lives on a drive that isn't plugged in lands here. A
  session that really ran and then stopped keeps exactly the words it had, and
  its real exit code.
- When a workspace file is too damaged to read, switchboard sets it aside so
  there is something to look at afterwards. Every copy used to go to the same
  name, so a second bad launch destroyed the copy from the first — the one that
  shows how the damage started. Each copy now carries the date and time in its
  name and can never overwrite another. Five are kept: the oldest, deliberately,
  plus the most recent; the extras in between are deleted and named in the log.
  Files you have renamed yourself are never touched.
- If setting that damaged file aside *fails* — a full disk, an anti-virus
  sitting on the folder — the damaged file is no longer written over seconds
  later by the first save of your now-empty workspace, on exactly the machine
  most likely to need the post-mortem. The save waits and tries again three
  different ways, the last of which simply renames the damaged file out of the
  way and works with no room left at all. If none of them work, the save is
  held back a few seconds, the live workspace then wins, and the log says the
  copy was lost. Nothing in the app is blocked while any of this happens.

### Internal

- Starting a session on a folder that has gone missing, and renaming a live
  session, now answer with a refusal instead of throwing an error into the
  running app — and the log names the folder and the reason, which previously
  went to a stream nothing records. On screen this is identical.
- `npm test` now spends a moment clearing the scratch folders older test runs
  left in the system temp directory — 115,314 of them had built up on one
  machine — and `npm run sweep:temp` clears the whole backlog in one go. It
  only ever touches folders our own tests named, and it is deliberately not in
  the app, which never creates them.
- The last test files making scratch folders outside the shared bookkeeping
  were moved onto it — two had no cleanup at all — and the end-to-end runner
  sweeps now as well as the unit runner. A run leaves nothing behind.
- The rule that stops hand-written colours in the interface code no longer
  reads an issue number such as `#358` as a colour, so citations in test names
  work again.
- The "Session ended" panel is now tested the real way — a session that runs
  and is then killed — rather than only through the card that never started.

## 0.1.2 — 2026-08-08

> **Errata, added at 0.2.0:** the set-aside filename named below,
> `workspace.json.corrupt`, is what 0.1.2 actually shipped and the note is left
> as released. From 0.2.0 the copy is named
> `workspace.json.corrupt-<timestamp>` and five are kept — see 0.2.0's Fixed
> group, and the manual's troubleshooting page, which describes the current
> build.

### Fixed

- Sessions with **Allow all** switched on are now genuinely silent in Direct
  mode. Before, every tool call still rang the bell — a beep, a taskbar flash,
  and a "needs permission" entry in the events panel for a question the app
  had already answered itself. Now those calls are answered inside the app
  without involving the window at all: no banner, no beep, no log spam.
- Closing (or crashing) a window can no longer strand a session that was
  waiting on a permission answer. An unanswerable question now times out to a
  safe "no" — the tool is denied and the session carries on, instead of
  hanging forever on a prompt nobody can see.
- Direct-mode sessions no longer flip to "needs permission" on background
  notification noise when nothing is actually being asked. Real questions
  still come through exactly as before.
- A group can no longer be renamed to an empty name — the edit simply ends and
  the old name stands, matching how session renames already behave. And if a
  hand-edited (or damaged) workspace file contains a blank group name, it now
  loads as "Untitled group" instead of producing an invisible, unclickable
  group.
- Pressing **Update** on a release that was withdrawn while the dialog sat
  open now says the release is no longer available, instead of the misleading
  "no installer this app can verify".
- Each session tab now shows the session's identity color and language badge,
  matching its card header. They previously always painted a grey dot.

### Added

- Screen readers now announce the "reconnect your pop-out window" offer in the
  events panel, the same way they announce update notices.
- The manual's troubleshooting page now explains what the app does with a
  damaged workspace file — both when the whole file is unreadable (it is set
  aside as `workspace.json.corrupt` and the app starts fresh) and when
  individual fields are quietly repaired.
- Every one of those load-time repairs now says so in the log: what was
  repaired or dropped, and — when the whole file was set aside — why it
  couldn't be read and where it went. Nothing about a damaged workspace is
  silent anymore.

### Internal

- The end-to-end test suite now refuses to run against a stale build, failing
  in seconds with a clear message instead of minutes of misleading failures.
- Group operations refuse bad input with a result the interface can react to
  instead of throwing, closing off a class of invisible background errors.
- Two tests that had quietly stopped proving anything were rebuilt so they
  fail when the behavior they name is actually broken.

## 0.1.1 — 2026-08-06

### Added

- One-click updates. The "there's a new release" dialog's **Update** button now
  does the whole job instead of opening a web page: it downloads the installer
  with a real progress bar and a working Cancel, checks the file against the
  checksum the release published — a download that doesn't match is deleted and
  never run — installs silently, and restarts the app. The next run confirms
  the update actually landed with a "You're now on vX" note in the events
  panel. Closing the dialog without answering leaves a small "ready to install"
  reminder there too; choosing Ignore or Skip doesn't. Every failure ends with
  a plain sentence and a link to the release page.

### Fixed

- Direct-mode sessions no longer show the "Claude is asking permission in the
  terminal" bar — there is no terminal in that mode, and the [Open Terminal]
  button it offered went nowhere. This includes the version of the bug where
  a session with "Allow all" switched on flashed that bar for a few seconds on
  every single permission, while nothing was actually waiting on you.
- A session can no longer be renamed to nothing: an empty rename box (or one
  with only spaces) now means "never mind", the same as pressing Escape, and a
  blank name can no longer sneak into the saved workspace.
- A very long session name now shortens with `…` in the card header instead of
  pushing the status pill and window buttons off the edge of the card.

### Internal

- Line endings are pinned repo-wide (`.gitattributes`, `eol=lf`).
- Build stamps on push builds name the real branch instead of "detached".
- The urgency lamp's timing-dependent tests now run on a clock the tests own.
- Every always-visible notice bar carries a height guard pinned by one shared
  regression roster.
- Group edits the app refuses now come back as an answer instead of an error
  nobody was listening for, so a refused edit can never surface as a crash
  report in the background.

---

## 0.1.0 — 2026-08-05

The first packaged build. This section describes what the app *is*, not what
changed — there is no earlier release to differ from.

### Added

- Run many Claude Code sessions in one window: a sessions rail, and a dockable
  workspace of terminal, changes and event-feed panels that can be popped out
  into their own windows.
- Attention routing — the app tells you which session needs you, and why.
- Approvals and autonomy settings, surfaced in the session's event feed where
  you can act on them.
- Per-session git status and diff viewing.
- Slash commands, a command palette, and full keyboard operation with
  screen-reader support.
- Selectable themes, including a high-contrast one.
- Session pinning (a pinned session sorts first and bulk actions skip it) and
  a focus-stealing policy that decides whether a session that needs you may
  jump to the front.
- The app checks for new releases once a day and offers the update in a small
  dialog with the release notes; checking is fail-open — no credentials or no
  network simply means no check, never an error.

### Internal

- Windows installer via electron-builder: per-user, one-click, no UAC
  (P2-E19-01).
