# Spike 01 harness

Throwaway harness for Spike 01 (see `docs/plans/01-spike-foundations.md`).
Findings notes in `findings/` are the real deliverable — don't polish this code.

## Run

```bash
cd spike
npm install
npm run rebuild   # rebuilds node-pty against Electron's ABI (required once)
npm start         # opens the harness window hosting a claude session
npm run smoke     # headless-ish spawn check: PASS/FAIL + first-byte latency
```

Session cwd defaults to `.claude/work_files/test-project/` (created on first
run). Override with `SPIKE_CWD=<path>`. Override the spawn command with
`CLAUDE_CMD=<path-to-exe>`. Pass extra CLI args (e.g. `--settings <file>`,
see S-02) with `SPIKE_CLAUDE_ARGS="..."`.

## S-02 settings-injection probes

`bash spike/s02/run-probes.sh` — self-contained PASS/FAIL check that
`--settings` injection fires hooks without touching the target project's
`.claude/`. Findings: `findings/s-02-settings-injection.md`.

## S-03 hook round-trip probes

`bash spike/s03/run-scenarios.sh` — headless decision matrix (allow/deny/ask/
hang/longhold) + §5.29 security negative tests. `bash spike/s03/run-interactive.sh
ask|hang` — scripted real-TUI scenarios via node-pty (run under electron.exe
with ELECTRON_RUN_AS_NODE=1). Findings: `findings/s-03-hook-roundtrip.md`.

## S-06 status-hook probes

`bash spike/s06/run-status.sh` — hook-only status cycle (SessionStart/
UserPromptSubmit/Notification/SubagentStop/Stop → status line);
`S06_ANSWER_DELAY_MS=90000` variant probes the Notification debounce.
Findings: `findings/s-06-status-hooks.md`.

## S-04 / S-05 transcript probes

`bash spike/s04/run-tail.sh` — transcript discovery + live tail (status line,
tokens, lag); `node spike/s04/malformed-test.js <outdir>` — tolerant-reader
test. `bash spike/s05/run-sidechain.sh` — subagent/sidechain visibility +
TodoWrite plan extraction. Findings: `findings/s-04-transcript-tailing.md`,
`findings/s-05-sidechain-visibility.md`.

## S-01 interactive verification checklist

Run `npm start` and drive a real session. Every box must hold with no visual
corruption:

- [ ] Session starts; trust prompt / welcome TUI renders correctly
- [ ] Type a prompt; streamed response renders cleanly
- [ ] `/help` and one other slash command (menu overlay draws + clears)
- [ ] Trigger a permission prompt (e.g. ask it to run a command); arrow keys +
      Enter select; prompt clears cleanly
- [ ] Shift+Tab cycles modes (plan mode on/off); Esc interrupts a response
- [ ] Ctrl+C behavior (interrupt, then exit on double-press)
- [ ] Resize the window aggressively mid-render — TUI reflows, no torn frames
      after settle
- [ ] Scroll back during/after output; note what scrollback actually contains
- [ ] Exit (`/exit`) — clean exit message; relaunch works
