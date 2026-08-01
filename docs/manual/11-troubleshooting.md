# Troubleshooting

> Status: draft

**A banner says the claude CLI wasn't found.**
Install it and sign in, then restart switchboard:
`npm install -g @anthropic-ai/claude-code`, then run `claude` once in a
terminal. New sessions stay disabled until it's found.

**A session sits on "starting" and won't finish.**
Some Claude Code start-up prompts — trust dialogs, the "resume from summary"
picker on a very long conversation — appear only in the terminal, where
switchboard can't see them. After about eight seconds the Session tab shows a
bar across the bottom: **"Claude is showing a start-up dialog."** Click **Open
Terminal**, answer the prompt there, and the session carries on normally.

**Claude asked me in the Terminal instead of in the card.**
That's the deliberate fallback, and the Session tab tells you when it happens —
a coloured bar along the bottom with an **Open Terminal** button, in the same
place the Allow/Deny bar appears.

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
