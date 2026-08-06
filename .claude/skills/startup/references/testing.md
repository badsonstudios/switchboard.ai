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
2. **Local live checks — `npm run check:*`.** Integration proofs that need
   something the unit job does not have — a logged-in CLI, or a BUILD. Run the
   relevant one when you touch that subsystem. **Every check is either in CI or
   recorded as local-only with a reason (#182)** — `src/main/check-scripts.test.ts`
   fails the build if a new one is neither:

   | Check | Where it runs | Why |
   |---|---|---|
   | `check:pty` (12 concurrent PTYs) | **CI**, all 3 OSes | no login, no tokens |
   | `check:fake-stream` (P2-E18-04: the compiled stream-json fake over real pipes) | **CI**, all 3 OSes | no login; needs `npm run build` first |
   | `check:adapter` (spawn + `--resume`) | local only | two real `-p` turns — **spends subscription tokens** |
   | `check:hooks` (hook-driven status) | local only | a real interactive session + a real Write tool call — **spends tokens** |
   | `check:transcripts` (usage extraction) | local only | a real `-p` turn, then parses the CLI's own transcript — **spends tokens** |

   **All five guard their bundle (#298).** A check script execs
   `out/main/<name>-check.js` directly and never builds, so it had #286's trap
   exactly: a check failing against last hour's bundle reads like a regression
   in the code you just wrote. They all run through
   `scripts/run-electron-node.js`, which calls the bundle guard (below) before
   it spawns anything under `out/` — one wiring, so a sixth check script gets it
   free and `check-scripts.test.ts` fails if one ever bypasses the runner. It
   guards **that check's bundle plus `out/main/index.js`** (where the build
   identity is baked), NOT the renderer — a half-built renderer is nothing to
   `check:pty`. **Run `npm run build` first**, or the check refuses with the
   command to paste.

   The three local-only ones can never be wired in: a runner has no
   subscription login, and the only ways to give it one (an API key, or
   spending Dan's tokens per PR) are hard constraints we do not cross. Re-run
   them by hand when you touch adapters, hooks, or transcripts — that is the
   whole safety net for those three, so it is not optional.
   *Why this layer exists for the stream work:* the unit job does not build, so
   anything asserting on a compiled entry point could only skip there — and a
   test that silently does not run is worse than none. `check:fake-stream`
   caught a real bug the unit tests structurally could not: the adapter is
   bundled into `out/main/chunks/`, so a `__dirname`-relative path to a rollup
   ENTRY resolved one directory too deep.
3. **E2E — `npm run e2e` (Playwright + Electron).** Drives the REAL app window
   headlessly — this is how we verify UI without a human ("Dan eyeball"):
   - Harness: `e2e/fixtures/app.ts` launches the built app fully isolated (temp
     HOME, so it never touches the real `~/.claude.json` or workspace) with the
     **fake provider** (`SWITCHBOARD_FAKE_PROVIDER=1`) — a shell-in-a-PTY, so
     tests need no `claude` login and run in CI.
   - **There are TWO fakes, one per transport (P2-E18-04).**
     `SWITCHBOARD_FAKE_PROVIDER=1` is the original shell-in-a-PTY and is what
     every pre-E18 spec uses. `=stream` selects the **stream-json fake**
     (`providers/fake-stream.ts` + the compiled `fake-stream-cli.js`), which
     speaks NDJSON and answers `can_use_tool` control requests. Distinct VALUES
     of one variable, not two variables, so the modes cannot both be on and race
     to register the same `claude-code` id. Stream-mode e2e arrives with
     P2-E18-08, when a stream session can first be created from the UI.
   - Seed a session with `launchApp({ seedFolder })`; assert on chrome (theme,
     pseudo-locale, autonomy), the card header (usage strip, git, plan chip),
     the live terminal (type a command → see output), pop-out (a second OS
     window opens), and the rail.
   - `npm run e2e` builds first; `npm run e2e:only` **does NOT** — it runs
     against whatever is already in `out/`; `npm run e2e:headed` (builds) /
     `e2e:ui` (does not) for debugging. **`e2e:only` is not "the full suite" —
     it is the full suite against the LAST BUILD.**
   - **The stale-bundle guard (#286, extended #298).**
     `scripts/bundle-guard.js` runs ahead of everything that executes `out/`
     without building it — `e2e:only`, `e2e:ui`, and all five `check:*`. It
     prints the build identity baked into `out/main/index.js` (which SHA, which
     branch, how old) and **exits 1** when any bundled source under `src/` — or
     `electron.vite.config.ts` / `package.json` / `package-lock.json` — is newer
     than `out/`. Editing a spec, a `*.test.ts` or a doc does not trip it; those
     are not bundled. It exists because testing an edit against the previous
     build fails in a way that reads exactly like a logic bug, and did (#253,
     and P2-E15-15's original hand-test). Escape hatch:
     `ALLOW_STALE_BUNDLE=1` (warns, then runs; `$env:ALLOW_STALE_BUNDLE=1` in
     PowerShell — #286's `E2E_ALLOW_STALE` still works). A missing `out/` fails
     regardless — there is nothing to test. **The failure message names the
     command you actually typed**, so it stays pasteable.
   - **It also flags a FOREIGN `out/` (#298)** — baked branch vs. the branch of
     the checkout, resolved the same way `probeBuildIdentity()` resolves it
     (including GitHub's env fallback, so CI's detached HEAD does not
     false-positive). That one is a printed **NOTE, never a failure**: mtimes
     are proof, a branch name is a hint, and `npm run build` then `git checkout
     -b` leaves a correctly-built bundle stamped with the old branch.
   - **It compares mtimes, so any git operation that rewrites files — rebase,
     `checkout`, `stash pop`, merge — trips it even when the content is
     identical.** The answer is `npm run build`, not `ALLOW_STALE_BUNDLE=1`.
     Never bake the override into a runbook or a worker prompt: a guard that is
     always overridden is a guard that is not there.
   - **Add an e2e test for every new user-facing surface.** If a feature can
     only be checked by looking at the window, it needs an e2e test — not a
     PROGRESS "[Dan eyeball]" note.
   - **`e2e/` holds BOTH runners, split by extension (#230).** `*.spec.ts` is
     Playwright (`playwright.config.ts` pins `testMatch` to it — its default
     would swallow `*.test.ts` too); `*.test.ts` is **vitest**, and today means
     the fixture's own unit tests (`e2e/fixtures/app.test.ts`, which mocks
     Playwright's launcher to reach `launchApp`'s launch-FAILURE reaping — a
     branch no spec can take on purpose). Both configs have to agree, so if you
     ever move that line, move it in both. A vitest test named `*.spec.ts`, or a
     spec named `*.test.ts`, is silently ignored by the runner you meant.

**CI (GitHub Actions), every PR:** `build` job = lint + typecheck + unit +
build + check:pty + check:fake-stream on Windows/macOS/Linux; `e2e` job =
Playwright on Windows + Linux (xvfb). Red CI blocks merge.

**Opt-in REAL-claude e2e lane (local only, 2026-07-22):**
`SWITCHBOARD_REAL_E2E=1 npx playwright test e2e/real-claude.spec.ts` — copies
the machine's claude credentials into the isolated temp home and drives a
real model turn through the Session tab (composer → response blocks). Skipped
everywhere else; CI stays fake-provider.

**The local pre-commit gate MUST mirror the CI matrix:** `npm run lint &&
npm run typecheck && npm test && npm run build && npm run e2e`. Skipping
`typecheck` locally shipped 6 TS errors to CI on 2026-07-21 — electron-vite's
build does not run tsc strict checks; only `npm run typecheck` does.

**`npm run typecheck` is THREE tsc projects, and every TypeScript source file
must be in one of them (#234):**

| Project | Covers |
|---|---|
| `tsconfig.node.json` | `src/main`, `src/preload`, `src/shared`, `src/build`, `electron.vite.config.ts`, `vitest.config.ts`, `src/test-setup.ts` |
| `tsconfig.web.json` | `src/renderer`, `src/shared`, `src/preload/index.ts` |
| `tsconfig.e2e.json` | `e2e/**` (BOTH runners' files), `playwright.config.ts`, `src/renderer/src/env.d.ts` |

(`scripts/**/*.js` is JavaScript and checked by no `tsc` — that would need
`allowJs`. Its vitest tests are the safety net there.)

A file in no project is checked by NOTHING — eslint's default preset is not
type-aware, so a type error there reaches `main` silently. That was `e2e/`'s
state until #234: switching it on surfaced **16 standing errors** — 14 from
`Window.switchboard` being undeclared (13 `page.evaluate` bodies plus the
implicit-`any` callback that followed), and 2 real ones (a closure that lost a
narrowing, an `HTMLElement` annotation that could not hold Playwright's
`SVGElement | HTMLElement`). Adding a new top-level source directory means
adding it to a project (or adding a project and appending it to the `typecheck`
script **and** `tsconfig.json`'s `references`). The e2e project pulls in
`src/renderer/src/env.d.ts` for the `Window.switchboard` global, since every
`page.evaluate` body is checked as renderer code; it also needs the `DOM` lib
alongside `node` types for the same reason.

**eslint has two tiers, and `e2e/` is the only tree on the upper one (#245).**
Everything else gets `tseslint.configs.recommended`, which is NOT type-aware.
`e2e/**/*.ts` and `playwright.config.ts` additionally extend
`recommendedTypeChecked`, pointed at `tsconfig.e2e.json` — the same project
`typecheck` uses, so lint and tsc see one program. A spec's assertion is only as
good as the types under it: an `any` leaking out of a boundary makes
`expect(x.foo).toBe(...)` compile no matter what `foo` is.

Turning it on surfaced **83 errors across 21 files** (32
`no-unsafe-member-access`, 29 `require-await`, 16 `no-unsafe-assignment`, 6
stragglers), all fixed with **zero disables**. Two lessons worth keeping:

- The `any` came from **`JSON.parse`**, not `page.evaluate` as #234 assumed —
  six specs each re-describing a corner of `workspace.json` inline. It now has
  one typed reader in `e2e/fixtures/app.ts` (`readWorkspaceFile` /
  `persistedLayout` / `persistedUi` / `gridLeafViews`, plus the
  `Persisted*` interfaces). Read the workspace file through those; do not
  re-parse it in a spec. The one other `any` source is Electron's
  `webContents.executeJavaScript`, typed `Promise<any>` and not generic —
  narrow it at runtime (`String(...)`), don't cast.
- 25 of the 29 `require-await` were the same stub,
  `dialog.showOpenDialog = async () => ({...})`. Write
  `() => Promise.resolve({...})`: identical at runtime, and `async` with no
  `await` in it is a lie about the function.

If a rule ever genuinely cannot be satisfied, an inline disable needs a comment
saying why — `e2e/` currently has exactly one (`no-require-imports`, predating
this), and `grep -rn "eslint-disable" e2e/` is the check.

**Rules:**
- Never report half-working code as done — record blockers in PROGRESS.md with
  failing output.
- When there's a runtime surface, run the app and see the change work; tests
  alone don't count as verification.
- The tolerant-parser tests must include garbage/unknown-schema lines — the
  transcript format is an unofficial contract that WILL drift (OQ #3).
