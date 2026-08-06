// One switchboard per profile (#289).
//
// The bug this pins is not "two windows appeared" — it is what the second
// window's process does on the way in. Both instances derive the same
// `stateDir` from the same `userData`, so the newcomer's startup sweep deletes
// the RUNNING instance's live hook-token files (#282). The first app keeps
// running and looks perfectly healthy while every hook the CLI fires at it
// 401s: no status flips, no native-id binding, no permission holds. So this
// spec asserts the tokens survive, not just that no window opened.
//
// Focus is deliberately NOT asserted here. A raise is a window-manager
// behaviour, and CI runs headless under xvfb with no WM to honour it; the
// unminimize/show/focus sequence is unit-tested instead
// (`src/main/single-instance.test.ts`).
import { test, expect } from '@playwright/test';
import {
  findTokens,
  launchApp,
  launchSecondInstance,
  LaunchedApp,
  poll,
  tempProjectFolder,
} from './fixtures/app';

test.describe('a second launch does not start a second app', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the second process exits, and the running app keeps its hook tokens', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    await expect(a.window.getByText('No conversation yet')).toBeVisible({ timeout: 25_000 });

    // the live session's hook token, as it is on disk right now
    const before = await poll(() => {
      const t = findTokens(a.home);
      return t.size >= 1 ? t : null;
    });

    const second = await launchSecondInstance(a.home);
    expect(second.timedOut, `second instance never exited (stderr: ${second.stderr})`).toBe(false);
    expect(second.code, `second instance exited badly (stderr: ${second.stderr})`).toBe(0);
    // it should leave promptly — the lock is taken before anything else the
    // bootstrap does, so this is startup-to-exit with no window and no state
    expect(second.ms).toBeLessThan(15_000);

    // the running app is untouched: still one window...
    expect(a.app.windows().length).toBe(1);
    // ...still answering...
    const cards = await a.window.evaluate(() => window.switchboard.sessions.cards());
    expect(cards.length).toBe(1);
    // ...and its hook tokens are exactly the ones it wrote. THIS is the
    // regression: without the lock, the second process's sweep unlinks them and
    // this map comes back empty.
    const after = findTokens(a.home);
    expect([...after.entries()]).toEqual([...before.entries()]);
  });
});
