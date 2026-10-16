<p align="right"><a href="contents.md">☰ Contents</a></p>

# Using Codex

> Status: draft

switchboard.ai can run **Codex**, OpenAI's coding AI, as well as Claude Code. A
Codex session uses the same Session view: its replies, the commands it runs,
its approval questions, and a Stop button.

⚠️ **Not everything is in yet.** You will NOT see an AI picker or a way to
switch a card to Codex. Until that ships, there is no button that starts a
Codex session, so a new session is still a Claude session. See
[Starting a Codex session today](#starting-a-codex-session-today).

## What you need

- **The Codex CLI, logged in with your ChatGPT account.** Install it, run
  `codex` once in a terminal, and sign in the way it asks. switchboard.ai uses
  that same sign-in. It never asks for your password, never stores an OpenAI
  key, and never signs you in or out.
- **Node.js**, because its `npx` is what starts Codex's connector. The
  connector downloads itself the first time, so the first Codex session can
  take a minute to open.

If you are not signed in when a Codex session starts, Codex opens its own
sign-in page in your browser. That is Codex's own sign-in, not ours.

## Starting a Codex session today

There is no menu for it yet. The AI picker comes with the AI switch. Until
then, a card runs on Codex only if its saved settings say so. If you want to
try it before then, ask for the step-by-step instructions in the testing notes.
They involve editing the app's saved workspace while the app is closed.

## What works

- **The conversation.** Codex's replies stream in as Claude's do. Each command
  it runs is a step box that shows its exit code. Codex does not send the
  command's output, so the box cannot show it.
- **Approvals.** When Codex asks before doing something, you get the usual
  approval bar. **Allow** lets it do that one thing once. switchboard.ai never
  picks Codex's "don't ask again" answer for you. **Deny** stops the whole
  turn. That is how Codex works: tell it what to do differently in your next
  message.
- **Stop.** Stop ends the turn. Any question still waiting is withdrawn.
- **Model and effort.** The model chip lists Codex's models, and the effort
  button sets how hard it thinks. Both switch live.
- **Modes.** The mode chip switches Codex live, with no restart needed. The
  table below shows what each mode means for Codex.
- **Resume.** Closing and reopening a Codex card picks up the same
  conversation. Codex replays it, so you see what was said. Codex forgets the
  model and effort when a conversation is reopened, so switchboard.ai puts
  them back. If the app was restarted in between, they go back to Codex's own
  defaults.
- **The other sessions.** A Codex session is connected to the other sessions
  the same way a Claude session is, so it can read their work and send them
  messages.

### What each mode means for Codex

| Mode chip | Codex mode | What Codex says it does |
|---|---|---|
| **ask** | Workspace access | Edits files in the session's folder; asks before writing outside it or using the network |
| **plan** | Read-only | Asks before editing any file or using the internet |
| **auto-edit** | Workspace access | The same as ask: Codex has no mode between these two |
| **full-auto** | Full access | Anything, anywhere on your computer, without asking |

**Codex has a fifth mode, "Auto review", that switchboard.ai never uses.**
It is Codex's own default. In it, a second, hidden model decides on Codex's
behalf whether something is safe enough to go ahead without asking you. That
model's work does not show in the conversation or in the usage numbers. With
switchboard.ai, every question is put to you, unless you choose **full-auto**,
which asks nothing.

Codex's **ask** lets it change files in the folder without asking. That is
looser than Claude's **ask**, which asks before every file change. If you want
Codex to ask before it edits anything, use **plan**.

## What is different from Claude

- **No Fork.** A Codex conversation cannot be forked yet.
- **No live MCP controls.** The MCP list cannot switch Codex's servers on or
  off, or reconnect them, while it runs.
- **`AGENTS.md`, not `CLAUDE.md`.** Codex reads a project's instructions from
  `AGENTS.md` and ignores `CLAUDE.md`. If a project's rules live only in
  `CLAUDE.md`, Codex does not see them.
- **Usage shows tokens and your plan's limits, with no dollar figure.** Codex
  reports the tokens each turn used, and they add up in the session's usage line and in the
  status-bar total. switchboard.ai also reads your ChatGPT plan's **5-hour** and
  **weekly** windows when a Codex session opens and after each turn. To see
  them, hover over the usage total in the status bar. You'll see lines such as
  "5-hour limit: 37% used, resets …" and "Weekly limit: 17% used, resets …".
  The read costs nothing and runs no model. You are on a plan, not paying per
  token, so no price is shown, and the total reads `no price` when Codex is
  the only AI with usage.
- **Some tokens are not counted.** Codex reports nothing for a turn you
  stopped or denied, and it does not count the short title it writes for each
  new conversation.

## Good to know

- **Nothing changes for Claude.** With Codex not installed, the app behaves
  exactly as before. A new session is still a Claude session either way.
- **Codex keeps its own history.** Its conversations are saved in Codex's own
  folder (`.codex` in your user folder), where the Codex CLI can see them too.

## If something goes wrong

- **"Codex is not signed in"** — run `codex` in a terminal, sign in, and start
  the session again.
- **The first session takes a long time to open** — the connector is
  downloading. Later starts are quick.
- **No 5-hour or weekly lines in the tooltip** — either the Codex CLI is not
  on your PATH, or you are signed out. The token numbers still show.
- **A Codex card's usage starts again from zero after a restart** — Codex
  keeps no record that switchboard.ai can read back, so the count begins
  again from the next turn.

---

[← Back to Contents](contents.md)
