// WHICH SESSION AM I TYPING INTO (#1405) — measured as Chromium paints it.
//
// Two sessions in one group, both WAITING. Under #1351 both tabs were the same
// gold box, the wash replaced the open tab's own colour, and the owner typed
// into the wrong session. The owner's rule: knowing which tab is selected
// matters more than knowing which tabs are waiting.
//
// So: waiting is a word, not a fill — every waiting tab says "waiting", and no
// tab is filled for it. The OPEN tab carries the card header's own colour and
// a bar along its top. And the pane says whose it is: the session's name first
// in the header, and "Message <name>…" in the message box — in a popped-out
// window too.
//
// The ratios on every token pair are tokens.drift's; this file is the half it
// cannot see: what the browser really paints, in all four themes.
import { test, expect, Page, Locator } from '@playwright/test';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  setTheme,
  skipPopoutOnLinux,
  streamPrompter,
  tempProjectFolder,
} from './fixtures/app';

const ELLIPSIS = String.fromCodePoint(0x2026);
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
const tab = (w: Page, title: string) => tabs(w).filter({ hasText: title });
const box = (w: Page, title: string) => tab(w, title).locator('.identity-tab');
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

const bgOf = (el: Locator): Promise<string> => el.evaluate((e) => getComputedStyle(e).backgroundColor);
const shadowOf = (el: Locator): Promise<string> => el.evaluate((e) => getComputedStyle(e).boxShadow);

/** what a token resolves to right now, as a computed colour */
const tokenColour = (w: Page, token: string): Promise<string> =>
  w.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);

type Rgba = [number, number, number, number];
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

/** the tab's state word: its ink, and the first opaque fill behind it */
const wordOn = (el: Locator): Promise<{ text: string; ink: string; under: string }> =>
  el.locator('[data-tab-state]').evaluate((e) => {
    const opaque = (c: string): boolean => c !== 'transparent' && !/(,\s*0\)|\/ 0\))$/.test(c);
    let under = 'rgb(0, 0, 0)';
    for (let p: HTMLElement | null = e as HTMLElement; p; p = p.parentElement) {
      const bg = getComputedStyle(p).backgroundColor;
      if (opaque(bg)) {
        under = bg;
        break;
      }
    }
    return { text: e.textContent ?? '', ink: getComputedStyle(e).color, under };
  });

/**
 * The open tab is joined to the header under it (same fill), carries a bar in
 * `bar` along its top, and the shut one is unfilled with no bar. Both say
 * "waiting".
 */
async function expectOpen(w: Page, open: string, shut: string, theme: string): Promise<void> {
  await expect(tab(w, open)).toHaveClass(/dv-active-tab/);
  await expect(box(w, open).locator('[data-tab-state]')).toHaveText('waiting');
  await expect(box(w, shut).locator('[data-tab-state]')).toHaveText('waiting');
  // joined to the pane below: the same colour as its header
  await expect.poll(async () => (await bgOf(box(w, open))) === (await bgOf(header(w)))).toBe(true);
  // the shut tab is not filled — not by waiting, not by anything
  expect(parse(await bgOf(box(w, shut)))[3], `${theme}: the shut waiting tab is filled`).toBe(0);
  expect(parse(await bgOf(tab(w, shut)))[3], `${theme}: the shut waiting tab is filled`).toBe(0);
  // the bar along the top, in the focused group's blue; none on the shut one
  const link = await tokenColour(w, '--link');
  const bar = await shadowOf(box(w, open));
  expect(bar, `${theme}: open tab's bar`).toContain(link);
  expect(bar).toMatch(/0px 3px 0px 0px inset/);
  expect(await shadowOf(box(w, shut)), `${theme}: shut tab has a bar`).toBe('none');
  // bold, the shut one is not — luminance, not hue alone
  await expect(tab(w, open)).toHaveCSS('font-weight', '700');
  await expect(tab(w, shut)).toHaveCSS('font-weight', '500');
  // the word reads, on both
  for (const t of [open, shut]) {
    const { text, ink, under } = await wordOn(box(w, t));
    expect(ratio(ink, under), `${theme}: "${text}" on ${t}'s tab (${ink} on ${under})`).toBeGreaterThanOrEqual(4.5);
  }
  // the pane says whose it is: the name first, and in the message box
  const name = header(w).getByTestId('card-session-name');
  await expect(name).toHaveText(open);
  await expect(name).toHaveCSS('font-weight', '700');
  await expect(w.getByPlaceholder(`Message ${open}${ELLIPSIS}`, { exact: true })).toBeVisible();
}

test.describe('two waiting tabs: which one is open (#1405)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('the open one is obvious, both say "waiting", and the pane and the message box name the session — in every theme', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(tabs(w)).toHaveCount(1, { timeout: 25_000 });
    const second = await addSession(a);

    const prompt = streamPrompter(a);
    await prompt(first, 'hello');
    await prompt(second, 'hello');
    for (const t of [first, second]) {
      await expect(box(w, t)).toHaveAttribute('data-wait-state', 'waiting', { timeout: 30_000 });
    }

    // the newer session is the open one
    await expectOpen(w, second, first, 'nordic');
    // ...and the look follows the selection, not the state
    await tab(w, first).click();
    await expectOpen(w, first, second, 'nordic');

    for (const theme of ['daylight', 'high contrast', 'soft contrast', 'nordic']) {
      await setTheme(w, theme);
      await expectOpen(w, first, second, theme);
    }
  });

  test('the header and the message box name the session in a popped-out window too', async () => {
    skipPopoutOnLinux();
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const name = path.basename(folder);
    await expect(header(w).getByTestId('card-session-name')).toHaveText(name, { timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, { timeout: 15_000 })
      .toBe(1);
    const popout = app.windows().find((p) => p.url().includes('popout.html'))!;
    await expect(header(popout).getByTestId('card-session-name')).toHaveText(name, { timeout: 20_000 });
    await expect(popout.getByPlaceholder(`Message ${name}${ELLIPSIS}`, { exact: true })).toBeVisible();
    // the popped-out tab is the open one in its window: filled like its header
    const own = popout.locator('.dv-tabs-container .dv-tab.dv-active-tab .identity-tab');
    await expect.poll(async () => (await bgOf(own)) === (await bgOf(header(popout)))).toBe(true);
    expect(await shadowOf(own)).toMatch(/0px 3px 0px 0px inset/);
  });

  test('a long session name truncates in the header instead of pushing the buttons out', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const name = path.basename(folder);
    await expect(header(w).getByTestId('card-session-name')).toHaveText(name, { timeout: 25_000 });
    const long = 'Switchboard.ai - for tickets and a very long name that goes on and on past any header';
    // renamed the way a user does it: double-click the row in the list
    await w.locator('nav .rail-row').first().dblclick();
    const field = w.locator('nav .rail-row input');
    await expect(field).toBeVisible();
    await field.fill(long);
    await field.press('Enter');
    const shown = header(w).getByTestId('card-session-name');
    await expect(shown).toHaveText(long, { timeout: 15_000 });
    // cut with an ellipsis: narrower than its text, and inside the header
    const fit = await shown.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(fit.scroll).toBeGreaterThan(fit.client);
    await expect(shown).toHaveCSS('text-overflow', 'ellipsis');
    // the header's children, summed, fit the header (a flex row's own
    // scrollWidth hides its overflow): nothing was pushed out
    const sums = await header(w).evaluate((h) => {
      const cs = getComputedStyle(h);
      // laid-out children only: a display:none one takes no gap
      const kids = (Array.from(h.children) as HTMLElement[]).filter((k) => k.getClientRects().length > 0);
      const gap = parseFloat(cs.columnGap || '0') || 0;
      const used = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
      const room = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { used, room };
    });
    expect(sums.used).toBeLessThanOrEqual(sums.room + 1);
    // the message box cuts it too, with an ellipsis, and keeps the full name
    // for a screen reader
    const composer = w.getByPlaceholder(/^Message .+…$/);
    const placeholder = (await composer.getAttribute('placeholder')) ?? '';
    expect(placeholder.startsWith('Message Switchboard.ai - for tickets')).toBe(true);
    expect(placeholder).not.toContain('any header');
    expect(await composer.getAttribute('aria-label')).toContain(long);
  });
});
