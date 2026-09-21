import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, openSettings, setTheme, setUiLanguage } from './fixtures/app';

test.describe('titlebar chrome', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('theme toggle flips the document theme (E1-03)', async () => {
    a = await launchApp();
    const { window } = a;
    const html = window.locator('html');
    // The buttons moved into Settings (#885); what they DO is unchanged, which
    // is the whole claim of that move and the reason this test did not.
    await setTheme(window, 'daylight');
    await expect(html).toHaveAttribute('data-theme', 'daylight');
    await setTheme(window, 'nordic');
    await expect(html).toHaveAttribute('data-theme', 'nordic');
  });

  test('pseudo-locale mangles every UI string (E1-04)', async () => {
    a = await launchApp();
    const { window } = a;
    // real English first
    await expect(window.getByRole('button', { name: '+ session' })).toBeVisible();
    await setUiLanguage(window, 'pseudo');
    // strings are now wrapped in ⟦…⟧, proving none are hardcoded
    await expect(window.getByText(/⟦.+⟧/).first()).toBeVisible();
    await expect(window.getByRole('button', { name: '+ session' })).toHaveCount(0);
  });

  test('autonomy chip cycles (E6-01)', async () => {
    a = await launchApp();
    const { window } = a;
    await expect(window.getByRole('button', { name: /ask/ })).toBeVisible();
    await window.getByRole('button', { name: /ask/ }).click();
    await expect(window.getByRole('button', { name: /plan/ })).toBeVisible();
  });
});

/**
 * THE SETTINGS MODAL OPENS AT THE TOP (#885, found in review).
 *
 * This looks like a test of nothing, and it is the only shape that can see a
 * real bug that shipped past both the unit suite and every other e2e.
 * `PushSection` rescues focus when a control disables itself under the cursor,
 * and that effect has no dependency list — so it also ran on the FIRST commit,
 * where `document.activeElement` is `<body>` on the two commonest ways in
 * (`Ctrl+,`, and the palette, which deliberately restores focus to nothing).
 * React flushes child effects before the parent's, so the push block won the
 * race, and `focus()` scrolls its element into view inside the nearest
 * scroller — which is the modal. Settings opened scrolled down to the
 * credential fields.
 *
 * jsdom has no layout, so no unit test can measure `scrollTop`; the three
 * palette aliases papered over it, because their own `scrollIntoView` runs
 * afterwards. Hence: open with NO section, assert the top.
 */
test.describe('Settings opens where it says it does (#885)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('Ctrl+, opens Settings at the top, not scrolled to a section', async () => {
    a = await launchApp();
    const w = a.window;
    const dialog = await openSettings(w);
    // The first section's heading has to be ON SCREEN — asserting `scrollTop`
    // alone would pass on a window tall enough not to scroll at all, which is
    // most dev machines and neither CI runner.
    await expect(dialog.locator('[data-settings-section="appearance"]')).toBeInViewport();
    expect(
      await dialog.evaluate((el) => el.scrollTop),
      'Settings opened scrolled down. Something inside it called focus() or ' +
        'scrollIntoView() on mount — see this block for the one that did'
    ).toBe(0);
  });
});

/**
 * #879 — THE TITLE BAR FITS, AND THE PAGE DOES NOT SCROLL SIDEWAYS.
 *
 * The bug: at the 1024px the windows-latest runner uses, the bar held 19
 * controls, its content measured 1577px inside a 1009px bar, and 568px of it
 * was off screen — with the whole DOCUMENT scrolling horizontally to reach it.
 * #885 moved eight controls into Settings, which lands the content at ~983px
 * and closes it.
 *
 * ⚠️ THE CLAUSE THE TICKET ASKED FOR, and the reason this is a test rather than
 * a measurement in a PR description: ~26px of slack is not much. The next chip
 * anybody adds eats it, and the failure is remote from the cause — a compressed
 * chip WRAPS, a wrapped chip makes the bar taller than its floor, and in a short
 * window those pixels come out of the conversation, not out of the bar
 * (`always-visible-notices.test.ts` has the mechanism). So both halves are
 * asserted: no horizontal document scroll, and the bar keeps its height.
 */
test.describe('the title bar fits the window CI uses (#879)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('nothing overflows sideways at 1024px, and the bar keeps its height', async () => {
    a = await launchApp();
    // `w`, not `window`: everything below runs inside `page.evaluate`, where
    // `window` has to mean the BROWSER's window.
    const w = a.window;
    await w.locator('header').first().waitFor({ state: 'visible', timeout: 25_000 });

    // The CI width, set explicitly rather than assumed: the runner's window is
    // 1024x686 and a dev machine's is whatever fits the screen, so measuring
    // "does it fit" without pinning the width would pass here and fail there —
    // which is exactly how #879 went unnoticed for as long as it did.
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: 1024, height: 686 });
    });
    await expect
      .poll(async () => w.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeLessThanOrEqual(1024);

    const measure = (): Promise<{
      docScroll: number;
      inner: number;
      barScroll: number;
      barClient: number;
      barHeight: number;
      controls: number;
    } | null> =>
      w.evaluate(() => {
        const bar = document.querySelector('header');
        if (!bar) return null;
        return {
          docScroll: document.documentElement.scrollWidth,
          inner: window.innerWidth,
          barScroll: bar.scrollWidth,
          barClient: bar.clientWidth,
          barHeight: Math.round(bar.getBoundingClientRect().height),
          controls: bar.querySelectorAll('button').length,
        };
      });

    // 1. THE DOCUMENT DOES NOT SCROLL SIDEWAYS. The bug, in one line.
    //
    // POLLED, and that is not defensive padding — it was measured. Sampling
    // once right after `innerWidth` reports 1010 catches dockview mid-reflow:
    // it still holds the pre-resize width (measured: a 956px grid at x=298, so
    // scrollWidth 1254 in a 1010px window) and settles a moment later. The
    // TITLE BAR was already correct in that same frame — 995px of content in a
    // 995px bar — so a single sample would have failed this test for a reason
    // that has nothing to do with what it is guarding.
    await expect
      .poll(async () => {
        const s = await measure();
        return s ? s.docScroll - s.inner : null;
      }, { timeout: 15_000 })
      .toBeLessThanOrEqual(0);

    const m = await measure();
    expect(m, 'no <header> on screen — the bar itself is missing').not.toBeNull();

    // 2. …and the bar's own content fits inside the bar, which is the same
    //    claim one level down and survives a future ancestor that clips.
    expect(
      m!.barScroll,
      `the title bar's content (${m!.barScroll}px) is wider than the bar ` +
        `(${m!.barClient}px), so controls are off screen`
    ).toBeLessThanOrEqual(m!.barClient);

    // 3. the bar kept its height — nothing wrapped to a second line. The
    //    `minBlockSize: 34` floor is what a one-line row measures; a wrapped
    //    chip pushes it well past that.
    expect(
      m!.barHeight,
      `the title bar is ${m!.barHeight}px tall, so a chip label wrapped to a ` +
        `second line. That height comes out of the conversation in a short window`
    ).toBeLessThanOrEqual(40);
  });
});
