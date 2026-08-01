# S-11 probe 1 — does a stream-json pipe survive a working day?

**Date:** 2026-08-01 · **CLI:** claude 2.1.220 (Dan's PATH install, Max
subscription) · **Duration:** 8h 00m, uninterrupted · **Model:**
claude-opus-5[1m]

**Verdict: PASS, with no qualifications.** The pipe survived eight hours, 25
turns and a deliberate 2-minute stall without a single framing error, a memory
leak, or a latency drift. **The #112/#117-class deadlock we were most afraid of
did not reproduce.**

Artifacts: `spike/findings/artifacts/s11/` (`longrun-summary.json`,
`longrun-events.ndjson`, `longrun-stdout.log`). Harness: `spike/s11/`.

---

## Why this probe existed, and why it ran FIRST

S-10 listed long-run stability sixth of six unmeasured items. It was moved to
first because **every probe until then had been a SINGLE TURN**, and the actual
product is eight sessions holding open pipes for eight hours. A PTY is a
well-understood long-lived object; an NDJSON pipe with a bidirectional control
channel is not, and unhandled stdout backpressure deadlocks a busy session —
the bug class that cost weeks each in #112 and #117.

The reasoning was: **if this is bad, nothing else matters.** It is not bad.

---

## The headline numbers

| Measure | Result |
|---|---|
| Survived | **28,801,980 ms — the full 8h, still alive at shutdown** |
| Turns | **25 sent, 25 completed** |
| stdout | 546,770 bytes / **832 lines / 0 parse failures** |
| Child RSS | 367.8 MB → **302.3 MB** (went *down*, then flat from ~2h) |
| Host RSS | 31.1 MB → 34.6 MB over 8h |
| Heartbeat latency | 2700 ms → 2749 ms, **median 2016 ms** — no drift |
| `keep_alive` | **0** |
| Compactions | 0 |
| Processes per session | 3, constant (cmd.exe → claude.cmd → node) |

Message types seen: `stream_event` ×719, `assistant` ×27, `system:init` ×26,
`system:status` ×26, `result:success` ×26, `system:thinking_tokens` ×5,
`rate_limit_event` ×3.

---

## Q1 — Backpressure: RECOVERED, and the test was real this time

We stopped draining stdout for **120 seconds** in the middle of a turn
deliberately sized to produce a lot of output (print 12,000 integers).

- **359,003 bytes piled up behind us and arrived intact** when we resumed.
- **0 parse failures** — the framing was not corrupted by the stall.
- The turn **completed**, with its full 35,492-token output.
- The process never died.
- **A message written to the CLI *while it was blocked* was queued, not lost** —
  it was answered 143,998 ms after we resumed reading.

⇒ **The CLI blocks on a full pipe and recovers. It does not wedge, and it does
not corrupt framing.**

> **The first smoke run of this probe reported RECOVERED and had proved
> nothing.** A 5k-token answer is only ~90 KB of stdout, and Node's 64 KB
> `readableHighWaterMark` plus the OS pipe buffer swallowed all of it — the CLI
> was never blocked, so pausing our reader tested nothing. The probe now
> measures the bytes actually waiting at resume and reports **INCONCLUSIVE**
> below 150 KB; this run recorded `filledBuffers: true`.
>
> *Same lesson as #107's test-that-could-not-fail: it is worse than no test,
> because it gets counted.* **Any future probe of this shape must state how it
> filled the buffer.**

## Q2 — Survival and `keep_alive`: alive, and there is no cadence

The child was alive at the 8-hour mark and was still answering turns. It was
shut down by us, not by anything going wrong.

**`keep_alive` count: 0.** Not "rare" — *none*, in eight hours, across 25 turns
and gaps of up to 20 minutes.

⇒ **Nothing may be built on a `keep_alive` cadence.** It is in the protocol and
the VS Code extension knows the type, but it did not arrive once here. A liveness
design that waits for one would wait for ever. (`stream-status.ts` carries this
caveat at the point of use.)

## Q3 — Memory and latency: no drift

Child RSS *fell* from 367.8 MB to ~302 MB within the first two hours and stayed
there (±2 MB) for the remaining six. Host RSS rose 3.5 MB over eight hours,
which is our own bookkeeping and is not a leak worth chasing.

Heartbeat latency showed no trend: the first was 2700 ms, the last 2749 ms, the
median 2016 ms, with occasional 4-second outliers scattered throughout rather
than clustering late.

**The cost number the product has to live with: ~300 MB per idle-ish session, in
3 processes.** Eight concurrent sessions is therefore **~2.4 GB of CLI** before
switchboard's own footprint. Not a blocker; a number nobody had. **#111's
concurrency re-measure inherits it.**

## Q4 — Context cost: `input` lies, `cacheRead` is the truth

`cacheRead` grew 25,951 → 73,461 over the run. `input` stayed at **2** for every
single turn.

⇒ **A usage display that reads `input` alone would report a long conversation as
costing nothing.** The real growth is in the cache-read column.

Zero compactions in eight hours, so nothing here says anything about how a
compaction behaves mid-stream — that remains unmeasured.

---

## Incidental findings that changed code

1. **`system:init` is emitted ONCE PER TURN, not once per session.** 26 inits
   for 25 turns (the extra is the queued backpressure message, which became its
   own turn on resume). A host treating `init` as a session-start event
   re-initialises on every turn — and it is the obvious reading of the name.
   **Pinned by tests in P2-E18-05 and P2-E18-09.**
2. **`init` arrives ~10–20 ms AFTER our own send, never at spawn.** From the
   event log: spawn ms=14, our prompt ms=2026, init ms=2048; the same ordering
   on every later turn (+6 ms, +11 ms). **The CLI emits NOTHING at spawn.** So a
   stream session has no readiness signal of its own, and readiness has to come
   from the spawn succeeding. **This decided P2-E18-05's design**; reasoning by
   analogy with `SessionStart` would have left a stream session on `starting`
   until the user typed.
3. **`system:thinking_tokens` appeared — a type S-10 never saw.** Five of them.
   Our mapper lists the types it understands and returns null for everything
   else rather than defaulting, so it was absorbed with no transition and no
   warning. That posture is now evidenced rather than merely argued.
4. **`rate_limit_event` reports `five_hour`, `status: allowed`,
   `apiKeySource: none`** — the subscription-first constraint holds over a long
   run, not just a probe.

## What this probe does NOT say

- **Nothing about compaction mid-stream** (0 occurred).
- **Nothing about concurrency** — this was ONE session. Eight pipes at once is
  #111.
- **Nothing about the choosers.** Plan mode + `ExitPlanMode`, `AskUserQuestion`,
  sidechains from `parent_tool_use_id`, `interrupt` semantics, and the
  `/resume` · `/rewind` · `--from-pr` pickers are all still unmeasured. Those
  are S-11 probes 2–6, and **they are what decides whether the terminal stays as
  an escape hatch** (E18-16).
- **Nothing about hooks under `--permission-prompt-tool stdio`.** This probe ran
  no hooks. Whether the CLI still fires `PreToolUse` in stream mode is unknown,
  and P2-E18-07 guards against both answers rather than assuming one.

## Consequence for the plan

Probe 1 was the gate that could have stopped the migration. It did not.
**E18-01…E18-08b shipped against this evidence.** The remaining probes gate
**E18-11…E18-16**, which stay unfiled until they run.
