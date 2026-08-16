# Notifications & events

> Status: draft

The point of switchboard is knowing *which* session needs you without being
nagged about the ones that don't.

## The Events drawer

On the right-hand edge of the workspace there's a narrow **tab** with a number
on it. That number is how many sessions are waiting on you. Click it and a
drawer slides out over the workspace with one entry per session, showing its
latest state — never a scrolling log you have to keep up with. Each entry shows
the session's name and task label, so you know what it is without decoding an
ID.

- **Click an entry** to jump straight to that session.
- **✕** dismisses it.
- Entries read **needs permission**, **needs input**, **crashed**, or **Done.**
  A finished session relaxes from **Done.** to **Ready** once you've looked at
  it.
- When nothing is outstanding it says **Nothing needs you right now**.

Closing a session clears its entries. So does starting it again: a **crashed**
entry goes as soon as a fresh session takes its place, whether you restarted it
yourself or just came back to the card.

### Three ways to open it, and one to close it

| | |
|---|---|
| **Click the tab** | on the right edge, vertically centered |
| **`Ctrl+E`** | from anywhere except inside a terminal or a text box |
| **The command palette** | `Ctrl+Shift+P` → "Show or hide the events drawer" |

**`Esc`** closes it and puts your cursor back where it was. So does clicking the
tab again, or pressing `Ctrl+E`.

The drawer **sits on top of** the workspace rather than pushing it aside, so
opening and closing it never moves your sessions around. It's also not a dialog:
the sessions behind it keep running and stay clickable, and `Tab` walks out of
it normally.

It starts closed every time you launch. That's deliberate — it used to be a
permanent column down the right-hand side, and it was taking up room the session
grid wanted in every layout.

### Reading the tab without opening it

The tab is doing three jobs while it's shut:

- **The number** is how many sessions are waiting on you — the same number
  `Ctrl+Space` walks through, and the same one in the status bar.
- **Its color** is the *most urgent* thing waiting. A session blocked on a
  permission tints it differently from one that's merely finished.
- **A small dot** appears when there's a notice inside — an update, an offer to
  restore a pop-out layout, or a provider incident (see below). Something is in
  there that isn't a session.

If you use a screen reader, all three are read out in the tab's name — "Events ·
3 sessions waiting · 1 notice" — so none of it depends on seeing a color. And a
notice that turns up while the drawer is closed is announced as it arrives, so
you don't have to keep opening the drawer to check.

### The count in the status bar

The bottom-right of the window carries the same count, permanently: **"3
waiting"**, next to the session count. It never moves and never needs opening,
so "is anything waiting on me?" is answerable with a glance even when the drawer
is shut and the tab is off the edge of your attention.

## The drawer is a to-do list, in order

Entries aren't listed newest-first — they're listed **in the order you should
deal with them**:

1. **Needs permission** — Claude is blocked on your answer.
2. **Needs input** — Claude has asked you something.
3. **Crashed** — the session died.
4. **Done.** — finished, and you haven't looked yet.

Within each group, whoever has been waiting longest is higher up. Sessions
you've already reviewed (**Ready**) sink to the bottom and fade back — they're
history at that point, not work.

The entry marked **next** is where **`Ctrl+Space`** will take you; press it
again and the marker moves down to the following one. Clicking an entry counts
the same way, so the shortcut won't bounce you back to something you just
opened. See [Keyboard & commands](06-keyboard.md) for the full walk-through.

### A session you've told to stay quiet

If you've set a session's interrupt setting to **Never jump, skip the queue**
([Organizing your workspace](07-workspace.md#when-a-session-interrupts-you)),
its entries still appear in the drawer — the drawer is the log — but it is never
marked **next** and `Ctrl+Space` walks straight past it. That's the difference
between the log and the to-do list.

## The lamp strip

Across the top of the window, under the title bar, there's a thin row of
**lamps** — one per session, always there.

Each lamp is a small dot plus the session's name, and the dot is colored by what
that session is doing right now:

| The lamp | It means |
|---|---|
| a hollow ring, name in grey | calm — working, idle, or suspended |
| a **filled** dot, name in bold and tinted | it needs you |

The filled-versus-hollow difference is deliberate: you can read the strip
without relying on the color at all. At the right-hand end it totals things up
— **"2 need you"**, or **"all calm"** when nothing is outstanding.

**Click any lamp to jump to that session.** If you'd hidden its card, clicking
the lamp brings it back to exactly where it was. If the session is in its own
pop-out window, clicking the lamp raises that window rather than pulling the
card back into the main one.

The strip never goes away. Hide the sessions list, switch a card to its
Terminal, take a card out of the workspace entirely — the lamps stay put. It's
the one place that always shows you every session you have, so you never have to
wonder whether something is out of sight and shouting.

### The lamp that called you stays lit

When you press **`Ctrl+Space`** to jump to whatever needs you next, you arrive
at a session — but which one was it? By the time the screen has changed, the
thing that told you is gone.

So it isn't. The lamp you were just sent to gets a **ring around it for about a
second and a half** after you land, then quietly fades out. Long enough to see
where you were sent, short enough not to become part of the furniture.

The second and a half is counted **from the moment the ring is actually on your
screen**, not from the moment you pressed the key. If the machine is busy and
the window takes a while to catch up, you still get the full beat once it does —
you never arrive to find that the thing meant to show you where you are has
already come and gone. A ring that hasn't appeared yet waits for the window to
come back rather than counting down behind your back; once it's up, it fades on
its own schedule like anything else.

**Only ever one ring is kept waiting** — the last one. `Ctrl+Space` works from a
pop-out window, but the strip it rings is on the main window, so if that window
is behind something you can make several jumps before it gets a chance to draw
anything. You come back to a single ring on the session you actually landed on,
not a firework display of every jump you made while it was hidden. A ring that
is already *up on your screen* is left alone: jump to one session, then a moment
later to another, and both rings are there together, each fading on its own
count.

Nothing on the strip blinks or animates for attention. It's a readout, not an
alarm.

## What you'll hear and see

By default, when a session needs permission, needs input, finishes, or crashes:

- **A sound plays.**
- **An entry appears in Events.**
- **The taskbar icon flashes** — but only if the switchboard window is in the
  background. It stops as soon as you come back.

**Desktop pop-up notifications are off by default.** The sound plus the Events
panel is the calm default; pop-ups are opt-in.

Turn the whole lot off with the **🔔 / 🔕** chip in the title bar. That switch is
above everything on this page: with it off, nothing pops up, nothing beeps,
nothing is spoken, and no rule fires — including **Notify when done**, below.

That one beep can become a **different sound per session**, and switchboard can
**say out loud** which session needs you. Both are off until you ask — the next
two sections.

## Giving each session its own sound

By default every session shares one plain beep, which tells you *something*
happened but not *what*. Turn on **🔊 session sounds** in the title bar and each
session gets its own short cue instead — so with six cards open you can tell
which one wants you without looking away from what you're doing.

Sessions get different sounds **automatically**, in the order you opened them,
so you don't have to set anything up. There are eight, and they're chosen to be
easy to tell apart rather than to be pretty: Chime, Bell, Knock, Rise, Blip,
Fall, Ping and Thrum.

**To pick a session's sound yourself:**

1. Open the session's **⋯ menu** (top right of its card).
2. Click **Sound: <name> — switch to <next>**.

Each click moves to the next sound in the list **and plays it**, so you can keep
clicking until you hear one you like. Once you've picked one by hand it's
*pinned*: it stays with that session for good, and it won't shift when you close
other sessions. (A sound the app assigned automatically *can* shift if you close
a session ahead of it. Pinning is the fix.)

Keep clicking past the last sound and it comes back round to **Automatic** —
that's how you undo a choice. While a session is on automatic the entry names
the sound it will actually make, like *"Sound: Automatic (Knock)"*.

Your choice is remembered and comes back with the session when you reopen the
app.

Two more things:

- **The cue replaces the beep — it doesn't add to it.** One event, one sound.
- **If a sound can't be played** — no audio device, or the window is gone — you
  get the plain beep instead. You'll never get silence where you used to get a
  noise.

## Having switchboard tell you out loud

Turn on **🗣 announce** in the title bar and switchboard will *say* which session
needs you: *"Add markdown preview needs your input."*

It uses your computer's built-in voice — nothing is sent anywhere, and nothing
is downloaded.

- **It says the session's task label** if it has one — the short "what am I
  doing" line under the title (see [Sessions](02-sessions.md)). That's the
  useful half: it answers *what* is waiting, not just *which*.
- **If there's no label, it says the session's title instead.** Same if you've
  turned auto labels off with the **🏷** chip — the voice falls back to the
  title rather than going quiet.
- **It only speaks when you're not in switchboard.** Reading out something
  you're looking straight at is slow and annoying, so the voice waits until
  you've clicked away or minimized — the same rule the desktop pop-ups follow.
- **It never reads out a tool call or a long label.** Long labels are cut short;
  permission announcements say "needs permission" and leave the details on
  screen where you can read them.

If your computer has no voice installed (some Linux setups), nothing is said and
nothing breaks — the sound and the Events entry still happen.

## Notify me when *this* session is done

Long jobs are the ones worth being told about. A five-second turn is not.

So finishing is **opt-in, per session**:

1. Open the session's **⋯ menu** (top right of its card).
2. Tick **☐ Notify when done**.

That session — and only that session — will pop up a desktop notification when
it finishes a turn. Every other session stays quiet on finishing, exactly as
before. Untick it to stop.

Three things worth knowing:

- **It only pops up when you're not looking.** If you're currently in a
  switchboard window, there's no pop-up: you're already here, and the Events
  panel and the sound have already told you. Click away to another app (or
  minimize) and the pop-ups start arriving. "A switchboard window" means any of
  them — a session you've popped out into its own window counts, so working in a
  pop-out keeps things quiet even if the main window is minimized behind it.
- **It's remembered.** The tick survives closing the app, and comes back with
  the session when you reopen it. Closing a session for good forgets its
  setting along with the card.
- **It's a separate switch from the global pop-up one.** Ticking the box for a
  session is you asking for pop-ups *for that session*, so you get them whether
  or not desktop pop-ups are on for everything else.

### What still pops up on its own

With desktop pop-ups turned on globally, **needs permission** and **needs
input** pop up while you're away from the window, and a **crash** pops up even
if you're looking right at switchboard — a session that has died is not going to
fix itself while you read another card.

## Answering a permission from the pop-up itself

When a session asks permission to run something and you're in another app, the
pop-up doesn't just tell you — it **asks**, with **Allow** and **Deny** on it.
Press one and that's the answer: the tool runs, or Claude is told no, and the
session carries on. You never had to come back to switchboard at all.

**The pop-up tells you what you'd be allowing.** It reads *"Allow Bash? npm run
build"* — the same question the approval bar inside the app asks, with the
actual command, file, or address in it. A button that granted something you
couldn't see would be worse than no pop-up.

**A click on the pop-up itself is not an answer.** Clicking the body (rather
than a button) brings switchboard to the front and lands you on the card that's
asking, with its approval bar open. Dismissing notifications by reflex is a real
thing people do, and reflex should not be able to grant a tool call.

**Answer it anywhere and the pop-up goes away.** If you come back to the window
and use the approval bar, the Events drawer's buttons, or the batch bar, the
pop-up is withdrawn straight away — you'll never find a stale **Allow** sitting
in your notification centre for a question that was settled ten minutes ago. The
same is true if the session dies while the pop-up is up: pressing a button then
does nothing at all except say so in the log. It can't misfire into a session
that isn't there.

### What your desktop actually gives you

Buttons on notifications are the operating system's to grant, not ours, so this
one honestly differs by platform:

| | What you get |
|---|---|
| **Windows 10/11** | **Allow** and **Deny** buttons on the pop-up. In an installed build these work as described. Running switchboard from a development checkout, Windows may show the pop-up without its buttons — it only offers them to apps it has a Start-menu registration for — in which case clicking the pop-up still takes you straight to the request. |
| **macOS** | **Allow** and **Deny** buttons, on a signed build. An unsigned local build gets a plain pop-up; clicking it still takes you to the request. |
| **Linux** | No buttons — Electron doesn't offer notification actions there. Clicking the pop-up brings switchboard forward onto the card that's asking, which is still one gesture. |

Whatever your desktop does, **nothing is lost**: the approval bar inside the app
is always there, always keyboard-reachable, and is the same decision either way.
The pop-up is a shortcut to it, never a replacement for it.

## Under the hood: rules

The two behaviors above aren't special cases; they're **rules**, and they all
have the same shape:

> **when** [something happens] **in** [this session, or any session], **and**
> [the window is / isn't in front] → **do** [something]

A rule can pop up a desktop notification — with **Allow** / **Deny** on it
when the thing that happened was a permission request, as above — play a
**per-session sound**, **say it out loud**, send a notification to your
**phone**, or **POST an event to a webhook** (all below). **Quiet hours** are a
condition on the same machinery: a time of day the rules check before they act
(see below).

The only rule you can *write* by hand is the checkbox; the rest are switched on

### What a pop-up says

If you have turned pop-ups on, each one is headed with the session's **task
label** — "Add markdown preview needs your input" rather than a third pop-up
saying "switchboard.ai". That is the whole point of them at seven or eight
sessions: you can tell which one is calling without looking.

If the session has no label it falls back to the session's name. And if you have
turned **🏷 auto labels** off (see
[Sessions › Turning it off](02-sessions.md#turning-it-off-screen-sharing)),
pop-ups go back to the session name too — so a phrase from your prompt does not
appear on a shared screen.

## Getting told on your phone

A desktop pop-up is no use once you've walked away from the machine. So a
session can reach your **phone** instead — through
[ntfy](https://ntfy.sh) (no account, free) or
[Pushover](https://pushover.net) (a one-off purchase).

**This is off until you set it up, and switchboard works perfectly well with it
switched off forever.** Nothing is sent anywhere until you paste in a
destination yourself.

### Where the setup lives

There's no settings screen yet, so setup lives in a dialog you can reach two
ways:

- press **`Ctrl+Shift+P`** and type *phone push*; or
- open the **About** panel (click the version in the title bar) and press
  **Phone push & webhooks…**

*This placement is temporary and will move into Settings when that screen
exists.*

### Setting up ntfy (the easy one)

1. Install the **ntfy** app on your phone (iOS or Android), or open
   [ntfy.sh](https://ntfy.sh) in a phone browser.
2. Make up a **topic** name. Treat it like a password: anyone who knows it can
   read your notifications and send you fake ones, so
   `dan-switchboard-7f3a91c2` — not `dan`.
3. **Subscribe** to that topic in the phone app.
4. In switchboard, open the setup dialog, paste the topic into **Topic**, and
   press **Save**.
5. Tick **Send events to my phone**.
6. Press **Send test**. Your phone should buzz within a second or two.

Running your own ntfy server? Put its address in **Server**. Leave it empty for
the public ntfy.sh.

### Setting up Pushover

1. Sign in at [pushover.net](https://pushover.net) and copy your **User key**
   from the front page.
2. Create an application there (any name) and copy its **API token**.
3. In the setup dialog, choose **Pushover**, paste both, save each, tick the
   switch, and press **Send test**.

### What gets sent, and when

You get a push for **needs permission**, **needs input**, and **crashes** —
and only while you're **away from switchboard**. If you're sitting in front of
the app, your pocket stays quiet: the screen already told you.

A finished turn (**Done.**) does *not* push. That's what the per-session
**Notify when done** checkbox above is for.

The message is the same one a desktop pop-up would have shown: the session's
task label (or its name), plus what happened. That label is derived from what
you asked the agent, and it leaves your machine when a push is sent — turn off
**🏷 auto labels** in the title bar if you'd rather it didn't.

Attention events go out at *high* priority, never *urgent*: switchboard will not
override your phone's do-not-disturb.

## Webhooks — telling a program instead of a person

The **webhook** action POSTs each event as JSON to a URL you own — a home
dashboard, a Slack/Discord relay, a Home Assistant automation, a log file.

Set it up in the same dialog: paste the URL, save it, and tick **POST events to
my webhook**. **Send test** POSTs one immediately so you can check the other end
is listening.

Unlike the phone push, a webhook fires **whatever the window is doing** and
includes **Done.** — a program isn't distracted by being looked at, and a
dashboard wants the whole picture.

The body looks like this:

```json
{
  "source": "switchboard.ai",
  "version": 1,
  "event": "needs-permission",
  "sessionId": "live-8f1c…",
  "cardId": "card-3b2a…",
  "title": "Add markdown preview",
  "body": "needs permission",
  "ruleId": "default:webhook:needs-permission",
  "visibility": "hidden",
  "at": "2026-08-13T18:04:11.204Z"
}
```

A POST from the **Send test** button carries one extra field, `"test": true`.
It's absent on every real event, so an automation can skip it rather than
switching the lights on for a session that never ran.

- **`event`** is the one to switch on: `needs-permission`, `needs-input`,
  `done`, or `crashed`. Ignore any value you don't recognize — new ones may
  appear.
- **`cardId`** is stable across restarts; **`sessionId`** is not (it's minted
  fresh every time a session resumes).
- **`version`** only changes if the shape changes in a way that would break you.
- Nothing else goes with it: no folder, no file paths, no prompt text, no
  transcript.

Your webhook URL is treated as a secret, because most of them are. It has to be
a full `http://` or `https://` address — a bare `example.com/hook` is refused
when you save it, with a note saying so, rather than accepted and then never
fired.

**One thing the webhook is *not* louder than:** the 🔔 title-bar switch sits
above every channel on this page, webhooks included. With notifications off,
nothing is sent — your dashboard goes quiet too.

**Quiet hours are different, and this is worth knowing before you wire a
dashboard up:** they do **not** stop the webhook. A webhook goes to a program,
and a program isn't asleep — a log with a hole in it every night from 22:00 to
07:00 is a broken log. If yours flashes a lamp or pages you, see
[Quiet hours](#quiet-hours) for how to make one rule obey them anyway.

## Quiet hours

Hours of the day when switchboard won't make a noise at you.

Open it with **Ctrl+Shift+P → "Quiet hours…"**, or from the **About** panel
(the same place the phone-push button lives). Tick **Keep quiet between these
times**, set a **From** and an **Until**, and close the dialog. That's the whole
setting.

- **Times are your machine's clock**, and they mean the numbers on the clock on
  the wall. They follow you if you change timezone, and they need no special
  handling for daylight saving: an hour that happens twice in autumn is quiet
  twice, and an hour that doesn't happen at all in spring is skipped, exactly
  as if you'd read your own clock.
- **A window can run past midnight.** `22:00` until `07:00` means overnight —
  you don't have to split it into two.
- **The end is exclusive.** `22:00`–`07:00` is quiet at 06:59 and not at 07:00.
- **Both ends go together.** Two identical times would be a window of zero
  length, which is refused with a note rather than accepted and ignored.

### What stops, and what doesn't

**Stops — everything aimed at you:**

| | |
|---|---|
| Desktop pop-ups | held |
| The beep, and per-session sounds | held |
| Spoken announcements | held |
| **Phone push** | held — a phone buzzing on a nightstand is the *most* person-facing channel here, not the least |

**Doesn't stop — the one thing aimed at a machine:**

| | |
|---|---|
| **Webhooks** | still sent |

That last row is a deliberate decision, not an oversight. A webhook goes to a
program you pointed at this app precisely so that something would be watching
while you're not. Silencing it overnight would put a hole in a log or a
dashboard every night, and the cause — a *notification* setting on another
screen — is not something anyone diagnoses successfully at 9am.

If your webhook really *is* a person-facing channel (it flashes a lamp, it pages
you), a rule can be marked to obey quiet hours anyway. There's no rules editor
yet, so today that means hand-editing `quietHours: "obey"` onto the rule in the
workspace file; the same field set to `"ignore"` does the opposite — it fires a
pop-up at 3am for the one session whose crash is worth waking up for.

### Nothing is lost while it's quiet

Sessions keep running, and everything still lands in the **Events panel** —
you're just not told about it until the window is over. Anything the window
holds back is **written down**: what happened, when, which session, and which
channels were held. That list survives closing the app, and a *missed-events
digest* that shows it to you on return is the next item on this page's roadmap.

The list is capped at the **200 most recent** held events; past that, the oldest
drop off.

### Telling that it's working

A feature whose entire job is to do nothing is hard to trust. The dialog's
bottom line answers both questions: whether the window is open **right now**,
and how many notifications it has held so far. If it says *"Cannot tell right
now"*, this window couldn't reach the app's settings — see
[Troubleshooting](11-troubleshooting.md).

The 🔔 title-bar switch is still above all of this. Quiet hours are a schedule;
🔔 off is "not now, at all", and it silences the webhook too.

## Where your credentials are kept

Your topic, tokens and webhook URL go into your **operating system's credential
store** — Windows DPAPI, the macOS Keychain, or your Linux keyring — and never
into a switchboard file. What's on disk beside the workspace file is an
encrypted blob only your account on this machine can open; copy it to another
computer and it decrypts to nothing.

Consequences worth knowing:

- **switchboard can't show you a saved value again.** A field you've filled in
  reads **· saved** and stays empty. To change one, paste the new value over it;
  to remove it, press **Forget**.
- **They never appear in the logs**, even when a send fails.
- **On Linux without a keyring** (gnome-keyring or kwallet), there's nowhere
  safe to put them. The dialog says so and refuses to store anything rather than
  writing a token to a plain file.

## Good to know

- Notifications never interrupt a session. If notifying fails for any reason,
  the session carries on regardless. A phone that's off, a webhook host that's
  gone, a laptop with no signal: the session doesn't notice and neither do you.
- **Nothing is retried and nothing is queued.** A push that doesn't get through
  is gone — you'll find the session waiting when you come back, which is what
  the Events drawer is for.
- A failure is written to the log **once**, not once per event, so an evening
  with the phone off doesn't bury everything else in there.
- The 🔔 title-bar switch is still above all of this. With notifications off,
  nothing is sent anywhere.
- **Quiet hours don't stop webhooks** — see [Quiet hours](#quiet-hours) above
  for why, and how to override it per rule.

TODO: there is no rules *editor* yet — the per-session checkbox is the only rule
you can write from the UI, so the `quietHours` override is a hand-edit for now.
TODO: the missed-events digest that reads the held list is not built yet.
