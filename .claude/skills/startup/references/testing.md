# Testing — switchboard.ai

**Current phase (Spike 01):** no test suite. Spike items are findings-driven —
each item's "done when" is an observable behavior plus a written findings note.
Verify by actually driving the harness (spawn a real `claude` session, trigger
a real hook, watch a real transcript) and record what happened, including
numbers (latency, CPU, memory) where the item asks for them.

**The three test layers (run all before calling an item done):**

1. **Unit — `npm test` (vitest).** Services and pure logic: SessionManager
   state machine, TranscriptWatcher tolerant parsing + plan/usage extraction,
   GitService output parsing, token/theme/usage utilities. No Electron, no CLI.
2. **Local live checks — `npm run check:*`.** Real-`claude` integration proofs
   that need a logged-in CLI, so they run locally (not CI): `check:pty` (12
   concurrent PTYs — this ONE is in CI, no login needed), `check:adapter`
   (spawn + `--resume`), `check:hooks` (hook-driven status), `check:transcripts`
   (usage extraction). Run the relevant one when you touch that subsystem.
3. **E2E — `npm run e2e` (Playwright + Electron).** Drives the REAL app window
   headlessly — this is how we verify UI without a human ("Dan eyeball"):
   - Harness: `e2e/fixtures/app.ts` launches the built app fully isolated (temp
     HOME, so it never touches the real `~/.claude.json` or workspace) with the
     **fake provider** (`SWITCHBOARD_FAKE_PROVIDER=1`) — a shell-in-a-PTY, so
     tests need no `claude` login and run in CI.
   - Seed a session with `launchApp({ seedFolder })`; assert on chrome (theme,
     pseudo-locale, autonomy), the card header (usage strip, git, plan chip),
     the live terminal (type a command → see output), pop-out (a second OS
     window opens), and the rail.
   - `npm run e2e` builds first; `npm run e2e:only` skips the build;
     `npm run e2e:headed` / `e2e:ui` for debugging.
   - **Add an e2e test for every new user-facing surface.** If a feature can
     only be checked by looking at the window, it needs an e2e test — not a
     PROGRESS "[Dan eyeball]" note.

**CI (GitHub Actions), every PR:** `build` job = lint + typecheck + unit +
build + check:pty on Windows/macOS/Linux; `e2e` job = Playwright on
Windows + Linux (xvfb). Red CI blocks merge.

**Opt-in REAL-claude e2e lane (local only, 2026-07-22):**
`SWITCHBOARD_REAL_E2E=1 npx playwright test e2e/real-claude.spec.ts` — copies
the machine's claude credentials into the isolated temp home and drives a
real model turn through the Session tab (composer → response blocks). Skipped
everywhere else; CI stays fake-provider.

**The local pre-commit gate MUST mirror the CI matrix:** `npm run lint &&
npm run typecheck && npm test && npm run build && npm run e2e`. Skipping
`typecheck` locally shipped 6 TS errors to CI on 2026-07-21 — electron-vite's
build does not run tsc strict checks; only `npm run typecheck` does.

**Rules:**
- Never report half-working code as done — record blockers in PROGRESS.md with
  failing output.
- When there's a runtime surface, run the app and see the change work; tests
  alone don't count as verification.
- The tolerant-parser tests must include garbage/unknown-schema lines — the
  transcript format is an unofficial contract that WILL drift (OQ #3).
