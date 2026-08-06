// Issue #84 — tab strip usability: readable overflow dropdown, visible gaps,
// and (by default) tabs that wrap onto another row instead of hiding behind a
// dropdown. A session host must not bury the sessions.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** open N extra sessions, each in its own folder */
async function addSessions(a: LaunchedApp, n: number): Promise<void> {
  const w = a.window;
  const before = await w.locator('nav [draggable="true"]').count();
  for (let i = 0; i < n; i++) {
    const dir = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, dir);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(before + i + 1, {
      timeout: 25_000,
    });
  }
}

/** distinct vertical positions of the session tabs = how many rows they occupy */
async function tabRowCount(w: Page): Promise<number> {
  return w.evaluate(() => {
    const tops = [...document.querySelectorAll('.dv-tabs-container .dv-tab')].map((el) =>
      Math.round(el.getBoundingClientRect().top)
    );
    return new Set(tops).size;
  });
}

/** would the tabs overflow a single row? */
async function tabsExceedStrip(w: Page): Promise<boolean> {
  return w.evaluate(() => {
    const strip = document.querySelector('.dv-tabs-container');
    if (!strip) return false;
    const total = [...strip.querySelectorAll('.dv-tab')].reduce(
      (sum, el) => sum + el.getBoundingClientRect().width,
      0
    );
    return total > strip.getBoundingClientRect().width;
  });
}

test.describe('tab strip (#84)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('many sessions wrap onto more rows, with no overflow dropdown', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    expect(await tabRowCount(w)).toBe(1);

    // add until the tabs genuinely exceed the strip width — a fixed count would
    // silently stop testing wrapping if the window size or tab width changed
    await addSessions(a, 6);
    expect(await tabsExceedStrip(w), 'tabs still fit — nothing to wrap').toBe(true);
    // the whole point: every session is on screen, none hidden behind a `⌄ N`
    expect(await tabRowCount(w)).toBeGreaterThan(1);
    await expect(w.locator('.dv-tabs-overflow-dropdown-default')).toHaveCount(0);
    await expect(w.locator('.dv-tabs-container .dv-tab')).toHaveCount(7);

    // and the panel below still renders — a taller header must not eat it.
    // E12 clusters a whole group into ONE dockview group, so the strip is
    // capped rather than allowed to grow without limit.
    const share = await w.evaluate(() => {
      const header = document.querySelector('.dv-tabs-and-actions-container');
      const group = document.querySelector('.dv-groupview');
      if (!header || !group) return 1;
      return header.getBoundingClientRect().height / group.getBoundingClientRect().height;
    });
    expect(share).toBeLessThanOrEqual(0.45);
    await expect(w.locator('.dv-active-tab')).toBeVisible();
    await expect(w.getByText('Session', { exact: true }).first()).toBeVisible();
  });

  test('turning wrapping off restores the single-row strip and its dropdown', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await addSessions(a, 6);
    expect(await tabRowCount(w)).toBeGreaterThan(1);

    // the toggle lives in the command palette (E9-02)
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('multiple rows');
    await w.keyboard.press('Enter');

    await expect.poll(() => tabRowCount(w), { timeout: 10_000 }).toBe(1);
    await expect(w.locator('.dv-tabs-overflow-dropdown-default')).toHaveCount(1);
  });

  test('the choice survives a relaunch', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const first = a;
    const w = first.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('multiple rows');
    await w.keyboard.press('Enter');
    await expect
      .poll(() => w.evaluate(() => document.documentElement.dataset.tabRows), { timeout: 10_000 })
      .toBe('single');

    await w.waitForTimeout(900); // let the debounced ui-blob save land
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    expect(await a.window.evaluate(() => document.documentElement.dataset.tabRows)).toBe('single');
  });

  test('each session group is framed, and the focused one is marked (Dan 2026-07-26)', async () => {
    // "It's really hard to tell where the split is in daylight and Nordic."
    // dockview ships BOTH halves of the divide invisible: a group view has no
    // border, and --dv-sash-color is transparent in every one of its themes, so
    // stacked and side-by-side sessions read as one undivided surface.
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    for (const theme of ['daylight', 'nordic']) {
      await w.getByRole('button', { name: theme, exact: true }).click();
      await w.waitForTimeout(200);

      const m = await w.evaluate(() => {
        const g = document.querySelector('.dv-groupview');
        if (!g) return null;
        const parse = (c: string): number[] =>
          (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((n) => Number(n));
        const lum = (c: number[]): number =>
          (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        const cs = getComputedStyle(g);
        const contrast = (a: string, b: string): number => {
          const [x, y] = [lum(parse(a)), lum(parse(b))];
          const [hi, lo] = x > y ? [x, y] : [y, x];
          return (hi + 0.05) / (lo + 0.05);
        };
        // How much room the frame has before the nearest CLIPPING ancestor.
        // Dan 2026-07-31: the right border was missing while the other three
        // showed. Cause: dockview sizes the group to its container exactly and
        // an ancestor clips at that same coordinate, so on a scaled display —
        // where a 1px border is snapped to one DEVICE pixel — the right sliver
        // lands on the boundary and is rounded away. Geometry, not color, so
        // the contrast check above cannot see it.
        let clipper = g.parentElement;
        while (clipper && getComputedStyle(clipper).overflowX === 'visible') {
          clipper = clipper.parentElement;
        }
        const rightRoom = clipper
          ? clipper.getBoundingClientRect().right - g.getBoundingClientRect().right
          : 0;

        return {
          rightRoom,
          // the frame against the surface it sits on
          frameVsGroup: contrast(cs.borderTopColor, cs.backgroundColor),
          active: g.classList.contains('dv-active-group'),
          accent: cs.borderTopColor,
          radius: cs.borderTopLeftRadius,
          // the gutter a split would expose must not be see-through
          sash: getComputedStyle(document.documentElement)
            .getPropertyValue('--dv-sash-color')
            .trim(),
          pageBg: getComputedStyle(document.body).backgroundColor,
        };
      });

      expect(m, `no group view in ${theme}`).not.toBeNull();
      // a frame you can actually see — the whole point of the report
      expect(m!.frameVsGroup, `group frame invisible in ${theme}`).toBeGreaterThan(1.25);
      expect(m!.radius, `group not rounded in ${theme}`).not.toBe('0px');
      // ...on all four sides: flush against the clip, the right one is rounded
      // away and the card reads as open on that edge
      expect(
        m!.rightRoom,
        `group is flush against its clipping container in ${theme} — the right border will not paint`
      ).toBeGreaterThanOrEqual(1);
      // the focused group is drawn in the accent, not the neutral frame
      expect(m!.active, `expected the only group to be focused in ${theme}`).toBe(true);
      // A split's gutter is TRANSPARENT, and that reversed on 2026-07-31.
      // #84 painted it with the page background because dockview ships it
      // invisible and a split read as a fold in one surface — written before a
      // group had a frame. The sash is 4px, `z-index: 99` and centred on the
      // seam, so once frames existed the fill covered the border on BOTH sides
      // (Dan: "you can see a black space, but there is no line on each one").
      // What makes a split visible now is the two frames; `split.spec.ts`
      // asserts they actually paint. Hover and drag still light the sash.
      expect(m!.sash, `sash paints over the frames in ${theme}`).toMatch(/transparent|, *0\)/);
    }
  });

  test('the overflow dropdown is readable — our theme, not dockview’s default', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    // single-row mode is where the dropdown exists at all
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('multiple rows');
    await w.keyboard.press('Enter');
    await addSessions(a, 6);

    const control = w.locator('.dv-tabs-overflow-dropdown-default');
    await expect(control).toHaveCount(1);

    // Dan's bug: the popup mounts on dockview's shell, which we never themed, so
    // it painted in dockview's DEFAULT dark theme and the rows vanished into the
    // background. Theme-dependent — so check BOTH.
    for (const theme of ['daylight', 'nordic']) {
      await w.getByRole('button', { name: theme, exact: true }).click();
      await w.waitForTimeout(200);
      await control.click();
      const rows = w.locator('.dv-tabs-overflow-container .dv-tab');
      await expect(rows.first()).toBeVisible();

      const contrast = await w.evaluate(() => {
        const row = document.querySelector('.dv-tabs-overflow-container .dv-tab');
        const container = document.querySelector('.dv-tabs-overflow-container');
        if (!row || !container) return null;
        const parse = (c: string): number[] =>
          (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((n) => Number(n));
        const lum = (c: number[]): number =>
          (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        const fg = lum(parse(getComputedStyle(row).color));
        // the ROW's own background, falling back to the container when the row
        // is transparent — text matching its own row would be just as invisible
        const rowBg = getComputedStyle(row).backgroundColor;
        const opaque = !/rgba\(.*,\s*0\s*\)/.test(rowBg) && rowBg !== 'transparent';
        const bg = lum(parse(opaque ? rowBg : getComputedStyle(container).backgroundColor));
        const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
        return { ratio: (hi + 0.05) / (lo + 0.05), text: (row as HTMLElement).innerText.trim() };
      });
      expect(contrast, `no dropdown row in ${theme}`).not.toBeNull();
      expect(contrast!.text.length, `empty row label in ${theme}`).toBeGreaterThan(0);
      expect(contrast!.ratio, `unreadable dropdown in ${theme}`).toBeGreaterThan(3);
      await w.keyboard.press('Escape');
    }

    // clicking a row activates that session
    await control.click();
    // scoped to the STRIP: with the dropdown open, dockview renders a copy of
    // every overflowing tab inside it — including the active one when it is
    // among them — so a bare `.dv-active-tab` matches two elements and trips
    // strict mode. The assertion is about the strip's active tab.
    const activeTab = w.locator('.dv-tabs-container > .dv-active-tab');
    const before = await activeTab.innerText();
    await w.locator('.dv-tabs-overflow-container .dv-tab').first().click();
    await expect.poll(() => activeTab.innerText()).not.toBe(before);
  });

  test('a popped-out window gets our theme and tab mode (separate document)', async () => {
    test.skip(
      process.platform === 'linux',
      'popout opens a 2nd OS window — unreliable under headless xvfb'
    );
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await w.getByRole('button', { name: 'nordic', exact: true }).click();

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = a.app.windows().find((p) => p !== w)!;
    await popout.waitForLoadState('domcontentloaded');

    // its <html> carries the same flags, so the shared stylesheet paints it the
    // same way — without this a popped-out session was dark in a light app
    await expect
      .poll(() => popout.evaluate(() => document.documentElement.dataset.theme), { timeout: 10_000 })
      .toBe('nordic');
    expect(await popout.evaluate(() => document.documentElement.dataset.tabRows)).toBe('wrap');

    // and a theme switch in the main window follows it across
    await w.getByRole('button', { name: 'daylight', exact: true }).click();
    await expect
      .poll(() => popout.evaluate(() => document.documentElement.dataset.theme), { timeout: 10_000 })
      .toBe('daylight');
  });

  test('tabs are visually separated and rounded', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });
    await addSessions(a, 1);

    const shape = await w.evaluate(() => {
      const tabs = [...document.querySelectorAll('.dv-tabs-container .dv-tab')];
      if (tabs.length < 2) return null;
      const [a1, b1] = [tabs[0].getBoundingClientRect(), tabs[1].getBoundingClientRect()];
      return {
        gap: Math.round(b1.left - a1.right),
        radius: getComputedStyle(tabs[0]).borderTopLeftRadius,
      };
    });
    expect(shape).not.toBeNull();
    expect(shape!.gap).toBeGreaterThan(0); // Dan: "a tiny little space"
    expect(parseFloat(shape!.radius)).toBeGreaterThan(0); // ...and curved corners
  });

  // #264. dockview is told a panel's title once, at `addPanel`, and nothing in
  // the tree calls `setTitle` — so the strip kept announcing the name the
  // session was born with while the rail, the record and the card header had
  // all moved on. The tab now reads the session store, like everything else
  // that has to say which session it is.
  test('the tab follows a rename from the rail (#264)', async () => {
    const folder = tempProjectFolder();
    const name = path.basename(folder);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const strip = w.locator('.dv-tabs-container');
    await expect(strip.getByText(name, { exact: true })).toBeVisible({ timeout: 25_000 });

    // rename the one session from the rail, the way a user does
    await w.locator('nav .rail-row').first().dblclick();
    const field = w.locator('nav .rail-row input');
    await expect(field).toBeVisible();
    await field.fill('renamed-tab');
    await field.press('Enter');

    await expect(strip.getByText('renamed-tab', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(strip.getByText(name, { exact: true })).toHaveCount(0);
  });
});
