# 20 — Handing work to a fresh session

Sometimes the most useful thing you can do with finished work is show it to
someone who has never seen it before.

A review run inside the session that did the work tends to agree with itself. It
knows why you made every choice, so it judges whether you did what you meant to
— not whether what you meant to do was right. A session that has only the change
in front of it has to work out what the change is for, and that is exactly when it
notices the thing you both assumed.

**Dispatch** is how you do that without opening a new window and re-explaining
yourself. You pick a role, say in one line what the work was meant to do, and
switchboard starts a new session that has been handed precisely that and nothing
else.

<!-- screenshot: the Dispatch dialog with Code Reviewer selected -->

## Sending work off

From the session whose work you want looked at:

1. Click the **⋯** button in the card's header.
2. Choose **Dispatch…**.
3. Pick a role.
4. If you picked **Code Reviewer**, read the **What was this session asked to do?**
   line — see below, because this is the part worth ten seconds — and optionally
   fill in **What does done look like?**
5. Click **Dispatch**.

Those two boxes only appear for Code Reviewer, and that isn't an oversight: it is
the only role that gets nothing but the change itself, so it is the only one that
needs you to say what the change was for. The other two are handed the goal and
the decisions your conversation already recorded, so there is nothing for you to
type.

A new session appears, named after the role — *Code Reviewer of my-project* — and
its first message is already there. You don't have to type anything to start it.

You can also do this from the command palette (`Ctrl+K`): type *dispatch* and
you'll see one entry per role. They open the same box with that role already
chosen. There's no keyboard shortcut for it on purpose — dispatching starts a
session and spends part of your Claude usage, so it shouldn't be one mistyped
chord away.

## Read the task line before you send it

For **Code Reviewer**, the box fills that line in from the first thing you typed
in the session. That is often not what you'd say if someone asked you.

If you started the session with a slash command, the first *sentence* you typed
may well have been something like "do it." — which is true, and useless to a
reviewer. One sentence of your own is worth more than everything else in the box.

If you clear the line entirely, the new session is told the task isn't known,
rather than being handed a guess. That's a fair choice; just make it on purpose.

## The three roles that come with the app

| Role | What it's handed | What it can do |
|---|---|---|
| **Code Reviewer** | Only the change itself: the diff, the task, your criteria. None of your conversation. | Reads and reports. It cannot change your files. |
| **Doc Writer** | A briefing: the goal, the decisions, the files touched. | Asks before changing anything. |
| **PR Author** | The same briefing. | Asks before changing anything. |

**Code Reviewer deliberately does not get your conversation.** That's the whole
point of it, and it's why its findings are worth reading: it had to reconstruct
what the change was for, so anything it had to assume is something the change
doesn't say out loud.

The other two do get a briefing, because you can't write documentation or a pull
request from a diff alone.

### Your own roles

These three are built into the app, so they improve when you update. You can add
your own, and a role you write is treated exactly like a built-in one — same
list, same box, same behaviour. For now that means adding it to your workspace
file by hand; a proper editor is still to come.

Editing one of the built-in three gives you a copy rather than changing the
original, so an upgrade can't undo your version and your version can't be undone
by an upgrade.

## What a dispatched session is — and isn't

It's **a session like any other**. Its own card, its own tab, its own
conversation, its own permissions. You can click into it, read it, type at it,
and close it. It is not a helper thread hiding inside the session that started
it: if you close the original, this one carries on.

It also **doesn't know what you've said since**. It was handed a snapshot at the
moment you pressed Dispatch. If you change things afterwards and want them
looked at, dispatch again.

## Code Reviewer won't touch your files

It runs in **plan** mode, which is Claude Code's own read-only setting rather than
anything switchboard layers on top. It can read and explore as much as it likes;
it cannot edit.

One consequence worth knowing: if a reviewer decides it wants to write its
findings to a file, it will ask permission to leave plan mode — and because
nobody is sitting in front of a dispatched session, switchboard answers *no*
immediately and tells it to report its findings as its reply instead. You'll see
the findings in the session. Nothing is lost, and nothing sits waiting for a
click you were never going to make.

**Once you type into a dispatched session, that stops.** Typing is how switchboard
knows somebody is there, so from then on it asks you about leaving plan mode like
any other session would.

## When Dispatch is greyed out or refuses

- **No **Dispatch…** in the ⋯ menu** — the session hasn't started yet. There's
  nothing to hand over from a session that has never run.
- **A role is greyed out in the box** — its reason is printed under its name.
  Usually it wants a feature that isn't switched on or isn't built yet, and the
  message says which.
- **"Handing over the whole conversation needs session forking…"** — that role
  wants to pass on your entire conversation, which is an experimental feature.
  Turn on **Fork sessions** in Settings → Advanced, or pick **Briefed** instead.
- **"Dispatching into a fresh worktree is not available yet"** — that role wants
  its own separate checkout of your code. That arrives with the git work in a
  later release. For now a dispatched session works in the same folder as the
  one that sent it, which is worth remembering if you ask it to run tests.

## What doesn't happen yet

- **Findings don't come back to you automatically.** You read them in the new
  session's own card. Sending them back to the original session with one click is
  the next piece of work.
- **Dispatched sessions don't nest under the session that sent them** in the
  sessions list, and they don't clean themselves up. They're ordinary cards, so
  close them when you're done.
- **Nothing dispatches on its own.** There is no rule that sends a review off
  when a session finishes, and a session cannot dispatch another one by itself.
  Every dispatch is a button you pressed.
