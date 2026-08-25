# MCP servers

> Status: draft

MCP servers are the extra tools you give Claude Code — a connection to your
issue tracker, your error monitor, a database, a local script. Claude Code owns
them: it holds the configuration, makes the connections, and decides what a
session can reach. switchboard shows you what's there.

## Opening it

Two ways, and they do the same thing:

- **Type `/mcp`** in a session's prompt box and press Enter.
- Open the command palette (`Ctrl+Shift+P`) and pick **MCP servers…**

Either way you get a list of every server **the session you're in** can see. If
no session is active, it says so rather than showing you an empty list — an
empty list would look like "you have none", which is a different thing.

## What you're looking at

Servers are grouped by **where they're configured**, most specific first:

| Group | What it means |
|---|---|
| **This project (shared via `.mcp.json`)** | Configured in the project folder itself and checked into the repo, so everyone who clones it gets the same servers |
| **This project (just you)** | Yours, for this one project. This is what you get by default when you add a server without saying otherwise |
| **All your projects** | Yours everywhere |

The same name can appear in two groups. That's not a display bug — it's a real
situation worth knowing about, and hiding it would leave you wondering why a
server isn't behaving the way the file you were reading says it should.

Each row shows the server's name, the command or web address it uses, and its
current state.

## The states

| State | What it means |
|---|---|
| **connected** | Claude Code is talking to it right now |
| **not connecting** | It tried and couldn't — a wrong command, a server that isn't running, a network it can't reach |
| **waiting for your approval** | See below |
| **turned off** | Approved once, then switched off for this project |
| **status unknown** | We haven't heard back yet, or couldn't tell |

**"waiting for your approval" only happens to shared project servers.** When a
repo carries its own `.mcp.json`, Claude Code won't connect to it just because
you cloned the repo — someone else wrote that file, and it can start a program
on your machine. It waits for you to say yes. To approve one, open that project
in the `claude` command line and it will ask you.

The status column takes a moment to fill in. That's deliberate: checking means
actually connecting to every server, which can take a few seconds if one of
them is behind a VPN that's off. The list appears immediately and the states
land when they land — so a slow server never stops you reading the page.

## What it shows about credentials

If a server carries an API key or an authorization header, the panel names it —
*Carries: API_KEY, Authorization* — and never shows the value. That's enough to
answer "did I set my key up?" without putting a live credential on your screen
in the middle of a screen-share. Web addresses get the same treatment: a
password or a token in the address is stripped before it's shown.

**One place a secret can still be visible:** if a server was set up by passing
the key as a command-line option — `npx some-server --api-key sk-live-…` — that
option is part of the command, and the command is what the panel shows. There's
no reliable way to tell which of an arbitrary program's options are secrets, so
switchboard doesn't guess. If you share your screen a lot, keep keys in
environment variables instead, where they're masked.

All these values sit in plain text in Claude Code's own configuration files
either way. This panel doesn't show them, but anyone with your files can read
them.

## Adding and removing servers

**Not from here yet.** This panel is read-only for now. Use Claude Code's own
command line:

```
claude mcp add <name> -- <command>          # just you, this project
claude mcp add -s project <name> -- <cmd>   # shared with the repo
claude mcp add -s user <name> -- <command>  # you, everywhere
claude mcp remove <name>
```

Changes show up here the next time you open the panel.

## When something's wrong

**A whole group says the file couldn't be read.** There's a syntax error in it —
a stray comma, a missing quote. The other groups still show, so you can see
everything that *is* working while you fix it.

**A server says "not connecting".** The command is the first thing to check: the
row shows exactly what Claude Code is trying to run. A typo, a program that
isn't installed, or a script that isn't executable all land here.

**A server you added isn't listed at all.** Check which project you added it to.
Servers added "just you" are tied to a specific project folder, and the panel
shows the session you're currently in.
