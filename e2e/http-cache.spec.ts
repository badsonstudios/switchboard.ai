// The browser cache stays empty (#744), in the real app.
//
// Measured on an installed machine: 208 MB of cache, 189 MB of it twenty
// copies of the renderer bundle. The renderer is served from a loopback port
// the system picks on every launch, so a cached copy is stored under an
// address that is never asked for again, and one more is left behind each
// time.
//
// Only the real app can show the fix holding: the bundle really is about ten
// megabytes, and Chromium really does decide what to keep. Run against the
// code before the fix, this fails at the header: the server sent none.
import { test, expect } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('the browser cache stays empty (#744)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('after a launch, a session and a reload, nothing of the app’s own code has been stored', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // served the way an installed build is: over loopback http
    expect(w.url()).toMatch(/^http:[/][/]127[.]0[.]0[.]1:/);
    // every one of the app's own files says it is not to be stored
    const answer = await w.evaluate(async () => {
      const script = [...document.scripts].map((s) => s.src).find((src) => src.includes('/assets/'));
      const res = await fetch(script ?? '/index.html');
      return { url: script ?? '/index.html', cache: res.headers.get('cache-control'), bytes: (await res.blob()).size };
    });
    expect(answer.cache).toBe('no-store');
    // (so the size below is being compared with something real)
    expect(answer.bytes).toBeGreaterThan(1_000_000);

    // load everything a second time, the way a second launch would
    await w.reload();
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // THE CLAIM: the cache holds less than a tenth of one copy of the bundle
    await expect
      .poll(() => a.app.evaluate(({ session }) => session.defaultSession.getCacheSize()), { timeout: 15_000 })
      .toBeLessThan(answer.bytes / 10);
  });
});
