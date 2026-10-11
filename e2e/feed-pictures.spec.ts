// Pictures in the conversation (#1235), in the real app.
//
// The owner: "if I ask Claude to mock something up, it can show it to me right
// in the session." Until this, a picture in a reply was the broken-picture
// glyph: the reference resolved against the app's own origin.
//
// What only the real app can show: that a local SVG really is DRAWN (the
// scheme, main's handler, the read scope and the content security policy all
// agreeing), that a picture which cannot be loaded becomes a chip rather than
// a broken glyph, and that a remote picture is never asked for.
//
// The fake provider answers `FAKE-REPLY: <your prompt>`, and a reply is
// rendered as markdown, so a prompt that contains picture syntax produces a
// reply that does.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);

// 600 x 900: TALLER than the cap, so the cap is what is being measured
const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">' +
  '<rect width="600" height="900" fill="#dde3ee"/><rect x="16" y="16" width="240" height="56" rx="4" fill="#3b5bdb"/></svg>';

test.describe('pictures in the conversation (#1235)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a local SVG is drawn; a missing one and a remote one are chips; a local page can be opened', async () => {
    test.setTimeout(120_000);
    const folder = tempProjectFolder();
    fs.writeFileSync(path.join(folder, 'mock.svg'), MOCK_SVG);
    fs.writeFileSync(path.join(folder, 'page.html'), '<!doctype html><title>mock</title><h1>mock</h1>');
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // every request the page makes for a picture, to prove the remote one is not among them
    const asked: string[] = [];
    w.on('request', (r) => asked.push(r.url()));

    await composer(w).click();
    await composer(w).fill(
      'PICS ![a mock-up](mock.svg) then ![gone](missing.png) then ![far](https://example.invalid/pixel.png) then [the page](page.html)'
    );
    await composer(w).press('Enter');
    const reply = w.locator('[data-feed-block="assistant"]').filter({ hasText: 'FAKE-REPLY: PICS' });
    await expect(reply).toBeVisible({ timeout: 60_000 });

    // ── THE LOCAL SVG IS DRAWN ──────────────────────────────────────────────
    const picture = reply.locator('img.doc-image');
    await expect(picture).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 })
      .toBe(600);
    await expect(picture).toHaveAttribute('alt', 'a mock-up');
    // through the one scheme main answers, never a file: or data: address
    expect(await picture.getAttribute('src')).toMatch(/^sb-doc-image:\/\/local\/\?path=/);
    // ...and it is a BUTTON, named, so the keyboard can open the whole picture
    const open = reply.locator('button.feed-image-open');
    await expect(open).toHaveCount(1);
    await expect(open).toHaveAttribute('aria-label', 'Open a mock-up at full size');
    // (the folder may be spelled differently once main has resolved it: the name is the claim)
    expect(await open.getAttribute('data-feed-open-path')).toMatch(/mock[.]svg$/);
    // CAPPED, and still the right shape: 900 tall would take over the conversation
    await expect
      .poll(async () => Math.round((await picture.boundingBox())!.height), { timeout: 15_000 })
      .toBeLessThanOrEqual(421);
    const box = (await picture.boundingBox())!;
    expect(box.height).toBeGreaterThan(300);
    expect(Math.abs(box.width / box.height - 600 / 900)).toBeLessThan(0.02);
    // ...and it took no Tab stop: the conversation is one
    await expect(open).toHaveAttribute('tabindex', '-1');

    // ── WHAT CANNOT BE SHOWN IS A CHIP, NEVER A BROKEN GLYPH ────────────────
    const chips = reply.locator('.doc-image-chip');
    await expect(chips).toHaveCount(2, { timeout: 30_000 });
    await expect(chips.filter({ hasText: 'gone' })).toContainText('Not shown');
    // the remote one offers the browser, and was never asked for
    const far = chips.filter({ hasText: 'far' });
    await expect(far.locator('button')).toHaveText('Open in browser');
    expect(asked.filter((u) => u.includes('example.invalid'))).toEqual([]);
    // no bare <img> of the reply's own survives anywhere in it
    await expect(reply.locator('img:not(.doc-image)')).toHaveCount(0);

    // ── A LINK TO A LOCAL PAGE CAN BE OPENED ────────────────────────────────
    const link = reply.locator('a', { hasText: 'the page' });
    expect(await link.getAttribute('data-feed-open-path')).toMatch(/page[.]html$/);
  });
});
