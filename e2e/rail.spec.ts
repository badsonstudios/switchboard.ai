// The redesigned sessions rail (design_handoff_sessions_rail).
//
// The rail's contract is "which sessions need me right now", so the attention
// treatment is driven through the REAL hook listener — the test plays the
// CLI's part and asserts what a human would actually see, including the
// numeric contrast between a needy row and a calm one.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, hookPoster } from './fixtures/app';

const rail = (w: Page) => w.locator('nav');
const row = (w: Page, title: string) =>
  rail(w).locator('[draggable="true"]', { hasText: title }).first();

test.describe('sessions rail', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /**
   * One session inside one real group — the design's actual shape, and the
   * only arrangement that has a group header to summarize. (A workspace with
   * no groups at all renders the loose sessions headerless on purpose; the
   * footer is what carries the count there.)
   */
  async function oneSessionInAGroup(): Promise<{ w: Page; title: string }> {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Create a persistent group').click();
    const header = w.getByText('New group', { exact: true });
    await expect(header).toBeVisible();
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row(w, title).dispatchEvent('dragstart', { dataTransfer: dt });
    await header.dispatchEvent('drop', { dataTransfer: dt });
    await expect(rail(w).getByText('empty', { exact: true })).toHaveCount(0);
    return { w, title };
  }

  test('a session that needs you is loud; a calm one stays plain', async () => {
    const { w, title } = await oneSessionInAGroup();

    // calm to start: no attention tint, and the header summary says so
    const r = row(w, title);
    await expect(r).toHaveAttribute('data-needs-you', 'false');
    await expect(rail(w).getByText('calm')).toBeVisible();
    await expect(rail(w).getByText('need you')).toHaveCount(0);

    const post = await hookPoster(a);
    await post(title, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });

    // the row now SPELLS OUT the ask instead of showing a status word
    await expect(r).toHaveAttribute('data-session-status', 'needs-permission', { timeout: 15_000 });
    await expect(r.getByText('Wants permission to run')).toBeVisible();
    await expect(r).toHaveAttribute('data-needs-you', 'true');

    // ...the name goes bold and the identity bar thickens (2.5px -> 4px)
    const name = r.locator('span', { hasText: title }).first();
    await expect
      .poll(() => name.evaluate((el) => getComputedStyle(el).fontWeight))
      .toBe('700');
    await expect
      .poll(() => r.locator('span[aria-hidden]').first().evaluate((el) => getComputedStyle(el).width))
      .toBe('4px');

    // ...and both counters agree with the row, because one rule feeds all three
    await expect(rail(w).getByText('1 need you')).toHaveCount(2); // group summary + footer
    await expect(rail(w).getByText('calm')).toHaveCount(0);
  });

  test('answering the session puts the rail back to calm', async () => {
    const { w, title } = await oneSessionInAGroup();
    const post = await hookPoster(a);
    await post(title, { hook_event_name: 'Stop' }); // finished, unreviewed
    const r = row(w, title);
    await expect(r).toHaveAttribute('data-session-status', 'done', { timeout: 15_000 });
    await expect(r.getByText('Finished — review changes')).toBeVisible();

    // back to work: the attention treatment must clear completely, or the rail
    // cries wolf and the whole panel stops meaning anything
    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(r).toHaveAttribute('data-needs-you', 'false', { timeout: 15_000 });
    await expect(rail(w).getByText('calm')).toBeVisible();
    await expect(rail(w).getByText('need you')).toHaveCount(0);
  });

  test("the row's ✕ ends the session, and only after the confirm", async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // dismissing the confirm keeps the session — the ✕ sits on every row, so a
    // mis-click must never be able to kill work
    w.once('dialog', (d) => void d.dismiss());
    await row(w, title).getByTitle('Close session').click();
    await expect(row(w, title)).toBeVisible();

    w.once('dialog', (d) => void d.accept());
    await row(w, title).getByTitle('Close session').click();
    await expect(rail(w).getByText(title)).toHaveCount(0);
  });

  test('right-click opens the changes tab (the diff affordance the rows dropped)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await row(w, title).click({ button: 'right' });
    await expect(w.getByRole('menu')).toBeVisible();
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.getByRole('menu')).toHaveCount(0);
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
  });

  test('the right-click menu stays INSIDE the window, however little room is under it (#641)', async () => {
    // The regression #559 fired and nothing caught until CI: the rail's menu is
    // `position: fixed` at the pointer, so a menu taller than the room beneath
    // it hangs off the bottom edge — and a fixed box has no scroll container,
    // so the items past the fold are unreachable. `Move up`/`Move down` added
    // ~72px, the bottom radio landed 7px below the windows-latest runner's
    // 655px viewport, and `click()` retried for 30s against an element
    // Playwright itself called "visible, enabled and stable".
    //
    // Stated as geometry rather than inherited from the developer's monitor:
    // the window is squeezed to its own 600px minimum, which is short enough
    // that this menu cannot fit below row 2 on ANY machine — and the test
    // asserts that precondition, so it can never quietly stop testing anything.
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });

    // a second session, so the menu carries #559's `Order in this group`
    // section — the shape that actually shipped, not a trimmed-down one
    const second = tempProjectFolder();
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, second);
    await w.getByRole('button', { name: '+ session' }).click();
    const title = path.basename(second);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const b = win.getBounds();
      win.setBounds({ x: b.x, y: b.y, width: 1024, height: 600 }); // the app's own minimum
    });
    await expect
      .poll(async () => w.evaluate(() => window.innerHeight), { timeout: 10_000 })
      .toBeLessThan(600);

    const rowBox = (await row(w, title).boundingBox())!;
    await row(w, title).click({ button: 'right' });
    const menu = w.getByRole('menu');
    await expect(menu).toBeVisible();

    const geom = await w.evaluate(() => {
      const el = document.querySelector('[role="menu"]') as HTMLElement;
      const last = document.querySelector('[data-focus-item="none"]') as HTMLElement;
      const m = el.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return {
        viewport: window.innerHeight,
        menu: { top: m.top, bottom: m.bottom, height: el.scrollHeight },
        last: { top: l.top, bottom: l.bottom },
      };
    });

    // the precondition: at the pointer, this menu genuinely does not fit
    const pointerY = rowBox.y + rowBox.height / 2;
    expect(
      pointerY + geom.menu.height,
      'the window is no longer tight enough for this test to mean anything'
    ).toBeGreaterThan(geom.viewport);

    // ...and it was placed anyway — whole menu on screen, last item included
    expect(geom.menu.top).toBeGreaterThanOrEqual(0);
    expect(geom.menu.bottom).toBeLessThanOrEqual(geom.viewport);
    expect(geom.last.bottom).toBeLessThanOrEqual(geom.viewport);

    // and it is OPERABLE, not merely on screen. A short timeout on purpose: the
    // failure this guards against is a 30s click retry, and a regression should
    // say so in seconds.
    await w.locator('[data-focus-item="none"]').click({ timeout: 10_000 });
    await expect(menu).toHaveCount(0);
    await row(w, title).click({ button: 'right' });
    await expect(w.locator('[data-focus-item="none"]')).toHaveAttribute('aria-checked', 'true');
  });

  test('a session can be dropped ANYWHERE on a group card, not just its header', async () => {
    // Dan: "I have to drag it to the little folder icon when really I should
    // just be able to drag it right into the group window anywhere."
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    const [nameA, nameB] = [path.basename(folderA), path.basename(folderB)];
    await expect(w.getByText(nameA).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(nameB).first()).toBeVisible({ timeout: 25_000 });

    // put A in a group by dropping on the header (the path that already worked)
    await w.getByTitle('Create a persistent group').click();
    const dt1 = await w.evaluateHandle(() => new DataTransfer());
    await row(w, nameA).dispatchEvent('dragstart', { dataTransfer: dt1 });
    await w.getByText('New group', { exact: true }).dispatchEvent('drop', { dataTransfer: dt1 });
    await expect(rail(w).getByText('empty', { exact: true })).toHaveCount(0);

    // now drop B on the ROW for A — deep inside the card body, nowhere near
    // the header or the folder icon
    const dt2 = await w.evaluateHandle(() => new DataTransfer());
    await row(w, nameB).dispatchEvent('dragstart', { dataTransfer: dt2 });
    await row(w, nameA).dispatchEvent('drop', { dataTransfer: dt2 });

    // both live in the group card now
    const card = rail(w).locator('[data-group-card]', { hasText: 'New group' });
    await expect(card.locator('[draggable="true"]')).toHaveCount(2, { timeout: 15_000 });
  });

  test('an auto-group REFUSES a drop instead of silently swallowing it', async () => {
    // Dan 2026-07-26: two of his four cards wouldn't accept a drag and it took
    // a while to work out they were the automatic ones. The old code called
    // preventDefault on their dragover — so the browser advertised them as
    // valid targets — and then resolved the drop to "no group", which for an
    // already-ungrouped session is a no-op. Looked droppable, wasn't.
    const shared = tempProjectFolder();
    const other = tempProjectFolder();
    a = await launchApp({ seedFolder: shared });
    const w = a.window;
    const sharedName = path.basename(shared);
    await expect(w.getByText(sharedName).first()).toBeVisible({ timeout: 25_000 });

    // a second session in the SAME folder mints the auto-group
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, shared);
    await w.getByRole('button', { name: '+ session' }).click();
    const auto = w.locator('[data-group-kind="auto"]');
    await expect(auto).toBeVisible({ timeout: 25_000 });
    await expect(auto.locator('[draggable="true"]')).toHaveCount(2);

    // ...and a loose session in a different folder to drag at it
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, other);
    await w.getByRole('button', { name: '+ session' }).click();
    const otherName = path.basename(other);
    await expect(w.getByText(otherName).first()).toBeVisible({ timeout: 25_000 });

    // dragover must NOT be accepted — an unprevented dragover is exactly what
    // makes the browser draw a no-drop cursor
    const dt = await w.evaluateHandle(() => new DataTransfer());
    await row(w, otherName).dispatchEvent('dragstart', { dataTransfer: dt });
    const accepted = await auto.evaluate((el, type) => {
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: new DataTransfer() });
      (ev.dataTransfer as DataTransfer).setData(type, 'x');
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, 'application/x-switchboard-card');
    expect(accepted, 'auto-group advertised itself as a drop target').toBe(false);

    // and the auto-group is unchanged: still exactly its two same-folder members
    await expect(auto.locator('[draggable="true"]')).toHaveCount(2);
  });

  test('a group name clears AA against its card in BOTH themes', async () => {
    // The group palette is tuned to read on a dark panel; raw, those mid-tones
    // land at 2.2-3.1:1 as 11.5px text on the daylight card. Measured, not
    // eyeballed, so a future palette or token edit can't quietly break it.
    const { w } = await oneSessionInAGroup();
    const name = w.getByText('New group', { exact: true });

    for (const theme of ['Daylight', 'Nordic'] as const) {
      await w.getByRole('button', { name: theme }).click();
      const ratio = await name.evaluate((el) => {
        const lum = (c: string): number => {
          // two shapes come back here: rgb()/rgba() in 0-255, and — for
          // anything that went through color-mix() — color(srgb r g b) in
          // 0-1 floats. Treating the second as 0-255 silently scores every
          // mixed color as black, which is exactly how a false pass hides.
          const n = c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const [r, g, b] = c.startsWith('color(') ? n : n.map((v) => v / 255);
          const f = (s: number): number =>
            s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        // Walk up to the first OPAQUE background. The header band is a 7% tint,
        // so it must be skipped rather than measured — its rgba() channels are
        // the un-composited group color, which would score the text against
        // itself. The opaque card underneath is also the conservative choice:
        // the tint only darkens it, which helps dark text.
        let bg = 'rgb(255, 255, 255)';
        // `Element`, not `HTMLElement`: Playwright hands the callback an
        // `SVGElement | HTMLElement`, and only `Element` accepts both. Both
        // `getComputedStyle` and `parentElement` are defined on it.
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor;
          const parts = c.match(/[\d.]+/g);
          if (parts && (parts.length < 4 || Number(parts[3]) >= 0.99)) {
            bg = c;
            break;
          }
        }
        const a = lum(getComputedStyle(el).color);
        const b = lum(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio, `${theme} group name contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('the shared container frame reads against every surface it borders', async () => {
    // Dan asked for one border treatment across the rail's group cards and the
    // grid's session windows, and for it to be more prevalent than the first
    // pass. Asserting the TOKEN covers both consumers at once — and covers the
    // UNFOCUSED frame, which is the case tabs.spec can't see (with one group
    // on screen it is always the accent-drawn active one).
    a = await launchApp({ seedFolder: tempProjectFolder() });
    const w = a.window;
    await expect(w.locator('nav [draggable="true"]')).toHaveCount(1, { timeout: 25_000 });

    for (const theme of ['daylight', 'nordic']) {
      await w.getByRole('button', { name: theme, exact: true }).click();
      await w.waitForTimeout(200);
      const ratios = await w.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const tok = (n: string): string => root.getPropertyValue(n).trim();
        const lum = (hex: string): number => {
          const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)!;
          const f = (h: string): number => {
            const s = parseInt(h, 16) / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
        };
        const ratio = (x: string, y: string): number => {
          const [a2, b2] = [lum(x), lum(y)];
          const [hi, lo] = a2 > b2 ? [a2, b2] : [b2, a2];
          return (hi + 0.05) / (lo + 0.05);
        };
        const frame = tok('--group-frame');
        return {
          // the grid's session window against its own surface
          vsCard: ratio(frame, tok('--panel')),
          // the rail's group card, and the canvas the card sits on
          vsRailCard: ratio(frame, tok('--rail-card')),
          vsRailCanvas: ratio(frame, tok('--rail-canvas')),
        };
      });
      for (const [where, r] of Object.entries(ratios)) {
        expect(r, `${theme} frame ${where}`).toBeGreaterThan(1.55);
      }
    }
  });

  test('the rail width is draggable and survives a relaunch', async () => {
    a = await launchApp();
    const first = a;
    const w = first.window;
    const nav = rail(w);
    const before = (await nav.boundingBox())!.width;
    expect(Math.round(before)).toBe(286); // the design's figure, as shipped

    // drag the edge out to ~380px
    const handle = w.getByTitle('Drag to resize the rail');
    const box = (await handle.boundingBox())!;
    await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await w.mouse.down();
    await w.mouse.move(380, box.y + box.height / 2, { steps: 10 });
    await w.mouse.up();
    await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(380);

    await w.waitForTimeout(800); // let the debounced ui-blob save reach disk
    await first.close();
    a = await launchApp({ home: first.home });
    await expect
      .poll(async () => Math.round((await rail(a.window).boundingBox())!.width))
      .toBe(380);
  });
});
