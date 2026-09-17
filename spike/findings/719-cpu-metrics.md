# 719 — what Electron's per-process CPU metric means on Windows

**Probe:** `spike/probes/719/` (`node spike/probes/719/run.mjs [s] [burners] [sampleMs]`)
**Measured:** 2026-09-17, dev desktop, Windows 11, Electron 43.1.1, 32 logical
cores (i9-13900K). Method and raw numbers in the probe's README.

## Why this was measured rather than assumed

#719 (the app pegs the owner's laptop CPU) has **no local repro** — three
occurrences, all on the laptop, none on this desktop. The agreed approach is
to ship instrumentation and let the next occurrence name its own burner, which
means the instrument gets **one chance to be right**. Electron's own typing
says of `CPUUsage.cumulativeCPUUsage` "Will always return 0 on Windows"
(`node_modules/electron/electron.d.ts:7359`), and Windows is the target — enough
doubt to justify measuring the field the whole feature rests on.

The probe creates a **known** burner (renderers in hard infinite loops) so the
metric can be checked for attribution, not merely for plausibility. A number
that is non-zero but points at the wrong process would still have passed a
smoke test while being useless for the one job it has.

## The finding that mattered

**`percentCPUUsage` is a share of the WHOLE MACHINE, not of one core.**

| burners (pegged cores) | observed | `N/32` predicts | ratio |
|---|---|---|---|
| 1 | 3.1% | 3.125% | 1.00 |
| 2 | 6.2% | 6.25% | 0.99 |
| 4 | 12.4% | 12.5% | 1.00 |

Linear, and dead-on at three points. **One fully pegged core reads 3.1% here.**

**Consequence, and the reason this note exists:** any threshold chosen by eye on
a 32-core desktop is wrong by a factor of the core count on a laptop. "Warn
above 50%" would require *sixteen* pegged cores on this machine and would never
fire on the laptop the ticket is about — and the single capture from occurrence
4 would show an apparently idle app. Anything reading these numbers must
normalise by core count, and the core count must be **in the log line** so a
reader never has to infer the unit.

## The rest

- **Attribution is correct.** The burning renderers read high; the main
  (`Browser`) process reads 0.0% throughout. So the heartbeat can genuinely
  answer "which process is burning" — main vs renderer vs GPU vs utility — which
  is exactly the question the owner was being asked to answer by hand from Task
  Manager while his mouse would barely move.
- **A sample averages the interval.** At a 10-second gap the burners still read
  their full 6.2% (mean ratio 0.99). A once-a-minute beat is therefore a true
  one-minute average and cannot miss a sustained burn between beats. The
  **first** call after start always returns 0.0% — nothing to diff against yet,
  so the first line of any capture is expected to read idle and means nothing.
- **`cumulativeCPUUsage` is NOT always zero on Windows** via `getAppMetrics` in
  Electron 43, contradicting the caveat in Electron's own typing. Recorded
  because the typing is what a future reader will check first. `percentCPUUsage`
  is what the heartbeat uses regardless.
- **The instrument is cheap:** `getAppMetrics()` costs ≤0.9 ms on the main
  thread.
- **Event-loop lag idles at ~4-16 ms** on Windows, where timer resolution is
  ~15.6 ms. That ~16 ms *is the floor*, not a symptom — a lag threshold has to
  sit well above it or every idle machine reports as stalled.

## What this does not tell us

Nothing here explains #719. It establishes that the instrument about to be
shipped reports real, correctly-attributed numbers in a unit we can state. The
burner itself is still unidentified, and the laptop remains the only machine
that has ever shown the fault.
