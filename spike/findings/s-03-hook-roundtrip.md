# S-03 — Hook round-trip & decision semantics (OQ #10, the gate)

**Verdict: approval surfaces use the HOOK PATH.** PreToolUse round-trips
through an external listener work end-to-end on Windows: the CLI holds the tool
call while a remote decision is made, `allow`/`deny`/`ask` all behave usefully,
deny carries a feedback message the model actually sees, and human-scale hold
times are fine once the hook `timeout` field is raised. The KEYSTROKE FALLBACK
remains available (and is the only route to the TUI's own "allow all edits this
session" option) but is not needed for the core approve/deny loop.

**Tested:** Claude Code CLI **2.1.215**, Windows 11, 2026-07-19. Headless
(`claude -p`) and real interactive TUI driven via node-pty
(`ELECTRON_RUN_AS_NODE=1 electron.exe` so node-pty's Electron-ABI build runs
windowless). Probe kit: `spike/s03/` (loopback listener with §5.29 floor —
Host allowlist + per-session token — hook-forward command, scenario runner,
scripted PTY driver).

## Decision matrix (observed, not documented-behavior)

All eight cells below are directly observed (scripted headless + scripted
interactive TUI runs; artifacts in `spike/findings/artifacts/s03/`).

| Hook outcome | Headless (`-p`) | Interactive TUI |
|---|---|---|
| **allow** | Tool runs. **Overrides headless default-deny** — baseline (no hook) refuses file writes with "you haven't granted it yet", with hook-allow the same write succeeds. 2s hold: fine. | Tool runs, **no prompt shown**; file written; model turn completes normally (verified via completion marker). |
| **deny** (with reason) | Tool blocked. **Reason string delivered to the model verbatim** — model echoed `S03-DENY-REASON: switchboard operator rejected this edit` as the refusal it received. Session continues normally. | Tool blocked, no prompt; the deny reason surfaces in the TUI conversation (`S03-DENY-REASON` visible ~5s after submit); file not written. |
| **ask** | Degrades to a block; model sees the hook's reason string (no TUI to ask). | **TUI permission prompt appears** (~4.3s after hook response in our run): `Do you want to create live-ask.txt? ❯ 1. Yes / 2. Yes, allow all edits during this session (shift+tab) / 3. No · Esc to cancel · Tab to amend`. Enter accepts; write proceeds. |
| **timeout** (hook hangs) | CLI waits **~600s** (measured wall 606s; the folk-wisdom 60s default is wrong for 2.1.215), then abandons the hook and falls back to default permission behavior → headless deny, session survives (exit 0, model responds). | See TUI-fallback section below. |

Round-trip overhead: hook invocation → listener → decision → CLI resumption
added no observable overhead beyond the deliberate hold (2s hold ≈ 2.0s
round-trip in hook logs; 10s total wall for the whole `-p` run).

## The specific done-when questions

- **Can deny carry a feedback message?** Yes. `permissionDecisionReason` is
  shown to the model as the tool-block message, verbatim. This is the
  mechanism for "deny with instructions" (e.g. "denied — ask again with a
  smaller diff").
- **Is "don't ask again" expressible?** Not in the hook JSON schema (nothing in
  `hookSpecificOutput` persists preferences). It IS expressible as the TUI
  prompt's option 2 ("allow all edits during this session") — reachable only
  via keystroke. For switchboard: implement don't-ask-again in OUR layer
  (remember the user's choice in the app and auto-allow matching PreToolUse
  events), which is strictly more flexible than the CLI's session-scoped
  option. No CLI gap blocks us.
- **Real timeout budget under human-in-the-loop delay?** Default budget
  measured ≈ **600s** in 2.1.215 — already human-scale. With an explicit
  `"timeout": 600` on the hook entry, a **90s hold** completed cleanly
  (`longhold` scenario: decision returned after exactly 90013ms, write
  proceeded, total wall 98s). Phase 1 should still set an explicit large
  `timeout` on approval hooks rather than trusting the default, since the
  default is undocumented and version-volatile.
- **Does the TUI fallback engage cleanly on timeout?** _Filled in from the
  interactive hang probe — see below._

## TUI fallback on hook timeout (interactive hang probe)

**It engages, cleanly.** With the hook hung and never answering, the
interactive session showed the completely normal permission prompt
(`Do you want to create live-hang.txt? 1. Yes / 2. Yes, allow all edits… /
3. No`) **603s after prompt submission** — matching the ~600s headless budget.
Enter accepted it, the write proceeded, and the session continued undamaged.
No error banner, no session corruption, no stuck state. Timeline:
submit +22.8s → PreToolUse hit listener +27.9s → TUI prompt +626.7s →
accepted; file verified on disk at scenario end → clean `/exit`. (Screen-text
timing after acceptance is redraw-prone and not treated as evidence; the
on-disk file check is.)

Fail-safe story for switchboard: if our listener dies or hangs, the user
waits out the hook budget once and then gets the CLI's own prompt — degraded
(slow) but never blocked. Setting a **short** hook timeout (e.g. 5–10s) on
non-approval hooks and a long one only on approval hooks bounds that worst
case.

## Security floor (§5.29) — verified live

The spike listener implements loopback bind + Host-header allowlist +
per-session token, and the negative tests behave: request without token →
**401**, request with `Host: evil.example` → **403**, both audit-logged. The
hook command receives the port+token via the generated per-session settings
file (S-02 mechanism) — no secrets in the project, none in the repo.

## Mechanics worth keeping (Phase 1 notes)

- Hook stdin JSON carries everything the approval UI needs: `tool_name`,
  full `tool_input` (file path + content for writes), `session_id`, `cwd`.
- **Fail-open verified live** (`dead` scenario): settings pointing at a dead
  port → hook logs `ECONNREFUSED`, exits 0 with no output → CLI runs its own
  default permission flow; total wall 8s. Key asymmetry: a **dead** listener
  costs nothing (connect fails instantly); a **hung** listener costs the full
  hook timeout. Phase 1: connect with a short socket timeout in the
  hook-forward script so a wedged listener degrades like a dead one.
- Security-floor caveat for Phase 1: the spike passes the per-session token as
  a hook-command argv, visible in the process table to any same-user process.
  Deliver it via hook env or an ACL-tight file in the real implementation.
- PreToolUse fired ~6s after `claude -p` spawn (model turn latency included);
  headless `-p` runs never show trust prompts but also never persist trust —
  the first *interactive* session in a folder shows the "Accessing workspace"
  dialog (wording changed from the old "do you trust the files" — don't match
  on exact strings).
- Driving the TUI programmatically: text and Enter must be separate PTY
  writes (a single chunk registers as a paste and never submits) — matters
  for any future keystroke-fallback automation.

## Re-running

```bash
bash spike/s03/run-scenarios.sh                 # headless matrix + security negative tests
bash spike/s03/run-interactive.sh ask           # TUI prompt via hook "ask" (scripted PTY)
bash spike/s03/run-interactive.sh hang          # TUI fallback on hook hang (~11 min)
```
