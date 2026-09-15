# Probe 793 — hook arrival order after `/clear`

Two probes, one per transport. Both time hook POST arrival at a local receiver
on one clock, for the hook events switchboard listens to, and report whether
the first hook carrying the NEW conversation id is the tagged
`SessionStart source:'clear'`.

| probe | transport | why |
|---|---|---|
| `probe-clear-order.mjs` | **Direct mode**: stream-json flags, stdout frames (`conversation_reset`, `system:init`, `result`) timed too | the CLI awaits SessionStart(clear) here; measures the margin |
| `probe-clear-order-pty.cjs` | **Terminal mode**: interactive TUI in node-pty, typed with the app's "text, CR 75 ms later" pattern | the CLI DEFERS SessionStart(clear) here, and there is no stream init to fall back on |

Scenarios (`SCENARIOS`, `TRIALS` each, default 5):

- **A** — `say ok`, wait for the turn, then `/clear` alone
- **B** — `say ok`, wait, then `/clear` and **immediately** `say ok`
- **C** — `/clear` as the first input
- **G** (PTY only, optional) — a background shell still running across `/clear`.
  Needs a Bash permission grant in the TUI; the probe passes no permission flag,
  so a prompt may block it, and the timeline shows that.

```bash
TRIALS=5 node spike/probes/793/probe-clear-order.mjs > direct.json 2> direct.txt
SCENARIOS=B TRIALS=10 node spike/probes/793/probe-clear-order-pty.cjs > pty.json 2> pty.txt
```

A trial only counts when `observed=true`: the tagged hook was seen (and, in
Direct mode, the init), with no unparseable hook bodies.

**Costs real turns** (`say ok` only). Neither uses `--bg`. Confirm with
`claude agents --json` before and after anyway.

**The PTY probe copies `.claude.json` and `.credentials.json` into a temp
HOME** (a trusted temp project needs them). They are unlinked by name, retried,
and any survivor is printed as `!! CLEANUP`. Sweep `%TEMP%\sb793pty-*` if a run
is killed mid-trial.

Findings: `spike/findings/e11-793-clear-hook-order.md`.
