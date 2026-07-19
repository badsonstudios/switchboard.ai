# S-07 — Concurrency & perf probe

**Verdict: S6/S7 principles hold on the real stack without mitigation.** 8 and
12 concurrent claude PTY sessions + transcript tailers are comfortably cheap
on CPU; memory is dominated by the claude CLI itself (~420–435MB/session),
which is a capacity-planning fact, not a harness problem. No render throttling
needed for hidden panes **because hidden panes shouldn't render at all** —
ingest-only costs almost nothing.

**Tested:** Claude Code CLI 2.1.215, Windows 11, 32-core / 64GB machine,
2026-07-19. Probe: `spike/s07/` (multi-session Electron harness, one rendered
xterm pane with scrollback 5000, N−1 ingest-only sessions, one recursive
transcript tailer, PowerShell process-tree sampler every 2s). Full reports:
`spike/findings/artifacts/s07/`.

## Numbers (whole process tree: Electron + N claude + ConPTY hosts)

| Metric | N=8 | N=12 |
|---|---|---|
| Idle CPU (avg, % of one core) | **7.6%** | **27.8%** (~2.3%/session) |
| Streaming CPU (1 session active; avg / peak) | 33% / 63% | 38% / 68% |
| Total working set (idle) | 3.47 GB | 5.03 GB |
| Per-session working set | ~433 MB | ~419 MB |
| Renderer max event-loop stall | **15ms** (98s monitored) | 939ms — **artifact, see below** |
| Tailer parse errors | 0 | 0 |

- CPU percentages are of a **single core**; on this 32-core machine, 12 idle
  sessions cost <1% of total machine. Even on a 8-core laptop, ~28% of one
  core idle is acceptable.
- **The N=12 jank number is measurement artifact, not load:** Electron
  throttles timers in occluded windows to ~1s ticks; 939ms ≈ the 900ms drift
  a throttled 100ms timer shows, and the monitor stopped advancing when the
  probe window fell behind other windows mid-run. The unoccluded N=8 run —
  same streaming load — never exceeded 15ms. Product note: measure UI
  responsiveness only on focused/visible windows, and expect background
  windows to be timer-throttled by design.
- Streaming one active session raised tree CPU by ~25pp of one core —
  budget-wise, several simultaneously streaming sessions are fine.

## Design conclusions (S6 perf / S7 scrollback)

1. **Hidden panes: don't render, just ingest.** N−1 sessions had their PTY
   bytes counted and dropped at ~zero cost. Phase 1 should keep hidden
   sessions' PTY data in a ring buffer (for scrollback on focus) and only
   attach an xterm to the visible pane(s). Render throttling of hidden panes
   is moot — there's nothing to throttle.
2. **Scrollback cap 5000 held**: rendered pane stayed stable through
   streaming; total memory flat across the stream phase (Δ < 20MB tree-wide).
3. **The real capacity cost is the CLI**: ~420MB × N sessions of working set.
   12 sessions ≈ 5GB. switchboard should surface per-session memory in the
   UI (dogfooding note) but can't reduce it.
4. **Transcript note:** a session creates its `.jsonl` on the first prompt,
   not at spawn — idle sessions produced no transcript files (11 idle
   sessions → 0 new files; the tailer tracked the 1 active one). Session
   binding at spawn must therefore tolerate a transcript that doesn't exist
   yet (S-04's poll-for-new-file does).
5. Spawn burst: 12 sessions staggered 400ms apart spawned cleanly (all 12
   reached the TUI); teardown kills left no orphans (exit codes 1 /
   0xC000013A on kill are normal ConPTY teardown).

## Re-running

```bash
cd spike
env -u ELECTRON_RUN_AS_NODE SPIKE_N=8  ./node_modules/electron/dist/electron.exe s07/multi-main.js
env -u ELECTRON_RUN_AS_NODE SPIKE_N=12 ./node_modules/electron/dist/electron.exe s07/multi-main.js
# keep the probe window visible/unoccluded for a valid jank number
```
