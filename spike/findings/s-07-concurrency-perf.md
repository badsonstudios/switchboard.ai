# S-07 — Concurrency & perf probe

> **Re-measured on the shipped app 2026-08-10 (P2-E15-14, #111).** The verdict
> below still holds — by a wider margin than it claimed. Two of the numbers in
> this original section are measurement artifacts of the harness and should not
> be quoted: see **Real-app re-measure** at the bottom.

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

---

# Real-app re-measure — 2026-08-10 (P2-E15-14, #111, AR-P2-11)

**Verdict: the S-07 conclusions hold on the shipped app, and every headline
number got better, not worse.** 12 real `claude` sessions in switchboard.ai
v0.3.0 (`191255d`) — dockview, Monaco, live FeedView streaming, per-card git
polling and the slash-command scanner all running — cost **9.5 % of one core at
idle** and never stalled the renderer for more than **16.1 ms**, including a
phase with **all 12 sessions streaming a real model turn at once**. The
7–8-session workflow E9 is about to declare primary is not close to a limit on
this machine: the binding cost is still CLI memory (~330 MB/session in Direct
mode, ~372 MB in PTY mode), exactly as S-07 said.

**Tested:** switchboard.ai v0.3.0 @ `191255d`, Windows 11, i9-13900K
32-core / 64 GB, over an **RDP session**, 2026-08-10. Three runs, all with the
app window **maximized, focused and `setAlwaysOnTop`** for the entire
measurement — the S-07 occlusion trap, closed by construction:

| Run | Transport | What | Real turns |
|---|---|---|---|
| A | Direct (stream-json, the shipped default) | idle + 1-session stream at N=8 and N=12, then a 12-way concurrent burst | **14** |
| B | PTY (`SWITCHBOARD_TRANSPORT=pty`) | idle at N=8 and N=12 — the apples-to-apples comparison with the harness, which measured the TUI | 0 |
| C | Direct | N=12 idle, then diff panes (Monaco) opened on 4 and on all 12 sessions | 0 |

Driver: `spike/s07/real-app-driver.mjs` (Playwright drives the built `out/`;
sessions are created through the real "+ session" button with the folder dialog
stubbed; prompts go through `sessions.submitPrompt`, the same bridge call the
composer makes). Each session gets its own **git repo with a dirty worktree**, so
per-card git polling has real work. Reports:
`spike/findings/artifacts/s07/real-app-2026-08-10/`.

## Numbers (whole process tree, rooted at the Electron main pid)

CPU is **% of one core**. Medians are quoted first because a per-sample CPU delta
is a noisy statistic and the harness's own means were skewed by one outlier
(see *Two corrections* below); means are in parentheses.

| Metric | harness N=8 | **real N=8** | harness N=12 | **real N=12** |
|---|---|---|---|---|
| Idle CPU, Direct | 29.9 % med (7.6 mean†) | **7.9 % (8.4)** | 24.0 % med (27.8 mean†) | **9.5 % (11.0)** |
| Idle CPU, PTY/TUI | ″ | **7.1 % (7.1)** | ″ | **5.5 % (7.6)** |
| Streaming CPU, 1 session (med / peak) | 28.0 / 63.4 % | **10.6 / 34.3 %** | 36.3 / 68.0 % | **8.8 / 26.7 %** |
| Total working set, idle — PTY | 3.47 GB | **3.53 GB** | 5.03 GB | **5.06 GB** |
| Total working set, idle — Direct | — | **3.09 GB** | — | **4.46 GB** |
| Per-session working set (total ÷ N), PTY | ~433 MB | **442 MB** | ~419 MB | **422 MB** |
| Per-session working set (total ÷ N), Direct | — | **386 MB** | — | **371 MB** |
| Renderer max event-loop stall | 15 ms | **15.5 ms** | 939 ms ‡ | **15.8 ms** |
| Renderer stalls > 50 ms | 0 | **0** | — ‡ | **0** |

† harness mean, not trustworthy — see below.  ‡ the documented occlusion artifact.

**The app's own footprint is flat in N.** Broken out (Direct, idle):

| | N=8 | N=12 | 12 + all streaming | 12 + 12 diff panes open |
|---|---|---|---|---|
| main | 102 MB | 104 MB | 104 MB | 103 MB |
| renderer | 135 MB | 145 MB | 163 MB | 177 MB |
| GPU | 115 MB | 118 MB | 120 MB | 131 MB |
| utility | 45 MB | 46 MB | 46 MB | 46 MB |
| **Electron total** | **397 MB** | **413 MB** | **433 MB** | **457 MB** |
| CLI processes | 2.62 GB | 3.94 GB | 4.08 GB | 3.94 GB |
| App-side CPU (of one core) | 3.0 % | 2.9 % | 4.2 % | 2.7 % |

Adding four sessions costs the app 16 MB and no measurable CPU. Everything else
is the CLI.

## The load case S-07 never ran: 12 concurrent real turns

All 12 sessions were prompted 1 s apart and streamed their answers back through
12 live FeedViews at once (12 real turns, the item's whole token budget):

- tree CPU **15.3 % median, 36.1 % p95, 86.8 % peak** of one core (49 samples
  over 153 s) — on a 4-core laptop the peak would be ~22 % of the machine;
- renderer max stall **15.7 ms**, zero ticks over 50 ms, working set +17 MB;
- **jump latency 48.9 ms avg / 56.7 ms max** — statistically the same as at idle
  (45.2 ms / 51.5 ms). Switching sessions does not get slower under full load;
- all 12 sessions reached `done`; 12 transcript `.jsonl` files were written, so
  the transcript tailer was exercised, not idle.

Across the three runs the renderer's 100 ms timer was sampled **10,131 times**
(~17 minutes of ticks). The worst drift in any phase of any run was **16.1 ms**.

## Monaco (run C, zero turns)

Opening a diff pane on 4, then on all 12 sessions:

| | 12 idle | +4 diff panes | +12 diff panes |
|---|---|---|---|
| renderer | 139.6 MB | 166.2 MB | 177.0 MB |
| GPU | 115 MB | 129.2 MB | 131.0 MB |
| max stall | 14.9 ms | 15.8 ms | 15.2 ms |
| jump latency avg | 45.8 ms | 45.0 ms | 41.9 ms |

**Monaco is not 12 Monacos.** dockview mounts only the *active* panel, so with 12
diff panes open exactly **one** `.monaco-diff-editor` exists in the DOM at a
time (measured: the driver's "wait for the k-th editor" check timed out on
panes 2–12 for precisely this reason). The first diff pane costs ~27 MB of
renderer and ~14 MB of GPU; the other eleven cost ~11 MB *between them*. The
9 MB bundle is a one-time load, and S-07's design conclusion #1 — hidden panes
don't render — turns out to hold for diff panes as well as terminals.

## Two corrections to the harness numbers

Both are measurement bugs in `spike/s07/multi-main.js`, not product regressions,
and they are why the real app looks *cheaper* than the harness:

1. **The harness sampled itself.** `sampleTree()` was called from the probe's own
   main process, so every 2 s a `powershell.exe` was spawned as a **child of the
   measured root** and swept into the tree by the parent-walk. Its CPU landed in
   the "idle" figure, and its cost grows with tree size (the walk is O(procs²)),
   which is most of why N=12 looked 3.6× N=8. The fingerprint is in the raw
   samples: `nProcs` reads 30 with one sample at 32 (N=8) and 42 with one at 44
   (N=12). This driver spawns its sampler from the *parent* of Electron, so it is
   a sibling of the measured tree and excluded.
2. **The published idle means are skewed by a single negative sample.** When
   those transient children exit between two samples, total CPU-seconds *falls*
   and the delta goes negative: −418.1 % at N=8 and −122.9 % at N=12. The N=8
   "7.6 %" is that one value dragging fifteen samples averaging ~30 % down.
   Medians of the same data: **29.9 % (N=8), 24.0 % (N=12)** — i.e. the harness's
   idle cost was roughly *flat* in N, and mostly its own sampler.

Read the harness table as an upper bound, not a measurement. Nothing built on it
was wrong: it over-stated the cost, and the design conclusions still stand.

## Regressions

**None.** Every metric the harness measured is equal or better on the shipped
app, at both tiers, with all the subsystems AR-P2-11 named in the picture. Two
things are worth watching, neither a regression:

- **PTY main-process memory scales with N** — 156 MB at 8 sessions, 181 MB at 12
  (~6 MB/session), against Direct's flat 102–104 MB. That is `PtyService`'s
  per-session scrollback ring, i.e. the cost S-07 conclusion #1 deliberately
  chose. At 20 PTY sessions it extrapolates to ~230 MB of main. It is the only
  in-app number in the whole sweep that grows with session count.
- **Renderer working set climbs with UI surface**, 135 MB → 177 MB from
  "8 sessions idle" to "12 sessions with 12 diff panes open". Flat within each
  phase (no leak visible over a 17-minute run), but it is the number to re-check
  when E9 puts more per-session UI on screen.

## Limitations (read before quoting these numbers)

- **RDP.** The compositor pinned the renderer to **30.6 fps in every phase of
  every run**, so paint-side regressions are invisible here and the jump/input
  latency metrics (measured click → second painted frame) have a ~33 ms
  frame-quantisation floor. They can show *degradation under load* — they did
  not — but they are not absolute latency figures.
- **Token-bounded activity: 14 real turns**, all in run A (2 single-session
  streams + one 12-way burst of "count to 200"). No tool use, no approvals, no
  file edits, no sustained multi-hour streaming. A tool-heavy session is a
  different CPU profile that this budget could not buy.
- **PTY numbers are idle-only.** Streaming 12 TUI sessions would have cost
  another 12 turns; the harness's TUI streaming figures are therefore compared
  against *Direct* streaming, not like-for-like.
- **Synthetic projects.** Twelve freshly-`git init`ed folders with a two-line
  dirty diff, no `CLAUDE.md`, no MCP servers, no history. Per-card git polling
  and the slash-command scanner see far less work here than in a monorepo.
- **Isolated home.** Credentials are copied into a temp `HOME` (and deleted with
  it), as the real-claude e2e lane does. Transcripts *were* written (12 files),
  so the tailer was live, but MCP servers and user-level settings were not.
- **Not a quiet machine, strictly.** Dan's own switchboard instance (4 processes,
  3 idle `claude` sessions) and the Claude Code CLI running this item shared the
  32-core box. Both are outside the measured tree; on CPU headroom they are
  noise, but they are not nothing.
- Sampling cadence is ~3.5 s (PowerShell spawn + 1.5 s sleep), 20–49 samples per
  phase, phases of 60–153 s.

## Re-running

```bash
cd .claude/work_files   # or anywhere; the driver resolves the repo root itself
node <repo>/spike/s07/real-app-driver.mjs --tag=real-stream --transport=stream \
  --tiers=8,12 --prompts=1 --burst=1 --idle=120000 --stream=60000 --burstms=150000
# ^ this one SPENDS 14 real model turns. The two below spend none:
node <repo>/spike/s07/real-app-driver.mjs --tag=real-pty --transport=pty \
  --tiers=8,12 --prompts=0 --burst=0
node <repo>/spike/s07/real-app-driver.mjs --tag=real-monaco --tiers=12 \
  --prompts=0 --burst=0 --monaco=1
node <repo>/spike/s07/real-app-analyze.mjs report-real-stream.json
# --fake=1 dry-runs the whole harness on the fake provider (no CLI, no tokens)
```

`npm run build` first — the driver launches `out/`, not the dev server. Hold the
e2e lock (`C:\tmp\switchboard-e2e.lock`) while measuring, and do not touch the
mouse: the window is always-on-top, but a foreground app that steals focus still
changes what you are measuring.

