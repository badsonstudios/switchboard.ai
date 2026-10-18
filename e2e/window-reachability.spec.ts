// #1277 — a window that EXISTS is not a window anybody can SEE.
//
// The owner's log: every heartbeat counted `windows: 1` while the main window
// sat where no display showed it, and every permission request in that stretch
// waited its full 300 s for a person who could not see the approval bar, then
// was denied — six in a row, five minutes apart. The gate asked whether a
// window existed; it now asks whether anybody could reach it, and a request
// that arrives while nobody can is answered AT ONCE, with words that tell the
// agent to stop rather than to retry.
//
// The unit tests (`window-reach.test.ts`, `stream-permissions.test.ts`) pin the
// predicate and the router. This is the wiring between them in the real app:
// that `index.ts` hands the router a probe built from the real BrowserWindow,
// and that the window coming back puts holds back on.
//
// The fake CLI narrates the denial `message` it was sent as `DENIAL MESSAGE:`
// (`fake-stream-protocol`), so what is asserted is the payload on the wire.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { findFile, launchApp, LaunchedApp, pollAsync } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
/** the clause `StreamPermissions` uses for an alive-but-unreachable window */
const UNSEEN = /window was open but not where anyone could see it/;

/** the requests MAIN is still holding */
function heldIds(w: Page): Promise<string[]> {
  return w.evaluate(() =>
    window.switchboard.sessions.pendingPermissions().then((l) => l.map((p) => p.requestId))
  );
}

async function ask(w: Page, target: string): Promise<void> {
  const box = w.getByPlaceholder(/Prompt this session/);
  await box.click();
  await box.fill(`!perm ${target}`);
  await box.press('Enter');
}

/** the app's log, once it contains `needle` */
function logContaining(home: string, needle: string): Promise<string> {
  return pollAsync(
    () => {
      const f = findFile(home, 'switchboard.log');
      if (f === null) return Promise.resolve(null);
      const text = fs.readFileSync(f, 'utf8');
      return Promise.resolve(text.includes(needle) ? text : null);
    },
    `the log never said "${needle}"`,
    20_000
  );
}

/**
 * hide or show the MAIN window (not a popout).
 *
 * Shown the way the app itself would show it: inactive in a quiet launch
 * (`SWITCHBOARD_E2E_NO_ACTIVATE`, #1332), because a bare `show()` activates and
 * this spec is about whether the window is VISIBLE, not whether it is in front.
 */
async function setMainShown(a: LaunchedApp, shown: boolean): Promise<void> {
  await a.app.evaluate(({ BrowserWindow }, on) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/index.html'));
    if (!on) win?.hide();
    else if (process.env.SWITCHBOARD_E2E_NO_ACTIVATE === '1') win?.showInactive();
    else win?.show();
  }, shown);
}

test.afterAll(async () => teardown());

test.describe('a window nobody can see is treated as no window (#1277)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await teardown(launched);
  });

  test('hidden: the request is declined at once, and holds again once it is shown', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // Put the prompt in the box FIRST, while the window can still take input,
    // then hide it and send: the request must arrive at a window nobody sees.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm unseen.sh');
    await setMainShown(a, false);
    await box.press('Enter');

    // Asserted from MAIN's side while the window is hidden (review): a hidden
    // renderer is throttled, and unmapped under xvfb, so its DOM is not the
    // witness. The log line is the sync point — once it is written the request
    // has been answered — and then nothing may still be held.
    const log = await logContaining(a.home, 'the window is open but nobody can see it');
    expect(log).toContain('"msg":"main window hide"');
    expect(log).toMatch(/nobody can see it[^\n]*"why":"hidden"/);
    expect(await heldIds(w)).toEqual([]);
    expect(fs.existsSync(path.join(folder, 'unseen.sh'))).toBe(false);

    // Shown again: the card carries the denial the agent was sent — answered
    // at once, no 300 s hold — and no bar.
    await setMainShown(a, true);
    await expect(w.getByText(UNSEEN)).toBeVisible({ timeout: 30_000 });
    await expect(w.getByText('Allow Write?')).toHaveCount(0);

    // ...and the next request is HELD for a person, exactly as before.
    await ask(w, 'seen.sh');
    await expect(w.getByText('Allow Write?')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(() => {
      expect(fs.existsSync(path.join(folder, 'seen.sh'))).toBe(true);
    }).toPass({ timeout: 20_000 });
  });

  test('off every display: declined at once, and the move is logged', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm offscreen.sh');
    // Far past the right edge of every display there is.
    const landed = await a.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/index.html'))!;
      const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
      win.setBounds({ x: right + 4000, y: 100, width: 1100, height: 760 });
      const b = win.getBounds();
      const onSome = screen
        .getAllDisplays()
        .some((d) => b.x < d.workArea.x + d.workArea.width && b.x + b.width > d.workArea.x);
      return { onSome };
    });
    // A window manager that refuses to place a window off-screen leaves nothing
    // to test here; the hidden case above covers the gate either way.
    test.skip(landed.onSome, 'this platform clamped the window back onto a display');
    await box.press('Enter');

    // main's side first, as above: the gate's log line is the sync point
    const log = await logContaining(a.home, 'the window is open but nobody can see it');
    expect(log).toMatch(/nobody can see it[^\n]*"why":"off every attached display"/);
    // the placement log's own line is debounced behind the move, so poll for it
    await logContaining(a.home, 'main window is off every attached display');
    expect(await heldIds(w)).toEqual([]);
    expect(fs.existsSync(path.join(folder, 'offscreen.sh'))).toBe(false);
    await expect(w.getByText(UNSEEN)).toBeVisible({ timeout: 30_000 });
  });
});
