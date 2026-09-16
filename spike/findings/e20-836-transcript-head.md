# E20 / #836 — what one bounded transcript HEAD read can answer

**Measured 2026-09-16**, `claude` 2.1.272, owner's machine, against the real
`~/.claude/projects` (3,037 transcripts at the time of the probe). Probe:
`.claude/work_files/probe-836.js` (read-only; it opens transcripts and never
writes into `~/.claude/`).

## The question

The session-history picker needs two facts per row that `listConversations`
does not answer: **which folder** a conversation belongs to, and **a short
description** a person can recognise. The design (§5.33) assumed the
description would come from `ai-title` with a first-prompt fallback. What was
NOT known is how much of each file has to be read to get either — the fixture
header in `transcripts/fixtures/ai-title.ts` records first titles as late as
line 510 in three captured transcripts, which would have made a head-only read
unsafe and forced a second, tail-end pass.

So: over the **200 most recently written** transcripts, read only the first
`PACKAGE_HEAD_BYTES` (128 KB) and ask what is in there.

## Results

| fact | present in the 128 KB head | position |
|---|---|---|
| `cwd` (folder attribution) | **200 / 200** | first carried at line **2.0** on average |
| `ai-title` | **192 / 200** | the **last** one never later than line **18** |
| a real first user prompt | **200 / 200** | — |
| **neither** a title nor a prompt | **0 / 200** | — |

Two further findings:

- **Not one sampled transcript carried more than one `ai-title` line.** The
  "titles are revised, first ≠ last" note in the fixture header is not visible
  in this sample. Taking the last title in the window is therefore a statement
  about the *contract* (a revised title is one the CLI changed its mind about),
  not a behaviour the data currently exercises.
- Of the 8 transcripts with no title in the head, **3 have an `ai-title`
  somewhere past the window** (found by scanning those files whole) and 5 have
  none at all. All 8 have a first prompt, so all 8 are described.

## What this decided

- **One head read per row, no tail read, no second pass.** Both facts come out
  of the same window, so the per-row cost is one bounded read and the feature's
  whole cost centre is that number times the row cap.
- **The expensive path is the rare one.** Deriving blocks to find the first
  prompt only happens for the 8/200 without a title; the other 96% take the
  cheap branch.
- **Folder attribution reads the transcript's own `cwd`.** It is present
  everywhere and it is the only correct source: the directory name is
  `slugForCwd`'s output, which maps `\ / : . ` and space all onto `-` and cannot
  be inverted back into a path. Reading `cwd` is also what makes a conversation
  started *outside* switchboard listable at all.
- **A first line is often metadata.** The first JSONL line is frequently
  `last-prompt`, `queue-operation` or `mode`, carrying no `cwd` — which is why
  the scan walks the window's entries rather than reading line 1 and stopping.

## What the scan actually COSTS, and what it can actually SEE

**Measured 2026-09-16** (added after the #836 code review asked for the one
number the first pass never took). Probe:
`.claude/work_files/probe-836-timing.js`, which mirrors `everyProject()` +
`describe()` against the real root. Warm cache, owner's desktop.

| head budget | directory walk | 300-row read | total | bytes read | titles found |
|---|---|---|---|---|---|
| **128 KB** (`PACKAGE_HEAD_BYTES`) | 9 ms | 53 ms | **62 ms** | 14.6 MB | 26 / 150 |
| 32 KB | 7 ms | 16 ms | 23 ms | 4.1 MB | 18 / 150 |
| 8 KB | 7 ms | 7 ms | 14 ms | 1.1 MB | 2 / 150 |

**Decision: keep the shared 128 KB budget.** 62 ms for a whole-machine scan is
comfortably inside the bar, and the cheaper budgets are not free — 32 KB buys
~40 ms and loses **8 of 26 titles** (31%), 8 KB loses all but two. Those rows do
not go blank (they fall back to their first prompt) but they stop being
described the way the CLI describes them, which is the feature. The measured
answer is therefore the opposite of the review's hypothesis, and the hypothesis
was reasonable: the title is early in a *recently written* transcript, but this
population is the long tail, where it is not.

### The 500-entry cap barely bites, and where it does it is right

| | |
|---|---|
| project directories under the root | **59** |
| transcripts across all of them | **3,037** |
| directories past `MAX_LISTED_CONVERSATIONS` (refused) | **1** |
| transcripts inside that one directory | **2,887** |

The single refused directory is `C--Projects-BrainHarbor-artifacts-pipeline` —
a machine-generated pipeline, not a folder anyone holds a conversation in. Every
directory that IS one is far below the cap: switchboard.ai **42**, BrainHarbor
**30**, ClaudeMon **8**, Ashenfall **6**.

Two things follow, and they are why the numbers are recorded here rather than
just used:

- **The all-projects scan sees 150 transcripts, not 3,037** (3,037 − 2,887), and
  the 62 ms above is over those 150. A machine whose big directory were a real
  project would pay more — but it would also be refused, and say so.
- **Respecting the cap (rather than bypassing it, which §5.33 and the issue both
  forbid) costs the user nothing here.** The worry it invites — "my busiest
  project is exactly the one that will be refused" — is not true on this machine:
  conversation counts per real project are two orders of magnitude below the cap.
  If that ever changes, the fix is a newest-N listing for big folders, not a
  bigger cap.

## Note against the issue's own numbers

Issue #836 records `ai-title` at **196/200**; this probe reads **192/200 within
the head**, and 195/200 counting the three that sit past it. The difference is
a different 200 (the machine gained transcripts between the two samples) and a
different question (in-window vs anywhere in the file), not a contradiction.
`summary` was re-confirmed as a non-source and nothing is built on it.
