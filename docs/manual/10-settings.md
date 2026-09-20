# Settings

> Status: draft

Everything lives as chips in the title bar. There's no settings window yet.

| Chip | Does |
|---|---|
| **🔓 auto-trust / 🔒 ask trust** | Whether new folders are trusted automatically. Greyed out, because nothing can ask any more — see below |
| **🏷 auto labels / 🏷 labels off** | Whether a blank task label fills itself from the title Claude gives the conversation. Turn it off before a screen-share — see below |
| **🛡 ask / plan / auto-edit / full-auto** | The autonomy mode *new* sessions start at — click to cycle |
| **⬍ Keep visible / Collapse on submit / Hide on submit** | What happens to a session's card when you send it a prompt — click to cycle. See below |
| **🔔 on / 🔕 off** | All notifications |
| **system · nordic · daylight · high contrast · soft contrast** | Theme — see below |
| **en · pseudo** | Language. `pseudo` is a development aid that stretches every label to test the layout — you probably want `en` |

## Language

One chip, two choices for now: **en** (English) and **pseudo**.

`pseudo` is not a translation. It takes every English word and mangles it into
accented look-alikes wrapped in `⟦ ⟧` — so anything that comes out plain is a
piece of text somebody forgot to make translatable. It is there for whoever adds
the second language, not for daily use.

**The switch covers the desktop pop-ups too**, not just the window: the text on
a notification, the **Allow** and **Deny** buttons on it, and the copy sent to
your phone or a webhook all follow this chip, and they change on the very next
notification with nothing to restart. What is *not* translated is anything that
came from Claude Code or from you — a command, a file path, a session name. See
[Notifications › Pop-ups follow the language you picked](09-notifications.md#pop-ups-follow-the-language-you-picked).

## Themes

Four chips, and they are the whole picker:

- **system** — follow whatever your OS is set to, and change when it changes.
- **nordic** — the dark theme, and the default on a dark OS.
- **daylight** — the light theme.
- **high contrast** — a much starker dark theme for readability rather than
  looks: black surfaces, white text, bright status colors, and bordered edges
  instead of soft shadows. Pick it if the normal themes are hard to read.
- **soft contrast** — the same idea with the glare taken off: near-black
  surfaces instead of pure black, an off-white text instead of pure white, and
  a little depth back in the shadows. It is measured against the same
  readability standards as high contrast — softer to look at, not weaker.

Whatever you pick applies everywhere at once, including any session windows you
have popped out onto another monitor. Session colors — the little dot and stripe
that tell your sessions apart — deliberately do **not** change with the theme:
they identify a session, so they stay put.

Themes are plain data files, so more can be added without changing the app. A
way to write and import your own is planned, along with a screen for editing
individual colors.

## What a card does when you submit a prompt

The **⬍** chip sets this for every session at once. The default, **Keep
visible**, does nothing at all: the card stays put and you watch the turn come
in. The other two are opt-in — **Collapse on submit** folds the card into the
Collapsed strip the moment you send a prompt, **Hide on submit** takes it off the
workspace entirely, and both bring it back when the session finishes or needs
you, so the space goes to whatever you're actually looking at.

Individual sessions and groups can disagree with the chip: right-click a session
in the Sessions list, or use the **⬍** button on a group header. The full story,
including what it deliberately won't do, is in
[Organizing your workspace](07-workspace.md#getting-out-of-the-way-by-itself).

## What a session may do when it needs you

The other half of the same question, and it isn't a chip — it lives in the
command palette (`Ctrl+Shift+P`, search for *needs you*) and in the right-click
menu of a session's row. Four settings: **always jump to it**, **jump only if
its card is on screen** (the default), **never jump — just light its lamp**, and
**never jump, skip the queue**. (None of them touches sound or the taskbar
flash — that's the **🔔** switch above.) The full story is in
[Organizing your workspace](07-workspace.md#when-a-session-interrupts-you).

## Trusting folders

Claude Code asks whether you trust a folder the first time it runs there. With
**auto-trust** on (the default), switchboard answers that for you, on the
grounds that choosing a folder to run an agent in *is* the trust decision.

You can switch it to **🔒 ask trust** if you'd rather answer that prompt
yourself — but today nothing will ask you. Claude Code only ever draws the trust
question inside its own terminal interface, and switchboard no longer runs
sessions there ([Direct mode](12-direct-mode.md)); it does not raise the
question any other way, so it simply runs in the folder. Measured against claude
2.1.226.

### Why the chip is greyed out

Because of that, the chip **is disabled**. Hover it and it tells you why: there
is no session that could put the question in front of you, so the setting has
nothing to govern.

Being disabled never changes what you had chosen. If you had picked **🔒 ask
trust**, the chip still says so, greyed out, and that is still what you would
get if anything could ask.

And while the chip is greyed out, **switchboard doesn't answer the question
either.** It does not record an acceptance in Claude Code's own settings on your
behalf — there was never a question to get ahead of, and recording an answer you
were never able to give would quietly use up the one thing this chip controls.

So a folder switchboard has run in stays un-answered, and the question is still
there to be asked the first time you run `claude` in that folder yourself, in a
terminal of your own.

## Auto task labels

With **🏷 auto labels** on (the default), a session whose task label you have
not filled in shows the title Claude Code gave the conversation instead of
nothing. The full story — how it behaves, and why typing a label of your own
always wins — is in
[Sessions › The label writes itself](02-sessions.md#the-label-writes-itself).

Switch it to **🏷 labels off** before a screen-share or a demo. The label is
derived from what you asked, so it can put a phrase from your prompt on the
card, in the sessions list, and in desktop notifications; off hides all of them
at once and sends notifications back to using the session's name. **Labels you
typed yourself stay visible** — those are your words. Nothing is deleted, so
turning it back on restores everything instantly.

## AI task labels

The labels chip has a third setting, **✨ AI labels**, and it is the only
setting in switchboard that spends your Claude subscription — so it is **off
until you choose it**, and it stays off after an update and after moving to a
new machine.

Click the chip once from its default and it reads **✨ AI labels**: switchboard
asks Claude to read what each session has recently been doing and write a short
label for it, refreshing it as the work moves on. The default setting shows the
name Claude gave the *conversation*, which describes how a session started; this
one describes what it is doing **now**. Clicking once more hides labels
altogether and stops the spending.

It only asks when a session finishes a turn, only when the conversation has
actually grown, at most once every ten minutes per session, and never more than
one at a time per session — so idle sessions cost you nothing at all. The check
runs with **no tools**: it cannot run commands, change files, or reach your
other sessions.

Turn it off and the spending stops at once. The full walk-through is in
[Sessions › Letting Claude write the label instead](02-sessions.md#letting-claude-write-the-label-instead-and-keep-it-up-to-date).

## What's remembered

Your theme, language, notification setting, auto-label setting, **AI-label
setting** (which stays off until you turn it on, including after an update), autonomy default, what cards do on
submit (global, per group and per session), what a session may do when it needs
you (global and per session), layout, groups, sessions, per-session detail
level, and window position all persist across restarts, stored on your machine.

## Quiet hours

Reachable with **`Ctrl+Shift+P`** → *quiet hours*, or from the **About** panel.
Off until you set a window. Two times on your machine's clock, between which
nothing pops up, beeps, speaks or reaches your phone — webhooks keep going,
deliberately. Full walk-through in
[Notifications](09-notifications.md#quiet-hours).

Stored with your workspace, so it survives restarts like everything above.

## Phone push & webhooks

Reachable with **`Ctrl+Shift+P`** → *phone push*, or from the **About** panel.
Off until you set it up. Full walk-through in
[Notifications](09-notifications.md#getting-told-on-your-phone).

Anything you paste in there — an ntfy topic, Pushover keys, a webhook URL —
goes into your operating system's credential store, never into a switchboard
file, so it is **not** part of "what's remembered" above and does not travel
with your workspace.

## Good to know

- switchboard has no account, no cloud sync, and sends no telemetry anywhere.
- Credentials for **Claude** are handled by Claude Code itself, on your
  subscription. There is no API key to enter and switchboard never stores one.
  The only credentials switchboard holds are the phone-push / webhook ones you
  choose to give it, and those live in the OS credential store.

TODO: a proper settings screen is planned. Until it lands, the settings that
have no chip live behind palette commands and the About panel — quiet hours and
phone push are both reached that way, and they will move into it when it exists.
TODO: a notification-rules editor (which would replace hand-editing the
`quietHours` override) is not built yet.
