# Probe 719 — what `app.getAppMetrics()` actually reports on Windows

`main.cjs` runs a real Electron app with N renderers in **hard infinite loops**
and compares `app.getAppMetrics()` against a known number of pegged cores.

```bash
node spike/probes/719/run.mjs [seconds] [burners] [sampleMs]
node spike/probes/719/run.mjs 12 4        # 4 pegged cores, 1s sampling
node spike/probes/719/run.mjs 32 2 10000  # 2 pegged cores, 10s sampling
```

Spawns only its own Electron and its own burner windows, destroys them, and
quits. Touches no project state and no `claude` session.

`run.mjs` exists because the `check:*` family goes through
`scripts/run-electron-node.js`, which sets `ELECTRON_RUN_AS_NODE=1` — and under
that flag there is no `app` module at all, so it cannot host this probe.

Two details that would otherwise have faked the result: the burners set
`backgroundThrottling: false` and are **shown**, because Chromium throttles
hidden renderers hard and a throttled burner would have made the metric look
like it under-reports; and the windows are `destroy()`ed rather than `close()`d,
because a renderer in an infinite loop never runs a beforeunload handler.

## Why measure at all

#719 ships a CPU heartbeat to a machine we cannot reproduce on, so it has **one
chance to be right**. Electron's own typing says of `cumulativeCPUUsage` "Will
always return 0 on Windows" (`node_modules/electron/electron.d.ts:7359`) and the
target machine is a Windows laptop — enough doubt to justify measuring the
field the whole feature rests on rather than trusting it.

## Findings — 2026-09-17, dev desktop, Electron 43.1.1

32 logical cores (i9-13900K), Windows 11.

| # | question | answer |
|---|---|---|
| 1 | `percentCPUUsage` non-zero on Windows? | **Yes** — stable and usable |
| 2 | Does it attribute correctly? | **Yes** — burning renderers read high, `Browser` (main) reads 0.0% |
| 3 | `cumulativeCPUUsage` always 0 on Windows? | **No** — non-zero here. The typing's caveat does not hold for this field via `getAppMetrics` in Electron 43 |
| 4 | **What is 100?** | **Share of the WHOLE MACHINE** |
| 5 | What does one sample cover? | **An average over the whole interval since the last call** |

### 4 is the finding that would have broken the item

| burners (pegged cores) | observed total | `N/32` predicts | ratio |
|---|---|---|---|
| 1 | 3.1% | 3.125% | 1.00 |
| 2 | 6.2% | 6.25% | 0.99 |
| 4 | 12.4% | 12.5% | 1.00 |

**A fully pegged core reads 3.1% on this box.** A threshold picked by eye on
this machine — "warn over 50%" — would never fire on the laptop #719 is about,
and the one capture from the next occurrence would read as an idle machine.
So the heartbeat logs the core-normalised figure (`percent * cores`, "cores'
worth of CPU") **and** the core count alongside the raw share.

### 5 was the other design input

At a **10-second** sampling gap the burners still read their full 6.2% (mean
ratio 0.99), so a sample is an average across the gap, not an instantaneous
reading. A once-a-minute heartbeat therefore reports a true one-minute average
and cannot miss a sustained burn between beats. (The **first** call after start
always returns 0.0% — there is nothing to diff against yet.)

### Baselines, so the gauges are readable

- **Event-loop lag idles at ~4-16 ms.** Windows timer resolution is ~15.6 ms,
  so ~16 ms *is* the floor, not a symptom. A lag threshold must sit well above it.
- **`getAppMetrics()` costs ≤0.9 ms** on the main thread — cheap enough to call
  on a timer without the instrument becoming a burner itself.
