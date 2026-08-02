// P2-E15-12 / AR-P2-10 — the Content-Security-Policy must arrive as a HEADER,
// on both windows, and it must actually be enforced.
//
// The policy used to be a <meta> tag that index.html itself admitted only
// worked in dev because Vite injected its preamble above it. A meta tag would
// still pass "the policy is in effect" checks, so these tests read the header
// off the wire as well as proving enforcement — the two together are what say
// the mechanism changed and not just the outcome.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';
import { CSP_PROD, CSP_PROD_META } from '../src/shared/csp';

/** The `content-security-policy` header this document was served with. */
async function servedPolicy(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch(location.href, { cache: 'no-store' });
    return res.headers.get('content-security-policy');
  });
}

/**
 * True when an inline <script> is refused. `script-src 'self'` without
 * 'unsafe-inline' is the load-bearing half of the policy — this is what a
 * hostile string reaching the DOM would try.
 */
async function inlineScriptBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { __cspProbe?: boolean };
    delete w.__cspProbe;
    const s = document.createElement('script');
    s.textContent = 'window.__cspProbe = true;';
    document.head.appendChild(s);
    s.remove();
    return w.__cspProbe !== true;
  });
}

test.describe('CSP is header-based (#109)', () => {
  // reset the handle, not just clean it up: one test in here never launches an
  // app, and it would otherwise inherit — and re-close — the previous test's
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('the main window is served the policy as a header, and it is enforced', async () => {
    a = await launchApp();
    const { window } = a;
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible({ timeout: 25_000 });

    expect(await servedPolicy(window)).toBe(CSP_PROD);
    expect(await inlineScriptBlocked(window), 'inline script ran — CSP not enforced').toBe(true);
  });

  test('the renderer boots with no CSP violation in the console', async () => {
    a = await launchApp();
    const violations: string[] = [];
    a.window.on('console', (msg) => {
      if (/content security policy|refused to/i.test(msg.text())) violations.push(msg.text());
    });
    // RELOAD, deliberately: launchApp() already awaited domcontentloaded, so
    // every violation raised while the head and body were parsed — the entry
    // <script>, the stylesheet, a directive a <meta> cannot carry — happened
    // before the listener above existed. Without this the test is blind to
    // exactly the failures it is here to catch.
    await a.window.reload();
    // a real render pass, not just the empty shell: the entry chunk, the
    // stylesheet, the runtime-injected styles and the app's own listeners
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible({ timeout: 25_000 });
    await expect(a.window.getByText('No sessions yet')).toBeVisible();
    await a.window.evaluate(() => new Promise((r) => setTimeout(r, 250)));
    expect(violations).toEqual([]);
  });

  test('the built html keeps the prod policy as a meta backstop', () => {
    // main falls back to loadFile() if the loopback server cannot bind, and
    // file:// responses are not interceptable by webRequest — the backstop is
    // the only policy that path ever sees. Same constant, so it cannot drift.
    const dist = path.resolve(__dirname, '..', 'out', 'renderer');
    for (const file of ['index.html', 'popout.html']) {
      // Vite escapes the policy's quotes as &#39; in the attribute; the parser
      // decodes them, so compare what the browser will actually read.
      const html = fs.readFileSync(path.join(dist, file), 'utf8').replace(/&#39;/g, "'");
      expect(html, `${file} lost its CSP backstop`).toContain('http-equiv="Content-Security-Policy"');
      expect(html, `${file} backstop drifted from CSP_PROD_META`).toContain(CSP_PROD_META);
      // frame-ancestors in a meta tag is ignored AND logged as an error every
      // launch — the backstop must carry the meta-safe subset, not CSP_PROD
      expect(html, `${file} carries a directive <meta> cannot express`).not.toContain('frame-ancestors');
    }
  });

  test.describe('popout window', () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
    );

    test('gets the same policy as a header', async () => {
      a = await launchApp({ seedFolder: tempProjectFolder() });
      const w = a.window;
      await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

      await w.getByTitle('Pop out into its own window').click();
      await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);

      const popout = a.app.windows().find((p) => p.url().includes('popout.html'));
      expect(popout, 'no popout page found').toBeTruthy();
      expect(await servedPolicy(popout!)).toBe(CSP_PROD);
      expect(await inlineScriptBlocked(popout!), 'inline script ran in the popout').toBe(true);
    });
  });
});
