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

## Where the new session works

**In the same folder as the one that sent it.** The box tells you which folder,
under the list of roles, before you press anything.

That is worth a moment's thought when you ask a dispatched session to run
something. It is looking at the same files you are, so a test run or a build
happens in the tree you are working in — not in a copy of it. If you are
mid-edit, it sees your half-finished edit.

Giving a reviewer its own separate checkout is the obvious fix and it is coming
with the git work in a later release. Until then switchboard would rather tell
you where the session is than quietly put it somewhere and let you assume
otherwise. A role can *ask* for its own checkout — the setting exists — and if
one does, the box refuses it by name rather than dropping it into your folder
without saying so.

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
file by hand; a proper editor is still to come — which is also why there is
nowhere yet to *pick* a role's folder setting. You can write one into the file,
and the box will tell you it can't carry it out.

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

## Getting the findings back

When a dispatched session finishes, a row appears in **Events** — on the card
that *sent* it, not on the new one. Open Events with the tab on the right, or
press `Ctrl+Space` to jump to whatever is waiting for you.

<!-- screenshot: an Events row reading "Code Reviewer 'Code Reviewer of my-project' finished and reported back", with Inject findings and Open it -->

The row says which role finished, and shows the first line of what it wrote —
usually the sentence that tells you whether you want to read the rest. It has two
buttons:

- **Inject findings** puts the whole report into the sending session's message
  box, marked as coming from the session that wrote it. **It does not send it.**
  You read it, edit it if you like, and press Enter — exactly as you would with
  anything one session passes to another. Once you've clicked it the row changes
  to say where the findings went and the button disappears, so you can't hand the
  same report over twice. (If you've switched that card to accept messages from
  other sessions automatically, it goes straight in, and the row says that
  instead rather than pretending it is waiting.)
- **Open it** takes you to the session that wrote the report, so you can read the
  whole conversation instead. If you've already closed that session, the row says
  so and the Inject button still works — switchboard is holding the report, not
  the card.

If the hand-over doesn't work — the card was closed, or it already has as many
messages waiting as it can hold — the row tells you why and **keeps the button**.
A click that landed badly never costs you the findings.

The report is the reviewer's last reply — the findings themselves, not a summary
switchboard wrote. If it's very long it's shortened, and the row says so.

**The row does not count the findings.** A review is prose, and different runs
number their points in different ways — or don't number them at all — so any
count printed here would sometimes be wrong. You get the reviewer's own opening
line instead, which is always true.

You'll get a row even when there is nothing to inject. If the session stopped
before it finished, or finished without writing anything, the row says that
rather than leaving you waiting for a review that isn't coming. **Dismiss** on
the row clears just that row; the sending session's own status is untouched.

### One thing to know about closing cards

If you close the *sending* session's card, its waiting findings go with it —
there's nowhere left to put them. Closing the *reviewer's* card is fine: the
report is held by the app, so **Inject findings** keeps working. The one thing
you lose is the name on the block: without the original session around to name,
it arrives attributed to an unknown session.

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

- **Nothing re-runs the review after you fix things.** Fix, re-dispatch, read
  again — there's no loop that does the rounds for you.
- **Dispatched sessions don't nest under the session that sent them** in the
  sessions list, and they don't clean themselves up. They're ordinary cards, so
  close them when you're done.
- **Nothing dispatches on its own.** There is no rule that sends a review off
  when a session finishes, and a session cannot dispatch another one by itself.
  Every dispatch is a button you pressed.
