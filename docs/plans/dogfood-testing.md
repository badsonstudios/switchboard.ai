# Dogfood testing tracker

> **Live state — maintained automatically, without asking** (standing rule in
> `.claude/CLAUDE.md`, added 2026-08-15). Every session updates this file when:
> a user-facing feature merges (add it as UNTESTED), Dan reports a hand-test
> result (move it to TESTED or FOUND-A-BUG with the ticket number), or a fix
> for a found bug ships (move it back to UNTESTED for re-verification).
> When Dan asks "what should I test?", answer FROM this file: the UNTESTED
> and RE-TEST sections, phrased as steps + expected result.

Last updated: 2026-08-15 (Dan's first full pass over v0.4.0 + v0.5.0).

## Untested — never exercised by hand

| What | How to test | Note |
|---|---|---|
| Actionable toasts (Allow/Deny on Windows notification) | Unfocus the app, make a session hit a permission ask; buttons on the toast must work without focusing the app; answering in-app withdraws the toast | Dan got NO toast at all 2026-08-15 — possibly OS focus assist / notification settings during dev; INVESTIGATE before re-test (installed build should have AppUserModelId) |
| Notify-when-done (⋯ menu tick-box) | Tick one session, task it, alt-tab; toast on finish for that session only; survives restart | Same no-toast caveat as above |
| Phone push (ntfy/Pushover) + webhook | Palette → "phone push" → paste an ntfy topic → Send test; then a real needs-permission while unfocused | Deferred by Dan; needs 2-min setup |
| Themes under the new UI | High-contrast + daylight, re-run find/copy/chips/jump-latest checks | Deferred by Dan |
| Sounds 🔊 / TTS announce 🗣 | Title-bar toggles; per-session cue from ⋯ menu; announce speaks label while unfocused | Shipped 0.5.0, not yet exercised |
| Webhook payload | POST target you own; fires regardless of focus, includes finished turns | Never exercised |
| Service-health incident path | Needs a real/mocked Anthropic incident — dot, Events entry, corroboration banner | Hard to test on demand; low priority |

## Re-test after a fix ships

| What | Blocked on | Re-test |
|---|---|---|
| Find highlight in session view | #520 (fix landed) | Ctrl+F a word: current match brightly marked, others quietly, marks gone on Esc, Copy on a fence with a match still copies clean text |
| Update auto-restart | #525 | Next release install should close + reopen itself |
| Right-click menus | #526 | Composer paste (text AND image→chip), copy on feed selection |
| Links in replies | #527 | Click https link → default browser; javascript: inert |
| Composer draft survival | #485 (widened: popout remount) | Type, pop out → text still there; also quit/relaunch |
| Find on a BUSY session | #496 | Hits on a streaming session must jump, not go list-only |
| Resume-link orphans | #484 | His two orphaned cards should reattach via the repair sweep |
| Viewer pin removal | #530 | Every file → its own tab; no pin anywhere |
| New session from popout | #531 | Affordance exists, tab lands beside current card in the popout |
| Diff side-by-side | #532 | Toggle exists, persists, default side-by-side |
| Ctrl+F in document viewer | #533 | Find-in-file works on rendered Markdown, matches marked |

## Tested and passing (2026-08-15 pass, v0.5.0)

- Resume after restart — conversation replays (one caveat: watch for #484 orphan cards)
- Live document re-render — "looks great"; scroll held, delete-strip works
- Paste image into composer → chip → model sees it (verified end-to-end with a real screenshot)
- Drag file into composer → chip ("seems to work fine")
- Copy buttons (code header, Bash IN/OUT, popped-out card) — "works very well"
- ↓ Jump to latest — working
- Attention queue / Ctrl+Space walk — "seems okay"
- Trust chip greyed on Direct + no pre-write — "looks good"
- Status bar (health dot, usage, count, CLI version) — "seems okay"
- New session correctly lands in main app while a popout is focused (placement rule holds)

## Found-a-bug log (dogfood sessions)

| Date | Report | Ticket |
|---|---|---|
| 2026-08-14 | Blank session view on resume (was #395, unreleased at the time) + resume-link destruction | #484 |
| 2026-08-14 | Find jump paints no highlight | #520 |
| 2026-08-14 | No discoverable file-open; wants Files tab | #521 |
| 2026-08-14 | Update installs but never restarts the app | #525 |
| 2026-08-14 | No right-click context menus anywhere | #526 |
| 2026-08-14 | Links in replies dead on click | #527 |
| 2026-08-14 | Attention coloring not intuitive (design sitting) | #528 |
| 2026-08-14 | Focused-card border not prevalent enough (design sitting) | #529 |
| 2026-08-15 | Popping out a card deletes typed prompt text | #485 (widened) |
| 2026-08-15 | Viewer pin model rejected — always-new-tab wanted | #530 |
| 2026-08-15 | No new-session path from a popped-out window | #531 |
| 2026-08-15 | Diff stuck inline, no side-by-side option | #532 |
| 2026-08-15 | Ctrl+F dead in the document viewer | #533 |
| 2026-08-15 | Find goes all-list-only on a busy session | #496 (repro added) |
