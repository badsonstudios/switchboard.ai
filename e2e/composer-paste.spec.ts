// P2-E10-09 — a bitmap pasted into the composer reaches the CLI.
//
// WHAT THIS PROVES THAT A UNIT TEST CANNOT. `composer-attachments.test.ts`
// pins the clipboard rules, `FeedView.attachments.test.tsx` pins the wiring and
// `submit-prompt.test.ts` pins the block shape — and all three would stay green
// with the IPC argument dropped in the preload, the validator rejecting
// everything in main, or the transport never writing the frame. The bytes have
// to make the whole trip: paste event -> renderer state -> contextBridge ->
// broker -> `sanitizePromptAttachments` -> `userMessage` -> NDJSON on stdin -> the
// provider decoding it. Only an e2e crosses all of those.
//
// The fake answers an image turn with `IMAGE-SEEN:<media_type>:<base64 len>`
// (`providers/fake-stream-protocol.ts`), so the assertion is about what
// ARRIVED, not about the composer looking like it worked — which is exactly the
// "it did nothing and said nothing" failure #154 was.
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

/**
 * A real 1x1 PNG, base64. Small enough to assert its exact encoded length, and
 * a genuine image so the chip's canvas preview decodes rather than falling back.
 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe.configure({ mode: 'serial' });

test.describe('pasting an image into the composer (P2-E10-09)', () => {
  let a: LaunchedApp;
  let folder: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-paste-'));
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
   * Paste, from inside the page. Answers whether we swallowed the event.
   *
   * A real `ClipboardEvent` with a real `File` on a real `DataTransfer` —
   * Chromium can build both, unlike jsdom, so this is as close to Ctrl+V as a
   * test gets without asking the OS for the clipboard, which we must never do:
   * this machine's clipboard belongs to whoever is using it.
   *
   * THE ONE THING IT CANNOT DO, stated so no assertion below quietly assumes
   * otherwise: a dispatched event is UNTRUSTED, and a browser runs no default
   * action for an untrusted event. So the text does not appear in the box here
   * even when we correctly leave the paste alone. What we can prove — and what
   * the bug would actually be — is that we did not `preventDefault` it and did
   * not touch the draft ourselves. The rest is the browser's own behaviour, and
   * a hand-test covers it (see the PR's test list).
   */
  const pasteImage = (text?: string): Promise<boolean> =>
    a.window.evaluate(
      ({ b64, text }) => {
        const box = document.querySelector('textarea')!;
        box.focus();
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        if (text) dt.setData('text/plain', text);
        const ev = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        box.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      { b64: PNG_1X1, text }
    );

  test('the chip appears, the image is sent, and the CLI receives the block', async () => {
    const w = a.window;

    // an image-only clipboard has nothing to insert, so we take the event
    expect(await pasteImage()).toBe(true);

    // 1. a visible, removable affordance
    const chip = w.locator('[data-composer-attachment]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-composer-attachment', /^pasted-.*\.png$/);

    // 2. it is removable before send, and removing it puts the composer back
    await chip.getByRole('button').click();
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);

    // 3. paste again, type, send — and the FAKE reports what it decoded off the
    //    wire. The length is the base64 we pasted, so this fails if anything in
    //    the chain re-encoded, truncated, or added a `data:` prefix.
    await pasteImage();
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('what colour is this?');
    await box.press('Enter');

    await expect(w.getByText(`IMAGE-SEEN:image/png:${PNG_1X1.length}`)).toBeVisible({
      timeout: 30_000,
    });

    // 4. the composer cleared itself, both halves
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);
    await expect(box).toHaveValue('');
  });

  test('a clipboard with text AND an image keeps both', async () => {
    const w = a.window;
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('typed ');

    // NOT prevented: the browser is left to insert the text at the caret, which
    // is the whole of "both halves survive"
    expect(await pasteImage('pasted words')).toBe(false);

    // ...and the image came along anyway
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(1);
    // we did not rewrite the draft ourselves — the text half is the browser's
    await expect(box).toHaveValue('typed ');

    await w.locator('[data-composer-attachment]').getByRole('button').click();
    await box.fill('');
  });

  // The daily path. If this breaks, every user notices before any of them
  // notices the feature above.
  test('a plain-text paste is untouched', async () => {
    const w = a.window;
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('before');

    const prevented = await w.evaluate(() => {
      const el = document.querySelector('textarea')!;
      el.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', 'ordinary words');
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });

    // the handler returned before touching anything: no preventDefault, no
    // strip, no notice, and the draft exactly as it was
    expect(prevented).toBe(false);
    await expect(box).toHaveValue('before');
    await expect(w.locator('[data-composer-attachment]')).toHaveCount(0);
    // the notice region is always mounted (#222's rule for live regions) — the
    // assertion is that it has nothing to say, not that it is absent
    await expect(w.locator('[data-composer-attach-notice]').first()).toHaveText('');
    await box.fill('');
  });
});
