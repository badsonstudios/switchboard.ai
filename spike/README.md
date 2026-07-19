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
`CLAUDE_CMD=<path-to-exe>`.

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
