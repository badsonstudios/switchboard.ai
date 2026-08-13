# Troubleshooting

> Status: draft

## Is it me or is it them?

If several sessions are misbehaving at once — slow, refusing, erroring — check
the small dot at the right-hand end of the bottom status bar before you start
debugging your own prompt. It reflects Anthropic's public status page, and
hovering it tells you what that page says.

Full details, including the "several sessions just hit errors" strip and how to
turn the check off: [Is it me or is it them?](14-provider-status.md).

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

**A card says "Session didn't start" the moment I open it.**
The usual cause is that **the folder isn't there any more** — it was renamed or
deleted, or it lives on a drive or network share that isn't connected right now.
Cards remember the folder they were opened on, so a card can outlive its folder,
and a session can't start in a folder that doesn't exist.

The card shows **Session didn't start**, a line about the folder, and two
buttons: **Try again** and **Close**. That panel is deliberately different from
the **Session ended** one — this session never ran, so there was no crash, no
exit code, and nothing was lost. Check the folder:

- **Drive or share not connected?** Connect it and click **Try again**. The
  card, its name and its conversation history are all still there.
- **Folder renamed or moved?** switchboard can't follow it. Close the card and
  open a new session on the folder's new location; the conversation history
  belongs to Claude Code and is keyed to the folder, so a moved folder starts
  fresh.
- **Not sure which folder the card was on?** [The log](#where-the-logs-are) has
  it: a start that was refused writes one line naming the card and the exact
  folder it tried.

Any other reason a session can't start writes a line to the log too, so if the
folder is definitely there, that line is what to report.

If the card says **Session ended** instead, that is the other panel and a
different story: a session that *did* run and has stopped — see
[Restarting a dead session](02-sessions.md#restarting-a-dead-session).

**Claude asked me in the Terminal instead of in the card.**
That's the deliberate fallback in **Terminal mode** — a session you put back on
the terminal, since new ones run in [Direct mode](12-direct-mode.md) — and the
Session tab tells you when it happens — a coloured bar along the bottom with an **Open
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

**A Direct-mode session says a request was declined and I never saw it.**
Because nobody could be asked. In Direct mode there is no second prompt behind
switchboard — Claude Code is waiting on this app and on nothing else — so a
question that can't be put in front of you is declined rather than left hanging,
which would wedge the session for good. Three things cause it: the window was
closed or its display crashed while the session kept running, or the question
went five minutes unanswered.

The message Claude gets says it was nobody being available, not a restriction,
so it stops and asks again rather than looking for another route. Just tell it
to carry on. To keep a session moving while you're away, turn on **Allow all
(this session)** before you go — that answers at the source and needs no window
at all.

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

**As long as the card is still running, the session itself is fine.** This only
affects the rendered conversation view — the CLI is running, your work is not
lost, and the **Terminal** tab shows the session exactly as Claude Code draws
it. Restarting the app is safe and often enough, since matching starts fresh.
A card that has given up — or one you simply haven't typed into yet — still
keeps half an eye out: send it a prompt, or let a conversation file turn up,
and it will pick it up — within a few seconds normally, and within a minute even
when Claude Code's hooks have gone quiet as well.
(A card showing **Session ended** can also land on this message: switchboard
keeps looking for a crashed session's conversation for a short while, then
stops and says so rather than searching for ever.)

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

**A banner says this workspace isn't being saved.**
Different problem from the one above: this time the file is perfectly ordinary
and switchboard simply can't write it. The banner names the file, and the usual
causes are a drive with no room left, a permission on that folder, or another
program — a backup tool, an anti-virus, a sync client — holding the file open.
Free up some space or close whatever has it, and the banner goes away by itself:
switchboard keeps retrying in the background, and the moment a save works it
takes the notice down and writes everything you've done since. Your sessions run
normally the whole time. The full explanation is in
[Organizing your workspace](07-workspace.md#when-saving-keeps-failing).

**My layout didn't come back and there was no banner.**
A *single* failed write doesn't raise a banner — a scanner touching the file for
a moment is an everyday event on Windows and the next attempt works, so a notice
for it would just be noise. It takes about three seconds of failing before the
banner appears. The one case that can therefore go unannounced is a write that
fails **as you quit**, because there's no time left to retry or to show you
anything. Check the log (below) for a line from `workspace` saying the save
failed; relaunching is enough.

**My workspace came back completely empty, and there's a `.corrupt-…` file next
to it.**
Everything on the [workspace page](07-workspace.md) is kept in one file,
`workspace.json`. If switchboard can't read that file at all — it isn't valid
JSON any more, usually because a write was interrupted or the file was
hand-edited — it doesn't refuse to start. It copies the unreadable file aside
under a name stamped with the date and time, like
**`workspace.json.corrupt-2026-08-08T14-23-05.123Z`**, and opens with an empty
workspace, which it then saves over the original as you work.

Nothing announces this in the app — there's no banner. But the log says exactly
what happened: a line from `workspace` names what it couldn't parse and the file
it copied the damaged one into (or, if it couldn't even make that copy, says
that instead). In the app itself, an empty workspace where you left eight
sessions is the whole symptom.

**If that copy can't be made, the damaged file isn't overwritten anyway.** A
disk with no room left, or an anti-virus sitting on the folder, can stop
switchboard making the copy — and then the damaged `workspace.json` is the only
record of what went wrong. So the empty workspace is *not* saved over it. The
save is held back for a second or two and tried again: first by writing out the
bytes switchboard already read (or, if it never managed to read them, by copying
the file), and failing that by simply renaming the damaged file out of the way,
which works even when there is no room left to write anything at all.

Whichever way it goes, you end up with the same dated copy, and the log line
says which route it took. Nothing about the app is held up while this happens —
your sessions run normally. If none of the attempts ever work, switchboard says
so in the log and saves your live workspace rather than never saving again;
that's the one case where the damaged file is lost.

A folder stubborn enough to refuse all three of those attempts will usually
refuse that save too — and *that* you do get told about, by the banner in **"A
banner says this workspace isn't being saved"** above.

**A second failure can't overwrite the first copy.** The stamped name is never
reused, so if this happens twice you still have the copy from the *first* time —
the one that shows how the damage started. Switchboard keeps five of them: the
oldest, deliberately, plus the most recent ones. If there are ever more than
five, the copies in the middle are deleted and the same log line names the ones
it deleted. They live next to `workspace.json` — `%APPDATA%\switchboard` on
Windows, `~/Library/Application Support/switchboard` on macOS,
`~/.config/switchboard` on Linux.

**Your work isn't lost.** Conversations belong to Claude Code and are untouched;
what's gone is the arrangement — which sessions were open, your groups, the
layout. If you want to keep a copy for a bug report, move it out of that folder
(or rename it — switchboard only ever deletes the dated names it wrote itself),
then open the sessions you need again.

**A group came back called "Untitled group", or a session lost its group.**
When the file *does* read but a piece of it doesn't make sense, switchboard
repairs that piece rather than throwing the whole file away. You only ever see
the result:

- a group whose name was blank comes back as **Untitled group** — rename it and
  it stays renamed;
- a session pointing at a group that no longer exists comes back **ungrouped**;
- a session or group missing something it can't do without — no folder, no
  colour — is dropped entirely;
- a saved window position that isn't a sensible rectangle is ignored, so that
  window opens centred at its default size;
- notification and update settings that don't make sense fall back to their
  defaults: notifications on, OS toasts off, update checks on.

None of these interrupt you on purpose: they cost you a setting, not your work,
and a repaired workspace is better than no workspace. Each one does write a line
to the log saying what it repaired, so a workspace that comes back subtly
different is always explainable after the fact.

**A pop-out window vanished after I unplugged a monitor.**
It was rescued back onto a visible screen. Plug the monitor back in and Events
will offer to restore the layout.

**A pop-out window died — closed from the task bar, killed, or crashed — and
its session is nowhere.**
Wait a few seconds. switchboard checks its pop-out windows on a short timer,
and a window that goes without warning is noticed on the next check; the card
then comes back to the main window suspended, with a **Resume** button, exactly
as if you had closed the window normally. Nothing is lost while it's away — the
conversation belongs to Claude Code — and **Resume** picks the session up again.
If the card is still missing well after that, say so in a report with your log:
the app writes a line whenever it brings a stranded card home.

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
