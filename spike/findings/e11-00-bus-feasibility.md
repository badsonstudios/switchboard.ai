# E11-00 — Session Bus feasibility: findings

**Issue:** #760 · **Probes:** `spike/probes/760/` · **Measured:** 2026-09-07,
`claude` **2.1.261** on PATH, Windows 11, Node 22.20.0.
**Cost:** three real turns (`probe-toolcall`, `probe-discovery`, `probe-deadturn`);
everything else free.

**Verdict in one line: the bus design in #762/#763 works — but a broken bus is
NOT free, and the tool-discovery story turned out to be the opposite of what a
first reading of the evidence suggested.**

---

## The questions

| # | question | answer |
|---|---|---|
| Q1 | Does the CLI launch our stdio server from `--mcp-config`? | **Yes** — `connected`, `serverInfo` ours, both tools listed |
| Q2a | Does the named pipe round-trip, with no CLI in the loop? | **Yes**; a dead host fails cleanly rather than hanging |
| Q2b | Can a real agent call a bus tool and get the host's answer? | **Yes**, end to end |
| Q3 | Do the user's own MCP servers survive the merge? | **Yes** — nothing lost |
| Q4 | Does the config `env` block reach the server process? | **Yes** |
| Q5 | Is argv passed through verbatim? | **Yes** — §5.4's identity-at-spawn premise holds |
| Q6 | Does a broken bus block a session? | **It does not block — but it costs ~32 s.** See §5 |
| Q7 | Does `--strict-mcp-config` really evict the user's servers? | **Yes**, measured — the flag we must never pass |

---

## 1. The CLI launches our server, and `mcp_status` proves it without a model

Attaching `--mcp-config` with a `sbbus` entry, `mcp_status` settles to:

```json
{ "name": "sbbus", "status": "connected", "scope": "dynamic",
  "serverInfo": { "name": "sbbus-probe", "version": "0.0.0-760" },
  "tools": ["sb_probe_local", "sb_probe_echo"] }
```

`serverInfo` is *our* string and `tools` is *our* list, so this one call proves
the CLI spawned the process, sent `initialize`, and called `tools/list`. **No
turn required.** That made five of eight questions free.

**#763 can assert its done-when this way — as a local `check:*` script, NOT in
CI.** `mcp_status` costs no tokens but still needs a *logged-in* CLI, and
`.github/workflows/ci.yml` records (#182) that every check driving the real
`claude` binary is local-only precisely because a runner has no subscription
login and giving it one would mean an API key or spending Dan's tokens — the two
hard constraints. `src/main/check-scripts.test.ts` enforces that. So this joins
the `check:pty` / `check:hooks` family, not a CI job.

**Scope is `dynamic`**, which the repo already documents:
`src/main/mcp/config.ts:24-26` lists the CLI's eight-scope vocabulary, and
`McpManagerDialog.tsx:45` already says `dynamic` "covers `--mcp-config`,
plugins, the IDE bridge". So this is confirmation, not news. The consequence for
#763 is a UI decision: `merge.ts` builds the manager's inventory from the
runtime list, so the bus **will** appear in the §5.17 manager beside servers the
user actually controls, and `merge.ts` will offer no Remove for it (no config
file backs it). Whether it is shown or filtered is a deliberate call worth
making. *(Whether the user could still `mcp_toggle` it is **unmeasured** —
`docs/reference-implementations.md` warns in bold that the toggle works by NAME
rather than through a file, so do not assume config-backed rows only.)*

## 2. The user's servers survive the merge, and `--strict-mcp-config` really would evict them

Three full CLI runs, each settled to completion:

| run | servers |
|---|---|
| baseline (no flag) | `DeepWiki: connected` |
| `--mcp-config` | `DeepWiki: connected`, `sbbus: connected` |
| `--mcp-config --strict-mcp-config` | **`sbbus` only — `DeepWiki` gone** |

The third run is new: the help string ("ignoring all other MCP configurations")
was previously quoted as if it were a measurement. It is now a measurement.
**`--strict-mcp-config` is the flag #763 must never pass**, and its done-when
should keep asserting the absence.

⚠️ **Scope of Q3, stated plainly:** this machine has exactly **one** pre-existing
server, `DeepWiki`, at `scope: local`, living in `~/.claude.json` under
`projects[…].mcpServers`. There is **no `.mcp.json` in the repo**. So nothing is
proven about `user`, `project`, `enterprise`, `managed`, `builtin` or connector-
class servers surviving the merge — only that a `local`-scoped one does.

⚠️ **A soundness note on the measurement itself**, because two earlier versions
were wrong: the run first stopped as soon as `sbbus` went `connected`, catching
`DeepWiki` still `pending` — comparing a settled baseline against a half-settled
after. And the settle condition was vacuously true on an empty list (`[].every`
is `true`), so an early empty `mcpServers` would have settled the baseline with
zero servers and reported "nothing lost" from nothing. Both are fixed; Q3 now
refuses to render a verdict at all when the baseline is empty.

## 3. Identity at spawn holds — argv and `env` both arrive verbatim

The reason §5.4 chose stdio is that an MCP tool call carries no ambient session
identity, and one process per session gets it free. From the committed
`artifacts/server.log`:

```
ARGV ["C:\\Program Files\\nodejs\\node.exe","…\\mcp-bus-server.mjs","--session","sb-session-probe-760","--pipe","\\\\.\\pipe\\sb760-attach-47608"]
SESSION_FROM_ARGV "sb-session-probe-760"
ENV.SB_PROBE_SESSION "sb-session-probe-760"
ENV.ELECTRON_RUN_AS_NODE "1"
```

Both channels arrive intact. The CLI identifies itself in `initialize` as
`{"name":"claude-code","version":"2.1.261",…}` and proposes protocol version
**`2025-11-25`**.

⚠️ **What this does NOT prove: that Electron-as-node works.** The probe spawned
`process.execPath`, i.e. **plain Node** (`EXECPATH C:\Program Files\nodejs\node.exe`
in the log). What is measured is that a config `env` block reaches the child —
the *mechanism* Electron-as-node depends on, since `providers/claude.ts`
deliberately strips `ELECTRON_RUN_AS_NODE` from the *session's* env (an S-01
landmine) and would have to re-add it here. **Actually launching `electron.exe`
this way from `--mcp-config` is unmeasured**, and #762 should measure it rather
than inherit it.

## 4. A hand-rolled MCP server is enough — the SDK is a choice, not a necessity

`mcp-bus-server.mjs` is 194 lines including its comments, has no dependencies,
and satisfied the real CLI: `initialize` → `notifications/initialized` →
`tools/list` → `tools/call`. Four methods is the whole surface the bus needs.

**Recommendation for #762: hand-roll it.** Caveats that belong in the decision:
we **echo** the client's proposed `protocolVersion` rather than negotiating
(fine for one known client, not in general); `ping` is implemented but **no
client ever called it**, so it is untested; and cancellation, progress, and
resource/prompt methods were never exercised — none of which the bus needs
today.

## 5. ⚠️ A broken bus never *blocks* a session — but a silent one costs ~32 seconds

Two separate measurements, and the second is the one that matters.

**The control channel stays responsive** (`probe-deadserver.mjs`, no turn):

| the server | `mcp_status` reported | first observed at |
|---|---|---|
| binary does not exist | `sbbus: failed` | 3.5 s |
| starts, exits immediately | `sbbus: failed` | 2.0 s |
| **starts, never speaks MCP** | **`sbbus: pending`** | still pending at 30.5 s |

In all three the CLI answered normally and `DeepWiki` stayed `connected`.
*(Those timings are poll-quantized to a 1.5 s grid and include CLI startup —
they are when the probe first observed the settled state, not detection
latency.)*

**But a responsive control channel is not a working session**, so
`probe-deadturn.mjs` ran an actual turn:

| run | first token | total |
|---|---|---|
| control, no `--mcp-config` | **3.0 s** | 3.5 s |
| silent bus attached | **35.2 s** | 35.4 s |

**A silent MCP server delays the first token by ~32 seconds.** The turn does
complete and returns the right answer — so this is a stall, not a block, and the
fail-open constraint survives in letter. It does not survive in spirit: 32
seconds of dead air on session start is indistinguishable from a hang to the
person waiting.

This also **settles the "for ever" question** the earlier draft got wrong. It is
not indefinite: `pending` at 30.5 s plus a first token at 35.2 s is consistent
with a **~30 s connect timeout**, after which the CLI proceeds without the
server. Earlier wording ("never resolves", "hangs `pending` for ever") stated an
unproven absence as fact and has been removed.

**The consequence for #762 is concrete and load-bearing:** the bus must answer
`initialize` before doing anything that can block — no pipe connection, no
workspace read, no lock. A slow host does not degrade the bus, it costs every
session 30 seconds. This is the failure mode most likely to reach a user,
because it is the one our own bug produces.

## 6. Tool NAMES are visible; SCHEMAS are deferred — and the bus IS discoverable

This section reverses what an earlier draft claimed, and the reversal is worth
recording because the wrong version had already been sent to #764 and #765.

In `probe-toolcall`, the agent's first move was
`ToolSearch {"query":"select:mcp__sbbus__sb_probe_echo"}` — it produced the
**fully-qualified** name, server included, *before* any search result came back.
The draft read that as "MCP tools are not in the initial tool list, so the bus
is not discoverable". But the prompt had named `sb_probe_echo`, and the agent
knowing the qualified form is evidence the **names were visible and only the
schemas deferred** — close to the opposite conclusion. The experiment had not
been run.

`probe-discovery.mjs` ran it: same config, a prompt naming **no tool, no server
and no convention** — *"What other switchboard sessions are currently running,
and what are they working on?"*

```
ListAgents -> ToolSearch{select:mcp__sbbus__sb_probe_echo,mcp__sbbus__sb_probe_local}
           -> mcp__sbbus__sb_probe_local -> mcp__sbbus__sb_probe_echo -> …
```

**The agent found both bus tools unaided and called them**, and the host's own
record confirms the bytes crossed the pipe (`hostSaw: [{q:"echo", …}]`) rather
than the model narrating a call it did not make.

So: **the bus is discoverable.** An agent asked a question the bus can answer
will find it. Two facts to carry forward:

- **Tool names are `mcp__<server>__<tool>`** — measured, not guessed. Needed the
  moment anything wants an `--allowedTools` entry or a permission rule.
- **Schemas are fetched on demand** via `ToolSearch`, so tool *descriptions*
  carry real weight: they are what the agent matches against before it ever sees
  the schema. #764/#765 should write them for a reader who is deciding whether
  to search, not just for one who has already committed.

## 7. Three traps that cost real time, recorded so they are paid once

**Writing to the CLI's stdin at `t=0` loses the message silently.** The first
`probe-attach` polled from the instant `spawn()` returned, got zero samples
across two runs, and printed a confident **`Q1: NO — sbbus never appeared`** —
while the server log beside it showed the CLI had launched our server and
completed the handshake. Every `721` probe waits ~500 ms before its first write
and none says why; that delay is load-bearing. This is **721's own lesson 2
collected a second time by the same trap**, and the reason the
`sb_probe_local`/`sb_probe_echo` split earned its keep: without a probe that
fails *legibly*, the false negative would have been the finding.

**A verdict computed by substring can pass on the wrong evidence.** Review found
three in one function: `log.includes('"1"')` matched a `"1"` anywhere in the
file including timestamps; `log.includes(SESSION_ID)` for "argv is verbatim"
also matched the `ENV.` line, so **Q5 was passing on Q4's evidence**; and the
log was never bound to the current run at all, so a stale file would have
reported YES while the run launched nothing. All three now read their own key
and the log is bound by a pid tag.

**Node 22 cannot `child_process.spawn` a `.cmd`** (`EINVAL`; the CVE-2024-27980
fix demands `shell: true`). PATH here holds only `claude.cmd`, so `resolveCli()`
resolves past the shim to the real `.exe`. **This says nothing about the app** —
sessions spawn via `node-pty`, and `main/transport/win-cmd.ts` handles the shim
for `child_process` callers.

## 8. ⚠️ A probe with `bypassPermissions` reached well past its scratch directory

`probe-discovery.mjs` ran with `--permission-mode bypassPermissions` in a temp
cwd. It answered its question — and then, unprompted, enumerated the machine's
other live Claude Code sessions via `ListAgents`, read `~/.claude/sessions/*.json`
and transcripts under `~/.claude/projects/`, and **sent "status request" messages
to six live sessions** across four unrelated projects.

Nothing destructive happened (reads, plus messages). The lesson is the one
review had already flagged about the scratch directory, and it is bigger than
the filesystem: **a cwd is not a sandbox, and it contains file writes at best —
not agent-to-agent tooling, not reads of the user's home directory.** The real
containment is not giving the turn a permission or a reason to act.
`probe-deadturn.mjs` was written accordingly: no tools needed, so
`--permission-mode default` and a four-character answer.

Anything in E11 that runs a headless pass over a transcript (#766's `claude -p`
variant, and E13's dispatch) inherits this exact question.

---

## What this changes

**Nothing needs re-planning** — #762 and #763 were written against assumptions
that all held. Concrete edits, made on the issues:

| item | change |
|---|---|
| #762 | **Answer `initialize` before anything blocking** — a silent server costs the session ~32 s (§5). Hand-roll rather than take the SDK, with three caveats named (§4). Electron-as-node is **unproven**, only its mechanism is (§3). Do not encode `ENOENT` as the dead-host error shape — that is a Windows named-pipe fact. |
| #763 | Done-when is assertable **without a model**, as a local `check:*` script and **not in CI** (#182) (§1). Decide whether a `dynamic`-scoped bus is shown or filtered in the MCP manager (§1). `--strict-mcp-config` eviction now measured (§2). |
| #764, #765 | **Correction issued:** the bus **is** discoverable; the earlier "not discoverable" comment was wrong. Tool names are `mcp__<server>__<tool>`; schemas are deferred, so tool *descriptions* do the discovery work (§6). |
| #766 | New: a headless `claude -p` pass inherits §8's containment question. |

## What is NOT proven

> **Four of these were closed by #762 (2026-09-08)** and are marked ✅ below
> rather than deleted — the list is a record of what this probe measured, and
> silently editing it would lose the fact that these were once open. Anything
> still unmarked is still open.

- ✅ **CLOSED by #762.** ~~**Windows only.** The unix-domain-socket path in
  `pipe-host.mjs` is written and never executed.~~ `npm run check:bus` runs on
  the Linux runner in CI, so the socket path — bind, chmod, unlink, restart —
  now executes on every PR. The dead-host error shape is no longer a Windows
  fact either: `pipe-client.ts` branches on no errno at all, and
  `pipe-client.test.ts` pins `ENOENT`/`ECONNREFUSED`/`EACCES`/`ECONNRESET` to
  one condition with one message.
- ✅ **CLOSED by #762.** ~~**Electron-as-node is unmeasured** (§3) — only that
  an `env` block arrives.~~ Measured directly: `ELECTRON_RUN_AS_NODE=1
  electron.exe <app.asar>/child.js` runs AND reads siblings inside the archive,
  while plain `node` on the same path is `MODULE_NOT_FOUND`. That inverted the
  decision — Electron-as-node is the bus's **primary** launcher, not a fallback,
  because a rollup entry lives inside `app.asar` when packaged.
- **One pre-existing server, in one scope** (§2). Nothing about `.mcp.json`
  project servers, `user`/`enterprise`/`managed` scopes, or claude.ai connectors.
- **Whether `mcp_toggle` can reach a `--mcp-config` server** (§1).
- ⚠️ **Partly closed by #762.** ~~**One bus server, one session, one call.**~~
  Concurrent calls, repeated calls, two sessions side by side, and teardown →
  re-register are all covered by `host-channel.test.ts`. **Still open: a
  long-running session, and resume** — nothing here has run for hours or
  survived a `--resume`.
- **`ping` is implemented but was never called by any client** (§4).
- ✅ **CLOSED by #762.** ~~**No auth on the pipe.**~~ Per-session 32-byte token
  in a 0600 file, path on argv and never the token (S-03), compared with
  `timingSafeEqual`, and the host resolves the caller from the token rather than
  from the child's `--session` argument.
