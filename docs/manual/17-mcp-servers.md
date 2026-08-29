# MCP servers

> Status: current

MCP servers are the extra tools you give Claude Code — a connection to your
issue tracker, your error monitor, a database, a local script. Claude Code owns
them: it holds the configuration, makes the connections, and decides what a
session can reach. switchboard shows you what's there.

## Opening it

Two ways, and they do the same thing:

- **Type `/mcp`** in a session's prompt box and press Enter.
- Open the command palette (`Ctrl+Shift+P`) and pick **MCP servers…**

Either way you get a list of the servers **the session you're in** has
configured — see [What this list doesn't show](#what-this-list-doesnt-show)
below for the ones that don't come from your files. If no session is active, it
says so rather than showing you an empty list — an empty list would look like
"you have none", which is a different thing.

## What you're looking at

Servers are grouped by **where they come from**, most specific first:

| Group | What it means |
|---|---|
| **This project (shared via `.mcp.json`)** | Configured in the project folder itself and checked into the repo, so everyone who clones it gets the same servers |
| **This project (just you)** | Yours, for this one project. This is what you get by default when you add a server without saying otherwise |
| **All your projects** | Yours everywhere |
| **Set by your organisation** / **Managed for you** | Configured centrally, not by you |
| **Added at startup** | Brought in by a plugin, by the editor bridge, or by a command-line option when the session started |
| **From a skill** | Comes with a skill you're using |
| **Built into Claude Code** | Ships with Claude Code itself |
| **In your files, not loaded by this session** | See below — usually something you just added |

On a session that isn't running, the same name can appear in two groups. That's
not a display bug — it's a real situation worth knowing about, and hiding it
would leave you wondering why a server isn't behaving the way the file you were
reading says it should. A running session resolves one winner per name, so you
won't see it there.

### "In your files, not loaded by this session"

**Claude Code reads its MCP servers once, when the session starts.** So if you
add a server — here or from the command line — a session that's already running
won't have it, and it appears in this group instead of with the others. Same if
you remove one: it leaves this list, but the running session is still using it.

That's what **Reconnect** is for. Use it, or restart the session, and these rows
join the others.

Each row shows the server's name, its version once it's connected, the command
or web address it uses, its current state, and **how many tools it's giving
you** — which is usually the fastest way to spot a server that's connected but
not actually doing anything.

## Where the list comes from

**switchboard asks the running session directly.** That means you see everything
it really has, including the two kinds of server that live in no file at all:

- **Connectors from your claude.ai account** — the ones you turn on in your
  claude.ai account settings, under Connectors: Atlassian, Microsoft 365,
  Stripe and the rest. They come with your signed-in account, not from your
  disk.
- **Servers that plugins bring with them** — installed as part of a plugin
  rather than added by hand.

Some of those rows are marked **read-only**. That's not a permission problem:
they aren't written down in any configuration file, so Claude Code's own
commands have nothing to edit. You can see them here; you change them where they
came from — your claude.ai account settings, or the plugin that installed them.

**When the panel can't ask, it says so.** Three cases, and the panel names which
one you're in:

- **The session isn't running.** Start it and the full list appears.
- **The session is in Terminal mode.** Terminal-mode sessions can't be asked
  this question. Switch it to Direct mode, or run `/mcp` in its Terminal tab.
- **The session didn't answer.** Rare; try closing and reopening the panel.

In all three the panel falls back to reading your configuration files, which is
a shorter list — so if it looks short and says one of those things, nothing is
broken. You're seeing what's on disk rather than what the session has.

## The states

| State | What it means |
|---|---|
| **connected** | Claude Code is talking to it right now |
| **connecting…** | Still shaking hands. Normal for a few seconds after a session starts |
| **not connecting** | It tried and couldn't — a wrong command, a server that isn't running, a network it can't reach |
| **needs sign-in** | It's waiting for you to authorise it |
| **waiting for your approval** | See below |
| **turned off** | Approved once, then switched off for this project |
| **status unknown** | We haven't heard back yet, or couldn't tell |

**Seeing everything say "connecting…" right after you start a session is
expected.** Servers connect a few seconds after the session comes up, and the
panel re-checks on its own until they settle — you don't need to close and
reopen it.

**"waiting for your approval" only happens to shared project servers.** When a
repo carries its own `.mcp.json`, Claude Code won't connect to it just because
you cloned the repo — someone else wrote that file, and it can start a program
on your machine. It waits for you to say yes. See **Approving a shared server**
below.

On a session that isn't running, the status column takes longer to fill in, and
that's deliberate: with no session to ask, switchboard has to connect to every
server itself, which can take a few seconds if one of them is behind a VPN
that's off. The list appears immediately and the states land when they land — so
a slow server never stops you reading the page.

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
switchboard doesn't guess.

That's why the **Add server** form has a separate **Environment variables** box,
and says so next to the Arguments box: put your key there instead. Values you
type into Environment variables or Headers go straight to Claude Code and never
come back — the panel can only ever show you their *names*. Anything you type
into Arguments will be visible in the list.

All these values sit in plain text in Claude Code's own configuration files
either way. This panel doesn't show them, but anyone with your files can read
them.

## Adding a server

Click **Add server…** at the bottom of the panel. You'll be asked for:

- **Name** — letters, numbers, dots, dashes and underscores. This is what you'll
  see in the list and what Claude Code calls the server.
- **Available in** — which of the three groups above it goes into. The default,
  *This project (just you)*, is almost always the right one.
- **Kind** — *A program on this machine*, or a web address over HTTP or SSE.
- **Command** and **Arguments** (for a program), or **Web address** and
  **Headers** (for a web address). Put each argument on its own line — that way
  an argument containing a space needs no quoting.
- **Environment variables** — where API keys belong. See above.

switchboard runs Claude Code's own `claude mcp add` for you; it never edits the
configuration files itself. If Claude Code turns the request down — most often
because a server of that name already exists — you'll see its exact words, and
the form stays open so you can change something and try again.

**Double quotes aren't accepted anywhere in this form.** On Windows, Claude Code
is launched through a small script that can't receive a double quote reliably,
and switchboard would rather refuse than write something into your configuration
that isn't what you typed. In practice this almost never comes up: a quote you'd
type at a command prompt isn't part of the value anyway.

## Removing a server

Rows that came from a configuration file have a **Remove** button. It asks once
— **Remove it** or **Cancel** — and then deletes the server from the group it's
actually in, which matters when the same name appears in two groups. This runs
`claude mcp remove`; it doesn't edit any files directly.

Rows marked **read-only** have no Remove button, because there's no file to
remove them from. Those come from your claude.ai account, from a plugin, or from
Claude Code itself, and that's where you change them.

## Making a session pick up your changes

Adding or removing a server changes the configuration. A session that's already
running loaded its servers when it started, so it won't notice on its own —
that's why a server you just added shows up under **In your files, not loaded by
this session** rather than beside the rest.

Click **Reconnect** at the bottom of the panel.

- **A Terminal-mode session** gets `/mcp` typed into it, exactly as if you'd
  typed it yourself, and Claude Code's own picker opens in the terminal. Answer
  it there.
- **A Direct-mode session** has no terminal for that picker to appear in, so
  switchboard doesn't send anything and tells you so. Restart the session to
  pick up the change.
- **A session that isn't running** has nothing to reconnect; start it first.

## Approving a shared server

There's no "turn it on" button here yet. Click **Reconnect** and answer Claude
Code's own picker in the session.

If you want to be asked about *all* the project's shared servers again — because
you said no to one by mistake, or the repo's `.mcp.json` has changed — click
**Reset approvals**. It asks first. This clears every yes and every no for this
project at once; it doesn't approve anything by itself.

## When something's wrong

**A message at the top says a file couldn't be read.** There's a syntax error in
it — a stray comma, a missing quote. The message names the file and which groups
it affects. Everything in the other groups still shows, so you can see what *is*
working while you fix it.

**"Could not check whether Claude Code is connected."** The list is still
correct — it comes from the configuration files — but the states beside each
server are stale or missing, because the check itself didn't run. Usually that
means the `claude` command isn't where switchboard expected it. You'll only see
this on a session that isn't running; a running session reports its own states.

**The list is shorter than `/mcp` shows.** Read the note at the bottom of the
panel: it says which of the three reasons applies — the session isn't running,
it's in Terminal mode, or it didn't answer. Starting the session, or switching
it to Direct mode, gets you the full list.

**A server says "not connecting".** The command is the first thing to check: the
row shows exactly what Claude Code is trying to run. A typo, a program that
isn't installed, or a script that isn't executable all land here.

**A server you added isn't listed at all.** Check which project you added it to.
Servers added "just you" are tied to a specific project folder, and the panel
shows the session you're currently in.
