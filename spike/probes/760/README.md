# Session Bus feasibility probes (#760, P2-E11-00)

The harnesses behind **`spike/findings/e11-00-bus-feasibility.md`**. They live
here, committed, for the same reason the `721/` set does: that note makes
load-bearing claims about the CLI, and a citation into a git-ignored scratch
directory dies with the worktree.

Run against the **CLI on PATH** (measured on **2.1.261**, 2026-09-07) on
**Windows 11**. Three of the six spend a turn.

```bash
node spike/probes/760/probe-direct.mjs            # free
node spike/probes/760/probe-attach.mjs            # free, ~90s (three CLI runs)
node spike/probes/760/probe-deadserver.mjs        # free, ~40s
node spike/probes/760/probe-toolcall.mjs          # ⚠️ ONE TURN
node spike/probes/760/probe-discovery.mjs         # ⚠️ ONE TURN — see the warning below
node spike/probes/760/probe-deadturn.mjs          # ⚠️ TWO TINY TURNS (no tools)
```

## The pieces

| file | what it is |
|---|---|
| `mcp-bus-server.mjs` | **The subject.** A hand-rolled stdio MCP server — no SDK. Two tools, deliberately: `sb_probe_local` answers in-process, `sb_probe_echo` answers only via the host over the pipe. One tool would conflate "the CLI never launched it" with "the pipe is broken" into a single illegible failure. |
| `pipe-host.mjs` | Stand-in for Electron main at the other end of the named pipe. **No auth** — #762 owns that, and S-03's rule (token in an ACL'd file, never on argv) applies there. |
| `common.mjs` | Shared spawn + NDJSON read loop. Shared because `721/probe721b.mjs` diverged in its copy (`return` where the others `continue`) in a way that made every *absence* it reported unsound. |

## The probes

| probe | question | answer |
|---|---|---|
| `probe-direct.mjs` | **Q2a** — does the pipe round-trip with no CLI in the loop, and what does a **dead host** look like? | Yes. Dead host → `isError: true` immediately (`ENOENT`), not a hang. |
| `probe-attach.mjs` | **Q1** does the CLI launch our server · **Q3** do the user's servers survive · **Q4** does the `env` block reach the child · **Q5** is argv verbatim · **Q7** does `--strict-mcp-config` really evict | Yes to all five. Runs the CLI **three times** — Q3 and Q7 are differences, and one run cannot show one. |
| `probe-deadserver.mjs` | **Q6a** — does a broken bus wedge the CLI's control channel? Missing binary, exits immediately, starts and never speaks MCP. | No. But the silent case is still `pending` at 30 s — see `probe-deadturn`. |
| `probe-toolcall.mjs` | **Q2b** — can a real agent call a bus tool and get the host's answer back? | Yes, end to end, and it measured the tool-name format instead of assuming it. |
| `probe-discovery.mjs` | **B1** — does an agent find the bus when the prompt names **no** tool? | **Yes — discoverable.** This probe exists because the note first concluded the opposite from `probe-toolcall`, which had *named* the tool. |
| `probe-deadturn.mjs` | **Q6b** — does a broken bus delay a real **turn**? | ⚠️ **Yes — ~32 s.** The finding `probe-deadserver` could not reach, because a responsive control channel is not a working session. |

## Safety — read before running

1. **`--mcp-config` is spawn-scoped and writes to NO config file** (unlike
   `claude mcp add`). Nothing to clean up, and Dan's own servers are never
   named or mutated — Q3 only *reads* their names. Verified by hand after the
   runs (`~/.claude.json` holds no `sbbus`); the probes do not assert it, which
   they should — see the note's *What is NOT proven*.
2. ⚠️ **`probe-discovery.mjs` and `probe-toolcall.mjs` use
   `--permission-mode bypassPermissions`, and a cwd is NOT a sandbox.** The
   discovery run answered its question and then, unprompted, enumerated the
   machine's other live Claude sessions, read `~/.claude/sessions/` and
   transcripts under `~/.claude/projects/`, and messaged **six** live sessions
   across four projects. Nothing destructive, but nothing contained either.
   `probe-deadturn.mjs` is the model to copy instead: it needs no tools, so it
   gets `--permission-mode default` and a prompt with no reason to act.

## The traps these cost us

1. **Writing to the CLI's stdin at `t=0` loses the message, silently.** The
   first `probe-attach` run polled from the instant `spawn()` returned, got
   **zero** samples across two full runs, and produced a confident **false
   negative on Q1** — while the server log beside it proved the CLI had launched
   our server and completed the handshake. Every `721` probe waits ~500 ms
   before its first write; that delay was load-bearing and undocumented. This is
   721's own lesson 2 — *"a silent CLI is worth suspecting your own probe over"*
   — collected a second time by the same trap.
2. **`toolUses[0]` is not your tool.** The agent calls `ToolSearch` first, so
   element 0 was `ToolSearch` and the probe reported that as the tool name —
   wrong, and wrong in a way that reads as right.
3. **A verdict computed by substring can pass on the wrong evidence.** Review
   found three in one function: `log.includes('"1"')` matched timestamps;
   `log.includes(SESSION_ID)` for "argv is verbatim" also matched the `ENV.`
   line, so **Q5 passed on Q4's evidence**; and the log was never bound to the
   current run, so a stale file would report YES while the run launched nothing.
4. **A settle condition can be vacuously true.** `[].every(...)` is `true`, so
   the baseline could settle on an empty server list and Q3 would report
   "nothing lost" from nothing.
5. **Node 22 cannot `child_process.spawn` a `.cmd`** (`EINVAL`, the
   CVE-2024-27980 fix). PATH here holds only `claude.cmd`, so `resolveCli()`
   resolves past the shim to the real `.exe`. **This is a probe detail and says
   nothing about the app**, which spawns sessions through `node-pty` and
   elsewhere through `main/transport/win-cmd.ts`.

## Note on `artifacts/toolcall.json`

Its `Q2b` block is **hand-edited** (the file discloses this in a `note` field).
The probe had taken `toolUses[0]` — trap 2 — so the verdict *label* was
recomputed from that same run's recorded `toolUses` rather than spending a
second turn. The underlying `toolUses` and `hostSaw` data are the original
measurement. `probe-toolcall.mjs` is fixed, so a re-run produces the right label
directly and a file without the `note`.
