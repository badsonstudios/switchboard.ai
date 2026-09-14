# Probe 787 — when does the CLI write `cost-state`, and is its number usable?

`probe-cost-state.mjs` walks every `.jsonl` under `~/.claude/projects` and, for
each transcript carrying a `cost-state` line, records:

- **where the line sits** — `linesAfterLastCostState` is the question the whole
  probe exists for. A non-zero value anywhere would mean the CLI writes these
  mid-conversation and the number is usable live. It is **0 in 22 of 22**.
- how many there are per file, and whether `totalCostUSD` is monotonic across
  them (they are `last-wins`; a pair is real and must never be summed);
- which keys the line actually carries, and whether it has a `timestamp` /
  `uuid` (it has neither — only `sessionId`);
- **our estimate against the CLI's own figure**, using the same rate table
  `renderer/src/lib/usage.ts` ships, so the comparison is against what the app
  really showed rather than an idealised version of it.

Read-only. Spawns no `claude` process, so it leaves no background sessions.

```bash
node spike/probes/787/probe-cost-state.mjs > report.json 2> summary.txt
PROBE_ROOT=/some/other/corpus node spike/probes/787/probe-cost-state.mjs
```

Findings: `spike/findings/e11-787-cost-state.md`.

Note the probe **de-duplicates** token usage on `messageId:requestId` while the
app's watcher does not; that makes its estimate a best case for us, and the
2.4× Opus over-count in the findings is therefore a floor on the error, not a
ceiling.
