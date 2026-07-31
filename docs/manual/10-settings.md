# Settings

> Status: draft

Everything lives as chips in the title bar. There's no settings window yet.

| Chip | Does |
|---|---|
| **🔓 auto-trust / 🔒 ask trust** | Whether new folders are trusted automatically |
| **🛡 ask / plan / auto-edit / full-auto** | The autonomy mode *new* sessions start at — click to cycle |
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

## Trusting folders

Claude Code asks whether you trust a folder the first time it runs there. With
**auto-trust** on (the default), switchboard answers that for you, on the
grounds that choosing a folder to run an agent in *is* the trust decision.

Switch it to **🔒 ask trust** if you'd rather answer that prompt yourself in
the Terminal tab each time.

## What's remembered

Your theme, language, notification setting, autonomy default, layout, groups,
sessions, per-session detail level, and window position all persist across
restarts, stored on your machine.

## Good to know

- switchboard has no account, no cloud sync, and sends no telemetry anywhere.
- Credentials are handled by Claude Code itself, on your subscription. There is
  no API key to enter and switchboard never stores one.

TODO: a proper settings screen (notification rules, quiet hours, per-session
sounds) is planned.
