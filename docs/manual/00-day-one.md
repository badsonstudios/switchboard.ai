# Day one

> Status: draft

You have never seen switchboard.ai before and you want to get a day's work done
in it. This page is the shortest path: install it, open a project, give Claude
something to do, answer what it asks you, then look over what it did and commit
it. Every step links to the page that covers it properly.

## What this is, in one paragraph

switchboard.ai is one window that holds many Claude Code conversations at once,
each working in its own project folder. It doesn't replace Claude Code — it runs
the real `claude` command you already have, on your own subscription. What it
adds is everything around the conversation: seeing which session needs you,
answering permission requests without hunting for a terminal, and reading,
staging and committing the changes when the work is done.

## 1. Install

You need two things.

**Claude Code, signed in.** If you already use `claude` in a terminal, you're
done. If not:

```
npm install -g @anthropic-ai/claude-code
```

Then run `claude` once in a terminal and sign in. There is no API key to enter
anywhere in switchboard, and no switchboard account.

**switchboard.ai itself.** Download the newest `switchboard-Setup-<version>.exe`
from the project's Releases page on GitHub and run it. The installer is for
Windows; that's the only platform with a published build today. The repository
is private, so you need to have been given access to it before the Releases page
will open.

The installer is one click: no questions, no administrator prompt, and it
installs for your user only. It is **not code-signed**, so a copy downloaded
through a browser may be stopped by a blue *"Windows protected your PC"* box.
Click **More info**, then **Run anyway**. Beside every installer on the Releases
page is a `.sha256` file holding its fingerprint, if you want to check the
download first.

TODO: confirm the exact wording of that box against a fresh machine.

After this you don't download anything by hand again. The app checks for a newer
release on its own and offers it to you — see [Updates](13-updates.md).

**If a banner across the top says it can't find Claude Code**, new sessions stay
switched off until it can. Open a terminal, check that `claude --version` prints
a version, and restart switchboard.

## 2. Open a project and start a session

1. Click **+ session** in the middle of the window.
2. Pick your project folder.
3. A card appears. It says *starting* for a moment, then *idle*.
4. Type what you want into the box at the bottom of the card and press
   **Enter**.

Dragging a folder from Explorer onto the window does the same thing.

A **session** is one conversation in one folder. Want a second task going in the
same project, or in a different one? Click **+ session** again. Each gets its own
card, and its own row in the **Sessions** list on the left with a coloured dot
that tells you what it's doing:

| You see | It means |
|---|---|
| **working** | Claude is busy. Leave it. |
| **needs you** | It's waiting for you to allow or refuse something. |
| **needs input** | It asked you a question. |
| **idle** / **done** | Ready for your next prompt. |

The **Events** panel on the right lists whatever is waiting on you across all
your sessions. When it says *"Nothing needs you right now"*, nothing does.

To pick up a conversation you had before — including ones you had in a plain
terminal — click **🕘** in the card's header.

More: [Sessions](02-sessions.md), [The session view](03-session-view.md).

## 3. Answer what Claude asks you

By default a session runs in **ask** mode: Claude can read files in the project
on its own, and stops to ask before it changes a file or runs a command.

When it asks, a bar appears just above the prompt box — **Allow \<tool\>?** —
showing exactly what would happen: the real diff for a file change, the command
itself for a shell command. Then:

- **Allow** — yes, this once.
- **Approve all in this file** — yes, and stop asking about this one file.
- **Allow all (this session)** — stop asking for the rest of this session.
- **Deny** — no. Claude stops and asks what you'd like instead.
- **Deny with feedback…** — no, and here's why. Your words go back to Claude.

If being asked about every edit is too much, change how much the session may do
without you. Click the shield chip under the prompt box to cycle through the four
modes, and hover it to read what each one does:

| Mode | Runs without asking |
|---|---|
| **ask** | Reading files in the project. Nothing else. |
| **plan** | Reading. Claude writes a plan and changes nothing until you approve it. |
| **auto-edit** | File edits in the project. Commands still ask. |
| **full-auto** | Everything. |

A new mode takes effect the next time the session starts or resumes, not
mid-turn.

More: [Approvals & autonomy](04-approvals-and-autonomy.md).

## 4. Look at files

The tabs along the top of each card are **Session**, **Changes**, **Files** and
**History**.

- **Files** shows the project folder. Click a file to read it.
- **File › Open File…** (`Ctrl+O`) opens any file from anywhere.

Files open in a reader beside your session, with syntax colouring, and Markdown
is shown rendered.

**The reader is read-only. You cannot type into a file in switchboard.** There
are two ways to change one:

- **Ask Claude to.** That's the usual way here, and you see the diff before it
  lands.
- **Edit it yourself in your own editor.** Every open file has **Open
  externally** in its header, which hands the file to whatever app you normally
  use for it, and **Reveal in folder** beside it. Save there; switchboard picks
  up the change.

More: [The Files tab](21-files.md), [Reading files in the app](15-document-viewer.md).

## 5. Review what changed

Open the **Changes** tab on the card. It lists every file that differs from the
last commit, grouped the way git groups them:

| Group | What's in it |
|---|---|
| **Staged changes** | What a commit would capture right now. |
| **Changes** | Edited, but not staged. |
| **Untracked** | New files git hasn't seen before. |

Click a row to see its diff. Hover a row for its buttons:

- **＋** stages the file. **−** takes it back out.
- **↶** discards the change. It asks first, and it means it: a discarded new
  file is gone for good.
- **⊞** lets you stage just part of a file.

## 6. Commit and push

1. Stage what you want with **＋** (on a row, or on a group heading for
   everything in it).
2. Type a message in the box at the top of the Changes tab.
3. Press **Commit**, or **Ctrl+Enter**. The button tells you how many files it
   will capture, and if it's greyed out it says why.

Your project's commit hooks run exactly as they would from a terminal. If one
fails you see its output and keep your message.

Then, on the branch line at the top:

- **⟳** fetches. **↓** pulls. **↑** pushes.
- **↓** and **↑** only appear when there's something to pull or push.
- **Pull only fast-forwards.** If you and the remote have both moved it tells
  you and changes nothing — sort that out in a terminal.
- A brand-new branch needs a second, deliberate **↑** to publish it.

To start a branch, go to the **History** tab and press **⑂** on the commit you
want it to start from.

You sign in to your git remote the way you always have. switchboard doesn't
store or ask for git credentials.

More: [Changes & git](08-changes-and-git.md), [History](22-history.md).

## What you still need another tool for

Being straight about it, so you don't go looking:

- **Typing into a file.** See step 4.
- **Resolving a merge conflict, rebasing, force-pushing.** Conflicts are listed
  first in the Changes tab so you can't miss them, but you resolve them
  elsewhere.
- **Creating, renaming, moving or deleting files by hand.** Use your file
  manager, or ask Claude.
- **A terminal of your own.** There isn't one inside the app.

## Good to know

- **Everything comes back.** Close the app and reopen it: the same sessions, in
  the same places, with their conversations.
- **Nothing leaves your machine.** No account, no cloud sync, no telemetry.
- **Starting the conversation over** is **Clear**, on the row under the prompt
  box. It asks first. **Compact** beside it summarises the conversation instead
  of dropping it. See [Slash commands](05-slash-commands.md).
- **`Ctrl+Shift+P`** opens the command list — every action in the app, by name.
  **`Ctrl+,`** opens Settings.
- **If switchboard itself breaks, your work isn't trapped in it.** Run `claude`
  in the same folder from a terminal: same tool, same conversation history.

## If something goes wrong

- **A session won't start, hangs, or disappears** — see
  [Troubleshooting](11-troubleshooting.md).
- **Several sessions fail at once** — it may not be you. See
  [Is it me or is it them?](14-provider-status.md)
- **Something looks like a bug** — **Help ▸ Report a problem…** collects the logs
  and files the report for you. Say what you did and what you expected.
