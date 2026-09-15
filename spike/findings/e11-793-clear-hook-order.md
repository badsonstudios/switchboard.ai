# E11 #793 — after `/clear`, does the tagged hook land first?

**Date:** 2026-09-15 · **CLI:** 2.1.270 (PATH), Windows 11 ·
**Probes:** `spike/probes/793/probe-clear-order.mjs` (Direct mode, stream-json) and
`spike/probes/793/probe-clear-order-pty.cjs` (Terminal mode, PTY) — real CLI,
40 trials

## 1. The question

Two writers set a session's native id. The hook listener tags `'clear'` only
for `SessionStart source:'clear'`; every other hook carrying a `session_id`
calls the same setter untagged. In Direct mode the stream pump also writes it,
from `system:init`, tagged via the `conversation_reset` latch (#753). **The
first write wins the cause.** `setNativeSessionId` returns early on an
unchanged id before reading the cause, so a late tagged write cannot upgrade an
early untagged one.

#793 asked: after `/clear`, can an untagged hook carrying the NEW id arrive
first? If so, the watcher logs a false mis-bind at warn, and `resetBinding`
skips `conversationStarted = false`, leaving the give-up clock armed on a
conversation that will not write a transcript until the next prompt.

## 2. What the CLI does (read from the binary, 2.1.270)

The clear function ends:

```
if(E){E((e)=>XB(o,"clear",{signal:e,...}).catch(...));return}
let L=await XB(o,"clear",{...})
```

- With `deferSessionStartHooks` (`E`) passed, SessionStart(clear) is
  **queued** and the function returns without awaiting it.
- Without it, the hooks are **awaited inline**.
- **The only caller that passes `deferSessionStartHooks` is the interactive
  TUI host.** Its neighbours include `localJsx`, `toggleDiffPanel` and
  `columns:this._requireHost().columns`. The plan-mode `clearContext` caller
  passes only the release callback.

⚠️ **Corrected in review.** The first write-up of this note, the tag-site
comment and the issue comment all said the deferring caller was the
stream-json host. It is the TUI host. A `this.stream.…` property sits in that
same call's object, which is what misled the first read. Found by the
reviewer, re-verified with a wider grep.

So the two transports are not alike:

| | Direct (stream-json) | Terminal (PTY) |
|---|---|---|
| SessionStart(clear) | awaited before `/clear` returns | queued, released later |
| second writer of the id | stream pump `system:init` (tagged) | **none** |
| exposure to #793 | low, by construction | the real question |

## 3. Measurement

Hook POSTs to a local receiver and (Direct only) stdout frames, timed on one
clock. The hook command was a lean forwarder; see §5. Milliseconds after
`/clear`:

### Direct mode — 15 trials

| scenario | `conversation_reset` | `SessionStart(clear)`, new id | `system:init`, new id | first untagged new-id hook |
|---|---|---|---|---|
| A — `/clear` after a turn | 5–6 | **70–75** | 89–94 | none within 8 s |
| B — `/clear` + immediate prompt | 5–6 | **69–84** | 88–108 | `UserPromptSubmit` 166–189 |
| C — `/clear` as first input | 15–19 | **80–87** | 103–115 | none within 8 s |

15/15 tagged-first, beating the stream init by 17–33 ms. All 5 B trials had a
real competing prompt, which trailed the tagged hook by 82–112 ms.

### Terminal mode — 25 trials

| scenario | trials | `SessionStart(clear)`, new id | untagged new-id hook |
|---|---|---|---|
| A — `/clear` after a turn | 5 | **164–176** | none |
| B — `/clear` + prompt typed 77–80 ms later | 15 | **166–178** | `UserPromptSubmit` 251–266, in 6 of 15 |
| C — `/clear` as first input | 5 | **172–186** | none |

- **25/25 tagged-first.**
- In B the prompt **registered in only 6 of 15** trials. In the other 9 the
  TUI dropped it while `/clear` was still running: no `UserPromptSubmit`, no
  `Stop`, no reply. In the 6 where it registered, it trailed the tagged hook by
  **84–91 ms**.
- The deferred hook lands ~2× later than Direct mode's awaited one (164–186 vs
  69–87 ms), consistent with queue-then-release.
- 0 hooks carried the OLD id after `/clear` in any trial.

## 4. Verdict

**Not observed in 40 trials.**

- **Direct mode: ordered by construction.** The CLI awaits the tagged hook
  before `/clear` returns, and the next message is processed only after that.
  The stream init is a second tagged writer on top.
- **Terminal mode: not observed, not structural.** The hook is deferred, yet
  it has led the only competing untagged writer a prompt can produce by
  84–91 ms every time. A human-typed prompt is far slower than the probe's
  80 ms.

Per the issue's own rule ("if SessionStart always wins, the finding is a
comment, not a change"), the outcome is a comment at the tag site. No behaviour
change. It retires with E18-15, which deletes the hook listener.

## 5. Caveats

- **Lean forwarder.** The probe's hook command skipped the app's token-file
  read (`hook-forwarder.cjs`). In Direct mode that cost cannot reorder anything,
  since the tagged hook is awaited. In Terminal mode it applies to every hook
  equally, so it should not reorder them, but the margin was measured without it.
- One machine, one CLI version.
- The app also registers `PreToolUse`, ingested untagged. It cannot fire before
  the prompt's own `UserPromptSubmit`, because a tool call needs a turn.
- Background tasks surviving `/clear` were **not** measured (§6).

## 6. What would falsify this

| observation | meaning | covered by the probe? |
|---|---|---|
| a CLI release that releases Terminal mode's deferred hooks later (e.g. after the next prompt starts) | the next `UserPromptSubmit` overtakes; Terminal mode has no fallback writer | re-run `probe-clear-order-pty.cjs` scenario B |
| Direct mode starts passing `deferSessionStartHooks` | Direct loses its structural ordering; the stream init still backs the tag up | re-run `probe-clear-order.mjs` |
| the tagged hook LOST, not late (forwarder 3 s timeout, token-file read failure / 401, a stalled main event loop) | the next untagged hook wins. Direct: the pump's latched init covers it. **Terminal: nothing does** | no |
| a background subagent or shell that survives `/clear` (the clear re-parents running tasks and sets `CLAUDE_CODE_SESSION_ID` to the new id) fires `SubagentStop` / `PostToolUse` / `Notification` before the deferred hook lands | untagged new-id write first, Terminal mode especially | **no — unmeasured** (`SCENARIOS=G` exists but needs a Bash permission grant in the TUI) |
| `transcript mis-bind corrected (same-cwd race)` at warn right after a `/clear`, **with no second session in that folder** | the race was reached in the wild (a genuine same-cwd mis-bind logs the same line) | — |

## 7. Reproducing

```bash
TRIALS=5 node spike/probes/793/probe-clear-order.mjs > direct.json 2> direct.txt
SCENARIOS=A,B,C TRIALS=5 node spike/probes/793/probe-clear-order-pty.cjs > pty.json 2> pty.txt
```

Both cost real turns (`say ok` only). Neither uses `--bg`. Check
`claude agents --json` before and after. The PTY probe copies credentials into
a temp HOME and scrubs them by name, retrying and reporting any survivor.
