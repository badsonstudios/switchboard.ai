// What is left of "which transport is this session on" (#873, #952).
//
// ⛳ THE QUESTION IS CLOSED. This file was the home of the ⋯ menu's transport
// switch: the journey a person took to move a session between Terminal and
// Direct (#153), the pending-restart affordance, and the tests proving the
// choice survived a restart and a relaunch. #873 removed the switch and the
// Terminal tab every one of those tests used as its witness; #952 removed the
// transport itself.
//
// WHAT WAS LOST ALONG THE WAY, written down so the gaps stay known rather than
// being rediscovered from a green suite:
//
//  - **The switch journey (#153) and both persistence tests.** There is no
//    user-settable transport, so there is no choice to persist.
//
//  - **"a restarted Direct session offers no bar and no dead button".** Its
//    assertions were worth keeping, but the only way to RESTART a running
//    session from the UI was the switch's own "Restart session now" button. Per
//    its own comment it was the ONLY test anywhere proving a session restarted
//    INTO Direct has a working hook channel, so **that proof is still lost.**
//
//  - **"a brand-new session comes up in Direct with nothing asked for" (#381).**
//    Both witnesses were UI. The claim now rests on `stream-trust.spec.ts`,
//    which decides on DISK rather than on screen — though #952 cost that file
//    its counterpart too, so read its header before leaning on it.
//
// WHAT THIS FILE IS NOW: the regression guard for the terminal-handoff bar's
// REMOVAL. It is cheap, and it is the only end-to-end check that no surface
// still offers to send someone to a terminal.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs no
// `claude` login and no network.
import { test, expect } from '@playwright/test';
import { hookPoster, launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// #261, and its conclusion (#952) — nothing routes anyone to a terminal.
//
// Dan hit the original within minutes of the switch working: a freshly
// restarted Direct session showed "Claude is showing a start-up dialog … appear
// only in the terminal" over an [Open Terminal] button, next to a Terminal tab
// that correctly said there was no terminal. Two surfaces in one window
// contradicting each other. #261 made the bar transport-aware; #952 deleted the
// bar, because every branch of it routed somewhere that no longer exists.
//
// This drives the state the live incident produced. A `Notification` from the
// CLI's own debounced nudge is what put the bar on screen: no PreToolUse,
// therefore no hold, therefore no approval bar to outrank it.
//
// ⚠️ IT ASSERTS AN ABSENCE, so the FIRST assertion — that the session really
// reached `needs-input` — is what stops it passing because nothing happened.
// That is exactly how a sibling test used to pass before it was deleted.
test.describe('nothing offers a route to a terminal (#261, #952)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a session waiting on input offers no bar and no dead button', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' },
    });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const post = await hookPoster(a);
    await post(title, {
      hook_event_name: 'Notification',
      notification_type: 'generic',
      // NOT "waiting for your input", which is the CLI's 60s idle nag and
      // classifies to `idle` — a calm state with no bar at all. This is the
      // other arm: a bare "waiting", which is the CLI stopped on something.
      message: 'Claude is waiting on you',
    });

    // The session REALLY reached the state — see the warning above.
    await expect(w.locator('nav .rail-row[data-session-status="needs-input"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // ...and the Session tab stays silent rather than pointing at a terminal
    // that does not exist. `data-handoff` was the bar itself; the button is what
    // the user would have clicked to nowhere.
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
    await expect(w.getByText(/waiting for your answer/i)).toHaveCount(0);
  });
});
