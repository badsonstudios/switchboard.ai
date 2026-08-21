// Which transport a session is actually ON: the Terminal tab's honest
// degradation on Direct, switching modes the way a user does (#153), and Direct
// being what a brand-new session gets without anyone asking (#381).
//
// Split out of `stream.spec.ts` by #626 (move-only). See that file's header for
// the whole `stream*.spec.ts` family and what belongs where.
//
// TRANSPORT SCOPE (P2-E18-18, #404; tags corrected by #639): MIXED, and the
// mixing is the subject. Exactly ONE test here is PTY-by-construction —
// "[pty] a PTY session still gets a real terminal", which takes the PTY-only
// fake and asserts a real terminal behind the Terminal tab. It is the only
// `[pty]` in this file.
//
// EVERY OTHER TEST THAT PASSES `SWITCHBOARD_TRANSPORT: 'pty'` IS DELIBERATELY
// UNTAGGED, and this is the file that makes the distinction worth stating: a
// switch test has to START somewhere the switch can move it away FROM, so it
// asks for the terminal and then asserts DIRECT behaviour. Its green is real
// evidence about the app's default transport, and a `[pty]` on it would be a
// lie in the opposite direction. The rule — reach the terminal on purpose AND
// assert the terminal's own answer — lives with `launchApp` in
// `fixtures/app.ts`.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs no
// `claude` login and no network.
import { test, expect } from '@playwright/test';
import { hookPoster, launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// P2-E18-08b (#149) — the Terminal tab in a stream session.
test.describe('the Terminal tab degrades honestly (P2-E18-08b)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('says there is no terminal instead of showing an empty black pane', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      // TWO variables now, and the split matters: the first picks the
      // dual-capable fake, the second ASKS it for stream. The fake used to
      // return a stream recipe unconditionally, which meant nothing could
      // exercise switching — and that is why #153 shipped (#153: the setting
      // could never take effect and no test could have caught it).
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('tab', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 15_000 });
    // and it says what you GAIN, not only what is missing
    await expect(w.getByText(/permission requests appear in this window/i)).toBeVisible();
  });

  test('[pty] a PTY session still gets a real terminal', async () => {
    const folder = tempProjectFolder();
    // the PTY-only fake (`SWITCHBOARD_FAKE_PROVIDER=1`), which every other spec
    // in the suite uses. Since #381 the host ASKS it for Direct and it answers
    // with a PTY recipe — an adapter that cannot speak stream-json is honoured,
    // which is the same fall-back a real terminal-only provider gets. So this
    // still tests a PTY session; it just gets there by refusal now.
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('tab', { name: 'Terminal' }).first().click();

    await expect(w.getByText('No terminal for this session')).toHaveCount(0);
  });
});

// P2 #153 — THE PATH A PERSON TAKES.
//
// This is the test whose absence is the actual root cause of #153. Everything
// was covered: setTransport was unit-tested for persistence and the pending
// flag, and the stream e2e drove a full session end to end. But the e2e
// launched with stream ALREADY selected by env, so nothing ever walked
// set-it → restart → use-it — and the shipped feature could not take effect at
// all, because the only route to a restart was the card's ✕, which deletes the
// card record and the stored choice with it.
//
// The parts were each verified. The product did not work.
test.describe('switching transport the way a user does (#153)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('set it in the menu, restart from the menu, and the session comes up in the new mode', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake, asked for the PTY — because the thing under test
    // is the SWITCH, and a switch needs somewhere to start from. Since #381 a
    // session that asks for nothing starts in Direct, so the terminal side of
    // this journey has to be requested explicitly.
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it starts on the terminal
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toHaveCount(0);

    // switch it — the label names the CURRENT mode and the action separately
    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();

    // it is saved but NOT yet in effect, and it says so
    await expect(w.getByText(/still running on the old one/i)).toBeVisible();

    // the affordance that #153 was missing entirely
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // and now it really is in the new mode
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
  });

  // Dan hit this within minutes of the switch working: a freshly restarted
  // Direct session showed "Claude is showing a start-up dialog … appear only in
  // the terminal" over an [Open Terminal] button — next to a Terminal tab that
  // correctly said there was no terminal. Two surfaces in one window
  // contradicting each other.
  //
  // TWO bugs behind it. The bar had no notion of transport, and every branch of
  // it routes to a terminal a stream session does not have. And the session was
  // genuinely stuck reporting `starting`, because transport-ready was deferred
  // by a tick while the renderer learns the session id from a much slower IPC
  // response — so the only status push it would ever get was filtered out for
  // an id nobody knew yet.
  //
  // RETARGETED BY #339, because it had been passing for the wrong reason ever
  // since the second of those two bugs was fixed. What it CLAIMED was that a
  // restarted Direct session never renders the handoff bar. What it actually
  // exercised was nothing at all:
  //
  //  - the session now leaves `starting` in well under a second, so
  //    `startingLong` is never true and `terminalHandoff` returns null off its
  //    FINAL fall-through — the `transport === 'stream'` guard the test is
  //    named for is never reached. Deleting that guard outright left this test
  //    green (measured 2026-08-07);
  //  - and both absence assertions were made with the TERMINAL tab selected,
  //    so the Session panel that renders the bar was not even mounted. It
  //    asserted the absence of a bar from a tab that has never had one.
  //
  // It now drives a status the bar DOES have a branch for, through the hook
  // channel the fake grew in #338: `!notify` runs the forwarder command out of
  // the `--settings` file THIS session was spawned with, so the signal comes
  // from inside the restarted child rather than from the test process. That is
  // the one thing the #261 test below cannot do — a restart moves the live
  // session id out from under `hookPoster`, which is why that test starts in
  // Direct instead of switching — and it makes this the only test anywhere
  // that proves a session restarted INTO Direct has a working hook channel.
  //
  // The `startingLong` branch itself is no longer reachable from the outside
  // (nothing can hold the fake in `starting` for 8s). It keeps its teeth at the
  // render site in `FeedView.handoff.test.tsx` and in `terminal-handoff.test.ts`'s
  // branch table, both of which fail if the stream guard is removed.
  test('a restarted Direct session offers no bar and no dead button when the CLI waits', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    // starts on the PTY on purpose — it is a session RESTARTED into Direct that
    // is under test, not one born there (#381 made born-in-Direct the default,
    // and the test below at "#261" is the one that covers that path)
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();

    // the Terminal tab is honest about there being no terminal...
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // ...and the Session tab — the one that renders the bar — has to be the
    // tab actually on screen for its absence to mean anything.
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    // The CLI says it is waiting on the user, from inside the restarted child.
    // NOT "waiting for your input", which is the 60s idle nag and classifies to
    // `idle` — a calm state with no bar at all. And not a permission nudge,
    // which #313 drops on this transport before the state machine sees it.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!notify generic Claude is waiting on you');
    await box.press('Enter');

    // The session REALLY reached a status the bar has a branch for. Without
    // this the three absences below prove only that nothing happened — which
    // is exactly how this test used to pass.
    await expect(w.locator('nav .rail-row[data-session-status="needs-input"]')).toHaveCount(1, {
      timeout: 20_000,
    });

    // `!notify` leaves the turn open, so the status stays put and nothing can
    // walk the card out of it while we look.
    await expect(w.locator('[data-handoff]')).toHaveCount(0);
    await expect(w.getByRole('button', { name: /Open Terminal/i })).toHaveCount(0);
    await expect(w.getByText(/waiting for your answer/i)).toHaveCount(0);
  });

  // #261 — the SAME contradiction, on the branch Dan actually reported, and the
  // reason the test above was not enough.
  //
  // That one drives only `startingLong`, and that branch stopped firing once
  // transport-ready was fixed: the session no longer sits on `starting`, so
  // there is nothing to suppress and the assertion passes for the wrong reason.
  // It would have stayed green through the entire life of this bug — and did.
  //
  // So this one drives the branch by hand. A `Notification` from the CLI's own
  // debounced nudge is exactly what put the bar on screen in the live incident:
  // no PreToolUse, therefore no hold, therefore no approval bar to outrank it.
  // On a PTY session that is the #125 case and the bar is CORRECT (asserted in
  // approval.spec.ts). Here there is no terminal to send anyone to.
  //
  // RETARGETED FROM `needs-permission` TO `needs-input` BY #313, and the reason
  // is that #313 removed the state this test used to drive. A permission-
  // classified Notification no longer reaches the state machine on a stream
  // session at all — see `stream-notification-guard.test.ts` and the e2e at the
  // end of this file — so `needs-permission` is now reachable on this transport
  // ONLY via a held `can_use_tool`, and a held request sets `hasApproval`, which
  // short-circuits `terminalHandoff` BEFORE the transport check. Driving it that
  // way would leave this test green for a reason that has nothing to do with the
  // transport: precisely the failure mode its own comment above is about.
  //
  // `needs-input` is the same shape and is still reachable: an unheld, unbarred
  // status whose handoff branch routes to a terminal a Direct session does not
  // have. Same rule, same line of `terminalHandoff`, same two absences.
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

    // it really is Direct — otherwise everything below is a PTY test that
    // happens to pass
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const post = await hookPoster(a);
    await post(title, {
      hook_event_name: 'Notification',
      notification_type: 'generic',
      // NOT "waiting for your input", which is the CLI's 60s idle nag and
      // classifies to `idle` — a calm state with no bar at all. This is the
      // other arm: a bare "waiting", which is the CLI stopped on something.
      message: 'Claude is waiting on you',
    });

    // The session REALLY reached the state — without this the two absence
    // assertions below prove only that nothing happened, which is the exact
    // failure mode of the test above.
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

  // The path Dan took, and the one that was still broken after the restart
  // button worked: he switched to Direct, used it successfully, closed the APP,
  // reopened — and was back on Terminal.
  //
  // Cause: the create-time card write rebuilt the persisted record field by
  // field, so `transport` was dropped on EVERY session start, including the one
  // at launch. Same defect shape as `reason` vanishing from the approval queue
  // earlier the same day. Must run against the BUILT app, like the theme
  // relaunch test, because that is where the real persistence path lives.
  //
  // BOTH launches now pass `SWITCHBOARD_TRANSPORT=pty`, and that is what keeps
  // this test meaningful after #381. Direct is the default, so a second launch
  // that asked for nothing would come up in Direct whether or not the card
  // remembered anything — the test would pass for the wrong reason and the very
  // bug it exists for could come back unnoticed. Asking for the PTY and getting
  // Direct anyway can only mean the stored choice survived and outranked the
  // env, which is exactly the claim.
  test('the choice survives a relaunch of the whole app', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const first = a;
    await expect(first.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await first.window.getByRole('button', { name: /switch to Direct/i }).click();
    await first.window.getByRole('button', { name: /Restart session now/i }).click();
    // it really is in Direct before we quit
    await first.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(first.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
    await first.close();

    // Same profile, fresh process — and deliberately NO seedFolder. Seeding
    // again creates a SECOND card, which is what my first attempt did: two
    // sessions, and the assertion landed on the wrong one.
    a = await launchApp({
      home: first.home,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    await expect(a.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await a.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(a.window.getByText('No terminal for this session')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('the choice survives the restart it triggered', async () => {
    const folder = tempProjectFolder();
    // pinned to the PTY for the same reason as the relaunch test above: the
    // switch has to move the session somewhere it was not already (#381)
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'pty' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await w.getByRole('button', { name: '⋯' }).first().click();
    await w.getByRole('button', { name: /switch to Direct/i }).click();
    await w.getByRole('button', { name: /Restart session now/i }).click();
    await expect(w.getByText(/still running on the old one/i)).toHaveCount(0);

    // reopen the menu: it should now report Direct as the CURRENT mode
    await w.getByRole('button', { name: '⋯' }).first().click();
    await expect(w.getByRole('button', { name: /switch to Terminal/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});

// #381 — Direct is where a session starts, without anybody asking for it.
//
// Dan, 2026-08-09: "all sessions default to direct mode. not terminal". Every
// other test in this file states a transport in its env; these two are the only
// ones that deliberately state NOTHING, because the absence is the subject.
test.describe('a new session starts in Direct (#381)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('a brand-new session comes up in Direct with nothing asked for', async () => {
    const folder = tempProjectFolder();
    // the dual-capable fake and NO transport variable: whatever this session
    // comes up on is the default, which is the whole assertion
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it really is Direct: no terminal behind the Terminal tab...
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });

    // ...and the menu names Direct as the CURRENT mode, so the one control that
    // states the mode agrees with the session (the two disagreed in #153)
    await w.getByRole('button', { name: '⋯' }).first().click();
    await expect(w.getByRole('button', { name: /switch to Terminal/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  // The other half of the promise, and the reason this is a DEFAULT and not a
  // migration: choosing Terminal is still a choice, and a default that could
  // overwrite it would make the setting decorative. No env anywhere in this
  // test — the only two things deciding are the default and the stored answer.
  test('a session switched to Terminal is still on Terminal after a relaunch', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const first = a;
    await expect(first.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // born in Direct, moved to Terminal by hand
    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await first.window.getByRole('button', { name: /switch to Terminal/i }).click();
    await first.window.getByRole('button', { name: /Restart session now/i }).click();
    // POSITIVELY, not by the absence of the notice: during the restart the card
    // body is unmounted entirely, so "no notice on screen" is also true of the
    // gap in between — `toHaveCount(0)` would be satisfied by the wrong state.
    // The menu naming Terminal as the CURRENT mode can only be true of a live
    // session on the PTY.
    await first.window.getByRole('button', { name: '⋯' }).first().click();
    await expect(first.window.getByRole('button', { name: /switch to Direct/i })).toBeVisible({
      timeout: 30_000,
    });
    await first.window.keyboard.press('Escape');
    await first.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(first.window.getByText('No terminal for this session')).toHaveCount(0);
    await first.close();

    // same profile, fresh process, still no env — and deliberately NO
    // seedFolder, which would create a second card and move the assertion onto
    // the wrong one (the lesson from the relaunch test above)
    a = await launchApp({ home: first.home, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    await expect(a.window.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    await a.window.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(a.window.getByText('No terminal for this session')).toHaveCount(0, {
      timeout: 30_000,
    });
    // and the menu still reads Terminal as the current mode
    await a.window.getByRole('button', { name: '⋯' }).first().click();
    await expect(a.window.getByRole('button', { name: /switch to Direct/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
