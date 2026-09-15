# Probe 807 — token totals vs the CLI's ledger

`probe-ledger.mjs` reconciles per-session token totals, under several counting
rules, against the CLI's own `cost-state.modelUsage`.

Read-only over `~/.claude/projects` (`PROBE_ROOT` overrides); spawns nothing.

```bash
node spike/probes/807/probe-ledger.mjs > report.json 2> summary.txt
```

Findings: `spike/findings/e11-807-usage-ledger.md`.
