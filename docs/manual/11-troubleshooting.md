# Troubleshooting

> Status: draft

## Which version am I running?

**Before you chase any bug, check you're looking at the build you think you
are.** It's the first thing to rule out, and it takes five seconds.

At the top left of the window, next to the switchboard name, is the version and
a short code — something like **`v0.1.0  a1b2c3d4`**. That code is the exact
snapshot of the source this copy was built from. Click it and you get the full
picture:

| Field | What it tells you |
|---|---|
| **Version** | The release number. Changes when a new version ships. |
| **Commit** | The exact source snapshot this was built from. |
| **Branch** | Which line of development it came from. `main` is the normal one. |
| **Built** | When this copy was built. |
| **Build age** | How long ago that was — *"just now"*, *"3 h ago"*, *"4 days ago"*. |
| **Platform** | Which operating system it's running on. |

**Build age is the one that catches the usual mistake.** If you were told a fix
just landed and this build is four days old, you're running an old copy — you
haven't found a bug, you've found a stale build. Rebuild or reinstall and try
again.

**A star after the code (`a1b2c3d4*`)** means the copy was built from a working
folder with unsaved edits in it, so the code shown doesn't completely describe
what you're running. Normal while someone is developing; unexpected in a
released copy.

**If it says `unknown`** instead of a code, the build was made somewhere the
source history wasn't available. Everything still works — the app just can't
tell you where it came from.

You can also reach this from the keyboard: press `Ctrl+Shift+P` and type
*build*.

**The window's own title bar helps too.** A normal release just says
**switchboard**. Anything else — a test build, a development branch — adds the
branch and code, so you can tell two copies apart from the taskbar without
even opening them.

Use **Copy** in the panel when you report a problem; it puts all of this on the
clipboard in one go.

<!-- screenshot: the About this build panel, showing a recent build -->

## I launched switchboard and no new window appeared

That's the intended behaviour: only one copy runs at a time, and launching it
again brings the copy you already have forward — unminimizing it if it was
minimized. If nothing at all seems to happen, the window is most likely on
another monitor or another desktop/workspace; check there before assuming the
launch failed.

## Sessions

**A banner says the claude CLI wasn't found.**
Install it and sign in, then restart switchboard:
`npm install -g @anthropic-ai/claude-code`, then run `claude` once in a
terminal. New sessions stay disabled until it's found.

If you use a screen reader, you don't have to go looking for that banner: the
check runs a moment after the window opens, and the message is read out as soon
as it appears. It's the only warning that explains why nothing will start, so
it announces itself rather than waiting to be found.

**A session sits on "starting" and won't finish.**
Some Claude Code start-up prompts — trust dialogs, the "resume from summary"
picker on a very long conversation — appear only in the terminal, where
switchboard can't see them. After about eight seconds the Session tab shows a
bar across the bottom: **"Claude is showing a start-up dialog."** Click **Open
Terminal**, answer the prompt there, and the session carries on normally.

This one is **Terminal mode only** — a [Direct mode](12-direct-mode.md) session
draws no start-up dialog and has no terminal, so it never shows that bar.

**Claude asked me in the Terminal instead of in the card.**
That's the deliberate fallback in the default **Terminal mode**, and the Session
tab tells you when it happens — a coloured bar along the bottom with an **Open
Terminal** button, in the same place the Allow/Deny bar appears.

Two different things can put it there. Usually switchboard simply couldn't get
the question in front of you and handed it back rather than answering on your
behalf. But some decisions **Claude Code insists on making in its own prompt** —
most commonly writing to a project's own `.claude` folder, which it treats as a
sensitive location. For those, switchboard deliberately **stands aside instead
of asking you the same question twice**: it can see the request, but its answer
wouldn't stick, so the only prompt you get is the real one. You'll see it every
time such a file changes, and no setting on our side turns it off. Answer it in
the Terminal; choosing the "…for this session" option stops it repeating until
that session ends.

Either way, **nothing gets auto-approved.**

None of this applies to a session on [Direct mode](12-direct-mode.md). That mode
exists to stop permissions escaping into a terminal in the first place: Claude
hands the decision to switchboard properly and you answer it in the card. There
is no terminal to be sent to, so no bar and no **Open Terminal** button ever
appear — switchboard stays quiet rather than offering a button that goes
nowhere.

**The Session tab is empty but the Terminal is working.**
The tab itself tells you which case you're in — read what it says before doing
anything:

- *"No conversation yet"* — nothing is wrong. Claude Code only starts a
  conversation file when you send your first prompt. Send one.
- *"Looking for this session's transcript…"* — it's matching the conversation
  to this card; give it a moment.
- *"Couldn't find this session's transcript"* — see below.

The Terminal tab is the same session either way, and always works.

**The Session tab says it couldn't find the transcript.**
The conversation view reads the file Claude Code writes for each session. When
that file can't be found, the message names what switchboard did see:

- *"Transcripts are being written for this folder, but none match this
  session"* — most often two cards open on one folder, where the conversation
  you're looking for belongs to the other card. Check the other card first.
- *"…and Claude Code has not reported any activity"* — Claude Code's hooks
  aren't reaching switchboard, so status pills and the attention queue will be
  quiet too. Check that this session's folder isn't blocking hook scripts, and
  see **"Statuses never change"** below.
- *"No transcript for it has turned up in `…`"* — the path is in the message.
  If a Claude Code update moved where conversations are stored, that's what
  this looks like; please report it with the path shown.

**In every case the session itself is fine.** This only affects the rendered
conversation view — the CLI is running, your work is not lost, and the
**Terminal** tab shows the session exactly as Claude Code draws it. Restarting
the app is safe and often enough, since matching starts fresh.

**A session ended on its own.**
The card stays with **Session ended** and a **Restart** button. If it exited
unexpectedly you'll see the exit code.

**My session didn't come back after restarting the app.**
Sessions you **closed** with the tab ✕ are forgotten on purpose — that's what
the confirmation warns about. Sessions that were merely open, or suspended,
come back.

**I'm hearing notification sounds and don't know why.**
Every session that needs permission, needs input, finishes, or crashes makes a
sound. Check the Events panel on the right — it names the session. Silence
everything with the 🔔 chip in the title bar.

**A banner says nothing in this workspace will be saved.**
You're running an older switchboard than the one that last saved this
workspace, and it won't rewrite that file because doing so would delete what
the newer version had put in it. Your sessions work normally; the layout you
build now just won't come back. Go back to the newer version and it saves
again — the full explanation, and the alternative if you'd rather stay put, is
in [Organizing your workspace](07-workspace.md#when-your-workspace-cant-be-saved).
Pop-out windows carry the same banner, so it's still in front of you when you
work in one.

**My layout didn't come back and there was no banner.**
The layout is written when you quit, and a failed write is logged rather than
shown. Check the log (below) for a line from `workspace` saying the save
failed; on Windows an anti-virus or indexer holding the file for a moment is
the usual cause, and relaunching is enough.

**A pop-out window vanished after I unplugged a monitor.**
It was rescued back onto a visible screen. Plug the monitor back in and Events
will offer to restore the layout.

**A pop-out came back in the wrong place after a restart.**
Pop-out windows are meant to reopen exactly where you left them, on whichever
monitor that was. If one comes back somewhere else — drifted, or sitting across
two monitors — that's a bug worth reporting with your log; it isn't something
you need to work around.

## Where the logs are

Useful when reporting a problem — they record what each session did, with
timestamps.

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\switchboard\logs` |
| macOS | `~/Library/Logs/switchboard` |
| Linux | `~/.config/switchboard/logs` |

TODO: confirm these paths against a packaged build, and note what's safe to
share — logs include folder paths and command lines.
