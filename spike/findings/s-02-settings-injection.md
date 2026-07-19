# S-02 — Settings injection at spawn (OQ #2)

**Verdict: GO — `claude --settings <absolute-path-to-file>` at spawn is the
Phase 1 mechanism.** Hooks fire, the user's own settings still compose, and the
target project's `.claude/` is never touched.

**Tested:** Claude Code CLI **2.1.215**, Windows 11 native, 2026-07-19.
Headless (`claude -p … --settings …`) and interactive (Electron + node-pty
harness, spawn via `claude.cmd` argv). Probe scripts: `spike/s02/`.

## What was proven

| Claim | Evidence |
|---|---|
| Injected hooks fire | `SessionStart`, `UserPromptSubmit`, `Stop` all produced marker lines in both headless and PTY runs |
| User's settings still apply | Fixture project's own `.claude/settings.json` hooks fired **in the same session, for the same events** as the injected ones (timestamps within 2 ms) — merge is additive, not replacement |
| Project untouched | Fixture `.claude/` byte-identical (sha1) before vs after; only file present afterward is the one we planted at setup |
| Works through the real spawn path | Harness passes `--settings` as an extra argv to `claude.cmd` under ConPTY (`SPIKE_CLAUDE_ARGS`); `SessionStart` marker fired from an Electron-spawned session launched from PowerShell |
| Inline JSON also works | `--settings '{"hooks":…}'` fired hooks too — **manually verified one-off, not in the committed probe script**; viable fallback, but see recommendation |

## Mechanism details Phase 1 needs

- **Hook commands run under Git Bash on Windows.** Two signals, neither from
  the committed headless probe (whose `shellHints` are confounded — it launches
  from Git Bash, and the CLI inherits that env): (1) a manual one-off where
  POSIX-only syntax (`VAR=x node …` inline env assignment) executed fine, and
  (2) **probe C**, where the hook saw `MSYSTEM` + `SHLVL` — env vars Git Bash
  sets at startup — despite a PowerShell → Electron → node-pty → claude chain
  that never touched bash. The claim rests on probe C. Write Phase 1 hook
  commands in POSIX sh; Git Bash is already a hard prerequisite of Claude Code
  on native Windows, so this adds no new dependency.
- **Merge semantics (hooks):** additive across sources — injected-file hooks
  and project-settings hooks for the *same event* both run. No observed
  ordering guarantee worth relying on (fired same-millisecond).
- **File path over inline JSON:** both work, but a file path avoids argv
  quoting through the `.cmd` shim + ConPTY (inline JSON was only validated from
  a bash-quoted parent). Generate a per-session settings file in switchboard's
  own app-data dir, pass its **absolute path**.
- **Silent-failure caveat:** CLI help notes settings that fail validation can
  be **silently ignored**. A malformed injected file = all our hooks silently
  gone (fail-open, but invisible). Phase 1 must validate the JSON it generates
  before spawn and treat missing hook traffic as a signal (per DESIGN §2's
  "hooks are a lossy accelerator" posture).
- **Hook-delivery version risk stands:** this proves 2.1.215 behavior. DESIGN
  documents hook regressions across minor CLI versions; record the CLI version
  per session and re-verify on upgrades.
- **Trust note (unprobed edge):** the fixture was auto-trusted by the first
  headless run (trust state lives in `~/.claude.json`, not the project). Whether
  `--settings` hooks fire in a *never-trusted* folder before the trust prompt is
  answered was not tested — irrelevant for Phase 1 (sessions are spawned into
  folders the user chose), but flag it if S-03 sees missing early hooks.
- **Out of scope, untested:** precedence for *scalar* (non-hook) settings
  collisions between `--settings` and user/project files; OQ #2 is about hooks.

## Re-running

```bash
bash spike/s02/run-probes.sh   # probes A+B: headless, strict PASS/FAIL verdict
                               # (per-event + same-session checks; exit 1 on FAIL)
# probe C (PTY path) — run probes A+B first (they generate the injected file
# and the fixture), then from PowerShell:
#   $env:SPIKE_CWD='C:\tmp\s02-project'
#   $env:SPIKE_CLAUDE_ARGS='--settings C:/Projects/Switchboard.ai/.claude/work_files/s02/injected-settings.json'
#   $env:SPIKE_AUTOCLOSE='40'; cd spike; npm start
# then check .claude/work_files/s02/markers-*.log for a SessionStart from the
# new session id
```
