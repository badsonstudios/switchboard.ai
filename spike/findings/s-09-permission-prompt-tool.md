# S-09 — Can switchboard own the permission prompt without giving up the terminal?

**Date:** 2026-07-31 · **CLI:** claude 2.1.220 · **Verdict: NO.**
`--permission-prompt-tool` is honoured in `--print` mode and **silently ignored
in interactive (TUI) mode.**

## Why this was asked

Dan hit a permission prompt switchboard could neither show nor answer:
ClaudeMon asked to create `.claude\scripts\coverage.sh`, the rail and Events lit
up *needs-permission*, and the Session view had nothing to click. Diagnosis (see
PROGRESS 2026-07-31): **Claude Code guards `.claude/**` writes above BOTH the
`permissions.allow` layer and the PreToolUse hook layer** — proven because that
project's `.claude/settings.json` already allows bare `Write`/`Edit` and it
prompted anyway, and because no PreToolUse ever reached our listener.

The VS Code extension *does* surface these. Its bundle
(`anthropic.claude-code-2.1.220`) shows the CLI delegating via a `can_use_tool`
control request whose payload carries `blocked_path`, `decision_reason`,
`title`, `display_name` and `permission_suggestions` — the CLI is **built** to
hand this prompt to a host UI. But the extension earns that by passing
`--permission-prompt-tool stdio` **and** driving the CLI with
`--output-format stream-json --input-format stream-json`: it hosts no terminal
and renders everything itself.

So: does the *other* form of the flag — `--permission-prompt-tool <mcp-tool>` —
work against an interactive session? If yes, switchboard gets extension-quality
prompts and keeps the real terminal.

## What was run

`spike/s09/` — a minimal stdio MCP server (`perm-mcp-server.cjs`) exposing one
`approve` tool that logs every call and always allows, plus two drivers:

| Run | Mode | Result |
|---|---|---|
| `run-print.cjs` | `claude -p …` | **Tool CALLED.** Control passes. |
| `run-interactive.cjs` | real PTY, no `-p` | **Tool NEVER called.** TUI prompted instead. |

### Run A — the control (print mode)

Our tool received exactly the case that started this:

```json
{"name":"approve","arguments":{
  "tool_name":"Write",
  "input":{"file_path":"…\\.claude\\scripts\\coverage.sh","content":"echo hi\n"},
  "tool_use_id":"toolu_01WosVN1k6GNninJYarFCMNM"}}
```

We answered `{"behavior":"allow"}` and the file was created. **So the `.claude/`
guard IS delegatable — it simply is not exposed to hooks.**

### Run B — the question (interactive PTY)

MCP server started ✅ · CLI sent `initialize` and `tools/list` ✅ ·
**`tools/call` — never.** The TUI drew its own prompt, verbatim:

```
Do you want to create coverage.sh?
❯ 1 Yes
  2. Yes, and allow Claude to edit its own settings for this session
  3. No
```

The MCP connection is live and healthy in interactive mode — the CLI enumerates
our tools. It just never routes permission decisions through them.

## Four false negatives before the real answer — read this before trusting a null result

Runs 1-4 all reported "tool not called" **for reasons that had nothing to do
with the flag.** Each looked exactly like a negative verdict:

1. **`ENOENT`** — `claude` resolves via a `.cmd` shim on Windows; must spawn
   `claude.cmd` (or resolve it) explicitly.
2. **Inherited `CLAUDE_CODE_*` env.** The spike runs *inside* a Claude Code
   session, so the child inherited `CLAUDE_CODE_CHILD_SESSION` and came up with
   *"Transcript saving is off"* and in manual mode — a crippled session. Scrub
   everything matching `/^CLAUDE(CODE|_)/`. (S-01's env landmines, new costume.)
3. **Bracketed paste on a single-line prompt.** `renderer/lib/composer.ts` only
   wraps MULTILINE text; a single line goes as plain text with a **separate,
   delayed** CR. Pasting one line put it nowhere.
4. **`cmd.exe /c` wrapper + the trust dialog.** Spawn the CLI DIRECTLY with
   ConPTY as `PtyService` does — the `cmd` wrapper starts the TUI but swallows
   keystrokes written back. And a fresh temp folder is UNTRUSTED, so the CLI
   opens its trust dialog first and eats the prompt; pre-accept it the way
   `sessions/trust.ts` does (`hasTrustDialogAccepted` in `~/.claude.json`).

**The lesson, and it is the transferable one:** a silent tool is
indistinguishable from a broken harness. The run only became evidence once
`prompt reached the composer: true` was asserted *before* reading the verdict.
Any future spike of this shape needs that assertion first.

## What this settles

- **The cheap win does not exist.** There is no flag that gives switchboard the
  permission prompt while it hosts a TUI.
- **The `.claude/` case is not special-cased against us** — it rides the same
  delegation everything else does. We are simply not on the receiving end.
- **MCP itself works interactively** (initialize + tools/list), which is useful
  for E11: a Session Bus over MCP is viable; *permission* delegation is not.

## The options that remain, none free

1. **Accept it, and fix the fallback.** The CLI owns these prompts; switchboard
   says so loudly and puts you one click from the Terminal. Today it whispers —
   a 10px chip, top-left, in the wrong hue, while every permission the user has
   ever answered arrived as a full-width bar at the bottom. Cheap, honest, and
   it does not buy the prompt itself.
2. **The extension trade — stream-json, no terminal.** Buys every permission
   prompt AND deletes the whole transcript-binding subsystem (no slug math, no
   adoption races: #107/#108/#112/#117 exist only because we read files instead
   of a stream). Costs the TUI and everything the CLI puts in it, forever —
   which is a **PHILOSOPHY amendment**, since "host-don't-reimplement (real CLI
   in real terminals)" is one of four hard constraints. Not a PR-sized decision.
3. **Screen-scrape the TUI prompt.** Detect `Do you want to …?` in the PTY
   stream, render our own bar, send `1`/`2`/`3`. Keeps the architecture, works
   for every TUI dialog — and is a §5.26 drift liability by construction: the
   CLI changes that text whenever it likes, and a mis-parse either misses a
   prompt or answers the wrong one. **Never auto-answer on a fuzzy match.**
4. **Ask upstream.** `--permission-prompt-tool` honoured in interactive mode is
   a small, coherent ask that would collapse this whole problem. Costs nothing
   to file and runs in parallel with any of the above.

**Recommended sequencing:** (1) now, because it is right regardless and cheap;
(4) in parallel, because it is free; and (2) only as a deliberate, measured
decision with its own spike — what stream-json mode actually costs in slash
commands, plan mode, `AskUserQuestion` and subscription auth is **unmeasured**,
and that measurement is the precondition for the conversation, not the outcome.

## POSTSCRIPT — 2026-07-31, later the same day

**The recommended sequencing did not survive contact.** Two things happened:

1. **The option 1/3 workaround was attempted in a parallel session and did not
   work** (Dan's report; that session holds the specifics). The cheap path is
   not merely unsatisfying — it is not available.
2. **The precondition got measured.** `spike/findings/s-10-stream-json-transport.md`
   ran the transport against our own PATH CLI and found it works on the
   subscription, delivers the exact `.claude/` prompt above as a `can_use_tool`
   control request, keeps writing the JSONL transcript, handles slash commands
   as plain text, and never draws a trust dialog.

**So the verdict at the top of this file still stands and is still the right
answer to the question it asked** — there is no flag that gives us the prompt
while we host a TUI. What changed is that option 2 stopped being the expensive
hypothetical and became the only route that reaches the goal. **Read S-10
next.**

## Reproducing

```
cd spike/s09
SB_CLAUDE="C:\\Users\\dheinz\\AppData\\Roaming\\npm\\claude.cmd" node run-print.cjs
SB_CLAUDE="C:\\Users\\dheinz\\AppData\\Roaming\\npm\\claude.cmd" node run-interactive.cjs
```

Both spend real subscription tokens (one tiny turn each). `run-interactive.cjs`
temporarily adds a `hasTrustDialogAccepted` key for its temp folder to
`~/.claude.json` and removes it on exit.
