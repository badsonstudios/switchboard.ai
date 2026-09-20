// Which transport a session is actually ON — what is left of that question
// after #873.
//
// This file was the home of the ⋯ menu's transport switch: the journey a person
// took to move a session between Terminal and Direct (#153), the
// pending-restart affordance, and the tests proving the choice survived both a
// restart and a relaunch. The switch was removed on the owner's call
// (2026-09-19), and with it the Terminal tab that every one of those tests used
// as its witness.
//
// WHAT WENT, AND WHAT IT COST — written down so the gaps are known rather than
// rediscovered from a green suite:
//
//  - **The switch journey (#153) and both persistence tests.** There is no
//    user-settable transport any more, so there is no choice left to persist.
//    They went with the control they were about.
//
//  - **"a restarted Direct session offers no bar and no dead button".** Its
//    assertions were transport-level and worth keeping, but the only way to
//    RESTART a running session from the UI was the switch's own "Restart
//    session now" button — the card's ✕ deletes the record, and the overlay's
//    Restart only exists once a session has ended. The scenario can no longer
//    be staged. Per its own comment this was the ONLY test anywhere proving a
//    session restarted INTO Direct has a working hook channel, so **that proof
//    is lost**; the bar-absence half of its claim survives below.
//
//  - **"a brand-new session comes up in Direct with nothing asked for" (#381).**
//    Both witnesses were UI — the Terminal tab's notice and the ⋯ menu's mode
//    label. The default-transport claim now rests on `stream-trust.spec.ts`,
//    which decides it ON DISK rather than on screen: a Direct spawn writes no
//    trust acceptance for the folder and a PTY spawn does. That pair is a
//    better witness than either of these was, because it cannot be satisfied by
//    something merely rendering.
//
//  - **"a session switched to Terminal is still on Terminal after a relaunch".**
//    Its premise — a session the user chose Terminal for — can no longer exist.
//
// The PTY transport itself is untouched and still reachable with
// `SWITCHBOARD_TRANSPORT=pty`: E18-16 requires it to keep WORKING as the
// fallback while Direct mode is under test. What was removed is the UI.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs no
// `claude` login and no network.
import { test, expect } from '@playwright/test';
import { hookPoster, launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// #261 — the handoff bar must not route a Direct session to a terminal it does
// not have.
//
// Dan hit the original within minutes of the switch working: a freshly
// restarted Direct session showed "Claude is showing a start-up dialog … appear
// only in the terminal" over an [Open Terminal] button, next to a Terminal tab
// that correctly said there was no terminal. Two surfaces in one window
// contradicting each other.
//
// This test drives the branch by hand. A `Notification` from the CLI's own
// debounced nudge is exactly what put the bar on screen in the live incident:
// no PreToolUse, therefore no hold, therefore no approval bar to outrank it.
// On a PTY session that is the #125 case and the bar is CORRECT (asserted in
// approval.spec.ts). Here there is no terminal to send anyone to.
//
// RETARGETED FROM `needs-permission` TO `needs-input` BY #313, which removed the
// state this test used to drive: a permission-classified Notification no longer
// reaches the state machine on a stream session at all, so `needs-permission` is
// reachable on this transport ONLY via a held `can_use_tool` — and a held
// request sets `hasApproval`, which short-circuits `terminalHandoff` BEFORE the
// transport check. Driving it that way would leave this test green for a reason
// that has nothing to do with the transport.
//
// `needs-input` is the same shape and is still reachable: an unheld, unbarred
// status whose handoff branch routes to a terminal a Direct session does not
// have. Same rule, same line of `terminalHandoff`, same two absences.
//
// The `startingLong` branch is not reachable from the outside (nothing can hold
// the fake in `starting` for 8s). It keeps its teeth at the render site in
// `FeedView.handoff.test.tsx` and in `terminal-handoff.test.ts`'s branch table,
// both of which fail if the stream guard is removed.
test.describe('the handoff bar stays silent on Direct (#261)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a Direct session waiting on input offers no bar and no dead button (#261)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // Start in Direct rather than switching + restarting: the transport is
      // the subject of the test, not the path taken to it, and a restart moves
      // the live session id out from under `hookPoster`.
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // The "it really is Direct" probe was a Terminal-tab round trip and went
    // with the tab (#873). The env above SELECTS the transport rather than
    // observing it, which is the stronger of the two anyway — but note that a
    // silent fall-back to the PTY would no longer be caught here.
    const post = await hookPoster(a);
    await post(title, {
      hook_event_name: 'Notification',
      notification_type: 'generic',
      // NOT "waiting for your input", which is the CLI's 60s idle nag and
      // classifies to `idle` — a calm state with no bar at all. This is the
      // other arm: a bare "waiting", which is the CLI stopped on something.
      message: 'Claude is waiting on you',
    });

    // The session REALLY reached the state — without this the absence
    // assertions below would prove only that nothing happened, which is exactly
    // how the deleted sibling test used to pass.
    await expect(w.locator('nav .rail-row[data-session-status="needs-input"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // ...and the Session tab stays silent rather than pointing at a terminal
    // that does not exist. `data-handoff` is the bar itself; the button is what
    // the user would have clicked to nowhere.
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
    await expect(w.getByText(/waiting for your answer/i)).toHaveCount(0);
  });
});
