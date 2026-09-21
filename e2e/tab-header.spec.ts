// WHICH TAB IS OPEN (#905, the owner's "style B") — measured as Chromium
// paints it.
//
// With several sessions docked in one group, the open tab used to differ from
// the rest by one fill step, and the card header right under it was the colour
// of the UNSELECTED tabs. Now the open tab and its header share one wash of the
// session's identity accent, the other tabs are transparent on the strip, and
// the header no longer repeats the name the tab already shows.
//
// tokens.drift.test.ts measures `--text` on every accent's wash in every theme
// from the token file. This file is the half it cannot see: that the browser
// actually paints the tab and the header the SAME colour, that every word on
// them — chips, prompt, label, buttons — is AA against what is really behind
// it, and which tabs are bold in a split layout.
import { test, expect, Page, Locator } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  tempProjectFolder,
  setTheme,
  gridLeafViews,
  persistedLayout,
  readWorkspaceFile,
  writeWorkspaceFile,
} from './fixtures/app';

const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const openTabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab.dv-active-tab');
const header = (w: Page) => w.getByTestId('card-header').filter({ visible: true });

async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  const before = await tabs(a.window).count();
  await a.window.getByRole('button', { name: '+ session' }).click();
  await expect(tabs(a.window)).toHaveCount(before + 1, { timeout: 25_000 });
  return path.basename(dir);
}

/** the computed background of `el`, as Chromium resolves it */
const bgOf = (el: Locator): Promise<string> => el.evaluate((e) => getComputedStyle(e).backgroundColor);

/** what `var(--panel)` paints right now — the fill an accent-LESS open tab and
 *  header fall back to. Without comparing against it, "the tab matches the
 *  header" also passes when neither got an accent at all. */
const plainPanel = (w: Page): Promise<string> =>
  w.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--panel)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });

type Rgba = [number, number, number, number];

/** `rgb()`/`rgba()`, and the `color(srgb …)` a `color-mix()` computes to */
function parse(c: string): Rgba {
  let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(c);
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
  throw new Error(`unparsed colour: ${c}`);
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(parse(a)), luminance(parse(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Every element under `root` that writes words of its own, with its ink and the
 * first OPAQUE background behind it — the surface the words are actually read
 * against. Hidden elements are skipped: the bold-width reserve is a hidden
 * pseudo-element and paints nothing.
 */
async function wordsOn(root: Locator): Promise<Array<{ text: string; ink: string; under: string }>> {
  return root.evaluate((r) => {
    const out: Array<{ text: string; ink: string; under: string }> = [];
    const opaque = (c: string): boolean => c !== 'transparent' && !/(,\s*0\)|\/ 0\))$/.test(c);
    for (const el of [r, ...Array.from(r.querySelectorAll('*'))] as HTMLElement[]) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || el.getClientRects().length === 0) continue;
      let under = 'rgb(0, 0, 0)';
      for (let p: HTMLElement | null = el; p; p = p.parentElement) {
        const bg = getComputedStyle(p).backgroundColor;
        if (opaque(bg)) {
          under = bg;
          break;
        }
      }
      out.push({ text: own, ink: cs.color, under });
    }
    return out;
  });
}

async function expectAllAA(w: Page, theme: string): Promise<void> {
  const words = [...(await wordsOn(header(w))), ...(await wordsOn(openTabs(w).first()))];
  expect(words.length, `${theme}: nothing measured`).toBeGreaterThan(3);
  for (const { text, ink, under } of words) {
    expect(ratio(ink, under), `${theme}: "${text}" (${ink} on ${under})`).toBeGreaterThanOrEqual(4.5);
  }
}

test.describe('the open tab and its card header (#905)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('share one identity wash; the other tabs recede; the name leaves the header', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    await addSession(a);
    const third = await addSession(a);
    await expect(openTabs(w)).toContainText(third);
    await expect(header(w)).toBeVisible();

    // ONE piece: the open tab and the header under it are the same colour...
    const open = openTabs(w).locator('.identity-tab');
    await expect
      .poll(async () => (await bgOf(open)) === (await bgOf(header(w))))
      .toBe(true);
    // ...and it is the WASH: not the strip it sits on, and not the plain panel
    // an accent-less card falls back to
    const strip = w.locator('.dv-tabs-and-actions-container').first();
    expect(await bgOf(open)).not.toBe(await bgOf(strip));
    expect(await bgOf(open)).not.toBe(await plainPanel(w));

    // the unselected tabs are not filled at all
    const shut = w.locator('.dv-tabs-container .dv-tab.dv-inactive-tab');
    await expect(shut).toHaveCount(2);
    for (const t of await shut.all()) {
      expect(parse(await bgOf(t))[3]).toBe(0);
      expect(parse(await bgOf(t.locator('.identity-tab')))[3]).toBe(0);
    }

    // not hue alone (§5.32): the open tab is bold, the rest are not
    await expect(openTabs(w)).toHaveCSS('font-weight', '700');
    for (const t of await shut.all()) await expect(t).toHaveCSS('font-weight', '500');

    // the name is the tab's; the header no longer repeats it
    await expect(header(w)).not.toContainText(third);
    await expect(header(w).getByTestId('card-task-label')).toHaveText('+ task label');

    // Opening a tab must not shove its neighbours: the title reserves its BOLD
    // width, so every tab keeps its width whichever one is open.
    const widths = async (): Promise<number[]> =>
      Promise.all((await tabs(w).all()).map(async (t) => (await t.boundingBox())!.width));
    const before = await widths();
    await tabs(w).first().click();
    await expect(tabs(w).first()).toHaveClass(/dv-active-tab/);
    const after = await widths();
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i], 0);
  });

  test('every word on the washed tab and header clears AA, in all four themes', async () => {
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    await addSession(a);
    await expect(header(w).getByTestId('card-context-chip')).toBeVisible();
    const themes = ['nordic', 'daylight', 'high contrast', 'soft contrast'];

    // no label yet: the "+ task label" prompt. Each theme's header must be a
    // DIFFERENT colour, or a switch that silently failed would measure nordic
    // four times — and it must be washed, not the plain fallback.
    const seen = new Set<string>();
    for (const theme of themes) {
      await setTheme(w, theme);
      await expect.poll(async () => seen.has(await bgOf(header(w)))).toBe(false);
      seen.add(await bgOf(header(w)));
      expect(await bgOf(header(w)), `${theme}: header not washed`).not.toBe(await plainPanel(w));
      await expectAllAA(w, `${theme}, no label`);
    }

    // with a label, which is the header's main text now the name is gone
    await header(w).getByTestId('card-task-label').click();
    await header(w).locator('input').fill('tighten the tab strip');
    await header(w).locator('input').press('Enter');
    await expect(header(w).getByTestId('card-task-label')).toHaveText('tighten the tab strip');
    for (const theme of themes) {
      await setTheme(w, theme);
      await expectAllAA(w, `${theme}, labelled`);
    }
  });

  // Every group's open tab is what that group shows, so each is washed. Only
  // the FOCUSED group's is bold — with the group's accent frame, "which one am
  // I in" has one answer.
  test('a split layout washes every group’s open tab and bolds the focused one', async () => {
    const first = await launchApp({ seedFolder: tempProjectFolder() });
    await expect(tabs(first.window)).toHaveCount(1, { timeout: 25_000 });
    await addSession(first);
    await first.window.waitForTimeout(1200); // let the layout reach disk
    await first.close();

    const ws = readWorkspaceFile(first.home);
    const layout = persistedLayout(ws);
    const views = gridLeafViews(layout.grid.root.data[0]);
    expect(views.length, 'need two panels to split').toBe(2);
    const half = Math.floor(layout.grid.width / 2);
    layout.grid.root.data = [
      { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
      { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
    ];
    writeWorkspaceFile(first.home, ws);

    a = await launchApp({ home: first.home });
    const w = a.window;
    const groups = w.locator('.dv-groupview');
    await expect(groups).toHaveCount(2, { timeout: 25_000 });
    await expect(openTabs(w)).toHaveCount(2);

    const openIn = (g: Locator) => g.locator('.dv-tab.dv-active-tab');
    const strip = await bgOf(w.locator('.dv-tabs-and-actions-container').first());
    const plain = await plainPanel(w);
    for (const g of await groups.all()) {
      // washed in both groups...
      const fill = await bgOf(openIn(g).locator('.identity-tab'));
      expect(fill).not.toBe(strip);
      expect(fill).not.toBe(plain);
    }

    // ...bold in exactly one, and it is the focused one — and it moves with focus
    for (const target of [0, 1]) {
      await openIn(groups.nth(target)).click();
      await expect(groups.nth(target)).toHaveClass(/dv-active-group/);
      await expect(openIn(groups.nth(target))).toHaveCSS('font-weight', '700');
      await expect(openIn(groups.nth(1 - target))).toHaveCSS('font-weight', '500');
    }
  });
});
