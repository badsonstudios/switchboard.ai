// Gated tool calls on the Direct transport, and the attention they must NOT
// raise: no terminal-handoff bar over a session that has no terminal (#310), no
// status / beep / Events row when allow-all answers in main (#319), and no hook
// `Notification` faking a permission the CLI never asked for (#313).
//
// Split out of `stream.spec.ts` by #626 (move-only). See that file's header for
// the whole `stream*.spec.ts` family and what belongs where. The Direct
// approval BAR is `stream-approval.spec.ts`; this file is about the calls that
// must never surface one.
//
// TRANSPORT SCOPE (P2-E18-18, #404): Direct throughout. The PTY counterparts —
// where a handoff bar is CORRECT — are in `approval.spec.ts`, and the two read
// as bugs in each other unless read together.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

/**
 * "No permission request ever reached the attention queue."
 *
 * Read off the events TAB rather than the drawer's rows (P2-E14-01): the drawer
 * is collapsed by default now, so counting rows in it would pass for the wrong
 * reason — there would be nothing in the DOM to count whatever the feed thinks.
 * Opening it is worse here than elsewhere, because it overlays the right edge
 * of the workspace and these tests go on to click buttons underneath it.
 *
 * The tab is always visible and always current, and `data-hottest` answers this
 * exact question: `needs-permission` is the TOP of the queue's priority ladder
 * (lib/queue.ts), so if one had arrived it would be the hottest thing there —
 * no other kind can outrank it and hide it.
 */
async function noPermissionInQueue(w: Page): Promise<void> {
  await expect(w.getByTestId('events-tab')).not.toHaveAttribute(
    'data-hottest',
    'needs-permission'
  );
}

// The net for the last test's stragglers: by now every app in this file is
// gone, so a folder that was merely late to unlock goes on this pass.
test.afterAll(async () => teardown());

// #310 — an allow-all Direct session runs gated tools with NO handoff banner.
//
// Dan, dogfooding 2026-08-06: a Direct session with "Allow all (this session)"
// on grew "Claude is asking permission in the terminal", over an [Open Terminal]
// button, above the composer, on EVERY gated call — for about five seconds each
// time, in a transport that has no terminal. Two causes, both fixed here:
// `StreamPermissions.decide` never applied `permission-resolved` (so the status
// only left `needs-permission` when the CLI next spoke, i.e. after the tool had
// run), and the renderer's auto-allow branch answered without opening the
// `recentlyDecided` window the manual Allow/Deny path opens.
//
// AN INDEPENDENT GUARD, deliberately. The transport prop that would let
// `terminalHandoff` short-circuit on `transport === 'stream'` is #261's fix and
// is NOT on this branch — `panels.tsx` still does not forward `ctx.transport`
// to `<FeedView>`. So everything asserted below is carried by the status and
// suppression fixes alone. It keeps its value after #261 lands: that fix hides
// the bar, this one proves the state underneath it is not wrong.
//
// IT USES `!permhang`, AND THAT IS THE WHOLE TEST. Measured while writing it:
// with both fixes reverted and a plain `!perm`, this spec still PASSED — the
// fake answers and replies in the same tick, so the buggy `needs-permission`
// window never survived a task boundary and there was nothing to catch. The bug
// lives in the seconds a REAL tool spends running while the CLI says nothing,
// and `!permhang` is that silence, modelled: the fake performs the write and
// then emits nothing at all. Under the old code the card stays in
// `needs-permission` for ever there; under this one it is `working` the instant
// the answer is sent. Re-verified by reverting both fixes: this then fails with
// one counted frame, and the bar is still on screen when the test ends.
//
// It is the STATUS fix this pins, measured the same way: restoring
// `StreamPermissions.decide`'s `permission-resolved` alone makes it pass again,
// because against the fake the IPC round trip is too short for a frame to land
// in between. The renderer's `suppressHandoff` covers that round trip — a
// loaded machine, a busy renderer — and is pinned where it can be asserted
// without a race, in `lib/held-permissions.test.ts`.
//
// A MutationObserver rather than a poll so the count is of DOM CHANGES, not of
// samples — a bar that came and went between two 100ms probes would be invisible
// to a poll and is not to this. It is not infinitely fine either, and it should
// not be read as if it were: observer callbacks are batched at the microtask
// checkpoint, so a node added AND removed inside one batch leaves nothing for
// `innerText` to find. That is the limit, and it is comfortably below the thing
// under test — the hold and its resolution arrive on separate IPC messages, and
// reverting the fixes does make this fail.
test.describe('allow-all in Direct mode never hands off to a terminal (#310)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  /** the handoff bar's headline, verbatim from `i18n/locales/en.json` */
  const HANDOFF = /Claude is asking permission in the terminal/i;

  test('a gated tool runs end to end with the handoff bar never rendered', async () => {
    // Two full turns plus a deliberate 3s sit in the silence, against a 60s
    // default. Comfortable on this machine (~25s) and not on a cold runner,
    // where a timeout would cost two runs under `retries: 1`.
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);

    // 1. the first gated call is answered by hand — this is what turns allow-all
    //    on, and it is the only bar the user should ever see in this test.
    await box.click();
    await box.fill('!perm .claude/scripts/one.sh');
    await box.press('Enter');
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'one.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });

    // 2. start counting commits that contain the bar. Installed AFTER the manual
    //    answer so the count is about the AUTO-allow path and nothing else.
    await w.evaluate((pattern) => {
      const win = window as unknown as { __sbHandoffFrames?: number };
      win.__sbHandoffFrames = 0;
      const re = new RegExp(pattern, 'i');
      const look = (): void => {
        if (re.test(document.body.innerText ?? '')) win.__sbHandoffFrames!++;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      look(); // the state it starts in counts too
    }, HANDOFF.source);

    // 3. a second gated call, answered by the allow-all path with no bar, no
    //    queue and no user click — and then a tool that RUNS while the CLI
    //    stays silent, which is where the five seconds used to go.
    await box.click();
    await box.fill('!permhang .claude/scripts/two.sh');
    await box.press('Enter');
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'two.sh'))).toBe(true);
    }).toPass({ timeout: 30_000 });
    // The file proves the answer was delivered. Now sit in the silence: nothing
    // further will ever arrive on this turn, so this is the whole window the old
    // code spent advertising a question that had already been answered.
    await w.waitForTimeout(3_000);

    // 4. the whole point: not once, not for a frame.
    const frames = await w.evaluate(
      () => (window as unknown as { __sbHandoffFrames?: number }).__sbHandoffFrames ?? -1
    );
    expect(frames, 'the terminal-handoff bar rendered during an auto-allowed tool call').toBe(0);
    await expect(w.getByText(HANDOFF)).toHaveCount(0);
  });
});

// #319 — an allow-all Direct session answers its own gated calls, in MAIN.
//
// #310 killed the handoff banner and left the rest of the promise unkept. Dan
// still got a BEEP and a taskbar flash on every gated call of an allow-all
// Direct session, plus an Events row, because the verdict lived only in the
// renderer: `sessions:allowAllSession` told `HookListener` (which passes stream
// sessions straight through) and nothing else, so every call still travelled
// main -> renderer -> main, and `streamStatusEvent` mapped it to
// `permission-held` on the way — `apply` -> `onStatusChange` -> `feed.ingest` ->
// ATTENTION -> `Notifier.shell.beep()` -> taskbar flash -> an Events row.
//
// The beep is not observable from here. THE STATUS IT HANGS OFF IS, and it is
// the same signal: nothing reaches the Notifier that did not first become a
// status change, and nothing becomes an Events row either. So a turn that never
// enters `needs-permission` is a turn that cannot have beeped.
//
// `!permhang` again, for #310's reason and one more. It models the silence a
// real tool call spends most of its life in — the fake performs the write and
// then emits NOTHING — and that silence is what gives this test teeth: with the
// suppression reverted the card enters `needs-permission` and STAYS there,
// because the CLI has nothing more to say and (allow-all having answered at the
// server) there is no decision coming to resolve it either. Measured both ways;
// see the assertions.
test.describe('allow-all in Direct mode answers at the server (#319)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  const permissionRow = 'nav .rail-row[data-session-status="needs-permission"]';

  test('a gated call raises no attention at all: no status, no Events row', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);

    // 1. the first call is answered by hand — this is what turns allow-all on,
    //    and it is the only attention this session is allowed to raise.
    await box.click();
    await box.fill('!perm .claude/scripts/one.sh');
    await box.press('Enter');
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });
    // it really did reach needs-permission — otherwise the absences below prove
    // only that nothing ever happens in this app
    await expect(w.locator(permissionRow)).toHaveCount(1, { timeout: 15_000 });
    await w.getByRole('button', { name: 'Allow all (this session)' }).click();
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'one.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    // and the baseline is clean again before anything is counted
    await expect(w.locator(permissionRow)).toHaveCount(0, { timeout: 20_000 });
    await noPermissionInQueue(w);

    // 2. count every commit in which the rail claims this session needs
    //    permission. `attributes` matters and `characterData` does not: the
    //    status is an ATTRIBUTE on a row that is never added or removed, so an
    //    observer without it would watch the wrong thing and pass for ever.
    await w.evaluate((selector) => {
      const win = window as unknown as { __sbPermFrames?: number };
      win.__sbPermFrames = 0;
      const look = (): void => {
        if (document.querySelector(selector)) win.__sbPermFrames!++;
      };
      new MutationObserver(look).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      look(); // the state it starts in counts too
    }, permissionRow);

    // 3. a gated call answered entirely in main, followed by the silence.
    await box.click();
    await box.fill('!permhang .claude/scripts/two.sh');
    await box.press('Enter');
    await expect(() => {
      expect(fs.existsSync(path.join(folder, '.claude', 'scripts', 'two.sh'))).toBe(true);
    }).toPass({ timeout: 30_000 });
    // The file proves the CLI got its answer without a renderer round trip.
    // Now sit in the silence — nothing further will ever arrive on this turn.
    await w.waitForTimeout(3_000);

    // 4. the claim. No frame of `needs-permission`, so no beep and no flash…
    const frames = await w.evaluate(
      () => (window as unknown as { __sbPermFrames?: number }).__sbPermFrames ?? -1
    );
    expect(frames, 'the rail reported needs-permission during an auto-allowed call').toBe(0);
    // …and the same fact read off the other surface it would have reached.
    await noPermissionInQueue(w);
    // no review bar was raised either: the request never left main
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);
  });
});

// #313 — a Direct session's own hook Notification cannot flip it to
// needs-permission, and the SESSION fires it, not the test.
//
// A Direct session runs BOTH signal channels into one state machine.
// `stream-status.ts` maps `can_use_tool` -> `needs-permission` exactly; the hook
// `Notification` arm in `state-machine.ts` transitions on a regex over the CLI's
// DEBOUNCED nudge, with no evidence anything is held. On stream every real
// permission arrives on the control channel, so the hook route is a duplicate at
// best and a false alarm at worst — the nudge landing after a request was
// answered, dragging a working card back to "needs permission" with nothing held
// and no bar to answer. That is the beep, the taskbar flash and the Events row
// Dan reported, for a question that does not exist.
//
// THE FAKE FIRES IT ITSELF (`!notify`), and that is the point of the seam rather
// than a flourish. `hookPoster` posts from the test process, which proves what
// the listener does with a POST; it cannot prove a Direct session HAS a hook
// channel at all — and it was exactly that unanswerable question that left #261
// part B to be settled by reading code. `!notify` runs the forwarder command out
// of the `--settings` file the session was spawned with, so this is the real
// port, the real token and the real listener, reached from inside the session.
//
// The turn is left OPEN by `!notify` (the `!hang` shape), so nothing overwrites
// the status afterwards: a false `needs-permission` would be entered and STAYED
// IN, which is what gives the first phase its teeth. Measured with the guard
// reverted: the row reaches `needs-permission` and never leaves.
test.describe('a hook Notification cannot fake a permission on Direct (#313)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('the nudge is dropped, while the same channel still moves the badge', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({
      seedFolder: folder,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_TRANSPORT: 'stream' },
    });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    // it really is Direct — otherwise all of this is a PTY test that passes
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    const box = w.getByPlaceholder(/Prompt this session/);
    const row = (status: string): string => `nav .rail-row[data-session-status="${status}"]`;

    // 1. the nudge. Verbatim the payload the live incident produced: the CLI's
    //    debounced notification, with no PreToolUse and therefore no hold.
    await box.click();
    await box.fill('!notify permission_prompt Claude needs your permission to use Write');
    await box.press('Enter');

    // The prompt was sent, so the card is working — and it must STAY working:
    // the notification is fired inside that turn, synchronously, before the fake
    // goes quiet.
    await expect(w.locator(row('working'))).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(3_000); // nothing else will ever arrive on this turn
    await expect(w.locator(row('needs-permission'))).toHaveCount(0);
    // and nothing rang the bell on the way past, either
    await noPermissionInQueue(w);

    // 2. THE CONTROL, and the reason the absence above means anything. The same
    //    command, the same forwarder, the same listener — one word of payload
    //    different — and the badge moves. So the hook channel is live in this
    //    session and phase 1 was a suppression, not a delivery failure.
    await box.click();
    await box.fill('!notify idle Claude is waiting for your input');
    await box.press('Enter');
    await expect(w.locator(row('idle'))).toHaveCount(1, { timeout: 20_000 });

    // 3. the tightest form of the claim: the same nudge again, now that the
    //    channel has been PROVEN live one message ago. (The new prompt walks the
    //    card back to `working` on its own — `prompt-sent` — so this asserts the
    //    turn is running and nothing else, exactly as phase 1 did.)
    await box.click();
    await box.fill('!notify permission_prompt Claude needs your permission to use Write');
    await box.press('Enter');
    await expect(w.locator(row('working'))).toHaveCount(1, { timeout: 20_000 });
    await w.waitForTimeout(3_000);
    await expect(w.locator(row('needs-permission'))).toHaveCount(0);
    await noPermissionInQueue(w);
  });
});
