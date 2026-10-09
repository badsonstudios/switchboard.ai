// The one-click arrangements and "make them even" (#1147), in the real app.
//
// The owner: "If I want two docks side by side, I click a button. If I want
// three, I click a button. … I resized the left one bigger and now I want them
// even again — I have no way to know where the middle is."
//
// The arithmetic has unit tests (lib/layout-presets.test.ts). What only the
// real app can say is whether dockview ends up in the shape that was asked
// for, at the sizes that were asked for, with every session still there — so
// every claim here is MEASURED off the cards on screen.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const row = (w: Page, title: string) =>
  w.locator('nav .rail-row').filter({ has: w.locator('[data-rail-title]', { hasText: title }) });
const preset = (w: Page, name: string) => w.locator(`[data-layout-preset="${name}"]`);

interface Place {
  x: number;
  y: number;
  width: number;
  height: number;
  /** the tab titles in this place, in order */
  tabs: string[];
}

/** every place in the main workspace, reading left to right and then down */
async function places(w: Page): Promise<Place[]> {
  const found = await w.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dv-groupview'))
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          x: Math.round(b.left),
          y: Math.round(b.top),
          width: Math.round(b.width),
          height: Math.round(b.height),
          tabs: Array.from(el.querySelectorAll('.dv-tabs-container .dv-tab')).map(
            (t) => t.textContent?.trim() ?? ''
          ),
        };
      })
  );
  return found.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** open one more session, in its own folder (so nothing auto-groups) */
async function addSession(a: LaunchedApp): Promise<string> {
  const dir = tempProjectFolder();
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, dir);
  await a.window.getByRole('button', { name: '+ session' }).click();
  const name = path.basename(dir);
  await expect(row(a.window, name)).toBeVisible({ timeout: 25_000 });
  return name;
}

/** the app with this many sessions open; their names, in Sessions-list order */
async function open(count: number): Promise<{ a: LaunchedApp; names: string[] }> {
  const folder = tempProjectFolder();
  const a = await launchApp({ seedFolder: folder });
  await expect(row(a.window, path.basename(folder))).toBeVisible({ timeout: 25_000 });
  for (let i = 1; i < count; i++) await addSession(a);
  const names = await a.window
    .locator('nav .rail-row [data-rail-title]')
    .evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
  expect(names).toHaveLength(count);
  return { a, names };
}

/** within a few pixels: dividers have a width, and sizes round */
const SLACK = 6;
const near = (got: number, want: number): boolean => Math.abs(got - want) <= SLACK;

/** does a tab strip hold this session? (a tab's text may carry more than the name) */
const holds = (p: Place, name: string): boolean => p.tabs.some((t) => t.includes(name));

test.describe('one-click arrangements (#1147)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('three side by side: three equal columns, in the Sessions list’s order', async () => {
    const opened = await open(3);
    a = opened.a;
    const w = a.window;
    // new sessions open as tabs in one place: that is the starting point
    expect(await places(w)).toHaveLength(1);

    await preset(w, 'columns3').click();
    await expect.poll(async () => (await places(w)).length).toBe(3);
    const got = await places(w);

    // side by side: one row, three columns
    expect(new Set(got.map((p) => p.y)).size).toBe(1);
    // ...of equal width, to within the dividers
    expect(near(got[0].width, got[1].width), JSON.stringify(got)).toBe(true);
    expect(near(got[1].width, got[2].width), JSON.stringify(got)).toBe(true);
    // ...each holding one session, first in the list on the left
    opened.names.forEach((name, i) => {
      expect(got[i].tabs).toHaveLength(1);
      expect(holds(got[i], name), `${name} should be column ${i + 1}`).toBe(true);
    });
  });

  test('two side by side with three open: the extra stacks as a tab on the right, nothing is lost', async () => {
    const opened = await open(3);
    a = opened.a;
    const w = a.window;

    await preset(w, 'columns2').click();
    await expect.poll(async () => (await places(w)).length).toBe(2);
    const got = await places(w);
    expect(near(got[0].width, got[1].width), JSON.stringify(got)).toBe(true);
    expect(got[0].tabs).toHaveLength(1);
    expect(holds(got[0], opened.names[0])).toBe(true);
    expect(got[1].tabs).toHaveLength(2);
    expect(holds(got[1], opened.names[1])).toBe(true);
    expect(holds(got[1], opened.names[2])).toBe(true);
    // and all three are still sessions in the list: rearranged, not closed
    await expect(w.locator('nav .rail-row')).toHaveCount(3);
    await expect(w.locator('nav .rail-row[data-folded="true"]')).toHaveCount(0);
  });

  test('two rows: one above the other, equal heights', async () => {
    const opened = await open(2);
    a = opened.a;
    const w = a.window;

    await preset(w, 'rows').click();
    await expect.poll(async () => (await places(w)).length).toBe(2);
    const got = await places(w);
    expect(got[0].x).toBe(got[1].x);
    expect(got[1].y).toBeGreaterThan(got[0].y);
    expect(near(got[0].height, got[1].height), JSON.stringify(got)).toBe(true);
    expect(holds(got[0], opened.names[0])).toBe(true);
    expect(holds(got[1], opened.names[1])).toBe(true);
  });

  test('two by two: four equal quarters, reading left to right and then down', async () => {
    const opened = await open(4);
    a = opened.a;
    const w = a.window;

    await preset(w, 'grid').click();
    await expect.poll(async () => (await places(w)).length).toBe(4);
    const got = await places(w);
    for (const p of got) {
      expect(near(p.width, got[0].width), JSON.stringify(got)).toBe(true);
      expect(near(p.height, got[0].height), JSON.stringify(got)).toBe(true);
    }
    // two rows of two
    expect(got[0].y).toBe(got[1].y);
    expect(got[2].y).toBe(got[3].y);
    expect(got[2].y).toBeGreaterThan(got[0].y);
    opened.names.forEach((name, i) => expect(holds(got[i], name)).toBe(true));
  });

  test('one place: back to every session as a tab', async () => {
    const opened = await open(3);
    a = opened.a;
    const w = a.window;

    await preset(w, 'columns3').click();
    await expect.poll(async () => (await places(w)).length).toBe(3);
    // no button for this one (the bar has room for five): the command list
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Arrange: one place');
    await w.keyboard.press('Enter');
    await expect.poll(async () => (await places(w)).length).toBe(1);
    const got = await places(w);
    expect(got[0].tabs).toHaveLength(3);
  });

  test('⭐ make them even: two side by side, one dragged wider, come back to the middle', async () => {
    // the owner's literal case
    const opened = await open(2);
    a = opened.a;
    const w = a.window;
    await preset(w, 'columns2').click();
    await expect.poll(async () => (await places(w)).length).toBe(2);
    const even = await places(w);

    // drag the divider between them well to the right
    const edge = even[0].x + even[0].width;
    const midY = even[0].y + even[0].height / 2;
    await w.mouse.move(edge + 1, midY);
    await w.mouse.down();
    await w.mouse.move(edge + 80, midY, { steps: 4 });
    await w.mouse.move(edge + 160, midY, { steps: 4 });
    await w.mouse.up();
    // the precondition: they really are uneven now, by a lot
    await expect
      .poll(async () => {
        const p = await places(w);
        return p[0].width - p[1].width;
      })
      .toBeGreaterThan(200);

    await preset(w, 'equalize').click();
    await expect
      .poll(async () => {
        const p = await places(w);
        return Math.abs(p[0].width - p[1].width);
      })
      .toBeLessThanOrEqual(SLACK);
    // nothing moved: the same session is still on each side
    const after = await places(w);
    expect(holds(after[0], opened.names[0])).toBe(true);
    expect(holds(after[1], opened.names[1])).toBe(true);
  });

  test('the same arrangements are in the command list, and the arrangement survives a relaunch', async () => {
    const opened = await open(3);
    a = opened.a;
    const w = a.window;

    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Arrange: three side by side');
    await w.keyboard.press('Enter');
    await expect.poll(async () => (await places(w)).length).toBe(3);

    const home = a.home;
    await w.waitForTimeout(1500); // let the layout reach disk
    await a.close();
    a = await launchApp({ home });
    await expect(row(a.window, opened.names[0])).toBeVisible({ timeout: 25_000 });
    await expect.poll(async () => (await places(a.window)).length, { timeout: 20_000 }).toBe(3);
  });

  test('with one session there is nothing to arrange: the buttons are dimmed and say why', async () => {
    const opened = await open(1);
    a = opened.a;
    const w = a.window;
    await expect(preset(w, 'columns2')).toHaveAttribute('aria-disabled', 'true');
    await expect(preset(w, 'columns2')).toHaveAttribute('title', /Nothing to arrange/);
    await preset(w, 'columns2').click({ force: true }); // dimmed: a person can still click it
    expect(await places(w)).toHaveLength(1);
  });

  test('the "▦ Grid" chip is gone in the ordinary state, and back while Focus is on', async () => {
    const opened = await open(2);
    a = opened.a;
    const w = a.window;
    await expect(w.getByTestId('layout-presets')).toBeVisible();
    await expect(w.getByTestId('layout-mode')).toHaveCount(0);

    await w.keyboard.press(`${MOD}+Shift+L`);
    await expect(w.getByTestId('layout-mode')).toContainText('Focus');
    // one or the other, never both: the bar has no room for both
    await expect(w.getByTestId('layout-presets')).toHaveCount(0);

    // The top bar with the chip showing has to fit at the width the CI
    // window has (e2e/chrome.spec.ts holds the ordinary state to the same
    // rule). Measured as the room left after the last control, not as
    // scrollWidth: a flex row's scrollWidth hides how close it is.
    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: 1024, height: 686 });
    });
    await expect
      .poll(async () => w.evaluate(() => window.innerWidth), { timeout: 10_000 })
      .toBeLessThanOrEqual(1024);
    const fit = await w.evaluate(() => {
      const bar = document.querySelector('header')!;
      const box = bar.getBoundingClientRect();
      const kids = Array.from(bar.querySelectorAll<HTMLElement>('button, [role="group"]'));
      const right = Math.max(...kids.map((k) => k.getBoundingClientRect().right));
      const left = Math.min(...kids.map((k) => k.getBoundingClientRect().left));
      return {
        spare: Math.round(box.right - right),
        cutLeft: Math.round(left - box.left),
        tall: Math.round(box.height),
        scroll: bar.scrollWidth - bar.clientWidth,
      };
    });
    expect(fit.scroll, JSON.stringify(fit)).toBeLessThanOrEqual(0);
    expect(fit.spare, JSON.stringify(fit)).toBeGreaterThanOrEqual(0);
    expect(fit.cutLeft, JSON.stringify(fit)).toBeGreaterThanOrEqual(0);
    expect(fit.tall, JSON.stringify(fit)).toBeLessThanOrEqual(40);
    console.log('[layout-presets] top bar with Focus on, at 1024:', JSON.stringify(fit));
    // ...and an arrangement is made in the plain grid, so asking for one ends Focus
    await w.keyboard.press(`${MOD}+Shift+L`); // Queue
    await w.keyboard.press(`${MOD}+Shift+L`); // Grid
    await expect(w.getByTestId('layout-mode')).toHaveCount(0);
    await expect(w.getByTestId('layout-presets')).toBeVisible();
  });

  test('choosing an arrangement from the command list while Focus is on ends Focus', async () => {
    const opened = await open(2);
    a = opened.a;
    const w = a.window;
    await w.keyboard.press(`${MOD}+Shift+L`);
    await expect(w.getByTestId('layout-mode')).toContainText('Focus');

    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Arrange: two rows');
    await w.keyboard.press('Enter');
    // an arrangement is made by hand, in the plain grid
    await expect(w.getByTestId('layout-mode')).toHaveCount(0);
    await expect(w.getByTestId('layout-presets')).toBeVisible();
    // ...and the session Focus had folded away is BACK, and arranged: going
    // to Grid this way is the same as going there any other way
    await expect.poll(async () => (await places(w)).length, { timeout: 15_000 }).toBe(2);
    const got = await places(w);
    expect(got[1].y).toBeGreaterThan(got[0].y);
    await expect(w.locator('nav .rail-row[data-folded="true"]')).toHaveCount(0);
  });

  test('a popped-out session is left alone, and comes back when its window closes', async () => {
    // The rule "popped-out windows are not touched", end to end.
    //
    // A review raised that dockview can leave an empty, hidden place in the
    // main workspace for a popped-out window, which an arrangement would tidy
    // away and "make them even" would give a share to. The code guards both
    // (`inGrid` in grid-presets, `visible` in lib/layout-presets, each with a
    // unit test). BE HONEST ABOUT THIS TEST, THOUGH: it was run with the
    // guard taken out and it still passed, so in this app, today, popping a
    // card out does not leave such a place. It is here for the behaviour,
    // not as proof the guard is needed.
    skipPopoutOnLinux();
    test.slow();
    const opened = await open(3);
    a = opened.a;
    const w = a.window;

    await row(w, opened.names[0]).click();
    await expect(w.locator('.dv-active-tab')).toContainText(opened.names[0]);
    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => a.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');

    // two are left in the main window: arrange THEM
    await preset(w, 'columns2').click();
    await expect.poll(async () => (await places(w)).length).toBe(2);
    let got = await places(w);
    // half each: the hidden spot got no share
    expect(near(got[0].width, got[1].width), JSON.stringify(got)).toBe(true);
    expect(holds(got[0], opened.names[1])).toBe(true);
    expect(holds(got[1], opened.names[2])).toBe(true);
    // the popped-out window is still there
    expect(a.app.windows().filter((p) => p.url().includes('popout.html'))).toHaveLength(1);

    // drag one wider, then even: still half each
    const edge = got[0].x + got[0].width;
    const midY = got[0].y + got[0].height / 2;
    await w.mouse.move(edge + 1, midY);
    await w.mouse.down();
    await w.mouse.move(edge + 120, midY, { steps: 6 });
    await w.mouse.up();
    await preset(w, 'equalize').click();
    await expect
      .poll(async () => {
        const p = await places(w);
        return Math.abs(p[0].width - p[1].width);
      })
      .toBeLessThanOrEqual(SLACK);

    // and when its window closes, the session comes back to the workspace
    await popout.evaluate(() => window.close());
    await expect.poll(() => a.app.windows().length, { timeout: 15_000 }).toBe(1);
    await expect
      .poll(async () => (await places(w)).flatMap((p) => p.tabs).length, { timeout: 15_000 })
      .toBe(3);
    got = await places(w);
    expect(got.some((p) => holds(p, opened.names[0]))).toBe(true);
    await expect(w.locator('nav .rail-row')).toHaveCount(3);
  });
});
