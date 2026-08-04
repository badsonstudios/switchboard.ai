// #185 — the busy-sessions quit confirmation (P1-E6-02), and the fixture guard
// that keeps it out of every OTHER spec's teardown.
//
// The dialog is a main-process `showMessageBoxSync`. It is not a page, so
// Playwright cannot click it; while it is up the close path is blocked and the
// app never exits. Quitting with a session in `working` / `needs-input` /
// `needs-permission` raises it. No spec had ever driven a fake session into one
// of those states before quitting, so nothing hit it — but nothing stopped it
// either, and the first spec that quit mid-work would have hung the suite.
//
// So the fixtures now set `SWITCHBOARD_NO_QUIT_CONFIRM=1` on every launch, and
// this file is the pair of tests that keeps that honest:
//
//  1. with the guard on (the default every other spec gets), a quit with a
//     session mid-work completes;
//  2. with the guard OFF, the dialog really does fire, names the busy session,
//     and Cancel really does keep the app alive — i.e. test 1 passes because of
//     the guard, not because the dialog was never going to appear.
//
// Both drive the status through the REAL hook listener, as attention.spec.ts
// and urgency.spec.ts do: the test plays the CLI's part with a UserPromptSubmit
// POST, and the status machine does the rest.
import { test, expect } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  LaunchOptions,
  tempProjectFolder,
  hookPoster,
  sessionStatuses,
} from './fixtures/app';

/** Somewhere to hang a recording inside the main process between evaluate() calls. */
type Stash = typeof globalThis & { __sbQuitPrompts?: string[] };

/**
 * The launched app, at MODULE scope so `sessionMidWork` can publish it the
 * instant `launchApp` returns.
 *
 * Deliberate, not laziness: a helper that launched into a local and handed the
 * handle back at the end would leave `afterEach` with nothing to clean if any
 * assertion inside it failed, leaking the Electron + PTY tree and hanging the
 * worker on teardown — the CI poison called out in
 * `docs/code-review-2026-07-23-phase-2-e10.md:185`.
 */
let a: LaunchedApp;

/**
 * Launch one seeded session and leave it in `working` — a member of the busy set.
 *
 * The status is checked against main's RAW record, not the DOM: a seeded fake
 * session sits in `starting`, which the urgency lamp already paints with the
 * `working` token, so a DOM assertion here would pass whether or not the hook
 * POST landed — and `starting` is not busy. That would make the whole file
 * vacuous.
 */
async function sessionMidWork(opts: LaunchOptions = {}): Promise<string> {
  const folder = tempProjectFolder();
  a = await launchApp({ seedFolder: folder, ...opts }); // publish before anything can throw
  const title = path.basename(folder);
  await expect
    .poll(() => sessionStatuses(a).then((m) => [...m.keys()]), { timeout: 25_000 })
    .toContain(title);

  const post = await hookPoster(a);
  await post(title, { hook_event_name: 'UserPromptSubmit' });
  await expect
    .poll(() => sessionStatuses(a).then((m) => m.get(title)), { timeout: 15_000 })
    .toBe('working');
  return title;
}

/**
 * Close the app and say WHICH thing happened, rather than letting a hang run
 * out the test timeout with no explanation (#165's lesson: fail by name).
 * Generous budget — a normal teardown here is a couple of seconds, and this is
 * only trying to tell "finished" from "waiting on a human forever".
 */
async function closeWithin(ms = 20_000): Promise<'closed' | 'blocked'> {
  return Promise.race([
    a.app.close().then(() => 'closed' as const),
    new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), ms)),
  ]);
}

/**
 * Stand in for the human at the dialog: record what it was asked, answer
 * `choice` (0 = Quit anyway, 1 = Cancel — main's own button order).
 *
 * Every test here arms this, INCLUDING the one that expects the dialog never to
 * open: a regression then leaves a readable recording instead of a real modal
 * parked on the developer's screen or on a headless CI runner.
 */
async function armDialogRecorder(choice: 0 | 1): Promise<void> {
  await a.app.evaluate(({ dialog }, answer) => {
    const g = globalThis as Stash;
    g.__sbQuitPrompts = [];
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      // main calls the (window, options) overload; tolerate both
      const o = (args.length > 1 ? args[1] : args[0]) as { message?: string };
      g.__sbQuitPrompts!.push(String(o?.message ?? ''));
      return answer;
    }) as unknown as typeof dialog.showMessageBoxSync;
  }, choice);
}

/** Every message the recorder has been asked to show since it was armed. */
function recordedPrompts(): Promise<string[]> {
  return a.app.evaluate(() => (globalThis as Stash).__sbQuitPrompts ?? []);
}

test.describe('quit confirmation with busy sessions (#185)', () => {
  test.afterEach(async () => a?.cleanup());

  test('a session mid-work does not block teardown — the fixture guard reaches main', async () => {
    await sessionMidWork();

    // the guard is a main-process env var; assert it ARRIVED, so a fixture that
    // silently stopped passing it fails here instead of hanging some unrelated
    // spec months from now
    expect(await a.app.evaluate(() => process.env.SWITCHBOARD_NO_QUIT_CONFIRM)).toBe('1');

    // Cancel, so that a regression keeps the app alive to be interrogated below
    // rather than sailing past on the answer the recorder happened to give.
    await armDialogRecorder(1);

    const outcome = await closeWithin();
    if (outcome === 'blocked') {
      // still up, so it can say why
      const recorded = await recordedPrompts().catch(() => ['<main process unreachable>']);
      expect(recorded, 'teardown was blocked by the busy-sessions dialog').toEqual([]);
    }
    expect(outcome, 'quit with a session in `working` never completed').toBe('closed');
  });

  test('with the guard off the modal fires, names the session, and Cancel keeps the app', async () => {
    // '' rather than omitting the key: `opts.env` is applied over the fixture
    // default, so this is how a spec turns the guard back off.
    const title = await sessionMidWork({ env: { SWITCHBOARD_NO_QUIT_CONFIRM: '' } });
    expect(await a.app.evaluate(() => process.env.SWITCHBOARD_NO_QUIT_CONFIRM || '')).toBe('');

    await armDialogRecorder(1); // the human clicks Cancel

    await a.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });

    // Electron's close is not guaranteed to have run the handler by the time
    // close() returns, so poll for the recording rather than reading it once.
    await expect.poll(() => recordedPrompts(), { timeout: 15_000 }).toHaveLength(1);

    const [asked] = await recordedPrompts();
    expect(asked).toContain(title); // it says WHO is mid-task...
    expect(asked).toContain('working'); // ...and what they are doing
    // Cancel was honoured — the window is still standing
    const windows = await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windows, 'Cancel did not stop the close').toBeGreaterThan(0);

    // ...and "Quit anyway" lets it go: the dialog is a gate, not a wall. (Also
    // what lets afterEach tear down without waiting out the close timeout.)
    await armDialogRecorder(0);
    expect(await closeWithin(), 'Quit anyway did not let the app close').toBe('closed');
  });
});
