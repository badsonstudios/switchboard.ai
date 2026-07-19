# Spike 01 — Foundations

**Goal:** prove the three load-bearing mechanisms of the entire design — PTY
hosting, hook round-trips, transcript tailing — in a throwaway harness, and
retire open questions #2, #3, #5, #10 (+ evidence toward #13). Everything in
Phase 1 is assembly on top of what this spike proves.

**Not the goal:** product code. The harness is disposable; findings are the
deliverable. Copy patterns forward, not files.

**Timebox:** ~2 weekends. If an item busts its box, that itself is a finding.

**Harness shape:** minimal Electron app (one window, no real UI design) with
xterm.js + node-pty + a Node "orchestrator" module — the real stack in
miniature, because the point is to test the real stack on Windows first.

---

## Work items

### S-01 · PTY-host the real CLI — Size M
Spawn `claude` under ConPTY via node-pty with cwd = a test project; render in
xterm.js; keyboard passthrough.
**Done when:** a full interactive Claude Code session (slash commands, permission
prompts, plan mode, TUI redraws, resize) is usable inside the harness window on
Windows with no visual corruption; findings note covers scrollback behavior and
anything ConPTY-quirky.

### S-02 · Settings injection at spawn — Size S · (OQ #2)
Attach our hook config via `--settings` flag (or the least-invasive alternative)
WITHOUT writing into the project's `.claude/` files.
**Done when:** hooks fire in a project whose `.claude/` we never touched, AND the
user's own existing settings still apply (composition verified); findings state
the exact mechanism Phase 1 should use.

### S-03 · Hook round-trip & decision semantics — Size L · (OQ #10, the gate)
HookListener on loopback (per-session token, per §5.29 floor). PreToolUse fires
on an Edit → harness holds the response while a human decides → returns
allow / deny / ask.
**Done when:** a decision matrix documents — for allow, deny, ask, and timeout —
exactly what the CLI does, including: whether deny can carry a feedback message,
whether "don't ask again" is expressible, real timeout budget under
human-in-the-loop delay, and whether the TUI fallback engages cleanly on
timeout. Verdict line: approval surfaces use HOOK PATH or KEYSTROKE FALLBACK.

### S-04 · Transcript discovery & live tailing — Size M · (OQ #3)
From a spawned session, locate its JSONL transcript; tail it live; parse
defensively (tolerant reader per §5.26): status transitions, token usage per
message, tool calls, file paths touched.
**Done when:** harness shows a live status line + running token count for the
session, derived purely from the transcript, surviving malformed/unknown lines
without crashing; findings record discovery mechanism (cwd-slug mapping) and
lag between CLI event and transcript line (measured).

### S-05 · Sidechain / subagent visibility — Size M · (OQ #5, + #13 evidence)
Drive a session that spawns a Task subagent; observe how sidechains appear in
the transcript; attempt live extraction of subagent identity, current tool, and
completion. Also probe: is TodoWrite/plan state extractable (OQ #13)?
**Done when:** findings state what watcher windows CAN reliably show (fields +
latency + interleaving behavior) and whether plan-chip extraction is viable or
degrades to static task labels.

### S-06 · Notification/Stop hooks → status events — Size S
Wire Notification + Stop + SubagentStop hooks through the listener; map to
status transitions (working / needs-input / needs-permission / done).
**Done when:** the harness status line flips states correctly through a real
work-approve-finish cycle driven only by hook events (no transcript polling for
status), including timing notes (how fast after the TUI shows a prompt does the
hook arrive?).

### S-07 · Concurrency & perf probe — Size M · (roadmap perf spike)
Run 8–12 concurrent PTY sessions + tailers in the harness; measure idle CPU,
per-session memory, and UI responsiveness; test a hard scrollback cap.
**Done when:** numbers are recorded for 8 and 12 sessions (idle + one actively
streaming); verdict on whether S6/S7 principles hold on the real stack or need
mitigation (render throttling for hidden panes, scrollback cap value).

### S-08 · Findings report & design updates — Size S
**Done when:** `docs/plans/spike-01-findings.md` exists; OQ #2/#3/#5/#10 are
marked resolved-or-reframed in DESIGN.md with verdicts; Phase 1 plan is
adjusted where findings contradict assumptions; go/no-go stated for each
mechanism.

---

## Exit criteria (the spike is done when)
1. All four target OQs have verdicts written into DESIGN.md.
2. The approval-path decision (hook vs keystroke) is made.
3. Perf numbers for 12 sessions exist.
4. Phase 1 plan reviewed against findings and re-sequenced if needed.

## Dependencies / order
S-01 first (everything needs a running session). Then S-02 → S-03 (hooks need
injection) and S-04 → S-05 (sidechains need tailing) in parallel tracks.
S-06 after S-02. S-07 after S-01+S-04. S-08 last.
