# PROGRESS — switchboard.ai

> Live state. Updated the moment an item starts, finishes, or hits a blocker.
> A fresh session reads this file and knows exactly where things stand.

**Milestone:** Spike 01 - Foundations (issues #1–#8)
**Milestone:** Phase 1 - MVP (issues #12–#35, filed 2026-07-19)
**AUTOPILOT RUN 2 ACTIVE** — started 2026-07-19 after Spike 01 merged (PR #11,
all GO). Branch `auto/phase-1-mvp`, draft PR opens after first commit.
**In progress:** P1-E3-01 — Main window layout (#24)
**Next up:** P1-E3-02 — Terminal pane (#25)
**E1+E2 epics: COMPLETE** (#12–#23; E2 epic-review fixes landed, all live
checks PASS: check:pty / check:adapter / check:hooks / check:transcripts)
**E1 epic: COMPLETE** (#12–#17 all done, CI green)
**Branch:** auto/phase-1-mvp

## Blockers / open questions for Dan

- **[user] "Red build blocks merge" (#13) can't be enforced server-side**:
  branch protection and rulesets are both plan-gated on free private repos.
  Options: GitHub Pro / make repo public / accept procedural gate (merge only
  when PR checks green). CI itself is live and green on all 3 OSes.

## Log

- 2026-07-19 — **E2 epic review fixes** (autopilot run 2): 2 blockers fixed —
  transcript binding (case-sensitive slug hard gate would silently never bind
  on real paths; now case-insensitive prefilter + widen fallback, head-cwd
  authority, NEW check:transcripts proves it live) and create(settingsFor)
  (integrated spawn-with-hooks path now exists and check:hooks runs it:
  create→real PTY→TUI→hook-driven working→done). Kill maps to done not
  crashed (proven live); crashed terminal; subscriber isolation; node
  resolution for claude.exe installs; misc hardening.
- 2026-07-19 — **P1-E2-06 done** (autopilot run 2; E2 epic complete):
  TranscriptWatcher — recursive scan incl. nested subagents/ + meta.json,
  binding validated against cwd/sessionId (race fix; pre-existing files never
  adopted; transcript-absent-until-first-prompt tolerated), tolerant reader,
  live usage totals/tools/files/lastActivity, subagent identity pickup.
  Done-when tested: live-append token updates + malformed lines survive.
  67 unit tests green.
- 2026-07-19 — **P1-E2-05 done** (autopilot run 2): HookListener — §5.29
  floor (loopback + Host allowlist + per-session token; token delivered by
  ACL'd file path, never argv per S-03), instant-ack status hooks with
  timeout:10, generated fail-open forwarder, buildHookSettings for adapter
  injection, native-session-id capture. Done-when verified LIVE:
  `npm run check:hooks` ran real claude -p with injected hooks →
  starting→working→done from hook events alone; 401/403 negative tests in
  the same run. 61 unit tests green.
- 2026-07-19 — **P1-E2-04 done** (autopilot run 2): WorkspaceStore — persisted
  sessions (identity, layout slot, native id for resume-on-focus) + window
  geometry with display fingerprint (§7); tolerant load (corrupt→.corrupt
  backup + fresh start), atomic saves; missing-display rescue to centered
  (keeps maximized). Shell geometry migrated from window-state.json to
  workspace.json (window-state.ts is pure helpers now). Round-trip +
  rescue tested (55 total); smoke x2 shows real 3-display fingerprint
  persisting. UI consumption (suspended cards) lands with E3.
- 2026-07-19 — **P1-E2-03 done** (autopilot run 2): SessionManager —
  create/kill/restart via registry-resolved adapters + injected PtyService;
  identity registry; S-06-semantics state machine (unknown events never
  transition; exit 0→done, nonzero→crashed; permission hold/resolve path).
  Done-when: transitions observable (subscription + queryable history +
  sessionId-filterable log lines), verified by replaying the REAL recorded
  S-06 cycle (artifacts/s06/transitions.json) through the machine. Live
  hook wiring lands in E2-05. 47 tests green.
- 2026-07-19 — **P1-E2-02 done** (autopilot run 2): Claude adapter v1 —
  absolute CLI resolution (PATH scan, cached), per-session settings file
  generation with validate-before-spawn (S-02 silent-ignore trap), resume
  args, env scrubs. Done-when verified live: `npm run check:adapter` spawned
  a session in a fresh temp folder, planted a marker, and --resume recalled
  it (PASS). Local-only check (needs logged-in CLI); 39 unit tests green;
  CI green 3 OSes incl. node-pty rebuild + check:pty.
- 2026-07-19 — **P1-E2-01 done** (autopilot run 2): PtyService — generic
  spawn/resize/write/kill with per-session ring-buffer scrollback (2MB cap,
  S-07 ingest-only verdict), always-on S-01 env scrub, dead-PTY write guards.
  node-pty + @electron/rebuild postinstall (Spectre fallback fired on this
  machine as spike predicted — sanctioned fix still: VS component).
  Done-when verified: `npm run check:pty` = 12 concurrent PTYs
  spawn→resize→write→kill clean (12/12/12, 0 orphans); wired into CI.
  Note: node-pty's console-list helper prints AttachConsole noise under
  run-as-node teardown — cosmetic, exit code governs.
- 2026-07-19 — **P1-E1-06 done** (autopilot run 2; E1 epic complete):
  contribution registry + capability manifests (§5.23); ProviderAdapter and
  EventSource contracts v0; Claude adapter registered via bootstrap and
  resolved through the registry (done-when tested); spawn recipe carries the
  S-01 env scrubs. 26 tests green.
- 2026-07-19 — **P1-E1-05 done** (autopilot run 2): zero-dep JSON-lines
  logger with rotation, deep redaction (token-through-args test), sessionId
  lifecycle-grep test, per-subsystem debug toggles. Wired into app lifecycle.
- 2026-07-19 — **P1-E1-04 done** (autopilot run 2): i18next + ICU, en.json,
  generated pseudo-locale (⟦mangled⟧, ICU args preserved — tested against
  every en.json leaf), language toggle in shell, react/jsx-no-literals bans
  hardcoded JSX strings (canary-verified). 15 tests green. Logical-CSS
  convention adopted (marginBlockStart in shell); CSS-side lint deferred to
  first real stylesheet work (E3).
- 2026-07-19 — **P1-E1-03 done** (autopilot run 2): three-layer token system
  (Nordic/Daylight maps + theme-independent semantics + component tokens)
  from the design handoff; OS-sync with persisted override; theme toggle in
  shell; ESLint bans raw colors in renderer (canary-verified fail + pass).
  12 unit tests green.
- 2026-07-19 — **P1-E1-02 done** (autopilot run 2): CI matrix
  (win/ubuntu/macos, Node 22) — lint/typecheck/test/build, green on all 3 OSes
  (also completes E1-01's cross-platform done-when). [user] note: server-side
  merge blocking is plan-gated (see Blockers).
- 2026-07-19 — **P1-E1-01 done** (autopilot run 2): electron-vite + TS + React
  scaffold at repo root; sandboxed/isolated windows, CSP, external-link +
  navigation guards, window-state persistence with missing-display rescue
  (tested, 8 unit tests); S-01 env landmines mitigated day-one (scripts/ev.js).
  Reviewed (code-reviewer): 0 blockers, 8 should-fixes applied. Smoke: open/
  close clean x2, state restores. CI (mac/linux compile) lands with #13.
- 2026-07-19 — **S-08 done** (autopilot; milestone complete):
  `docs/plans/spike-01-findings.md` written; DESIGN.md OQ #2/#5/#10 resolved,
  #3 verdict added, #13 evidence added; Phase 1 plan corrected (scrollback
  5000, settings validation, Notification-as-backup, recursive tailer +
  binding validation, hidden-panes-don't-render). Spike exit criteria all met.
- 2026-07-19 — **S-07 done** (✅ GO, autopilot): 8/12 concurrent sessions —
  idle 7.6%/27.8% of one core, ~420MB/session (CLI-owned), streaming peak 68%,
  UI stall 15ms max (N=12's 939ms = occluded-window timer throttling
  artifact). Findings: `spike/findings/s-07-concurrency-perf.md`
- 2026-07-19 — **S-06 done** (✅ GO, autopilot): hook-only status cycle works;
  Stop ~30ms after turn end; permission Notification debounced ~6s & skippable
  → PreToolUse hold is needs-permission authority. Findings:
  `spike/findings/s-06-status-hooks.md`
- 2026-07-19 — **S-05 done** (✅ GO, autopilot): subagent transcripts are
  nested per-agent files (`<session>/subagents/agent-<id>.jsonl` + meta.json
  with agentType/description/toolUseId); live tail lag ~160ms; TodoWrite
  plan-state extraction viable (OQ #13). Findings:
  `spike/findings/s-05-sidechain-visibility.md`
- 2026-07-19 — **S-04 done** (✅ GO, autopilot): transcript discovered 3.9s
  after spawn (slug mapping confirmed for :/ chars; new-file detection is the
  real binding), tail lag 24–815ms (median 268ms), tolerant reader survives
  garbage/unknown types, tokens/tools/files extractable. No terminal "done"
  marker in transcript → hooks are status authority. Findings:
  `spike/findings/s-04-transcript-tailing.md`
- 2026-07-19 — **S-03 done** (✅ HOOK PATH, autopilot): full decision matrix
  observed headless + interactive TUI. allow overrides default-deny; deny
  carries reason verbatim to model; ask surfaces real TUI prompt; hook hang →
  clean TUI fallback after ~600s default budget (config via timeout field —
  90s hold verified); dead listener fails open instantly. §5.29 floor
  verified (401/403). Findings: `spike/findings/s-03-hook-roundtrip.md`
- 2026-07-19 — Autopilot run started: milestone Spike 01 (S-03→S-08), branch
  `auto/spike-01-foundations`.

- 2026-07-19 — **S-02 done** (✅ GO): `claude --settings <abs-file-path>` at
  spawn is the Phase 1 hook-injection mechanism — hooks fire, user settings
  compose additively, project `.claude/` untouched (sha1-verified); hook
  commands run under Git Bash on Windows. Findings:
  `spike/findings/s-02-settings-injection.md`. PR #10 (Closes #2, merged):
  https://github.com/badsonstudios/switchboard.ai/pull/10

- 2026-07-19 — **S-01 done** (✅ GO): claude CLI PTY-hosts cleanly in
  Electron + node-pty + xterm.js on Windows; full interactive checklist passed
  with no corruption. Findings: `spike/findings/s-01-pty-host.md` — three
  env/build landmines documented (NoDefaultCurrentDirectoryInExePath, Spectre
  libs, ELECTRON_RUN_AS_NODE). PR #9 (Closes #1):
  https://github.com/badsonstudios/switchboard.ai/pull/9

- 2026-07-18 — Design phase complete: DESIGN.md (29 sections), PHILOSOPHY.md,
  control-room design handoff. Repo created and pushed
  (badsonstudios/switchboard.ai). Plans written (docs/plans/); Spike 01
  milestone + issues S-01..S-08 filed.
- 2026-07-18 — Claude workflow migrated from BrainHarbor and adapted to
  issue-driven flow (skills/agents/hooks/scripts under .claude/).
