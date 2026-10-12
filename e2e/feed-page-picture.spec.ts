// A picture of an HTML mock-up in the conversation (#1239), in the real app.
//
// The owner, offered a live frame: "I like the rule for now, so maybe we just
// do pictures of mockups." So a reply that names a local `.html` file gets a
// PICTURE of the page, which main draws in a window nobody sees.
//
// What only the real app can show is the half no unit test reaches: that the
// hidden window really draws, and that it is the box it claims to be. The page
// here is built to tell on it. Its colours are the evidence:
//
//   - the stylesheet NEXT TO the page paints a black box top-left: it loaded;
//   - a script would turn the whole page magenta: it did not run;
//   - a white picture from OUTSIDE the page's folder would sit top-right: it
//     was refused;
//   - and a local web server counts the requests the page makes to it, AND
//     the connections: none. Connections, because a page can ask the browser
//     to look a name up or open a connection early (`dns-prefetch`,
//     `preconnect`), and neither of those is a request anything gets to
//     cancel. The page tries both, and a `<meta refresh>` to the server too.
//
// Every colour is the same read as RGBA or BGRA, so the pixel check does not
// care which the platform hands back.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const composer = (w: Page) => w.getByPlaceholder(/Prompt this session/);

const WHITE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/></svg>';

test.describe('a picture of an HTML mock-up (#1239)', () => {
  let a: LaunchedApp;
  let server: http.Server | undefined;
  let outside: string | undefined;
  test.afterEach(async () => {
    await a?.cleanup();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  });

  test('the page is drawn as a picture: its own stylesheet in, script, the web and other folders out', async () => {
    test.setTimeout(120_000);

    // a web server on this machine that counts what it is asked for
    const hits: string[] = [];
    let connections = 0;
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('body { background: #ff00ff !important; }');
    });
    server.on('connection', () => (connections += 1));
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;

    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-page-outside-'));
    fs.writeFileSync(path.join(outside, 'white.svg'), WHITE_SVG);

    const folder = tempProjectFolder();
    fs.writeFileSync(path.join(folder, 'mock.css'), '.box { position: fixed; left: 0; top: 0; width: 300px; height: 300px; background: #000000; }');
    fs.writeFileSync(
      path.join(folder, 'mock.html'),
      [
        '<!doctype html><html><head><title>mock</title>',
        '<link rel="stylesheet" href="mock.css">',
        `<link rel="stylesheet" href="http://127.0.0.1:${port}/remote.css">`,
        `<link rel="preconnect" href="http://127.0.0.1:${port}">`,
        `<link rel="dns-prefetch" href="http://127.0.0.1:${port}">`,
        `<link rel="prefetch" href="http://127.0.0.1:${port}/prefetch">`,
        `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/refresh">`,
        '</head><body style="margin:0;background:#00ff00">',
        '<div class="box"></div>',
        `<img src="${pathToFileURL(path.join(outside, 'white.svg')).href}" style="position:fixed;right:0;top:0;width:200px;height:200px">`,
        `<img src="http://127.0.0.1:${port}/pixel.png" style="position:fixed;right:0;bottom:0">`,
        '<script>document.body.style.background = "#ff00ff";</script>',
        '</body></html>',
      ].join('\n')
    );

    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    await composer(w).click();
    await composer(w).fill('PAGE I wrote [the mock-up](mock.html) for you');
    await composer(w).press('Enter');
    const reply = w.locator('[data-feed-block="assistant"]').filter({ hasText: 'FAKE-REPLY: PAGE' });
    await expect(reply).toBeVisible({ timeout: 60_000 });

    // ── A PICTURE, UNDER THE WORDS, AT THE SIZE THAT WAS PROMISED ───────────
    const picture = reply.locator('img.feed-page-image');
    await expect(picture).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 })
      .toBe(1280);
    expect(await picture.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(800);
    const src = (await picture.getAttribute('src'))!;
    expect(src).toMatch(/^sb-doc-image:\/\/local\/\?path=/);
    await expect(picture).toHaveAttribute('alt', 'A picture of the page mock.html');
    // capped like every picture, and still the page's shape
    const box = (await picture.boundingBox())!;
    expect(Math.round(box.height)).toBeLessThanOrEqual(420);
    expect(Math.abs(box.width / box.height - 1280 / 800)).toBeLessThan(0.02);

    // ── IT OPENS THE REAL PAGE, AND SAYS WHAT IT IS ─────────────────────────
    const open = reply.locator('.feed-page-shot button.feed-image-open');
    await expect(open).toHaveAttribute('aria-label', 'Open mock.html in your browser');
    expect(await open.getAttribute('data-feed-open-path')).toMatch(/mock[.]html$/);
    await expect(open).toHaveAttribute('tabindex', '-1');
    await expect(reply.locator('.feed-page-note')).toContainText('Scripts did not run');
    // the reply's own link is still there, and still opens the page
    expect(await reply.locator('a', { hasText: 'the mock-up' }).getAttribute('data-feed-open-path')).toMatch(
      /mock[.]html$/
    );
    // NO FRAME: the rule the owner kept
    await expect(w.locator('iframe, webview')).toHaveCount(0);

    // ── WHAT IS IN THE PICTURE ──────────────────────────────────────────────
    // Asked of main for the same address the `<img>` used, and read as pixels.
    const pixels = await a.app.evaluate(async ({ net, nativeImage }, url) => {
      const res = await net.fetch(url);
      const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
      const { width } = image.getSize();
      const bitmap = image.toBitmap();
      const at = (x: number, y: number): number[] => {
        const i = (y * width + x) * 4;
        return [bitmap[i], bitmap[i + 1], bitmap[i + 2]];
      };
      return { status: res.status, type: res.headers.get('content-type'), box: at(150, 150), corner: at(1180, 100), page: at(640, 600) };
    }, src);
    expect(pixels.status).toBe(200);
    expect(pixels.type).toBe('image/png');
    // the stylesheet beside the page loaded: black
    expect(pixels.box).toEqual([0, 0, 0]);
    // the script did not run and the remote stylesheet did not load: green, not magenta
    expect(pixels.page).toEqual([0, 255, 0]);
    // the picture from another folder was refused: green, not white
    expect(pixels.corner).toEqual([0, 255, 0]);
    // and the web server on this machine was never asked for anything, nor
    // so much as connected to
    expect(hits).toEqual([]);
    expect(connections).toBe(0);
  });
});
