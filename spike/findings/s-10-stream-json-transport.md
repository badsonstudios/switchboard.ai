# S-10 — What the stream-json transport actually costs

**Date:** 2026-07-31 · **CLI:** claude 2.1.220 (Dan's PATH install) ·
**Verdict: the transport works, on our own CLI, and it delivers the prompt
S-09 proved we cannot otherwise have.**

S-09 closed with a recommendation: option 2 (the extension trade) only "as a
deliberate, measured decision with its own spike — what stream-json mode
actually costs in slash commands, plan mode, `AskUserQuestion` and subscription
auth is **unmeasured**, and that measurement is the precondition for the
conversation, not the outcome."

This is that measurement. It was pulled forward because the two cheaper options
ran out: **S-09's option 1/3 workaround was attempted in a parallel session and
did not work** (2026-07-31, Dan — that session holds the specifics). With no
cheap win available, the precondition became the critical path.

---

## 1. How the VS Code extension actually works

Read from the shipped bundle at
`~/.vscode/extensions/anthropic.claude-code-2.1.220-win32-x64/`. Not inferred —
`extension.js` is one 2.6 MB minified line and line 235 is a **verbatim embed of
`@anthropic-ai/claude-agent-sdk`**, arg builder and all.

> **The bundle stays useful after this note.** It is a known-correct consumer of
> every CLI contract we depend on, and it is still on disk. **`docs/reference-implementations.md`**
> covers what is in it, how to grep the minified files without drowning your
> context, the `settings.json` schema it ships, and the rules for using it
> (read contracts, don't copy code; verify against the PATH CLI before
> building). Go there when stuck, not back to guessing.

**There is no terminal, because there is nothing to emulate.** The transport:

```js
spawn(command, args, { cwd, stdio: ["pipe","pipe","pipe"], signal, env, windowsHide: true })
```

Plain `child_process.spawn` over pipes. **`node-pty` does not appear anywhere in
the bundle.** The args it builds:

```
--output-format stream-json --verbose --input-format stream-json
--permission-prompt-tool stdio          # whenever a canUseTool callback exists
[--permission-mode …] [--resume=…] [--settings …] [--mcp-config …]
[--thinking …] [--effort …] [--max-turns …] [--allowedTools …] …
```

**No `--print`.** The 4.8 MB `webview/index.js` is a React app rendering the
message stream; there is no xterm and no ANSI handling in it.

Message types observed on the wire: `system:init`, `system:status`,
`system:commands_changed`, `system:post_turn_summary`, `system:task_summary`,
`stream_event` (token deltas), `assistant`, `user`, `result`,
`rate_limit_event`, `transcript_mirror`, `active_goal`, `keep_alive` — plus a
bidirectional control channel: `control_request` / `control_response` /
`control_cancel_request`, carrying `can_use_tool`, `hook_callback`,
`mcp_message`, `initialize`, `interrupt`, `set_permission_mode`, `set_model`,
`rewind`.

Two details worth carrying forward:

- **The extension ships its own `claude.exe`** (265 MB,
  `resources/native-binary/`). It does not depend on the user's install. We do,
  and that difference is why probe A below had to be run rather than assumed.
- **`claudeCode.useTerminal` (default `false`) is a real alternate mode**, using
  `vscode.window.createTerminal`. Anthropic kept the terminal as an escape
  hatch, not as the substrate. That is a precedent for our own sequencing.

---

## 2. What was run

`spike/s10/`, three probes, each against `claude.cmd` on PATH.

### Probe A — does duplex stream-json run without `--print`?

**Yes.** `--help` claims `--input-format` / `--output-format` "only works with
--print". **That help text is stale** — the SDK does not pass `--print` and the
CLI does not require it.

The process came up, streamed `text_delta` chunks token-by-token, emitted
`result:success`, and **stayed alive waiting for the next message**. It is a
conversation, not a batch invocation.

```
system:init → system:status → rate_limit_event → stream_event×7 → assistant → result:success
```

### Probe B — the case that started all of this

A temp folder whose `.claude/settings.json` **already allows bare `Write`/`Edit`**
— the ClaudeMon configuration, reproduced — then: *"Create the file
`.claude/scripts/coverage.sh`."* With `--permission-prompt-tool stdio`:

```json
{ "type": "control_request", "request_id": "a09c2ddc-…",
  "request": {
    "subtype": "can_use_tool", "tool_name": "Write", "display_name": "Write",
    "input": { "file_path": "…\\.claude\\scripts\\coverage.sh", "content": "echo hi\n" },
    "description": ".claude\\scripts\\coverage.sh",
    "decision_reason": "Claude requested permissions to edit … which is a sensitive file.",
    "decision_reason_type": "safetyCheck",
    "permission_suggestions": [ { "type": "setMode", "mode": "acceptEdits", "destination": "session" } ],
    "classifier_approvable": true,
    "tool_use_id": "toolu_01XF73D7YpDPjwQLPtHdQwDT" } }
```

Answered `{"behavior":"allow","updatedInput":…}`; the file was created.

**This is the whole bug, delegated to us, with a human-readable reason and a
suggested remedy attached.** S-09 proved the `.claude/` guard sits above both
the `permissions.allow` layer and the PreToolUse hook layer. It does *not* sit
above this one.

Note `decision_reason_type: "safetyCheck"` and `permission_suggestions` — the
payload is richer than anything our hook path ever had. `decision_reason` is
renderable prose we did not have to write, which is P7 working in our favour.

### Probe C — slash commands and what the CLI tells us at startup

Slash commands **work as plain user text**. `/cost` executed and returned prose
through the normal `assistant` → `result` path; no special encoding.

Better: `system:init` advertises the session's real capabilities.

```
keys: type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode,
      slash_commands, apiKeySource, claude_code_version, output_style, agents,
      skills, plugins, capabilities, analytics_disabled, product_feedback_disabled,
      uuid, memory_paths, fast_mode_state, fast_mode_disabled_reason
```

`slash_commands` came back with **59 entries including this machine's project
and user commands** — `/startup`, `/check-code`, the android-* set. Our
`CLAUDE_BUILTIN_COMMANDS` in `main/providers/claude.ts` is 40 hand-curated
builtins that the file itself calls "version-volatile by nature… a maintenance
chore". This replaces it with ground truth, and adds the user's own commands,
which we could never have enumerated.

### Also settled, incidentally

- **Subscription auth is fine.** Every probe ran on Dan's Max subscription;
  `rate_limit_event` reports `five_hour` / weekly windows exactly as the TUI
  does. `apiKeySource` is in `init`. **No API key anywhere** — the
  subscription-first hard constraint is not threatened by this transport.
- **The JSONL transcript is still written.** `~/.claude/projects/<slug>/<uuid>.jsonl`
  appeared normally. The transcript stack (`watcher.ts`, `drift.ts`, binding
  states, #107's contract) **keeps working during a migration** rather than
  having to be replaced in the same step. The stream additionally carries
  `transcript_mirror`, so it becomes redundant later, on its own schedule.
- **No trust dialog.** Probe B ran in a fresh, untrusted temp folder and simply
  warned on stderr that it was ignoring the `permissions.allow` entries. It did
  not block. S-09's run-interactive needed a `~/.claude.json` edit to get past
  the modal; this mode never draws one.

---

## 3. Still unmeasured — do not treat these as answered

Honest list. These are the next probes, not conclusions:

1. **Plan mode + `ExitPlanMode`.** `--permission-mode plan` sets it, but the
   plan-approval interaction is a TUI chooser. Does it arrive as `can_use_tool`,
   or does it need a control request we have not seen?
2. **`AskUserQuestion`.** Same shape of question, and it is the one that most
   looks like "interaction the CLI owns" under P7.
3. **Sidechains / subagents.** `parent_tool_use_id` is on every message, so the
   data is there — but our feed's sidechain rendering (S-05) has not been driven
   from it.
4. **`/resume`, `/rewind`, `--from-pr` pickers.** Interactive choosers with no
   stream equivalent observed. `rewind` exists as a control request; the
   *picker* does not.
5. **Interrupt semantics.** `interrupt` is in the protocol; not exercised.
6. **Long-run stability.** Every probe was one turn. Nothing here says anything
   about a pipe held open for eight hours, which is the actual product.

---

## 4. What migrating costs us

The load-bearing PTY surface is **14 files** (68 mention `pty`; the rest are
comments and tests).

| Piece | Fate |
|---|---|
| `main/pty/pty-service.ts` | Sibling `StreamService`: `child_process.spawn` + NDJSON framing. Ring buffer, env scrubbing (S-01 landmines), lifecycle logic port near-verbatim |
| `renderer/lib/composer.ts` | **Deleted.** The bracketed-paste wrapper and the 75 ms delayed CR (S-03) become one `stdin.write(JSON.stringify(msg))` |
| `TerminalPane.tsx`, `terminal-attach.ts`, `shared/ipc/pty.ts` | xterm, FitAddon, the NaN-dimension guard, the #117 epoch protocol — all of it exists to make an emulated terminal behave. Kept only if the terminal survives as an escape hatch |
| `main/providers/claude.ts` `buildSpawn` | Four flags added. `CLAUDE_BUILTIN_COMMANDS` replaced by `system:init.slash_commands` |
| `main/hooks/hook-listener.ts` (25 KB + 25 KB tests) | The hold-and-release dance over a local listener collapses into answering `can_use_tool` on a pipe we already own. Optionally the shell-hook mechanism goes entirely, via `hook_callback` |
| `main/transcripts/*` (46 KB watcher + 42 KB tests, `drift.ts`, binding) | **Survives untouched** through the migration; becomes redundant later |
| `FeedView.tsx`, `lib/feed.ts`, block contributions | **Survives.** Same block shapes, better source — typed messages and token-level streaming instead of file-poll latency |
| `e2e/` | `real-claude`, `reconnect`, `session`, `approval`, `binding`, `slash-commands`, `split` assert against terminal output or the hook path. Substantial rewrite |

**Gained:** the permission prompts we cannot currently answer · token-by-token
streaming · `interrupt` / `set_permission_mode` / `set_model` / `rewind` as
first-class operations instead of keystroke injection · a slash-command list
that cannot go stale · `--replay-user-messages` for send acknowledgment · and
the S-03/S-04/S-07 class of problems — bracketed paste, submit timing, ANSI
redraw, xterm visibility — stops existing.

**Lost:** the CLI's TUI affordances with no stream equivalent — Ctrl-R history,
vim mode, the `/resume` and `--from-pr` pickers, and whatever unmeasured item
from §3 turns out to be a chooser. Each is either rebuilt (a P7 violation) or
dropped.

**The contract trade, stated plainly:** we swap one undocumented dependency for
another. But stream-json is the *SDK's own surface* — versioned, and the thing
Anthropic ships a product on — whereas DESIGN §5.2 already records hook payloads
mutating across patch releases with zero changelog notice. `--permission-prompt-tool`
is hidden from `--help`, and `transcript_mirror` / `active_goal` /
`post_turn_summary` are undocumented, so this is a better bet, not a safe one.

---

## 5. What this settles, and what it does not

- **Settled:** the transport runs on our CLI, on the subscription, and delivers
  the `.claude/` prompt. S-09's option 2 is *viable*, which was genuinely open
  before this.
- **Settled:** the migration is incremental. `StreamService` lands beside
  `PtyService` behind a per-session flag; the feed, transcript stack, state
  machine, and extensibility registry all survive the cut. **The extension keeps
  both modes itself**, which is decent evidence the seam is clean.
- **Not settled:** whether we take it. That is the PHILOSOPHY P7 amendment
  (made 2026-07-31 alongside this note), and then the six unmeasured items in
  §3 — because the ones that are choosers are the ones that decide whether the
  terminal stays as an escape hatch or goes.
