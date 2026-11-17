# #1612: status hooks in exec form, and in the background where nothing waits

**Date:** 2026-11-17 · **CLI:** 2.1.322 (PATH) · **Machine:** the owner's desktop (Defender)

## Question

Claude Code's settings schema offers two hook fields: `args` ("`command` is
resolved as an executable and spawned directly with these arguments — no
shell") and `async` ("hook runs in background without blocking"). Without
`args`, a hook "runs through a shell (bash on POSIX, PowerShell on Windows
without Git Bash)", and on a Windows machine with Git Bash that means bash
starts first, then node, for every hook. `PostToolUse` fires on every tool
call. Do the two fields work on the CLI we run, and what do they save?

## The schema (read from the PATH binary, §2.1 of reference-implementations.md)

`grep -a -o -E '.{200}runs through a shell.{400}' claude.exe` shows `args`,
`shell`, `timeout`, `async` and `asyncRewake` on the command hook schema, with
the descriptions quoted above. The hook runner treats `args !== void 0` as the
exec form.

## Probe A: exec form and async, driven for real (`spike/probes/1612/run.mjs`)

One `claude -p --model haiku` turn with hooks in exec form (`command` =
`process.execPath`, `args` = `[hook.cjs, log, 'a b "c" $HOME']`):
SessionStart and PostToolUse `async: true`, UserPromptSubmit and Stop not.

- Every hook fired. The argument `a b "c" $HOME` reached the hook **byte for
  byte**: no shell split it, unquoted it or expanded `$HOME`.
- All eight async `PostToolUse` hooks were delivered, each before `Stop`.
- The hook's own `Date.now() - process.uptime() * 1000` (when the process
  started) rose monotonically in spawn order.

## Probe B: what a hook costs to start (`spike/probes/1612/hook-spawn-bench.mjs`)

The real forwarder against a throwaway listener, 30 runs of each form,
alternated so background load hits both alike:

| Form | median | p90 | min | max |
|---|---|---|---|---|
| through Git Bash (`bash -c "<cmd>"`, today) | 86 ms | 94 ms | 84 ms | 94 ms |
| exec form (`node <args>`) | 53 ms | 55 ms | 51 ms | 55 ms |

So exec form saves about a third of every hook's start-up here. `async` takes
the rest of it off the agent's path for the events that only record something.
The laptop (VIPRE, which taxes every spawn) was not measured; that is the
owner's hand test.

## What shipped

- Exec form for every status hook when `node` is on PATH. The run-as-node
  fallback (`ELECTRON_RUN_AS_NODE=1 <app>`) stays a shell command, because it
  needs an env prefix and a hook has no field for env.
- `async: true` on `PostToolUse`, `Notification` and `SubagentStop`.
  `UserPromptSubmit` answers (the waiting-note line), `SessionStart(clear)` is
  awaited by `/clear`, and `Stop` is the done authority, so those three stay
  synchronous.
- A background event could in principle arrive after the next synchronous one
  (a slow spawn, then a fast `Stop`), and a late `PostToolUse` would turn a
  finished session back to "working". The forwarder now sends when it started
  (`x-switchboard-born`), and the listener drops a background event that started
  before the last synchronous one. A forwarder with no stamp is never dropped.
