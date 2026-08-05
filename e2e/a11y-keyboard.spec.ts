// #197 — the keyboard path across the surfaces #174 left behind: the sessions
// rail, the urgency lamps, the card's view tabs, and the Events rows.
//
// The unit tests hold the SHAPE (real buttons, honest roles, resolvable
// aria-controls) off a jsdom tree. What only a real window can prove is that
// the shape adds up to a journey: that Tab actually arrives, that the focus
// ring is really painted, and that Enter on the thing you arrived at does what
// clicking it does. That is what this file is for — one journey per surface,
// driven by real key events.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder, hookPoster } from './fixtures/app';

/** what the keyboard is currently on, in the terms these assertions care about */
async function focused(w: Page): Promise<{
  tag: string;
  cls: string;
  label: string;
  expanded: string | null;
  role: string | null;
  ring: string;
}> {
  return w.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? '',
      cls: el?.className ?? '',
      label: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim().slice(0, 60),
      expanded: el?.getAttribute('aria-expanded') ?? null,
      role: el?.getAttribute('role') ?? null,
      ring: el ? getComputedStyle(el).outlineWidth : '',
    };
  });
}

/** press Tab until the focused element matches, and say how many it took */
async function tabUntil(w: Page, selector: string, max = 12): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await w.keyboard.press('Tab');
    const hit = await w.evaluate(
      (sel) => !!(document.activeElement as HTMLElement | null)?.matches(sel),
      selector
    );
    if (hit) return i;
  }
  throw new Error(`Tab never reached ${selector} in ${max} presses`);
}

test.describe('keyboard paths swept by #197', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('the sessions rail is walkable, operable and visibly focused', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    // A group, so the header disclosure is on screen too. "+ group" is a real
    // button and sits immediately above the list, which makes it the honest
    // place to start Tabbing from.
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group', { exact: true })).toBeVisible();

    // 1. one Tab off the header reaches the group's disclosure, and it says so
    await tabUntil(w, '[data-rail-group-toggle]');
    let f = await focused(w);
    expect(f.tag).toBe('BUTTON');
    expect(f.label).toBe('New group');
    expect(f.expanded).toBe('true');
    // a keyboard path nobody can SEE is not a keyboard path
    expect(f.ring).not.toBe('0px');

    // 2. Enter collapses it and Enter opens it again — the platform's, because
    //    it is a real button and not a div pretending
    await w.keyboard.press('Enter');
    expect((await focused(w)).expanded).toBe('false');
    await expect(w.getByText('empty', { exact: true })).toHaveCount(0);
    await w.keyboard.press('Enter');
    expect((await focused(w)).expanded).toBe('true');
    await expect(w.getByText('empty', { exact: true })).toBeVisible();

    // 3. Tab reaches the session row's own button, which announces the session
    //    AND its state — the state used to live only in a decorative glyph
    await tabUntil(w, '[data-rail-open]');
    f = await focused(w);
    expect(f.tag).toBe('BUTTON');
    expect(f.label).toContain(title);
    expect(f.label).toContain('—');
    expect(f.ring).not.toBe('0px');

    // 4. Enter focuses that session, exactly as clicking the row does
    await w.keyboard.press('Enter');
    await expect(w.locator('.dv-active-tab')).toContainText(title);
    await expect(w.locator(`[data-rail-open][aria-current="true"]`)).toHaveCount(1);

    // 5. Shift+F10 is the keyboard's right-click. The menu it opens is walkable
    //    and Escape puts you back where you were — a menu you can summon but
    //    not leave is a trap, not an affordance.
    await w.keyboard.press('Shift+F10');
    await expect(w.locator('[role="menu"]')).toBeVisible();
    expect((await focused(w)).role).toBe('menuitem');
    await w.keyboard.press('ArrowDown');
    expect((await focused(w)).label).toBe('Rename…');
    await w.keyboard.press('Escape');
    await expect(w.locator('[role="menu"]')).toHaveCount(0);
    expect((await focused(w)).cls).toBe('rail-row-open');
  });

  test('the card view tabs are a real tablist, walked with the arrows', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // by testid, not by role: dockview publishes a `tablist` of its own for the
    // session CARDS, and it comes first in the document
    const strip = w.getByTestId('view-tabs').first();
    await expect(strip).toBeVisible({ timeout: 25_000 });
    const tabs = strip.getByRole('tab');
    expect(await tabs.count()).toBeGreaterThan(1);

    // exactly one selected tab, and exactly one tab stop: a tablist promises
    // arrows inside it, so N tab stops would be the broken half of that promise
    await expect(strip.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
    await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    const selected = strip.locator('[role="tab"][aria-selected="true"]');
    const before = await selected.getAttribute('data-vtab');

    // the selected tab points at a panel that exists, and the panel points back
    const panelId = await selected.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = w.locator(`[role="tabpanel"][id="${panelId}"]`);
    await expect(panel).toHaveCount(1);
    expect(await panel.getAttribute('aria-labelledby')).toBe(await selected.getAttribute('id'));

    // ArrowRight MOVES focus and nothing else. Manual activation is the point:
    // arrowing past Changes must not build its diff on the way through.
    await selected.press('ArrowRight');
    const f = await focused(w);
    expect(f.role).toBe('tab');
    expect(f.ring).not.toBe('0px');
    const walked = await w.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.vtab ?? ''
    );
    expect(walked).not.toBe(before);
    expect(await selected.getAttribute('data-vtab')).toBe(before); // still selected
    // the roving stop went WITH the focus: leaving it on the selected tab would
    // lose your place the moment you Tab out and back
    await expect(strip.locator(`[role="tab"][data-vtab="${walked}"]`)).toHaveAttribute(
      'tabindex',
      '0'
    );
    await expect(strip.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

    // Enter is what selects
    await w.keyboard.press('Enter');
    await expect(strip.locator(`[role="tab"][data-vtab="${walked}"]`)).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // End reaches the far tab, Home comes back, and the walk wraps
    await w.keyboard.press('End');
    const last = await w.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.vtab ?? ''
    );
    await w.keyboard.press('ArrowRight'); // a closed ring, not a dead key
    expect(await w.evaluate(() => (document.activeElement as HTMLElement).dataset.vtab)).not.toBe(
      last
    );
    await w.keyboard.press('Home');
    expect(await w.evaluate(() => (document.activeElement as HTMLElement).dataset.vtab)).toBe(
      await strip.locator('[role="tab"]').first().getAttribute('data-vtab')
    );
  });

  test('an Events row opens its session from the keyboard, and the lamps say where you are', async () => {
    const folders = [tempProjectFolder(), tempProjectFolder()];
    a = await launchApp({ seedFolder: folders[0] });
    const w = a.window;
    const names = folders.map((f) => path.basename(f));
    await expect(w.getByText(names[0]).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, folders[1]);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.locator('[data-urgency-lamp]')).toHaveCount(2, { timeout: 25_000 });

    // the lamps: named buttons, and "you are here" is not carried by color alone
    const lamps = w.locator('[data-urgency-lamp]');
    await expect(lamps.first()).toHaveJSProperty('tagName', 'BUTTON');
    await expect(w.locator('[data-urgency-lamp][aria-current="true"]')).toHaveCount(1);

    // make the FIRST session ask for something, so it has an Events row
    const post = await hookPoster(a, 2);
    await post(names[0], {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    });
    const row = w.locator('[role="listitem"]', { hasText: names[0] }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // the row is a list item holding TWO reachable buttons — open, and dismiss.
    // Nesting dismiss inside the open button would have hidden it from both a
    // screen reader and the Tab key.
    const open = row.locator('[data-event-open]');
    await expect(open).toHaveJSProperty('tagName', 'BUTTON');
    await expect(row.locator('.event-dismiss')).toHaveJSProperty('tagName', 'BUTTON');
    await expect(open).not.toHaveAttribute('tabindex', '-1');

    // we are standing on the SECOND session; Enter on the row moves us
    await expect(w.locator('.dv-active-tab')).toContainText(names[1]);
    await open.press('Enter');
    await expect(w.locator('.dv-active-tab')).toContainText(names[0]);
    // the lamps followed, so "you are here" stayed true across the jump
    await expect(w.locator('[data-urgency-lamp][aria-current="true"]')).toHaveCount(1);
  });
});
