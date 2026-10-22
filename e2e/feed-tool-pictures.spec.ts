// Pictures that arrive IN the conversation (#1240), in the real app.
//
// A tool can answer with a picture (a `Read` of a `.png`, a screenshot from an
// MCP tool). Until this the conversation flattened a tool's result to its
// text, so the picture was dropped.
//
// What only the real app can show: that the thumbnail is really DRAWN, which
// takes the message, main's store, the handle on the block, the picture
// scheme's `feed` host and the content security policy all agreeing; that it
// is never a `data:` address; and that a picture which cannot be drawn is the
// placeholder in the same box, not a broken glyph.
//
// The fake CLI's `!shot` answers with two tool calls: a `Read` whose result
// is one picture and no text, and a screenshot tool whose result is text, a
// large picture, and a picture of a type nothing draws.
// (A picture ATTACHED to a prompt is `composer-paste.spec.ts`, which already
// makes the whole trip from a paste.)
import { test, expect, Page } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/^Message .+…$/);

test.describe('pictures a tool returned (#1240)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a thumbnail is drawn on the tool’s box; one that cannot be drawn is a placeholder of the same size', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(composer(w)).toBeVisible({ timeout: 25_000 });

    const asked: string[] = [];
    w.on('request', (r) => asked.push(r.url()));

    await composer(w).click();
    await composer(w).fill('!shot');
    await composer(w).press('Enter');
    await expect(w.getByText('SHOT_PROSE after the pictures')).toBeVisible({ timeout: 60_000 });

    // ── THE READ: ONE PICTURE, DRAWN ────────────────────────────────────────
    // (and NOT folded away: a result with a picture is an event)
    const strips = w.locator('[data-feed-pictures]');
    await expect(strips).toHaveCount(2, { timeout: 30_000 });
    const read = strips.nth(0);
    const picture = read.locator('button[data-feed-picture] img');
    await expect(picture).toHaveCount(1);
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 })
      .toBe(2);
    // by handle, through the one scheme main answers; never the bytes
    expect(await picture.getAttribute('src')).toMatch(/^sb-doc-image:\/\/feed\/\?id=[0-9a-f-]{36}$/);
    await expect(picture).toHaveAttribute('alt', 'Picture from Read');
    const open = read.locator('button[data-feed-picture]');
    await expect(open).toHaveAttribute('aria-label', 'Open Picture from Read at full size');
    await expect(open).toHaveAttribute('tabindex', '-1');
    // THE BOX: one size, whatever the picture's own (this one is 2 x 1)
    // (144 x 108 and a hairline each side; a pixel of slack for the window's zoom)
    const box = (await open.boundingBox())!;
    expect(Math.abs(box.width - 146)).toBeLessThan(2);
    expect(Math.abs(box.height - 110)).toBeLessThan(2);

    // ── THE SCREENSHOT TOOL: ONE DRAWN, ONE A PLACEHOLDER ───────────────────
    const shot = strips.nth(1);
    await expect(shot).toHaveAttribute('data-feed-pictures', '2');
    const large = shot.locator('button[data-feed-picture] img');
    await expect(large).toHaveCount(1, { timeout: 30_000 });
    // THE TOOL RETURNED 1200 x 800, AND THAT IS NOT WHAT REACHED THE PAGE: main
    // drew it small (twice the box, for a dense display), in its own shape
    await expect
      .poll(() => large.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 })
      .toBe(288);
    expect(await large.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(192);
    const gone = shot.locator('[data-feed-picture-gone]');
    await expect(gone).toHaveCount(1, { timeout: 30_000 });
    await expect(gone).toContainText('Picture 2 from mcp__browser__screenshot');
    await expect(gone).toContainText('Not shown');
    // the same box as a drawn one, so nothing moved when it turned out not to load
    const goneBox = (await gone.boundingBox())!;
    expect(Math.abs(goneBox.width - box.width)).toBeLessThan(0.5);
    expect(Math.abs(goneBox.height - box.height)).toBeLessThan(0.5);
    // no broken-picture glyph anywhere in the conversation
    const broken = await w.evaluate(
      () =>
        [...document.querySelectorAll<HTMLImageElement>('[data-feed-pictures] img')].filter(
          (i) => i.complete && i.naturalWidth === 0
        ).length
    );
    expect(broken).toBe(0);

    // ── NOTHING WAS ASKED FOR AS DATA ───────────────────────────────────────
    expect(asked.some((u) => u.startsWith('data:image') || u.startsWith('blob:'))).toBe(false);
    expect(asked.filter((u) => u.startsWith('sb-doc-image://feed/')).length).toBeGreaterThanOrEqual(3);

    // ── A REMOUNT SHOWS THE SAME PICTURES ───────────────────────────────────
    // (the backlog a mounting panel reads carries the same handles)
    const src = await picture.getAttribute('src');
    // leaving the Session tab tears its whole tree down: the cheapest real remount
    await w.getByRole('tab', { name: 'Changes' }).click();
    await expect(composer(w)).toHaveCount(0, { timeout: 20_000 });
    await w.getByRole('tab', { name: 'Session' }).click();
    await expect(w.locator('[data-feed-pictures]')).toHaveCount(2, { timeout: 60_000 });
    const again = w.locator('[data-feed-pictures]').nth(0).locator('button[data-feed-picture] img');
    expect(await again.getAttribute('src')).toBe(src);
    await expect
      .poll(() => again.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 })
      .toBe(2);
  });
});
