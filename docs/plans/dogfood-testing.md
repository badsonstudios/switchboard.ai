# Dogfood testing tracker

> **Live state — maintained automatically, without asking** (standing rule in
> `.claude/CLAUDE.md`, added 2026-08-15). Every session updates this file when:
> a user-facing feature merges (add it as UNTESTED), Dan reports a hand-test
> result (move it to TESTED or FOUND-A-BUG with the ticket number), or a fix
> for a found bug ships (move it back to UNTESTED for re-verification).
> When Dan asks "what should I test?", answer FROM this file: the UNTESTED
> and RE-TEST sections, phrased as steps + expected result.

Last updated: 2026-08-17 — **v0.7.0 SHIPPED**, cut specifically so Dan can hand-test
#563's question panel in a real installed build. v0.7.0 carries **#563** (Claude's
questions, answerable in the card), **#555** (feeds restore at the tail), and
**#557 + #496 + #495** (find is a bar first, and works in a resumed session) —
all four are UNTESTED below. The earlier v0.6.0 note stands: everything in the
RE-TEST table is in the installed build once Dan updates.

## Untested — never exercised by hand

| What | How to test | Note |
|---|---|---|
| **Claude's questions, answerable in the card (#563)** | In a **Direct** session ask for something genuinely ambiguous ("I want to add caching — ask me which approach before you start"). A panel appears above the prompt box with the question and clickable answers: round buttons = pick one, boxes = pick several, always an **Other** with a text field. Answer, hit **Send answer**, and Claude should carry on using what you chose — including free text typed into Other. Try the arrow keys/Space instead of the mouse. Half-answer it, go to **Changes**, come back — your ticks should still be there. Unfocused: the pop-up says "A question for you: …" and has **no Allow button**. Note a **Terminal**-mode session keeps its questions in the terminal by design | **v0.7.0.** The fake-provider path is e2e-covered; only the real CLI proves the model actually *reaches for* the tool, and only you can judge whether Other feels like a first-class answer |
| **Feeds restore at the tail (#555)** | Scroll to the end of a busy session, quit switchboard, relaunch. It should come back showing the END of the conversation, not the top. Then drag the panel to another part of the workspace — it should keep its position rather than jumping | **v0.7.0.** Was: every session restored scrolled to the top |
| **Find is a bar first (#557)** | Ctrl+F in a session — you should get the bar with a match count, and Enter / Shift+Enter walking the hits. The results list should stay shut behind its **▸** until you click it | **v0.7.0** |
| **Find in a RESUMED session (#496 + #495)** | Resume a session, send one new turn, then Ctrl+F for something that appears both before and after the resume. Post-resume hits should jump normally; only the older hydrated ones stay unjumpable, and the notice should be about that one hit rather than over the whole session | **v0.7.0.** The ticket's premise was measured wrong first — see PROGRESS |
| **File menu: Open File / Exit (#569)** | A **File** menu at the top left. **Open File…** browses — it should start in the folder of the session you are looking at, and after that wherever you last browsed. The file opens in a document tab BESIDE that session, in its dock section, never inside the session’s own tab strip. Try it with two sessions docked side by side and the SECOND one focused: the document must appear next to that one. Also try it right after typing a prompt (composer focused) — it must still open | Not yet released — on main after #569 |
| **Ctrl+O, and the CLI’s own ctrl+o (#569)** | **Ctrl+O** anywhere in the app opens the file browser — including while typing a prompt. **But click into a session’s Terminal tab and press Ctrl+O there: it must reach Claude Code** (its transcript view), NOT open our dialog. That is the P7 line, and it is the one check no automated test in this repo can make | Not yet released — on main after #569 |
| **Popped-out window comes forward (#571)** | Pop a session out, put another window in front of it, then click that session's row in the sidebar — its window should come to the front. Then click the main switchboard window: your popped-out windows must NOT come forward with it | Not yet released — on main after #571 |
| **Changes tab remembers your file (#562)** | Open **Changes** on a session, pick a file, scroll into the diff. Switch to **Session**, switch back — same file, same line. Then commit or discard that file and come back: the tab should open CLEAN, not on a blank comparison | Not yet released — on main after #562 |
| **Documents keep their place (#562)** | Open two files in the viewer (the ↗ beside a changed file). Read halfway down one, click the other tab, click back — you should still be halfway down | Not yet released — on main after #562 |
| **[UNRESOLVED] Terminal scrollback across a panel move (#562)** | Needs a session with real scrollback: run something long in the **Terminal**, scroll UP into the output, then click that card’s row in the sidebar (with two sessions docked side by side) and see whether the terminal keeps its position. The automated harness could not fill one screen, so this is the one panel measured only halfway | If it jumps to the bottom, say so — it needs the same fix the document viewer got |
| **The app says when it moved a card's conversation (#539)** | On your **next launch after this ships**, open the Events drawer (the tab on the right edge, `Ctrl+E`). Expect a notice saying **Switchboard.ai-2** and **Switchboard.ai** were both pointing at one conversation, that **Switchboard.ai** kept it and Switchboard.ai-2 starts a new one — plus, if the sweep reattached an orphaned card, a second notice naming that card. Then open both: **Switchboard.ai** must be in the conversation it was already in, and **Switchboard.ai-2** must be EMPTY (a new conversation) — never the same transcript as its twin, and never some unrelated session's history. Now the part that matters most: quit **without** pressing Got it and relaunch — the notices must still be there. Press **Got it** on each, relaunch again: gone for good, and both cards land where they were left | Not yet released — on main after #539. Automated tests cover the policy, the persistence, the dismissal and the notice UI; only your real workspace has the actual duplicate pair |
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
| Find highlight in session view | **v0.6.0** | PARTLY VERIFIED — marks work where jumping works; retest with the #557 branch |
| Find on ANY resumed session | **MERGED to main** (PR #561 — #557 #496 #495) | Ctrl+F on a session you have restarted AND then prompted again: the bar alone should carry it — count, Enter/Shift+Enter, Esc — and **the results list must never appear unless you press ▸**. Hits from before the restart may say "earlier than the conversation on screen"; hits since it must jump. **Note the premise was measured wrong in the ticket:** an idle resumed session was always fine; it is the new turn on top that broke it |
| New session from popout | **v0.6.0** | Affordance exists, tab lands beside current card in the popout |
| Conversations sitting at the TOP instead of the tail (#555) | **MERGED to main** (PR #560) | Click every session in the sidebar in turn, especially with two cards side by side: each must show its NEWEST message, and stay there when you click its own row again. Also: scroll up, switch away, come back — you should be where you were reading, not at the bottom. The restart was never the cause — clicking a card was |
| Dock-back slot (#558) | **NOT FIXED** — diagnosed only | Still broken; nothing to re-test yet. `e2e/popout-dock-back.spec.ts` carries the repro (headline case `test.fixme`) and PROGRESS.md carries the reason the obvious fix cannot ship: it makes the card come home suspended |

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
