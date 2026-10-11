// A session waiting on an approval PULSES, and says how long it has (#1202).
//
// The owner: "I want it to maybe blink yellow and flash or something … because
// our approvals time out." A held approval is declined after five minutes; a
// steady yellow pill among many sessions was easy to miss, and five ran out
// unseen in one day.
//
// Real app, because the two halves that can go wrong are both outside jsdom:
// the STYLESHEET (is the cue really painted and moving on each of the four
// places it can be, and does it stand still at the same prominence when the
// system asks for less motion), and the DEADLINE crossing from main to the
// window.
import { test, expect, Locator, Page } from '@playwright/test';
import path from 'path';
import {
  answerHeldPermissions,
  launchApp,
  LaunchedApp,
  permissionHolder,
  tempProjectFolder,
} from './fixtures/app';

const row = (w: Page, title: string) => w.locator('nav .rail-row').filter({ hasText: title });
const pill = (w: Page, title: string) => w.locator('[data-strip-pill]').filter({ hasText: title });
const marked = (w: Page) => w.locator('[data-needs-approval="true"]');

/**
 * What the browser is really painting. The cue is its own layer over the
 * element, so the element's own shadows (the outline after a jump, a drop
 * target's ring) are left alone; that layer is what is read here.
 */
const painted = (el: Locator) =>
  el.evaluate((n) => {
    const cs = getComputedStyle(n, '::after');
    return {
      animation: cs.animationName,
      duration: cs.animationDuration,
      shadow: cs.boxShadow,
      opacity: cs.opacity,
      content: cs.content,
    };
  });

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

test.describe('a session waiting on an approval (#1202)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('its row and its pill pulse and show the time left; answered, they stop at once', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);

    // calm: nothing is marked and nothing moves
    await expect(marked(w)).toHaveCount(0);

    // we are standing on the SECOND session; the first asks for permission
    await permissionHolder(a)(first);
    await expect(row(w, first)).toHaveAttribute('data-needs-approval', 'true', { timeout: 20_000 });
    // only that one
    await expect(marked(w)).toHaveCount(1);
    await expect(row(w, second)).not.toHaveAttribute('data-needs-approval', 'true');

    // it MOVES: a slow pulse, far under three flashes a second
    const moving = await painted(row(w, first));
    expect(moving.animation).toBe('sb-approval-pulse');
    expect(moving.duration).toBe('1.8s');
    expect(moving.shadow).toContain('inset');

    // the deadline crossed from main: five minutes, said in the tooltip, with
    // what happens when it runs out
    await expect(row(w, first)).toHaveAttribute(
      'title',
      /^Waiting for your approval\. In less than 5 minutes the request is declined for you/
    );
    // five minutes out is not the last minute
    await expect(row(w, first)).not.toHaveAttribute('data-approval-urgent', 'true');

    // LESS MOTION: it stands still, at the pulse's loudest frame
    await w.emulateMedia({ reducedMotion: 'reduce' });
    const still = await painted(row(w, first));
    expect(still.animation).toBe('none');
    expect(still.opacity).toBe('1');
    expect(still.shadow).toContain('2px');
    await w.emulateMedia({ reducedMotion: 'no-preference' });

    // ACROSS THE TOP, the pill wears the same cue from the same rule
    await w.locator('[data-placement="top"]').click();
    await expect(pill(w, first)).toHaveAttribute('data-needs-approval', 'true');
    expect((await painted(pill(w, first))).animation).toBe('sb-approval-pulse');
    await expect(pill(w, first)).toHaveAttribute('title', /^Waiting for your approval\./);

    // ANSWERED: the cue is gone with the request. A pulse that outlives what
    // it is about is the stale-flash defect this app has had before.
    expect(await answerHeldPermissions(a)).toBe(1);
    await expect(marked(w)).toHaveCount(0, { timeout: 15_000 });
    // the layer itself is gone, not merely stopped
    expect((await painted(pill(w, first))).content).toBe('none');
  });

  test('a group carries it: its box across the top, and its header when closed on the left', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const first = path.basename(folder);
    await expect(row(w, first)).toBeVisible({ timeout: 25_000 });
    const second = await addSession(a);

    // a group with the FIRST session in it
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible();
    await row(w, first).click({ button: 'right' });
    await w.getByRole('menuitemradio', { name: 'New group' }).click();
    const card = w.locator('nav [data-group-card]', { hasText: 'New group' });
    await expect(card.locator('.rail-row')).toHaveCount(1);
    const head = card.locator('.rail-head');

    // stand on the second session; the one in the group asks
    await row(w, second).click();
    await permissionHolder(a)(first);
    await expect(row(w, first)).toHaveAttribute('data-needs-approval', 'true', { timeout: 20_000 });

    // OPEN, the row speaks for itself and the header is quiet: two things
    // pulsing for one request is noise
    await expect(head).not.toHaveAttribute('data-needs-approval', 'true');

    // CLOSED, the header is all there is, so it carries the cue and it is
    // really painted there (a header can be opaque; a cue on the card behind
    // it would not be seen)
    await head.click();
    await expect(row(w, first)).toBeHidden();
    await expect(head).toHaveAttribute('data-needs-approval', 'true');
    const onHead = await painted(head);
    expect(onHead.animation).toBe('sb-approval-pulse');
    expect(onHead.content).not.toBe('none');
    await expect(head).toHaveAttribute('title', /^Waiting for your approval\. In less than 5 minutes/);

    // ACROSS THE TOP a group is one box, and the box carries it
    await w.locator('[data-placement="top"]').click();
    const box = w.locator('[data-strip-group][data-needs-approval="true"]');
    await expect(box).toHaveCount(1);
    expect((await painted(box)).animation).toBe('sb-approval-pulse');
    await expect(box).toHaveAttribute('title', /^Waiting for your approval\./);

    expect(await answerHeldPermissions(a)).toBe(1);
    await expect(marked(w)).toHaveCount(0, { timeout: 15_000 });
  });
});
