# Dogfood testing tracker

> **Live state — maintained automatically, without asking** (standing rule in
> `.claude/CLAUDE.md`, added 2026-08-15). Every session updates this file when:
> a user-facing feature merges (add it as UNTESTED), Dan reports a hand-test
> result (move it to TESTED or FOUND-A-BUG with the ticket number), or a fix
> for a found bug ships (move it back to UNTESTED for re-verification).
> When Dan asks "what should I test?", answer FROM this file: the UNTESTED
> and RE-TEST sections, phrased as steps + expected result.

Last updated: 2026-08-16 (evening) — Dan's v0.6.0 pass done; results below. **v0.6.0 SHIPPED**; everything in the RE-TEST table below
is now IN the installed build once Dan updates. Twelve fixes landed via train #554.

## Untested — never exercised by hand

| What | How to test | Note |
|---|---|---|
| **The Events drawer (0.6.0)** | The 220px column is gone — look for the slim badge tab on the right edge; it shows the attention count, tinted by the hottest event. Click it, or the hotkey, or the palette; the drawer overlays the grid. Check the update/reconnect/incident notices appear inside it, Esc closes and gives focus back, and the status bar now carries a queue count | Shipped in v0.6.0 |
| **Quiet hours (0.6.0)** | Palette → quiet hours (or the About button); set a window covering now; a session needing you must NOT sound/speak/toast — but a webhook still fires | Shipped in v0.6.0 |
| Actionable toasts (Allow/Deny on Windows notification) | Unfocus the app, make a session hit a permission ask; buttons on the toast must work without focusing the app; answering in-app withdraws the toast | Dan got NO toast at all 2026-08-15 — possibly OS focus assist / notification settings during dev; INVESTIGATE before re-test (installed build should have AppUserModelId) |
| Notify-when-done (⋯ menu tick-box) | Tick one session, task it, alt-tab; toast on finish for that session only; survives restart | Same no-toast caveat as above |
| Phone push (ntfy/Pushover) + webhook | Palette → "phone push" → paste an ntfy topic → Send test; then a real needs-permission while unfocused | Deferred by Dan; needs 2-min setup |
| Themes under the new UI | High-contrast + daylight, re-run find/copy/chips/jump-latest checks | Deferred by Dan |
| Sounds 🔊 / TTS announce 🗣 | Title-bar toggles; per-session cue from ⋯ menu; announce speaks label while unfocused | Shipped 0.5.0, not yet exercised |
| Webhook payload | POST target you own; fires regardless of focus, includes finished turns | Never exercised |
| Service-health incident path | Needs a real/mocked Anthropic incident — dot, Events entry, corroboration banner | Hard to test on demand; low priority |

## Re-test after a fix ships

| What | Shipped in | Re-test |
|---|---|---|
| Find highlight in session view | **v0.6.0** | PARTLY VERIFIED — marks work where jumping works; blocked behind #495/#557 on resumed sessions |
| Find on ANY resumed session | NOT yet (#495 raised, #496, #557) | Every hit must jump; the bar alone should carry it — no auto-opening results list |
| New session from popout | **v0.6.0** | Affordance exists, tab lands beside current card in the popout |
| Conversations sitting at the TOP instead of the tail (#555) | PR open (`feature/555-feed-tail-after-dock-move`) | Click every session in the sidebar in turn, especially with two cards side by side: each must show its NEWEST message, and stay there when you click its own row again. The restart was never the cause — clicking a card was |

## Tested and passing (2026-08-16 pass, v0.6.0)

- Update installs **and restarts itself** — #525 verified in the wild
- Right-click menus (composer cut/copy/paste, feed copy) — "seems to be working now"
- Links in replies open the browser — "working, thank you"
- Documents: a tab per file, no pin; Ctrl+F in the viewer — both "working well"
- Side-by-side diff toggle — "working well"
- Composer draft survives tab-switch / popout / restart — "this is working"
- New session from a popped-out window (creation half) — "all worked fine"
- Resume-link repair — "appears to be working now" (orphaned cards reattached)

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
| 2026-08-16 | Every session restores scrolled to the TOP, never the tail | #555 |
| 2026-08-16 | Events drawer has no visible close button (tab only) | #556 |
| 2026-08-16 | Find auto-opens the results list; wants bar-only interaction | #557 |
| 2026-08-16 | Find refuses to jump on an IDLE resumed session (worked after new turns) | #495 (evidence added, priority up) |
| 2026-08-16 | Popout-born session docks back into the WRONG grid slot | #558 |
| 2026-08-16 | Wants drag-to-reorder sessions within a rail group | #559 |
