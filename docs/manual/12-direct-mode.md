# 12 — Direct mode (beta)

This page explains how switchboard talks to Claude Code, and what that costs.

**Short version:** Direct mode fixes permission prompts that used to escape into
the terminal and ask you twice. It costs you the terminal itself. **It is now
the only mode** — every session runs this way, and there is nothing to turn on.

> **This used to be a choice.** A session could be put back on "Terminal mode",
> which hosted the real Claude Code interface in a tab on the card. That mode
> has been removed as a choice, along with the tab and the ⋯-menu switch that
> reached it. A session you had set to Terminal moves to Direct the next time
> switchboard starts, and says so in the log; its conversation and history are
> untouched. The list under **What you give up** is what actually went with it.

---

## The problem it solves

Sometimes Claude asks to edit a file inside a project's own `.claude` folder —
its settings, its hooks, a script it keeps there.

In the normal mode, that goes wrong in a specific and annoying way:

1. Switchboard shows you the approval bar.
2. You click **Allow**.
3. A few seconds later, Claude asks you *again* — in the Terminal tab.

Your first answer was thrown away. Claude Code guards its own `.claude` folder
at a level that sits above the mechanism switchboard normally uses to answer,
so the answer never counted. (This is deliberate on Claude Code's part — the
rules live in that folder, so a rule that granted write access to it would be a
way around itself.)

In **Direct mode**, Claude hands switchboard that decision properly. You answer
once, in this window, and it's honoured. You'll also see Claude's own
explanation of *why* it's asking, which the normal mode never receives.

## You already have it

Every session runs in Direct mode. There is nothing to switch on, nothing to
check, and no setting that changes it.

> **If you were using switchboard before this changed:** a session you had
> explicitly set to Terminal mode moves to Direct the next time the app starts.
> The card, its name, its conversation and its history all come back exactly as
> they were — the only thing that changes is how switchboard talks to the CLI
> behind it.

## What you give up

**There is no terminal, and no Terminal tab.** That means you lose:

- **Ctrl-R history search** and **vim mode**
- Anything else that only exists as a full-screen terminal interface

If you need one of those for a particular piece of work, run `claude` yourself
in a terminal — it is the same CLI and the same conversation history.

This list used to be longer. It named the pickers for `/resume` and `/rewind`,
and slash commands generally were called a known gap — none of which is true any
more: **`/model` and `/mcp` have their own panels** and work in Direct mode, and
`/resume`, `/rewind`, `/permissions`, `/hooks`, `/output-style` and `/status`
turn out not to be commands at all in current Claude Code, so there is nothing
to give up. (Whatever Claude Code offers by keyboard inside its own terminal is
a separate question, and still terminal-only.)

**And the folder-trust question is never asked.** A Terminal-mode session shows
you Claude Code's trust prompt for a new folder and waits. A Direct-mode session
doesn't: Claude Code raises no trust question at all outside its own terminal,
so it just runs in the folder. Nothing hangs and nothing is hidden from you.

That is why the **🔓 auto-trust / 🔒 ask trust** chip in the title bar is greyed
out — hover it and it says so. It is not broken: there is no longer any session
that could put the question in front of you, so the setting has nothing to
govern. Your choice is kept exactly as you left it. Full story in
[Settings](10-settings.md#trusting-folders).

Because nothing can ask, switchboard doesn't answer on your behalf either: a
session leaves Claude Code's trust setting for that folder exactly as it found
it, whichever way the chip is set. Nothing is recorded in your name for a
question you were never able to see.

Everything else works the same — better, in a couple of places. Your
conversation still appears in the Session view (and arrives faster; see
[Replies arrive as they're written](#replies-arrive-as-theyre-written)), prompts
still go in the same box, slash commands still work, and your usage figures and
file changes are unaffected.

## What it doesn't change

- **Nothing about your Claude subscription.** Direct mode uses the same
  installed `claude` command and the same login. No API key, no extra cost.
- **Your conversation history.** It's still written to disk in the same place,
  and reopening switchboard picks the conversation back up: Claude remembers it,
  and the Session view shows it again (see
  [What you see when a session resumes](#what-you-see-when-a-session-resumes)).
- **Any other session.** The setting is per session. You can run one session in
  Direct mode and leave the rest alone.

## What is still being worked out

Some parts of Claude Code have no equivalent outside a terminal yet — plan-mode
approval and multiple-choice questions are the two being looked at. Those are
still being built, and until they are, a session that hits one has to be told to
carry on another way.

There is no longer a fallback to switch to, so if something breaks, say so —
that is now the only way it gets found.

## Fixed: `/usage`, `/cost` and `/context` now show their output

Commands that Claude Code answers *itself* rather than by asking Claude —
**`/usage`**, **`/cost`**, **`/context`** — used to produce no visible output in
the Session view at all. The command ran; there was simply nothing on screen.

They now print their output into the Session view like any other reply. (It was
never really a Direct-mode fault — the output had always been missing from the
Session view, and back when there was a Terminal tab you would see it there
instead, so Direct mode only removed the place it had been hiding.)

## What you see when a session resumes

Quit switchboard with Direct-mode sessions running, open it again, and each card
comes back with **the conversation you left in it** — your prompts, Claude's
replies, the file edits and commands, all in order. Carry on typing and the new
turn appends to the bottom, exactly where you left off.

Two details worth knowing:

- **The Session view shows the recent past, not the entire archive.** A very long
  conversation is trimmed to its most recent stretch, the same way it is while
  the session is running. Claude's own memory of the conversation is not trimmed
  — it has the full context regardless of how much of it is on screen.
- **If the history is missing, nothing was lost.** A resumed card can come back
  empty if the conversation's file has been deleted from `~/.claude/projects`
  (some people prune it). The card still works; it just starts a fresh
  conversation, because there is nothing left to resume.

### A card remembers more than its latest conversation

Claude Code only writes a conversation to disk once you actually **send
something**. So a session you open and close again without typing has a name but
no file behind it — and if that were the only thing a card remembered, the card
would come back next launch with nowhere to go.

It isn't. Each card keeps a short list of the conversations it has been in, and
when it starts it takes **the most recent one that's really on disk**. In
practice that means:

- Open a session, change your mind, close it without typing — next launch you're
  back in the conversation you were in before, not a blank one.
- Use `/clear`, then quit before sending anything at all — you come back in the
  conversation you cleared. Send `/clear` again and it's cleared again; nothing
  is stuck.
- If switchboard can't read `~/.claude/projects` for a moment — an antivirus
  scan, a file indexer, a network drive reconnecting — the card starts fresh
  **for that one launch only**. It does not forget the conversation, and the next
  launch picks it straight back up.

**switchboard never deletes your link to a conversation because a lookup
failed.** That's the rule the whole thing runs on.

### Getting a lost session back

Cards orphaned by an older version — where the app really did throw the pointer
away — repair themselves. When a card starts and the conversation it recorded
isn't on disk, switchboard looks in that project folder's own history and
reattaches the most recent conversation nothing else is using. Your session comes
back with its transcript, and the app writes what it did into the log.

It's careful about it: a **brand-new** card is never given someone else's
history, it never takes a conversation another card is already in, and it never
guesses from a folder it couldn't read. If it does pick the wrong one, nothing is
destroyed — the old pointer is kept underneath, and you can start a fresh session
on the card whenever you like.

> **Fixed in 0.4.0.** Before this, a resumed Direct-mode session came back
> *blank*: the conversation was still there and Claude still remembered every
> word of it, but the Session view showed none of it, which looked exactly like
> the session had been wiped. If you saw that on the 0.3.0 update, nothing was
> lost then either — the history was on disk the whole time.

### When switchboard tells you it moved a card

Two of the repairs above happen without asking you, so switchboard **says so on
screen** rather than only writing it to the log. The notice appears in the
**Events drawer** — the tab on the right-hand edge, which shows a small dot when
something is waiting behind it. Open it (`Ctrl+E`), read the notice, and press
**Got it** to clear it. **It waits for you** — quit without opening the drawer
and it will still be there next time. Once you dismiss it, it's gone for good:
both repairs happen once, so there is nothing left to say.

You'll see one of two sentences:

- **"… had lost track of its conversation — it's been reconnected to the most
  recent one in its folder."** That's the repair described above. Open the card
  and check it looks like the right conversation. If it doesn't, nothing is
  lost — the old pointer is still underneath.
- **"… and … were both pointing at one conversation."** See below.

### Two cards, one conversation

An older version could leave **two cards in the same project folder pointing at
the same conversation**. That's not harmless: both cards would resume into the
same transcript, so two sessions would be writing into one history. (Two cards in
*different* folders are never affected, even in the unlikely event they share a
name — a conversation belongs to a folder, so those are two separate files.)

switchboard untangles it once, the next time it starts, and it does it without
throwing anything away:

- **One card keeps the conversation.** If only one of them is actually *in* it
  right now, that card keeps it. If they both are, the **older card** keeps it —
  the one created first, which is the one the newer copy was made alongside.
  (When switchboard makes a second card for a folder you already have open, it
  names it `-2`. The `-2` is the copy.)
- **The other card gives it up, but doesn't lose it.** The conversation's name is
  moved onto a "given up" list on that card. It is not deleted.
- **That card starts a new conversation, and is not given someone else's.** This
  is deliberate, and it's the opposite of the repair above. That repair works
  because the card's conversation is genuinely *missing*, which makes "the newest
  one in this folder" a good guess. Here the conversation isn't missing — it's
  sitting right there on the other card — so the same guess would hand you an
  unrelated session's history and start writing into it. switchboard would rather
  give you an empty card you can see than a wrong one you can't.

**If you'd rather have it the other way round**, you can swap the two by hand.
Quit switchboard first (it writes this file on the way out) and take a copy of
it, then open `%APPDATA%\switchboard\workspace.json` (macOS:
`~/Library/Application Support/switchboard/workspace.json`; Linux:
`~/.config/switchboard/workspace.json`) and find the two cards by their titles.
**Swap it on both**: give the card you want the conversation id as its
`nativeSessionId`, and put it in the other card's `cededNativeIds` instead. Start
switchboard again and the card you chose resumes there.

The one thing not to do is leave the id as `nativeSessionId` on **both** cards —
that's the state this whole section exists to fix, so the next launch will simply
decide it again.

## Replies arrive as they're written

Claude's reply appears **a word at a time**, with a small block cursor at the
end while it's still being written — the same way it looks in a terminal. (The
old Terminal mode instead waited for each message to be finished and written to
disk, so replies landed in chunks a moment behind.)

## If something looks wrong

- **A card said it needed permission and there was nothing to answer.** Fixed.
  In Direct mode every real permission request arrives with an **Allow / Deny**
  bar attached to it, so the amber "needs permission" badge is now only ever
  shown when there is a question on screen waiting for you. Claude Code also
  sends a slower, vaguer nudge of its own a few seconds behind — sometimes after
  you'd already answered — and switchboard used to believe it. In Direct mode it
  no longer does.
- **Claude says a request was declined and you never saw it.** Nobody could be
  asked — the window was closed or its display crashed while the session kept
  running, or the question sat unanswered for five minutes. In Direct mode there
  is no terminal prompt behind switchboard to catch it, so declining is the only
  answer that doesn't leave the session stuck for ever. Tell Claude to carry on
  and it will ask again. See
  [Approvals & autonomy](04-approvals-and-autonomy.md#good-to-know).
- **You want a session to keep working while you're away.** Turn on **Allow all
  (this session)** before you leave. In Direct mode that's answered inside
  switchboard rather than on screen, so gated calls go through with the window
  closed — and with no beep and no taskbar flash while you're at the keyboard
  either.

See also: [04 — Approvals & autonomy](04-approvals-and-autonomy.md) ·
[11 — Troubleshooting](11-troubleshooting.md)
