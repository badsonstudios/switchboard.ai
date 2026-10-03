// Pictures inside a rendered document, end to end (#1080, §5.30).
//
// The unit tests own the decoration and the handler's refusal table. What only
// a real Electron window can prove is the part that is three systems agreeing:
// the CSP actually ALLOWS the one scheme, main actually ANSWERS it, and
// Chromium actually DECODES what came back — so this asserts on the picture's
// natural size, which is non-zero only when all three happened.
//
// And the other half, which is the half that matters: a picture OUTSIDE the
// session folder is on disk, is a real PNG, is one `../` away — and is not
// shown. A remote one is still never asked for.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir, tempProjectFolder } from './fixtures/app';

/** A tracking pixel's host. `.invalid` can never resolve, belt to the braces. */
const TRACKER = 'https://tracker.invalid/pixel.png';

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** An SVG that would run script if it were ever inlined rather than an `<img>`. */
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" onload="window.__pwned = 1">' +
  '<script>window.__pwned = 1</script><rect width="32" height="16" fill="#888"/></svg>';

function seededProject(): { folder: string; doc: string } {
  const folder = tempProjectFolder();
  // A real picture the session folder does NOT contain, next door to it.
  const outside = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-outside-')));
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  fs.mkdirSync(path.join(folder, 'img'));
  fs.writeFileSync(path.join(folder, 'img', 'shot.png'), PNG);
  fs.writeFileSync(path.join(folder, 'img', 'logo.svg'), SVG, 'utf8');
  // a picture's name on a text file's bytes
  fs.writeFileSync(path.join(folder, 'img', 'liar.png'), 'this is not a picture', 'utf8');
  const doc = path.join(folder, 'PICTURES.md');
  fs.writeFileSync(
    doc,
    `# Pictures

![a local shot](img/shot.png)

![a vector](./img/logo.svg)

<img src="img/shot.png" width="40" alt="sized by hand">

![missing](img/gone.png)

![not really a picture](img/liar.png)

![outside the folder](../${path.basename(outside)}/secret.png)

![a tracking pixel](${TRACKER})
`,
    'utf8'
  );
  return { folder, doc };
}

const rendered = (w: Page) => w.locator('[data-testid="doc-rendered"]');

test.describe('pictures in a rendered document (#1080)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a local picture is shown; one outside the folder, a broken one and a remote one are not', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    const requests: string[] = [];
    w.on('request', (r) => requests.push(r.url()));

    await expect(rendered(w).locator('h1')).toHaveText('Pictures');

    // THE THREE THAT LOAD — decoded, not merely present.
    const sizes = (): Promise<Array<{ alt: string; w: number; h: number; width: number }>> =>
      rendered(w)
        .locator('img.doc-image')
        .evaluateAll((imgs) =>
          (imgs as HTMLImageElement[]).map((i) => ({
            alt: i.alt,
            w: i.naturalWidth,
            h: i.naturalHeight,
            width: i.getBoundingClientRect().width,
          }))
        );
    await expect
      .poll(async () => (await sizes()).filter((s) => s.w > 0).map((s) => s.alt))
      .toEqual(['a local shot', 'a vector', 'sized by hand']);
    const loaded = await sizes();
    expect(loaded.find((s) => s.alt === 'a vector')).toMatchObject({ w: 32, h: 16 });
    // the document's own width, honoured
    expect(loaded.find((s) => s.alt === 'sized by hand')?.width).toBe(40);

    // THE FOUR THAT DO NOT — each one a chip, and no broken-image glyph left.
    const chips = rendered(w).locator('.doc-image-chip');
    await expect(chips).toHaveCount(4);
    await expect(chips).toContainText([
      'missing',
      'not really a picture',
      'outside the folder',
      'a tracking pixel',
    ]);
    await expect(rendered(w).locator('img')).toHaveCount(3);

    // the remote one was never asked for, and only it offers the browser
    expect(requests.filter((u) => u.includes('tracker.invalid'))).toEqual([]);
    await expect(rendered(w).locator('.doc-image-open')).toHaveCount(1);
    // an SVG shown through <img> runs nothing
    expect(await w.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined
    );
  });

  test('a re-render keeps the pictures, and they come back at their size', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect
      .poll(() =>
        rendered(w)
          .locator('img.doc-image')
          .evaluateAll((imgs) => (imgs as HTMLImageElement[]).filter((i) => i.naturalWidth > 0).length)
      )
      .toBe(3);

    // An agent appends to the document while it is open.
    fs.appendFileSync(doc, '\n## Written afterwards\n', 'utf8');
    await expect(rendered(w).locator('h2')).toHaveText('Written afterwards');

    // The replacements carry the size the old ones had loaded at, so the page
    // does not collapse while they load — and then they load.
    const vector = rendered(w).locator('img.doc-image[alt="a vector"]');
    await expect(vector).toHaveAttribute('width', '32');
    await expect(vector).toHaveAttribute('height', '16');
    await expect
      .poll(() => vector.evaluate((i) => (i as HTMLImageElement).naturalWidth))
      .toBe(32);
    await expect(rendered(w).locator('.doc-image-chip')).toHaveCount(4);
  });
});
