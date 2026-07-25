# Settings

> Status: draft

Everything lives as chips in the title bar. There's no settings window yet.

| Chip | Does |
|---|---|
| **🔓 auto-trust / 🔒 ask trust** | Whether new folders are trusted automatically |
| **🛡 ask / plan / auto-edit / full-auto** | The autonomy mode *new* sessions start at — click to cycle |
| **🔔 on / 🔕 off** | All notifications |
| **system · nordic · daylight** | Theme — nordic is dark, daylight is light, system follows your OS |
| **en · pseudo** | Language. `pseudo` is a development aid that stretches every label to test the layout — you probably want `en` |

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
