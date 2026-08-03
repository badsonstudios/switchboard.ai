// P2-E15-15: app version + build identity. The failure this exists to kill —
// a hand-tester running a stale `out/` build and reading its old bugs as a PR
// failing — is only really gone if the identity survives the WHOLE pipeline:
// git → vite `define` → the renderer bundle → the screen, and → main's window
// title. Unit tests cover the formatting; this covers the wiring, which is the
// part that can silently produce "unknown" forever.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const about = (w: Page) => w.getByRole('dialog', { name: 'About this build' });
const field = (w: Page, name: string) => about(w).locator(`[data-about-field="${name}"]`);
const stamp = (w: Page) =>
  w.getByRole('button', { name: 'Version and build — click for details' });

/**
 * The shell is mounted and listening.
 *
 * `launchApp` resolves on `domcontentloaded`, which is BEFORE React has mounted
 * — and App renders an empty div until its UI state loads, so no key handler
 * exists yet and the #90 accelerator handshake has not happened either. A chord
 * pressed in that window goes nowhere and the test then waits 30s for a palette
 * that was never asked to open. Every other keyboard spec waits on a session
 * card first; these launch with no session, so they wait on the title bar.
 */
async function shellReady(w: Page): Promise<void> {
  await expect(stamp(w)).toBeVisible();
}

/** The OS window title, which the page's own <title> must not have overwritten. */
async function windowTitle(a: LaunchedApp): Promise<string> {
  return a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
}

test.describe('build identity (E15-15)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the title bar carries a real commit stamp, one click from the full identity', async () => {
    a = await launchApp();
    const w = a.window;
    await shellReady(w);

    // The stamp is a REAL short SHA, not the fail-open placeholder: this is the
    // single assertion that proves the define survived the renderer build.
    await expect(stamp(w)).toHaveText(/v\d+\.\d+\.\d+\s*[0-9a-f]{8}\*?/);

    await stamp(w).click();
    await expect(about(w)).toBeVisible();
    await expect(field(w, 'commit')).toHaveText(/^[0-9a-f]{8}\*?$/);
    await expect(field(w, 'version')).toHaveText(/^\d+\.\d+\.\d+$/);
    // The age computed from a real timestamp — the field that actually catches
    // a stale out/ directory. Asserted by SHAPE, not by a number: this build is
    // minutes old, but the suite's own runtime must not decide whether the
    // assertion passes.
    await expect(field(w, 'age')).toHaveText(/^(just now|\d+ (min|h) ago)$/);
    await expect(field(w, 'builtAt')).not.toHaveText('unknown');
    await expect(field(w, 'branch')).not.toHaveText('unknown');

    await w.keyboard.press('Escape');
    await expect(about(w)).toHaveCount(0);
  });

  test('the palette reaches it too — capability never depends on finding the chrome', async () => {
    a = await launchApp();
    const w = a.window;
    await shellReady(w);
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('build');
    // By ROW ID, not by text: the palette splits a matched title into one
    // element per character to bold the hits, so a text locator is at the mercy
    // of how the fuzzy matcher happened to chop this particular title up.
    const row = w.locator('[id="palette-row-help.about"]');
    await expect(row).toContainText('About this build');
    await row.click();
    await expect(about(w)).toBeVisible();
  });

  test('the window title reports the branch whenever this is not a clean main build', async () => {
    a = await launchApp();
    const w = a.window;
    await shellReady(w);
    await stamp(w).click();
    const commit = (await field(w, 'commit').textContent())!.trim();
    const branch = (await field(w, 'branch').textContent())!.trim();

    const title = await windowTitle(a);
    if (branch === 'main' && !commit.endsWith('*')) {
      // a clean release build carries no noise at all
      expect(title).toBe('switchboard');
    } else {
      // …and every other build says which one it is, readable from the taskbar
      expect(title).toContain(commit);
      expect(title).toContain(branch);
    }
    // whichever branch we are on, index.html's <title> must not have won
    expect(title.startsWith('switchboard')).toBe(true);
  });
});
