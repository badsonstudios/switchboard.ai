# E11 #807 — our token totals against the CLI's own ledger

**Date:** 2026-09-15 · **CLI:** transcripts from 2.1.2xx through 2.1.270 ·
**Probe:** `spike/probes/807/probe-ledger.mjs` (read-only, spawns nothing)

## 1. The ticket's premise was measured against the wrong reader

#807 was filed from #787's probe: "our" totals under-counted the CLI's ledger,
`input` by up to 600×, because subagent transcripts are separate files. The
measurement was real, but the thing measured was **#787's probe**, which summed
each file on its own — the parent transcript only — and de-duped.

The watcher never had that shape. `absorb()` adds usage from every file it
tails, subagent files included (`watcher.test.ts` "subagent tokens counted" has
pinned that since S-05). What it did not do is de-dupe. So on a live card the
error ran the **other way**.

## 2. Measurement

27 parent transcripts carry a `cost-state` line; 25 have a non-empty ledger
(the other two are #790 probe sessions with no spend), and 23 have a
`subagents/` directory. For each, our rules against the CLI's
`cost-state.modelUsage`, restricted to lines between the ledger's `startTime`
and the `cost-state` line (the process run the ledger describes). Ratios are
ours ÷ CLI:

| rule | input | output | cacheRead | cacheCreate |
|---|---|---|---|---|
| parent only, first copy (#787's probe) | 0.002–0.96 | 0.59–0.88 | 0.87–0.99 | 0.44–0.89 |
| **parent + subagents, every copy (the watcher until now)** | **0.003–4.9** | **1.5–7.5** | **1.5–4.3** | **1.9–5.8** |
| parent + subagents, first copy per response | 0.002–1.013 | 0.63–0.88 | 0.98–1.011 | 0.99–1.011 |
| parent + subagents, **latest copy** per response | **0.002–1.013** | **0.97–1.00** | **0.98–1.011** | **0.99–1.011** |

The low `input` tail is the Haiku side-query row (§4); the Opus row alone is
exact in those sessions. 21 of 25 sessions read exactly 1.0000 on input,
cacheRead and cacheCreate under the latest-copy rule.

Corpus-wide, over 265,463 lines / 79,490 usage lines / 41,641 responses:

- **0** usage lines without `message.id`.
- **24,496** responses written more than once.
- the ONLY field that differs between copies is `output_tokens` — **12,057**
  responses — plus `output_tokens_details.thinking_tokens` (8,976); **all** in
  `subagents/agent-*.jsonl` files, none in a parent transcript.
- **0** copies decrease. **0** responses have copies in two files.
- **0** response ids with two different `requestId`s; **16** with none.
- copies need not be adjacent: in the fixture, a response's third copy arrives
  after a `tool_result` line.

## 3. The rule

One contribution per **`message.id`**; **a later copy replaces** the earlier one
(subtract old, add new — O(1) per line, so live tailing is unaffected).
`src/main/transcripts/usage-ledger.ts`.

- **Not `message.id:requestId`** (the key §5.13 inherited from ClaudeMon, and
  the one #787's probe used). `requestId` never separated two responses in the
  corpus, and a response whose copies disagreed on having one would have split
  into two keys and counted twice. Found in review.
- **Latest, not max.** They agree on every real transcript (nothing
  decreases). Latest is what the CLI's own accumulator does — `SPo` adds the
  FINAL response usage once per API call — and a test pins it so the rule is
  one rule.
- **Lifetime = the snapshot's.** Recreated in `resetBinding`: a continued or
  forked conversation can carry message ids into a new file, and a ledger that
  survived the reset would net the rebuilt totals to zero. (That ids carry over
  is plausible, not measured — `continued-in` has 0 occurrences in the corpus.
  The reset is right either way.)

## 4. What does not reconcile, and why

- **Side queries the CLI bills and writes nowhere.** Six BrainHarbor sessions
  show `input` at 0.002–0.04. Per model, the `claude-opus-5` row matches exactly
  (e.g. 744 / 744); the CLI's ledger also holds a `claude-haiku-4-5` row (42k–281k
  input) that appears in no transcript file. Irreducible from transcripts.
- **`Switchboard-ai/28120e67…` reads HIGH: input 1.0126, cacheRead 1.011,
  cacheCreate 1.011.** So our totals are NOT a guaranteed floor, and no doc may
  say "never high". Not chased — likely a response written inside the
  `startTime` window that the CLI attributed to a previous run.
- **`Switchboard-ai/03b73d50…` reads input 0.984, cacheRead 0.98** — a few
  lines outside the window. Not chased.
- **output 0.97–0.99** on a handful of sessions, with input and cache exact —
  consistent with a response whose final copy was never written (interrupted
  stream). Not chased.

## 5. Not measured: resumed conversations

The watcher replays a resumed conversation's file from byte 0, so the card's
total covers every run. The probe compares against the CURRENT run's ledger,
and in this corpus "all lines" and "this run" were identical for every file
with a non-empty ledger — the only files with two `cost-state` lines have empty
ledgers. The CLI binary reads `cost-state` back as a last-wins entry on load,
which suggests it restores its totals on resume (keeping the two comparable),
but that is a reading of the code, not a measurement.

## 6. What would falsify this

| observation | what it would mean |
|---|---|
| a usage line with no `message.id` in a current transcript | the unkeyed path (adds every line) starts over-counting again |
| a response whose copies DECREASE | "latest" and "max" diverge; re-measure against the ledger |
| one `message.id` reused for two different responses | keying on the id alone under-counts; `requestId` would be needed after all |
| a response's copies in two files | fine as keyed (session-wide); a per-file key would double it |
| `message.id` renamed | every copy counts again. The drift detector reports an unknown key either way — moving `id` to `consumed` documents the dependency, it does not change detection (`drift.ts` treats both lists as known) |
| input/cache ratios drift from 1.0 with no Haiku row | a new copy shape; re-run the probe |

## 7. Reproducing

```bash
node spike/probes/807/probe-ledger.mjs > report.json 2> summary.txt
```

`PROBE_ROOT` overrides the corpus location. Nothing is spawned, so there are no
background sessions to clean up.
