// How a working session looks (#718), in the real app.
//
// Six looks, chosen in Settings, default the third. The stylesheet's rules have
// unit tests for their shape; what only the real app can show is that a row
// that IS working is actually painted differently, that each of the six really
// paints it, that a session that needs you is left alone by all of them, and
// that the choice survives a restart.
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import {
  closeSettings,
  hookPoster,
  launchApp,
  LaunchedApp,
  openSettings,
  tempProjectFolder,
} from './fixtures/app';

const row = (w: Page, title: string) =>
  w.locator('nav .rail-row').filter({ has: w.locator('[data-rail-title]', { hasText: title }) });

const LOOKS = ['glow', 'marquee', 'fill', 'shimmer', 'strip', 'bars'] as const;

/** what the row looks like, as the browser computed it */
async function paint(w: Page, title: string) {
  return row(w, title).evaluate((el) => {
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    const ring = el.querySelector('.status-ring');
    const bars = el.querySelector('.status-bars');
    return {
      background: cs.backgroundColor,
      outline: cs.outlineStyle,
      afterContent: after.content,
      afterAnimation: after.animationName,
      ringSize: ring ? getComputedStyle(ring).inlineSize : 'none',
      ringShown: ring ? getComputedStyle(ring).display !== 'none' : false,
      barsShown: bars ? getComputedStyle(bars).display !== 'none' : false,
      titleWeight: getComputedStyle(el.querySelector('[data-rail-title]')!).fontWeight,
      shadow: cs.boxShadow,
    };
  });
}

async function choose(w: Page, look: string): Promise<void> {
  const dialog = await openSettings(w);
  await dialog.locator(`[data-working-look-choice="${look}"]`).check();
  await closeSettings(w);
  await expect(w.locator('html')).toHaveAttribute('data-working-look', look);
}

test.describe('how a working session looks (#718)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.close();
  });

  test('the default is option 3: a working row is filled, bold, with a bigger spinner', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('html')).toHaveAttribute('data-working-look', 'fill');

    const post = await hookPoster(a, 1);
    await post(title, { hook_event_name: 'Stop' });
    await expect(row(w, title)).not.toHaveAttribute('data-session-status', 'working', {
      timeout: 15_000,
    });
    const idle = await paint(w, title);

    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(row(w, title)).toHaveAttribute('data-session-status', 'working', {
      timeout: 15_000,
    });
    // the row's background EASES to its new colour (0.11s), so wait for it to
    // arrive before reading it: a read on the same tick sees the old one
    await expect.poll(async () => (await paint(w, title)).background).not.toBe(idle.background);
    const working = await paint(w, title);

    // filled in: not the background it had while idle
    expect(working.background).not.toBe(idle.background);
    expect(working.titleWeight).toBe('700');
    expect(working.ringSize).toBe('17px');
    // and nothing moves but the spinner: no moving layer on the row
    expect(working.afterContent).toBe('none');
    // it is the session that is open (the only one there is), and it still
    // says so: a ring of its own inside the row. Idle, it has none.
    expect(working.shadow).toContain('inset');
    expect(idle.shadow).toBe('none');
  });

  test('each of the six really paints a working row, and each differently from the plain ring', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    const post = await hookPoster(a, 1);
    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(row(w, title)).toHaveAttribute('data-session-status', 'working', {
      timeout: 15_000,
    });

    const seen: Record<string, Awaited<ReturnType<typeof paint>>> = {};
    for (const look of LOOKS) {
      await choose(w, look);
      seen[look] = await paint(w, title);
    }

    // 1: an outline, and a glow layer that fades in and out
    expect(seen.glow.outline).toBe('solid');
    expect(seen.glow.afterAnimation).toBe('sb-work-breathe');
    // 2: a light running round the edge
    expect(seen.marquee.afterAnimation).toBe('sb-work-orbit');
    // 3: no moving layer; bigger ring; bold
    expect(seen.fill.afterContent).toBe('none');
    expect(seen.fill.ringSize).toBe('17px');
    // 4: a band sweeping across
    expect(seen.shimmer.afterAnimation).toBe('sb-work-sweep');
    // 5: a bar along the bottom
    expect(seen.strip.afterAnimation).toBe('sb-work-slide');
    // 6: bars instead of the ring, and a steady outline
    expect(seen.bars.barsShown).toBe(true);
    expect(seen.bars.ringShown).toBe(false);
    expect(seen.bars.outline).toBe('solid');
    // ...and in every other look it is the ring, not the bars
    for (const look of LOOKS.filter((l) => l !== 'bars')) {
      expect(seen[look].barsShown, look).toBe(false);
      expect(seen[look].ringShown, look).toBe(true);
    }
  });

  test('⚠️ a session that needs you looks the same under all six', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });
    const post = await hookPoster(a, 1);
    // finished, and waiting for you to look
    await post(title, { hook_event_name: 'Stop' });
    await expect(row(w, title)).toHaveAttribute('data-needs-you', 'true', { timeout: 15_000 });

    let first: Awaited<ReturnType<typeof paint>> | null = null;
    for (const look of LOOKS) {
      await choose(w, look);
      const now = await paint(w, title);
      // no working layer on it, whatever the look
      expect(now.afterContent, look).toBe('none');
      if (first) expect(now, look).toEqual(first);
      first = now;
    }
  });

  test('the choice is in Settings, shown moving, and it survives a restart', async () => {
    a = await launchApp();
    let w = a.window;
    const home = a.home;

    const dialog = await openSettings(w);
    await expect(dialog.locator('[data-working-look-choice="fill"]')).toBeChecked();
    // six samples, each painted by its own look
    await expect(dialog.locator('[data-settings-block="working-look"] [data-strip-pill]')).toHaveCount(6);
    const sampleAnimation = await dialog
      .locator('[data-working-look="shimmer"] [data-strip-pill]')
      .evaluate((el) => getComputedStyle(el, '::after').animationName);
    expect(sampleAnimation).toBe('sb-work-sweep');

    await dialog.locator('[data-working-look-choice="bars"]').check();
    await closeSettings(w);
    await expect(w.locator('html')).toHaveAttribute('data-working-look', 'bars');

    await w.waitForTimeout(1200); // let the ui blob reach disk
    await a.close();
    a = await launchApp({ home });
    w = a.window;
    await expect(w.locator('html')).toHaveAttribute('data-working-look', 'bars', { timeout: 25_000 });
  });

  test('a CLOSED group on the strip shows that a session inside it is working (#1179)', async () => {
    // The owner: "I don't know if something's running in a group currently if
    // my session window's at the top and the group is closed."
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(row(w, title)).toBeVisible({ timeout: 25_000 });

    // a group with the one session in it, arranged in the left list
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await w.locator('.rail-row').first().click({ button: 'right' });
    await w.getByRole('menuitemradio', { name: 'New group' }).click();
    await expect(w.locator('[data-group-card] .rail-row')).toHaveCount(1);

    const post = await hookPoster(a, 1);
    await post(title, { hook_event_name: 'Stop' });

    await w.locator('[data-placement="top"]').click();
    const group = w.getByTestId('sessions-strip').locator('[data-strip-group]');
    await expect(group).toHaveCount(1);
    // finished and waiting for a look: the group needs you, and is NOT marked working
    await expect(group).toHaveAttribute('data-needs-you', 'true', { timeout: 15_000 });
    await expect(group).not.toHaveAttribute('data-session-status', 'working');
    const quiet = await group.evaluate((el) => getComputedStyle(el).backgroundColor);

    // now it is working. The group is closed: nothing inside it is on screen.
    await post(title, { hook_event_name: 'UserPromptSubmit' });
    await expect(group).toHaveAttribute('data-session-status', 'working', { timeout: 15_000 });
    await expect(w.locator('[data-strip-list]')).toHaveCount(0);
    await expect(group.locator('[data-strip-group-summary]')).toHaveText('1 working');
    await expect(group.locator('.status-ring')).toBeVisible();
    // painted by the default look: filled in the group's colour, name bold
    await expect
      .poll(() => group.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(quiet);
    expect(
      await group.locator('[data-strip-group-name]').evaluate((el) => getComputedStyle(el).fontWeight)
    ).toBe('700');

    // and it follows the look chosen in Settings, like a session does
    await choose(w, 'shimmer');
    expect(
      await group.evaluate((el) => getComputedStyle(el, '::after').animationName)
    ).toBe('sb-work-sweep');
    await choose(w, 'bars');
    await expect(group.locator('.status-bars')).toBeVisible();
    await expect(group.locator('.status-ring')).toBeHidden();

    // when it finishes, the mark goes
    await post(title, { hook_event_name: 'Stop' });
    await expect(group).not.toHaveAttribute('data-session-status', 'working', { timeout: 15_000 });
  });
});
