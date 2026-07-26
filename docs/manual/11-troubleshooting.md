# Troubleshooting

> Status: draft

**A banner says the claude CLI wasn't found.**
Install it and sign in, then restart switchboard:
`npm install -g @anthropic-ai/claude-code`, then run `claude` once in a
terminal. New sessions stay disabled until it's found.

**A session sits on "starting" and won't finish.**
Some Claude Code start-up prompts — trust dialogs, the "resume from summary"
picker on a very long conversation — appear only in the terminal, where
switchboard can't see them. After about eight seconds the card offers a
**continue in Terminal ↗** chip. Click it, answer the prompt there, and the
session carries on normally.

**Claude asked me in the Terminal instead of in the card.**
That's the deliberate fallback. Whenever switchboard can't put the question in
front of you, it hands it back to Claude Code's own prompt rather than
answering on your behalf. Nothing gets auto-approved.

**The Session tab is empty but the Terminal is working.**
The conversation view reads Claude Code's transcript file, which occasionally
takes a moment to appear. The Terminal tab is the same session and always
works — use it while you wait.

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
