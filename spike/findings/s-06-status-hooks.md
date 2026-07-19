# S-06 — Notification/Stop hooks → status events

**Verdict: GO — hook events alone drive a correct status line through a real
work → needs-permission → approve → subagent → done cycle**, with one
characterized quirk (permission notifications are debounced ~6s) and one gap
(no event on prompt *acceptance*), both with clean product mitigations.

**Tested:** Claude Code CLI 2.1.215, Windows 11, 2026-07-19. Probe:
`spike/s06/` (status listener reusing the s03 forwarder + scripted TUI session
via `pty-drive.js status`). No transcript polling anywhere in the loop.

## Observed transitions (hook-only, ISO-correlated)

| Event | Status mapped | Timing observed |
|---|---|---|
| `SessionStart` | starting | fires before the TUI is even ready |
| `UserPromptSubmit` | working | ~1.0s after Enter |
| `Notification` (`notification_type:"permission_prompt"`, message "Claude needs your permission") | needs-permission | **6.0s after the TUI prompt rendered** — debounced; a prompt answered within ~2.5s produces NO Notification at all (verified both ways) |
| `SubagentStop` | transient marker | fired when the subagent finished; also fired a second, spurious-looking time right after `Stop` — treat as at-least-once, not exactly-once |
| `Stop` | done | **~30ms** after the reply finished rendering |

## The two design-relevant wrinkles

1. **Permission Notification is debounced (~6s) and skippable.** A fast human
   (or auto-accept) answers before it fires. So Notification is a "user has
   been needed for a while" signal, not a "permission prompt exists" signal.
   For switchboard this is fine: **our own PreToolUse hold IS the
   needs-permission signal** (S-03) — we know the instant approval is wanted
   because we're the ones being asked. Notification then covers only the
   non-tool cases (idle/waiting), where a few seconds of lag is acceptable for
   attention routing.
2. **No event on prompt acceptance** — status stays needs-permission until
   `Stop` (or the next `PreToolUse`/`PostToolUse` if those are hooked). Product
   mapping: clear needs-permission when our PreToolUse round-trip resolves, or
   on any subsequent hook event; hook `PostToolUse` for the crisp
   "working again" edge if wanted.

## Mechanics

- Status hooks must ack instantly: listener responds `200 {}` immediately,
  hook exits, CLI never waits. With `"timeout": 10` on every status hook, a
  dead/wedged listener costs at most 10s once (fail-open posture from S-03
  holds here).
- `Notification` payload carries `notification_type` + human `message` —
  classify on `notification_type` (`permission_prompt` observed), fall back to
  message regex.
- Status statechart for Phase 1:
  `SessionStart→starting`, `UserPromptSubmit→working`,
  `PreToolUse(held)→needs-permission` (ours), `Notification→needs-permission|
  needs-input` (debounced backup), `Stop→done`, `SubagentStop→transient
  subagent-done badge`. Unknown events: log, don't transition (§5.26 posture).

## Re-running

```bash
bash spike/s06/run-status.sh                          # fast-answer cycle (no Notification — expected)
S06_ANSWER_DELAY_MS=90000 bash spike/s06/run-status.sh  # debounce probe (Notification at ~6s)
```
