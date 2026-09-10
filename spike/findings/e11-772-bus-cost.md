# E11 / #772 — What a bus read costs the host: findings

**Issue:** #772 · **Probes:** `spike/probes/772/` · **Measured:** 2026-09-10,
Windows 11, i9-13900K (32 threads), Node 22.20.0 and Electron 43.1.1 (as node),
git 2.51.0.windows.2, `claude` 2.1.261 on PATH. **Cost:** no turns.

**Verdict in one line: the two deadlines #764 guessed were fine; the real
problems were a burst of *synchronous* reads freezing Electron main in one
block, and a `git diff` that was writing into the sibling's repository.**

---

## The questions

| # | question | answer |
|---|---|---|
| Q1 | What does one `get_session_output` cost the main thread? | **12–17 ms** for any transcript over 4 MB (Node; 9–14 under Electron), ~80% `JSON.parse`. Set by the 4 MB window, not the file |
| Q2 | What does a burst do? | **16 at once → one 184–186 ms stall.** Not sixteen small ones |
| Q3 | Does repository size drive diff cost? | **Barely.** 100,000 files, clean tree: 88 ms. *Diff* size drives it |
| Q4 | Do the 12 s / 15 s deadlines hold? | **Yes.** Worst answerable diff ≈ 2 s; 16 concurrent 9 MB diffs ≈ 3.7 s each |
| Q5 | How much concurrency can one session produce? | One agent loop: **none** — our tools lack `readOnlyHint`. Parallel subagents: some |
| Q6 | Does the bus's diff touch the sibling's repo? | ⚠️ **Yes — porcelain `git diff` rewrites `.git/index`.** `GIT_OPTIONAL_LOCKS=0` does not stop it |
| Q7 | Does a timeout-kill actually end git on Windows? | ⚠️ **Not through the launcher.** `execFile`'s `timeout` kills `cmd\git.exe` and the real git runs on — the first probe said otherwise and was wrong (§5). A tree kill does end it |
| Q8 | Can the sibling's repo config make our read run a command? | ⚠️ **Yes** — `core.fsmonitor` and clean filters, in the bus diff AND the git pane. **#776** |

---

## 1. The transcript read: cheap per call, set by the window, parsed not read

`readTranscriptTail` reads the last 4 MB (`HISTORY_TAIL_BYTES`, sized for the
Feed's 1,000-block hydration) and parses up to 5,000 lines. `sessionOutput`
then keeps twenty blocks.

| transcript | Node: read + parse | `sessionOutput(20)` | Electron: `sessionOutput(20)` |
|---|---|---|---|
| 33.2 MB (1,330 entries in window) | 11.6 ms | 12.6 ms | 11.0 ms |
| 5.8–8.0 MB (5 files) | 11.2–14.5 ms | 12.2–17.3 ms | 8.7–13.8 ms |
| 2.0 MB | 6.0 ms | 7.0 ms | 5.1 ms |
| 1.0 MB | 3.2 ms | 3.6 ms | 2.9 ms |
| 0.25 MB | 0.9 ms | 0.9 ms | 0.7 ms |

- **Disk is ~1.4 ms of it.** The rest is `JSON.parse` and derivation. Moving
  the *read* to `fs.promises` would buy almost nothing.
- **The 5,000-line cap never bound** on any of 8,961 real transcripts (max 2,663
  entries in a 4 MB window). Bytes are the budget that matters.
- **23 of this machine's 8,961 transcripts exceed 4 MB**, so the ceiling cost is
  the ordinary cost for any long-lived session.
- **This is a fast desktop.** The laptop in #719 is several times slower; treat
  these as floors.

## 2. A burst is ONE stall — and a counter would never have seen it

Part C: a real `BusHost`, a separate client process dialling N connections in
one tick, a 1 ms heartbeat in the host (idle floor on Windows: 16.5–16.8 ms).

| before #772 | latency min / median / max | host's longest gap |
|---|---|---|
| `get_session_output` × 1 | 15 / 15 / 15 ms | 15 ms (floor) |
| × 4 | 14 / 37 / 50 ms | 38 ms |
| × 16 | 15 / 110 / 196 ms | **184 ms** |
| `get_session_diff` × 16 (9 MB diffs) | 3.6 / 3.7 / 3.7 **s** | 37 ms |

**Why one block:** libuv runs every ready socket's `data` callback in a single
poll phase, and each one ran its synchronous read to completion before the next.
The consequence for the design is the important part — **a per-endpoint
in-flight counter measured from arrival to reply would never pass 1** for this
op, because each request takes its slot, does all its work and releases it
inside its own callback. A bound built that way would have sat on top of the
184 ms stall looking like a fix. The shipped bound yields one turn
(`setImmediate`) before doing any work, so every request that arrived in the
same turn is counted first and the excess is refused.

Diffs, by contrast, never stall the loop (git runs in its own process); they
cost wall time and processes.

## 3. git: diff size, not repository size

Synthetic repos, 40-line files, "dirty" = every line of N files changed
(~2.5 KB of diff each). Porcelain `git diff HEAD`, as #764 shipped:

| files | dirty | diff | `GitService.diff` |
|---|---|---|---|
| 2,000 | 0 | — | 68 ms |
| 20,000 | 0 | — | 66 ms |
| 100,000 | 0 | — | 84 ms |
| 100,000 | 40 | 0.08 MB | 94 ms |
| 100,000 | 800 | 1.76 MB | 205 ms |
| 20,000 / 100,000 | 4,000 | 9.1 MB | 618 / 693 ms |
| 20,000 / 100,000 | 14,500 | ~36 MB | **2.0 s, then `maxBuffer`** (throws, as #764 made it) |

- The two `rev-parse` probes cost ~20 ms each — process spawn on Windows.
- **#764's single data point (97 KB → ~370 ms) was pessimistic, not
  optimistic.** 12 s is six times the slowest diff that can be answered at all.
- Building the 100,000-file repo took 579 s; the git side barely noticed its
  size, which is Git for Windows' `core.fscache` doing its job.

## 4. ⚠️ Porcelain `git diff` writes the sibling's index

`probe-locks.mjs`: commit twenty files, rewrite ten of them with identical bytes
(new mtime, same content — what a formatter or editor leaves), change one.

| command | output | `.git/index` |
|---|---|---|
| `git diff --no-textconv --no-ext-diff HEAD` (what #764 shipped) | 119 chars | **rewritten** — the lock was taken |
| same, `GIT_OPTIONAL_LOCKS=0` | 119 chars | **still rewritten** |
| `git diff-index -p --no-textconv --no-ext-diff HEAD` | 119 chars, **byte-identical** | untouched |
| staged `git mv`: porcelain / `diff-index -p` / `diff-index -p -M` | 107 / 1,668 / 107 chars | — `-M` matches porcelain exactly |

Two consequences, one live and one latent:

1. **Live:** while a sibling read this session's changes, this session's own
   `git add` / `commit` could fail with `index.lock: File exists`. The bus
   reaching into another agent's work and breaking it.
2. **Latent:** #772 wanted to kill runaway diffs. Killed mid-refresh, porcelain
   leaves `index.lock` behind and every later git command in that repo fails
   until a human deletes it.

`GIT_OPTIONAL_LOCKS=0` is documented as the switch for background readers and
is what IDEs set — **it covers `status`, not `diff`'s refresh.** Measured, not
assumed; the documentation would have been wrong for us.

**Shipped:** `diff-index -p -M --no-color --no-textconv --no-ext-diff`.
(`--no-color` is belt and braces: plumbing ignores `color.ui=always` already —
also measured.)

**The price, measured:** with every file touched and none changed, plumbing
re-reads them on *every* call, where porcelain paid once and then cached:

| files, all touched | plumbing × 3 | porcelain × 3 | plumbing after porcelain's refresh |
|---|---|---|---|
| 2,000 | 535 / 514 / 513 ms | **493** / 25 / 23 ms | 21 ms |
| 20,000 | 2.44 / 2.49 / 2.45 s | **2.04 s** / 27 / 28 ms | 26 ms |

It is transient — any `git status` refreshes the index, and the git pane polls
`status` against every session folder — but a 100,000-file repo in that state
could exceed the 10 s budget below and be reported as "git did not finish".
That refusal is true; accepted.

## 5. ⚠️ A timeout kill does NOT end git through the launcher — a tree kill does

**This section was wrong in the first draft, and review caught it.**

Which `git` the app runs matters: an app started from Explorer inherits the
machine PATH, which carries `Git\cmd` — **`cmd\git.exe`, a launcher** that
starts the real `mingw64\bin\git.exe` as a child. `mingw64\bin` comes first only
inside Git Bash, which is where every probe here ran.

The first `probe-kill.mjs` hung git on `hash-object --stdin`, killed it with
`execFile`'s `timeout`, and counted survivors: **0 for both binaries**
(positive-controlled — it saw 1 and 2 processes while they hung). True, and
**for the wrong reason**: when the launcher dies its stdin pipe closes, and a
git blocked on stdin reads EOF and exits by itself. A git stuck on a slow disk
is not reading stdin. Redone with a git busy on something else (an alias
running `sleep`):

| binary | while running | after `execFile`'s kill | after a tree kill |
|---|---|---|---|
| `mingw64\bin\git.exe` | 1 | **0** | 0 |
| `cmd\git.exe` (the launcher) | 2 | ⚠️ **1 — the real git survives** | **0** |

(`probe-kill-tree.ts` is the second column's fix measured through the real
`GitService` against the real launcher: 2 → 0.)

**Shipped:** `GitService` runs its own timer and, on Windows, ends the whole
tree with `taskkill /pid <pid> /T /F` (the same call `mcp-attach-check.ts`
already makes). POSIX has no launcher; `kill` ends git, though not anything git
itself started — an fsmonitor hook or clean filter, which is #776's subject.

Combined with §4 (plumbing takes no lock), killing is safe — so
`GitService.diff` has a 10 s budget across its three calls and kills git past
it. That sits *inside* the host's 12 s: the model is told "git did not finish"
rather than "switchboard gave up", and the work is actually over when the
answer is sent.

**And a kill is not the end of the wait (review, round 2).** Replacing
`execFile`'s `timeout` with our own timer dropped something it did quietly:
**closing our end of stdout and stderr** before killing. `execFile` answers only
once both pipes close, and anything git started that inherited them — a hook, a
filter, an orphan outside the tree — holds them open after git is gone. The
reviewer measured a descendant holding the pipe for 3 s turning an 800 ms budget
into a 3.2 s wait. The timer now closes the pipes itself; a git that had
already exited gets a 250 ms grace first, so a finished answer still drains.

**The unit test's first version could not catch this either**, for a third
reason: its fake launcher was a Node process, and Node on Windows puts every
child in a job object that dies with its parent — so the fake launcher took its
child down unaided and the test passed against the very mutant it existed for.
The fake grandchild is now `detached`, which is the real launcher's shape.

## 6. One agent loop is serial; concurrency is subagents

From the PATH binary (2.1.261), the MCP tool wrapper:

```
isConcurrencySafe(){return v.annotations?.readOnlyHint??!1},
isReadOnly(){return v.annotations?.readOnlyHint??!1}
```

Our bus tools declare no annotations, so the CLI runs them one at a time within
one agent loop. Same-endpoint concurrency comes from parallel subagents sharing
their parent's MCP connection, a retry after the child gave up while the host
still worked, or another process holding the token. That is what sized the
bound at **4**.

(Declaring `readOnlyHint` on the read tools would let one loop fan out — and
would also mark them read-only to the permission layer. Not done here; it is a
behaviour change for the agent, not a bound.)

## 7. ⚠️ Repo config can make our read run a command (#776)

`probe-config-exec.mjs`, a stat-dirty file in each case:

| repo config | bus `diff-index` | git pane `status` |
|---|---|---|
| `core.fsmonitor = <cmd>` | **ran it** | **ran it** |
| clean filter (`filter.x.clean = <cmd>` + `.gitattributes`) | **ran it** | **ran it** |
| `-c core.fsmonitor=false` added | not run | — |

Same class as the `diff.external` hole #764 closed. Out of #772's scope, and it
lives in the git pane too — **filed as #776** with what is known about fixing it.

---

## What #772 shipped, against these numbers

| change | measured effect |
|---|---|
| Transcript read: 256 KB first, then **one** read at the old 4 MB budget if short | `sessionOutput(20)`: 12–17 ms → **1.1–1.3 ms** (Node), 0.9–1.2 ms (Electron). `sessionOutput(200)`: unchanged ±1 ms (12.7–17.4 ms) |
| Per-endpoint in-flight bound of 4 (`list_sessions` exempt), refused not queued, one-turn yield before work, slot held until the work settles or the 24 s backstop writes it off | 16-burst: host's longest gap **184 ms → 16 ms** (the timer floor); 4–5 admitted, the rest refused with a readable reason. (Five, not four, when a straggler's connection arrives a turn later — after an earlier slot was already given back. The bound is on what runs at once, and that never exceeded four.) |
| `git diff` → `git diff-index -p -M`, 10 s budget, tree kill | Sibling's index untouched; same output; a runaway git — launcher and real binary — ends at 10 s |
| `truncated` now reports a byte window that stopped short of the file's start | A transcript whose last 4 MB held fewer blocks than asked for used to come back as complete |

**Two window designs were tried and measured before the shipped one** (see the
`after-ladder` artifact): a 256 KB → 1 MB → 4 MB ladder made `lastN: 200`
slower (→ 17–21 ms), and a blocks-per-byte estimate made the largest real
transcript slower (13 → 29 ms, three reads — its older entries were denser).
"Small, then the old budget" is the only one whose worst case can be stated.

## What was deliberately NOT built

- **A worker thread for the transcript read.** The window change removes ~90%
  of the default path's work; a worker adds a bundle entry, a lifecycle and
  its own failure modes to save the remaining ~1 ms.
- **A host-wide cap across endpoints.** Ten sessions each at one in-flight
  default read is ~12 ms now. Revisit if the blackboard (E12) adds traffic.
- **A rate limit.** Legitimate callers are paced by the model — a tool call is
  seconds apart. Anything able to loop faster holds the token, i.e. runs as
  this user, and can read the transcripts straight off disk; throttling it
  protects nothing.

## What is NOT proven

- **Linux and macOS.** Every number here is Windows. The unit tests for the
  bound run on Linux CI; the costs do not.
- **The laptop.** #719's machine is the one where main-thread time hurts, and it
  was not measured. The shape of every table holds; the absolute numbers are a
  fast desktop's.
- **Cold cache.** No admin rights to flush the OS file cache; "first" columns are
  as cold as a first sibling's call gets, not truly cold.
- **A real hung filesystem.** The kill is proven against a git busy in
  userspace, not one stuck in the kernel on a dead network share — where
  `TerminateProcess` can itself be delayed. That case is why the in-flight slot
  has a ceiling: past the 24 s socket backstop it is written off with an error
  logged, rather than held for the life of the session.
