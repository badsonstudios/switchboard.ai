# Getting started

> Status: draft

switchboard.ai runs many Claude Code sessions side by side in one window —
each pointed at its own project folder — so you stop juggling a dozen terminal
windows and can see, at a glance, which one needs you.

## Before you start

You need **Claude Code** installed and signed in. switchboard runs *your*
`claude` command on *your* subscription: there's no API key to enter, no
account to create, and nothing is sent to us.

```
npm install -g @anthropic-ai/claude-code
```

Then run `claude` once in a terminal and sign in. If switchboard can't find it,
a banner appears along the top of the window and new sessions are disabled
until it's sorted.

TODO: where to download switchboard itself, per platform (no public release
yet).

## Your first session

1. Click **+ session** in the middle of the window.
2. Pick the project folder you want Claude to work in.
3. A card appears and Claude starts up inside it. The first moments show
   *starting*; once it's ready the status changes to *idle*.
4. Type into the box at the bottom of the card and press **Enter**.

You can also drag a folder from your file manager straight onto the window —
same result, no dialog.

## What you're looking at

- **Title bar** (top) — the version and build code on the left (click it to see
  exactly which build you're running — see
  [Troubleshooting](11-troubleshooting.md#which-version-am-i-running)), then
  app-wide switches: trust, the autonomy mode new sessions start in,
  notifications, theme, language.
- **Sessions** (left) — every session you have open, with a colored status dot.
  Click one to jump to it.
- **The grid** (middle) — the session cards themselves. Each has its own tabs:
  Session, Terminal, Changes, History.
- **Events** (right) — what needs you right now. Empty is good; it says
  "Nothing needs you right now".
- **Status bar** (bottom) — how many sessions are open, total tokens and
  estimated cost, the Claude Code version, and the current theme.

<!-- screenshot: the whole window with two or three live sessions -->

## Good to know

- Your sessions, layout, and window position come back when you reopen the app.
- Nothing leaves your machine. There's no cloud sync, no telemetry, no login.
- If switchboard itself breaks, your sessions keep running — you can always
  drop into the **Terminal** tab and work exactly as you would without it.
