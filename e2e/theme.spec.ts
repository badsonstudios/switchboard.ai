// P2-E15-05 — themes are token maps, and the third one is a data file.
//
// The unit tests own the map mechanics; these are the two claims only the real
// window can settle: that a JSON theme actually REPAINTS (a token map nobody
// resolves is a token map that does nothing), and that the paint reaches a
// popped-out window, which is a separate document with its own <html>.
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

/** the RESOLVED value of a custom property on a document root */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
    name
  );
}

/** [picker label, the id it paints] — the shipped set, as a user meets it. */
const THEMES: Array<[string, string]> = [
  ['nordic', 'nordic'],
  ['daylight', 'daylight'],
  ['high contrast', 'high-contrast'],
  ['soft contrast', 'soft-contrast'],
];

test.describe('themes (P2-E15-05)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('every shipped theme is selectable and high contrast repaints', async () => {
    a = await launchApp();
    const w = a.window;
    const html = w.locator('html');

    for (const [label] of THEMES) {
      await expect(w.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    const light = await token(w, '--bg');

    await w.getByRole('button', { name: 'high contrast', exact: true }).click();
    // the id is the theme; data-theme stays on the PRESET it builds on, which
    // is what lets an overlay inherit the rest of a dark palette
    await expect(html).toHaveAttribute('data-theme-id', 'high-contrast');
    await expect(html).toHaveAttribute('data-theme', 'nordic');
    await expect(html).toHaveAttribute('data-color-scheme', 'dark');

    const hc = await token(w, '--bg');
    expect(hc).not.toBe(light);
    // black, from the JSON — the file is doing the painting
    expect(hc).toMatch(/^(#000000|rgb\(0, 0, 0\))$/);

    // and switching away leaves nothing of it behind
    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    expect(await token(w, '--bg')).toBe(light);
  });

  test('every theme composes a VALID drop-target ring', async () => {
    // The assertion class the contrast tests miss: they read values out of the
    // file, and a value can be a perfectly good color and still break the
    // declaration it lands in. The rail builds its drop highlight by
    // concatenating a shadow token — `box-shadow: 0 0 0 2px <accent>,
    // var(--group-lift)` — and `none` is a whole-property keyword, not a list
    // item, so a theme setting `--group-lift: none` makes the whole thing
    // invalid and the ring disappears in the theme that most needs it.
    a = await launchApp();
    const w = a.window;
    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      // the chip must actually have switched — otherwise this loop could pass
      // three times over the theme it booted in
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);
      const shadow = await w.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.boxShadow = '0 0 0 2px rgb(1, 2, 3), var(--group-lift)';
        document.body.append(probe);
        const value = getComputedStyle(probe).boxShadow;
        probe.remove();
        return value;
      });
      expect(shadow, `${label}: drop ring dropped by the browser`).not.toBe('none');
      expect(shadow, `${label}: ring color missing`).toContain('rgb(1, 2, 3)');
    }
  });

  test('the status pill is legible in every theme, as painted (#221)', async () => {
    // The unit tests compute this mix from the files; only the real window can
    // say what Chromium actually PAINTED. It matters here more than anywhere
    // else the tokens are checked, because the pill's fill is a `color-mix` of
    // a status hue into the card header — nothing in the token map holds that
    // colour, and the two halves of the pair live in different files (the rule
    // in tokens.css, the hue/ink it receives in StatusPill.tsx). This is also
    // the only check that would notice the pill being moved onto some other
    // surface, which would leave the computed promise measuring a fiction.
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    const pill = w.locator('.status-pill').first();
    await expect(pill).toBeVisible({ timeout: 25_000 });

    for (const [label, id] of THEMES) {
      await w.getByRole('button', { name: label, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme-id', id);

      const seen = await pill.evaluate((el) => {
        const lum = (c: string): number => {
          // rgb()/rgba() come back 0-255, but anything that went through
          // color-mix() arrives as color(srgb r g b) in 0-1 floats. Reading the
          // second as 0-255 scores every mixed colour as black — a false PASS
          // for dark ink, which is exactly the case this test exists for.
          const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const [r, g, b] = c.startsWith('color(') ? n : n.map((v) => v / 255);
          const f = (s: number): number =>
            s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        // the first OPAQUE background at or above the word. The pill's own fill
        // is opaque by design (#221) so this should stop on the pill itself —
        // reported back, because a walk that had to climb to the header would
        // mean the fill went transparent again and the ratio below would be
        // measured against a surface the user never sees through it.
        let from = 'none';
        let bg = 'rgb(255, 255, 255)';
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const parts = c.match(/[\d.]+/g);
          if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
            bg = c;
            from = n === el ? 'pill' : (n.getAttribute('data-testid') ?? n.className ?? 'ancestor');
            break;
          }
        }
        const [ink, fill] = [lum(getComputedStyle(el).color), lum(bg)];
        return {
          from,
          ratio: (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05),
        };
      });

      expect(seen.from, `${id}: the pill's own fill must be what the word sits on`).toBe('pill');
      expect(seen.ratio, `${id} status pill contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the theme AND language survive a relaunch of the built app', async () => {
    // P2-E15-06, and it was a LIVE bug measured 2026-07-31: both prefs lived in
    // localStorage, and the packaged renderer is served from a random loopback
    // port — origin `http://127.0.0.1:58814` on one launch, `:57029` on the
    // next — so the store they were written to did not exist any more. The
    // picker worked and the choice evaporated at the door, every time. This
    // test has to run against the BUILT app for that reason: a dev server has a
    // stable origin and would have passed throughout the bug.
    a = await launchApp();
    const first = a;
    await first.window.getByRole('button', { name: 'high contrast', exact: true }).click();
    await expect(first.window.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast');
    await first.window.getByRole('button', { name: 'pseudo', exact: true }).click();
    await expect(first.window.getByText(/⟦.+⟧/).first()).toBeVisible();
    await first.close();

    a = await launchApp({ home: first.home });
    await expect(a.window.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast', {
      timeout: 25_000,
    });
    // the language came back too — same store, same bug
    await expect(a.window.getByText(/⟦.+⟧/).first()).toBeVisible();
  });

  test('a theme switch reaches a popped-out window', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
    );
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    expect(popout, 'no popout page').toBeTruthy();

    await w.getByRole('button', { name: 'high contrast', exact: true }).click();

    // the popout shares the stylesheet but not our <html>: without the overlay
    // copy it would sit on the nordic PRESET with every override missing —
    // which looks exactly like a theme that half-applied
    await expect
      .poll(() => token(popout, '--bg'), { timeout: 10_000 })
      .toBe(await token(w, '--bg'));
    await expect(popout.locator('html')).toHaveAttribute('data-theme-id', 'high-contrast');

    // and back: a stale override in the popout is the same bug in reverse
    await w.getByRole('button', { name: 'nordic', exact: true }).click();
    await expect
      .poll(() => token(popout, '--bg'), { timeout: 10_000 })
      .toBe(await token(w, '--bg'));
  });
});
