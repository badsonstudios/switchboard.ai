# Settings

> Status: draft

Everything lives as chips in the title bar. There's no settings window yet.

| Chip | Does |
|---|---|
| **🔓 auto-trust / 🔒 ask trust** | Whether new folders are trusted automatically |
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

Switch it to **🔒 ask trust** if you'd rather answer that prompt yourself. Be
aware of where it appears: Claude Code draws the trust question in its own
terminal interface, so answering it needs a session in **Terminal mode** —
and new sessions start in [Direct mode](12-direct-mode.md), which has no
terminal. With **ask trust** on, put a session on Terminal mode from its **⋯**
menu the first time you open a folder, then switch it back if you like.

## What's remembered

Your theme, language, notification setting, autonomy default, what cards do on
submit (global, per group and per session), what a session may do when it needs
you (global and per session), layout, groups, sessions, per-session detail
level, and window position all persist across restarts, stored on your machine.

## Good to know

- switchboard has no account, no cloud sync, and sends no telemetry anywhere.
- Credentials are handled by Claude Code itself, on your subscription. There is
  no API key to enter and switchboard never stores one.

TODO: a proper settings screen (notification rules, quiet hours, per-session
sounds) is planned.
