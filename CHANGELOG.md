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

1. Bump `version` in `package.json` — patch for fixes, minor for features,
   major for a break. Pre-1.0, a minor is what a "release" normally is. If the
   open unreleased section's placeholder version is not the number you landed
   on, rename its heading to match.
2. Replace that version's `— unreleased` with the release date, and open a new
   `## <next version> — unreleased` section above it. **Always** — not "if work
   continues". That empty section is the only place the next work item is
   allowed to file, so skipping it blocks every item until the following cut.
   Guess the next number; step 1 corrects it. `release-notes.test.js` fails if
   you forget — that is deliberate, and it is why this step is not optional.
3. Commit both together. The version and its notes arriving in one commit is
   what makes "this tag has no changelog section" a bug worth failing a build
   over — which is exactly what P2-E19-02's workflow does.
4. Tag `v<version>`; the tag must equal `package.json`'s version.

---

## 0.5.0 — unreleased

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

- **A reply can no longer take over a conversation's own controls.** Replies are
  rendered Markdown, and Markdown can carry raw HTML. If that HTML happened to
  copy the small markers switchboard.ai puts on its own expanders and blocks, the
  app believed them — so a single message could stop the arrow keys moving
  between the real tool blocks below it, put a fake control on the keyboard path,
  or send **Find** to the wrong paragraph and highlight it as the match. Nothing
  a message or a document contains counts as the app's own markup any more, on
  every surface that renders Markdown: the conversation, the document viewer and
  the update notes.

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
