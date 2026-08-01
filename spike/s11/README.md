# S-11 — the six unmeasured stream-json items

Phase 0 of the transport migration, not a gate on deciding it (that decision is
made — PROGRESS.md "START HERE"). Discovering a pipe deadlocks at hour three is
cheap now and brutal after fourteen files have been rewritten.

Order is deliberate and is **not** the order S-10 §3 lists them in:

1. **Long-run stability** — probe 1, below. First, and left running, because
   every S-09/S-10 probe was a SINGLE TURN and the product is 8 sessions on open
   pipes for 8 hours. If this is bad, nothing else matters.
2. Plan mode + `ExitPlanMode`, then `AskUserQuestion` — the CHOOSERS, which
   decide whether the terminal stays as an escape hatch.
3. Sidechains from `parent_tool_use_id`, `interrupt` semantics, the `/resume` ·
   `/rewind` · `--from-pr` pickers.

## Probe 1 — long-run stability

```
node start-longrun.cjs     # detached; survives the session that launched it
node status.cjs            # read the live summary, safe at any time
node stop.cjs              # SIGTERM — verdicts are computed on the way out
```

Artifacts land in `../findings/artifacts/s11/`: `longrun-summary.json` (rewritten
every sample, so it is readable mid-run and survives a kill),
`longrun-events.ndjson`, `longrun-stdout.log`.

Knobs, all env vars: `S11_DURATION_MS` (default 8h) · `S11_HEARTBEAT_MS` (20m) ·
`S11_SAMPLE_MS` (5m) · `S11_BACKPRESSURE_AT_MS` (3m) · `S11_PAUSE_MS` (2m) ·
`S11_MIN_UNREAD` (150 KB) · `S11_OUT` · `SB_CLAUDE`.

It answers four questions:

| | |
|---|---|
| **Q1 backpressure** | Stop draining stdout mid-turn. Does the CLI block, die, drop messages, or wedge? Does it recover? Is a message written to a BLOCKED CLI queued or lost? |
| **Q2 survival** | Does the process live through hours of idle? `keep_alive` cadence? |
| **Q3 drift** | Child RSS, host RSS, turn latency over time |
| **Q4 context cost** | `result.usage` per turn — does an 8-hour conversation get expensive, hit a limit, or auto-compact? |

### Read this before trusting a Q1 result

**The first smoke run reported `RECOVERED` and had proved nothing.** A 5k-token
answer is only ~90 KB of stdout, and Node's 64 KB `readableHighWaterMark` plus
the OS pipe buffer absorbed all of it — the CLI was never blocked, so pausing
our reader tested nothing. The probe now measures how many bytes were actually
waiting when reading resumed and reports **INCONCLUSIVE** below
`S11_MIN_UNREAD`, because a probe that cannot fail is worse than no probe: it
gets counted.

Same reason the wedge watchdog tests *progress*, not *completion* — a 358 KB
drain legitimately took 111 s longer than the old completion-based watchdog
allowed, and it cried wolf over a healthy session.

Token spend is deliberately small: ~25 one-word heartbeat turns plus one chatty
turn sized to fill the pipe. **Do not re-run the S-09/S-10 probes** — they spend
real subscription tokens and their outputs are transcribed in the findings notes.

If a CLI contract is unclear, read `docs/reference-implementations.md` before
guessing.
