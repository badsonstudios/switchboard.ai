# Bus read cost probes (#772)

The harnesses behind **`spike/findings/e11-772-bus-cost.md`**. Committed for the
reason `760/` is: the note makes load-bearing claims about cost, git and the
CLI, and a citation into a git-ignored scratch directory dies with the worktree.

Measured 2026-09-10 on **Windows 11**, i9-13900K (32 threads), Node 22.20.0 and
Electron 43.1.1 (as node), git 2.51.0.windows.2. **None of these spend a turn.**

```bash
# the main one — bundled from src/, so it measures the REAL modules
npx esbuild spike/probes/772/probe-cost.ts --bundle --platform=node --format=cjs \
  --outfile=.claude/work_files/probe772.cjs
PROBE_TAG=run node .claude/work_files/probe772.cjs          # ~15 min with the 100k repo
PROBE_TAG=run PROBE_SCALES=2000,20000 node .claude/work_files/probe772.cjs   # ~3 min
PROBE_PARTS=A node .claude/work_files/probe772.cjs          # transcripts only, seconds
ELECTRON_RUN_AS_NODE=1 PROBE_PARTS=A node_modules/electron/dist/electron.exe .claude/work_files/probe772.cjs

node spike/probes/772/probe-locks.mjs        # does our diff write the sibling's index?
node spike/probes/772/probe-kill.mjs         # the WRONG answer, kept as the trap's record (Windows)
npx esbuild spike/probes/772/probe-kill-tree.ts --bundle --platform=node --format=cjs \
  --outfile=.claude/work_files/probe772-tree.cjs && node .claude/work_files/probe772-tree.cjs   # the right one
node spike/probes/772/probe-config-exec.mjs  # can repo config make our read run a command? (#776)
```

Run from the repo root. `PROBE_KEEP=1` keeps the synthetic repos.

## The pieces

| file | what it asks |
|---|---|
| `probe-cost.ts` | **A** — `readTranscriptTail` / `sessionOutput` against this machine's own transcripts, largest first. **B** — `GitService.diff` against synthetic repos (2k / 20k / 100k files) at five dirty states, porcelain beside plumbing, plus the "every file touched, none changed" state. **C** — a real `BusHost` over a real `SessionQueries`, hit with bursts of 1 / 4 / 16 connections from another process, recording the host's longest event-loop gap. |
| `fire.mjs` | The burst client for part C. A separate process on purpose — a client sharing the host's loop would put its own work into the stall being measured. Speaks the wire format raw, so no client deadline hides a slow host. |
| `probe-locks.mjs` | Whether `git diff` rewrites `.git/index` (i.e. takes `index.lock`), whether `GIT_OPTIONAL_LOCKS=0` stops it, and whether `diff-index -p [-M]` matches porcelain's output — including a staged rename. |
| `probe-kill.mjs` | `execFile`'s `timeout` against a git that hangs for ever, through both the real `mingw64\bin\git.exe` and the `cmd\git.exe` launcher. Positive-controlled — and still **wrong**: its git hangs on stdin, which exits by itself when the dead launcher's pipe closes. Kept as the record of the trap; see the next row. |
| `probe-kill-tree.ts` | The correction (#772 review): the REAL `GitService` against the REAL launcher, with a git busy on something other than stdin. Measures the shipped tree kill: 2 processes → 0. Bundle it like `probe-cost.ts`. |
| `probe-config-exec.mjs` | Whether `core.fsmonitor` or a clean filter in the **repo's own config** runs during the bus diff and the git pane's `status`. Filed as #776. |

## Artifacts

`artifacts/*.json` — one file per run, named `<tag>-<runtime>.json`:

| file | what it is |
|---|---|
| `before-node-22.20.0.json` | All three parts against `main` before #772 (100k scale included). |
| `before-electron-43.1.1.json` | Part A under Electron's V8. |
| `after-ladder-node-22.20.0.json` | Parts A/B/C after the change, with an INTERMEDIATE transcript window (a fixed 256 KB → 1 MB → 4 MB ladder) that this run caught making `lastN: 200` slower. **B and C are valid for what shipped; A is not** — see the next two. |
| `after-node-22.20.0.json`, `after-electron-43.1.1.json` | Part A against what shipped (small window, then one read at the old budget). |

## Traps

1. **A counter over a synchronous answer never trips.** The first sketch of the
   bound would have counted `get_session_output` from arrival to reply — and a
   sync answer finishes inside its own `data` event, so the count never passes
   1 while libuv runs every ready socket's `data` back to back. Part C is what
   showed the stall is one block, not sixteen small ones.
2. **"No survivors" needs a positive control — and a control is not enough.**
   `probe-kill`'s first version reported zero survivors for every binary; the
   positive control (count while alive: 1, and 2 through the launcher) made
   that look proven. It was still wrong: the hang was ON STDIN, and closing
   the pipe ended git without any kill. **How a process hangs decides whether
   killing its parent ends it** — review found this, not the probe.
3. **A Node fake is not a launcher.** Node on Windows puts children in a job
   object that dies with the parent, so a fake launcher written in Node kills
   its own child for free. The unit test's grandchild is `detached` for that
   reason; without it the test passed against the mutant it exists for.
4. **Porcelain's refresh hides plumbing's cost.** In the "all touched" state
   plumbing is timed first, because one porcelain `diff` refreshes the index
   and makes everything after it fast.
5. **The Windows timer floor is ~16 ms.** A 1 ms `setInterval` does not fire
   every millisecond there; part C measures an idle baseline first (16.5–16.8
   ms max gap), and any gap at that level is the floor, not a stall.
