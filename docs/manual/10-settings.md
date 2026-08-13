# Settings

> Status: draft

Everything lives as chips in the title bar. There's no settings window yet.

| Chip | Does |
|---|---|
| **🔓 auto-trust / 🔒 ask trust** | Whether new folders are trusted automatically |
| **🏷 auto labels / 🏷 labels off** | Whether a blank task label fills itself from the title Claude gives the conversation. Turn it off before a screen-share — see below |
| **🛡 ask / plan / auto-edit / full-auto** | The autonomy mode *new* sessions start at — click to cycle |
| **⬍ Keep visible / Collapse on submit / Hide on submit** | What happens to a session's card when you send it a prompt — click to cycle. See below |
| **🔔 on / 🔕 off** | All notifications |
| **system · nordic · daylight · high contrast · soft contrast** | Theme — see below |
| **en · pseudo** | Language. `pseudo` is a development aid that stretches every label to test the layout — you probably want `en` |

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

Switch it to **🔒 ask trust** if you'd rather answer that prompt yourself.
Where the question appears — and whether it appears at all — depends on the
session's mode:

- **Terminal mode:** Claude Code draws the trust question in its own terminal
  interface, and you answer it there, in the session's **Terminal** tab.
- **[Direct mode](12-direct-mode.md)** (what new sessions use): **Claude Code
  never asks.** It has no terminal to ask in, and it does not raise the question
  any other way — it simply runs in the folder. Measured against claude 2.1.226.

So **🔒 ask trust** only really does anything for Terminal-mode sessions. If
being asked matters to you for a particular folder, open it in Terminal mode
from the session's **⋯** menu the first time; once you have answered, the
answer is remembered and Direct mode works the same either way.

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

## What's remembered

Your theme, language, notification setting, auto-label setting, autonomy default, what cards do on
submit (global, per group and per session), what a session may do when it needs
you (global and per session), layout, groups, sessions, per-session detail
level, and window position all persist across restarts, stored on your machine.

## Good to know

- switchboard has no account, no cloud sync, and sends no telemetry anywhere.
- Credentials are handled by Claude Code itself, on your subscription. There is
  no API key to enter and switchboard never stores one.

TODO: a proper settings screen (notification rules, quiet hours, per-session
sounds) is planned.
