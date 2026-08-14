// P2-E10-10 — files dragged onto the composer reach the CLI.
//
// WHAT THIS PROVES THAT A UNIT TEST CANNOT. `composer-attachments.test.ts`
// pins the classifier and the folder split, `FeedView.attachments.test.tsx`
// pins the wiring, and `submit-prompt.test.ts` pins the block shape — and all
// three would stay green with the IPC argument dropped in the preload, the
// validator rejecting documents in main, or the transport never writing the
// frame. The bytes have to make the whole trip: drop event -> renderer state ->
// contextBridge -> broker -> `sanitizePromptAttachments` -> `userMessage` ->
// NDJSON on stdin -> the provider decoding it. Only an e2e crosses all of
// those.
//
// The fake answers a document turn with `DOC-SEEN:<kind>:<title>:<contents>`
// for text (`providers/fake-stream-protocol.ts`) — THE CONTENTS, not a length,
// because the failure worth catching here is a text file arriving base64'd,
// which has a plausible length and completely wrong bytes.
//
// WHAT IT CANNOT DO, stated so no assertion below quietly assumes otherwise:
// `webkitGetAsEntry()` returns null for a DataTransfer built in script, so a
// FOLDER cannot be synthesised here. The directory refusal is covered by
// `composer-attachments.test.ts` and by hand (see the PR's test list).
//
// NO `SWITCHBOARD_TRANSPORT` ANYWHERE: Direct is the default since #381 and
// this feature only exists on it.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

/** the dual-capable fake, asked for nothing — i.e. the app's own default */
const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** a real 1x1 PNG, base64 — small enough to assert its exact encoded length */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** the markdown body that has to survive the round trip byte for byte */
const MD_BODY = '# dropped\n\nthe quick brown fox\n';

test.describe.configure({ mode: 'serial' });

test.describe('dropping files onto the composer (P2-E10-10)', () => {
  let a: LaunchedApp;
  let folder: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drop-'));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    await expect(a.window.getByText(path.basename(folder)).first()).toBeVisible({
      timeout: 25_000,
    });
  });

  test.afterAll(async () => {
    registerTempDir(folder);
    await a?.cleanup();
  });

  /**
   * Drop, from inside the page.
   *
   * A real `DragEvent` with real `File`s on a real `DataTransfer` — Chromium
   * can build both, unlike jsdom. The event is dispatched at the composer's
   * ROOT, which is the element the handlers are actually on: dispatching at the
   * textarea would still bubble there and would hide a regression that moved
   * the handlers onto the box.
   */
  const dropFiles = (
    files: Array<{ name: string; type: string; body?: string; b64?: string }>
  ): Promise<boolean> =>
    a.window.evaluate((specs) => {
      const zone = document.querySelector('[data-composer-dropzone]') as HTMLElement;
      const dt = new DataTransfer();
      for (const s of specs) {
        const parts: BlobPart[] = s.b64
          ? [Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0))]
          : [s.body ?? ''];
        dt.items.add(new File(parts, s.name, { type: s.type }));
      }
      const fire = (type: string): DragEvent => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        zone.dispatchEvent(ev);
        return ev;
      };
      fire('dragenter');
      const over = fire('dragover');
      fire('drop');
      // dragover MUST be prevented or a real browser refuses the drop outright
      return over.defaultPrevented;
    }, files);

  test('a dropped markdown file becomes a chip and reaches the CLI as its CONTENTS', async () => {
    const w = a.window;

    expect(await dropFiles([{ name: 'notes.md', type: 'text/markdown', body: MD_BODY }])).toBe(
      true
    );

    // 1. a visible, removable affordance carrying the REAL file name
    const chip = w.locator('[data-composer-attachment]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-composer-attachment', 'notes.md');
    await expect(chip).toHaveAttribute('data-attachment-kind', 'text');

    // 2. removable before send
    await chip.getByRole('button').click();
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);

    // 3. drop again, type, send — and the FAKE reports what it decoded off the
    //    wire. Asserting the CONTENTS is what proves the text was NOT base64'd
    //    and that `source.type` was `text`, not `base64`.
    await dropFiles([{ name: 'notes.md', type: 'text/markdown', body: MD_BODY }]);
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('what does this say?');
    await box.press('Enter');

    await expect(w.getByText(`DOC-SEEN:text:notes.md:${MD_BODY.split('\n')[0]}`)).toBeVisible({
      timeout: 30_000,
    });

    // 4. the composer cleared itself, both halves
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);
    await expect(box).toHaveValue('');
  });

  // The item's actual headline: NOT just images, and several at once.
  test('one drop carries a source file and an image together, in order', async () => {
    const w = a.window;

    await dropFiles([
      { name: 'main.ts', type: '', body: 'const answer = 42\n' },
      { name: 'diagram.png', type: 'image/png', b64: PNG_1X1 },
    ]);

    const chips = w.locator('[data-composer-attachment]');
    await expect(chips).toHaveCount(2);
    // order preserved — a prompt that says "compare the first with the second"
    // has to mean what it says
    await expect(chips.nth(0)).toHaveAttribute('data-composer-attachment', 'main.ts');
    await expect(chips.nth(1)).toHaveAttribute('data-composer-attachment', 'diagram.png');

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('review these');
    await box.press('Enter');

    // both arrived, and `main.ts` arrived as text despite the OS giving it no
    // MIME type at all — the filename fallback, end to end
    await expect(w.getByText('DOC-SEEN:text:main.ts:const answer = 42')).toBeVisible({
      timeout: 30_000,
    });
    await expect(w.getByText(`IMAGE-SEEN:image/png:${PNG_1X1.length}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);
  });

  // `App.tsx` listens on the WINDOW for a dropped folder and opens it as a
  // session (E3-04). A drop that lands on the composer must not reach it — and
  // every drop that does NOT land on the composer still must.
  test('a drop on the composer does not also open a session', async () => {
    const w = a.window;
    const cards = w.locator('[data-session-status]');
    const before = await cards.count();

    await dropFiles([{ name: 'a.md', type: 'text/markdown', body: 'hi\n' }]);

    await expect(w.locator('[data-composer-attachment]')).toHaveCount(1);
    expect(await cards.count()).toBe(before);

    await w.locator('[data-composer-attachment]').getByRole('button').click();
  });

  // A file the model cannot read is REFUSED OUT LOUD — the reference's own
  // behaviour, including naming the escape hatch.
  test('an unusable file is refused with a reason rather than silently ignored', async () => {
    const w = a.window;

    await dropFiles([{ name: 'app.bin', type: 'application/octet-stream', body: 'nope' }]);

    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);
    await expect(w.locator('[data-composer-attach-notice]').first()).toContainText(
      'full file path'
    );
  });
});
