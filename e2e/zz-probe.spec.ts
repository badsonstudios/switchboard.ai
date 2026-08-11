// THROWAWAY diagnostic probe for the #416 windows-CI tail-pin failure.
// Never merged; lives only on probe/416-tailpin-ci.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

const diag = (w: Page, label: string): Promise<unknown> =>
  w.evaluate((lbl) => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
    ) as HTMLElement | undefined;
    const region = document.querySelector('[data-feed-region]') as HTMLElement | null;
    const r = region?.getBoundingClientRect();
    const rect = (t: string): unknown => {
      const n = [...document.querySelectorAll('p')].find((p) => p.textContent === t);
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
    };
    return {
      lbl,
      win: { w: window.innerWidth, h: window.innerHeight, dpr: devicePixelRatio },
      screen: { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight },
      scroller: el
        ? {
            top: Math.round(el.scrollTop),
            height: el.scrollHeight,
            client: el.clientHeight,
            gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            rect: {
              top: Math.round(el.getBoundingClientRect().top),
              bottom: Math.round(el.getBoundingClientRect().bottom),
            },
            isRegion: el === region,
          }
        : null,
      regionRect: r
        ? {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            h: Math.round(r.height),
            scrollH: region!.scrollHeight,
            clientH: region!.clientHeight,
            scrollTop: Math.round(region!.scrollTop),
            overflowY: getComputedStyle(region!).overflowY,
          }
        : null,
      block60: rect('SFEED_BLOCK_60'),
      block1: rect('SFEED_BLOCK_1'),
      counts: {
        p: document.querySelectorAll('p').length,
        boxes: document.querySelectorAll('[data-feed-box]').length,
      },
      fonts: getComputedStyle(document.body).fontFamily,
    };
  }, label);

test.describe.configure({ mode: 'serial' });

test.describe('probe', () => {
  let a: LaunchedApp;
  let title: string;
  let folder: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-'));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    title = path.basename(folder);
    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!tools');
    await box.press('Enter');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    registerTempDir(folder);
    await a?.cleanup();
  });

  test('probe the tail pin', async () => {
    test.setTimeout(240_000);
    const w = a.window;
    console.log('DIAG', JSON.stringify(await diag(w, 'after !tools')));

    // ---- replica of test 1 ----
    await expect(w.getByText('▸ OUT')).toBeVisible();
    await w.getByText('▸ OUT').click();
    await expect(w.getByText('STREAM_OUT_LINE2').last()).toBeVisible();
    console.log('DIAG', JSON.stringify(await diag(w, 'after OUT click')));

    // ---- replica of test 2 ----
    await w.getByRole('button', { name: 'quiet', exact: true }).click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(0);
    await w.getByRole('button', { name: 'normal', exact: true }).click();
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible();

    // ---- replica of test 3 ----
    await w.getByRole('button', { name: 'normal', exact: true }).click();
    await w.keyboard.press('Tab');
    await w.keyboard.press('Tab');
    await w.keyboard.press('ArrowUp');
    await w.keyboard.press('Home');
    await w.keyboard.press('Escape');
    await w.keyboard.press('Tab');
    console.log('DIAG', JSON.stringify(await diag(w, 'after keyboard walk')));

    // ---- the failing test ----
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!bulk 60 SFEED_BLOCK_');
    await box.press('Enter');
    await expect(w.getByText('SFEED_BLOCK_60', { exact: true })).toBeAttached({ timeout: 90_000 });
    for (let i = 0; i < 12; i++) {
      console.log('DIAG', JSON.stringify(await diag(w, `after bulk sample ${i}`)));
      await w.waitForTimeout(1000);
    }
    console.log(
      'DIAG inViewport before force:',
      await w.getByText('SFEED_BLOCK_60', { exact: true }).evaluate((n) => {
        const b = n.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= window.innerHeight;
      })
    );

    // DECISIVE: force the scroller to the tail from the test. If block 60 is on
    // screen after this, the app's pin simply never ran; if it is still not, the
    // geometry is wrong (the scroller is not where the window can show it).
    await w.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find(
        (d) => d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY === 'auto'
      ) as HTMLElement | undefined;
      if (el) el.scrollTop = el.scrollHeight;
    });
    await w.waitForTimeout(1500);
    console.log('DIAG', JSON.stringify(await diag(w, 'after FORCED scroll')));
    console.log(
      'DIAG inViewport after force:',
      await w.getByText('SFEED_BLOCK_60', { exact: true }).evaluate((n) => {
        const b = n.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= window.innerHeight;
      })
    );
  });
});
