// #569 — the File menu, and where an opened document lands.
//
// TWO CLAIMS, and only a real Electron window can make either:
//
//   * the File menu is really built, really first, and its Open File… item
//     really reaches the renderer. The item lives in the BROWSER process and
//     fires a command id down the accelerator channel; a unit test can prove
//     the template's shape but not that anything is listening at the far end.
//   * the document lands BESIDE the session you were looking at — in its own
//     group, splitting that region, never as a tab in the session's own strip.
//     That is §5.30's rule ("a viewer never displaces a session") and the
//     owner's ask ("the same dock section… not as a tab with the session")
//     turning out to be the same sentence.
//
// Playwright cannot click a native menu — it injects keys over CDP, which
// bypasses accelerators entirely — so the item's `click` is invoked through the
// Electron API, which is the same function the OS would call.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import {
  gridLeafViews,
  launchApp,
  LaunchedApp,
  persistedLayout,
  readWorkspaceFile,
  tempProjectFolder,
  writeWorkspaceFile,
} from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };

/** The labels of the top-level menus, in order. */
const menuLabels = (a: LaunchedApp): Promise<string[]> =>
  a.app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label)
  );

/** Fire File › Open File…, the way the OS would. */
const clickOpenFile = (a: LaunchedApp): Promise<boolean> =>
  a.app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File');
    const item = file?.submenu?.items.find((i) => i.label.startsWith('Open File'));
    if (!item) return false;
    // `MenuItem.click` is typed as a bare `Function` in electron.d.ts, so it is
    // called through a narrowed local rather than with an eslint suppression.
    const fire = item.click as unknown as () => void;
    fire();
    return true;
  });

/** Which dockview group each panel is in, so "beside, not inside" is assertable. */
const groupsOf = (w: Page): Promise<Array<{ id: string; panels: string[] }>> =>
  w.evaluate(() =>
    [...document.querySelectorAll('.dv-groupview')].map((g, i) => ({
      id: String(i),
      panels: [...g.querySelectorAll('.dv-tab')].map((t) => (t.textContent ?? '').trim()),
    }))
  );

test.describe('the File menu (#569)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('sits first, left of View', async () => {
    a = await launchApp({ env: DIRECT });
    expect(await menuLabels(a)).toEqual(['File', 'View', 'Window', 'Help']);
  });

  test('Open File… opens a document, beside the session and not inside it', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const doc = path.join(folder, 'NOTES.md');
    fs.writeFileSync(doc, '# Opened from the File menu\n\nSome prose.\n', 'utf8');

    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // the dialog is main's, so it is answered in main — the same seam every
    // folder-picking spec uses
    await a.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    }, doc);

    expect(await clickOpenFile(a), 'the File menu should carry an Open File item').toBe(true);

    await expect(w.locator('[data-testid="doc-scroll"]')).toBeVisible({ timeout: 30_000 });
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('NOTES.md');

    // TWO groups: the session's, and the document's beside it. One group would
    // mean the viewer had been dropped into the session's tab strip, which is
    // the thing §5.30 forbids and the owner asked not to have.
    const groups = await groupsOf(w);
    expect(groups.length, 'the document should get its own group, not the session tab strip').toBe(
      2
    );
    const docGroup = groups.find((g) => g.panels.some((p) => p.includes('NOTES.md')));
    expect(docGroup, 'a group holding the document').toBeTruthy();
    expect(
      docGroup!.panels.some((p) => p.includes(path.basename(folder))),
      'the session must NOT be in the document group — a viewer never displaces a session (§5.30)'
    ).toBe(false);
  });

  // #569 REVIEW, B2: proven broken before it was fixed. The menu click rides the
  // accelerator channel, which is typing-gated for CHORDS — and a menu click is
  // not a chord. With the composer focused (which it is right after you send a
  // prompt, the single most likely moment to reach for Open File) the command
  // was dropped in silence.
  test('opens a file even with the composer focused', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const doc = path.join(folder, 'TYPED.md');
    fs.writeFileSync(doc, '# typed' + String.fromCharCode(10), 'utf8');

    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    }, doc);

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('half a prompt');
    await expect(box).toBeFocused();

    await clickOpenFile(a);

    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('TYPED.md', { timeout: 30_000 });
    // ...and what was being typed is untouched
    await expect(box).toHaveValue('half a prompt');
  });

  // S3 FROM THE REVIEW. With ONE session there is one group, so `api.addGroup()`
  // with no argument — the old behaviour — also lands the document "beside" it:
  // the test above passes identically before and after the fix, which makes it a
  // §5.30 guard and not a proof of anything the owner asked for.
  //
  // The distinguishing case needs TWO grid groups and the SECOND one focused:
  // the document must appear next to THAT session, not next to the first.
  test('lands beside the session you are actually in, with two docked side by side', async () => {
    test.setTimeout(240_000);
    const one = tempProjectFolder();
    const two = tempProjectFolder();
    const doc = path.join(two, 'HERE.md');
    fs.writeFileSync(doc, '# here' + String.fromCharCode(10), 'utf8');
    const [n1, n2] = [one, two].map((f) => path.basename(f));

    const first = await launchApp({ seedFolder: one, env: DIRECT });
    a = first;
    await expect(first.window.getByText(n1).first()).toBeVisible({ timeout: 25_000 });
    await first.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, two);
    await first.window.getByRole('button', { name: '+ session' }).click();
    await expect(first.window.locator('nav').getByText(n2).first()).toBeVisible({ timeout: 25_000 });
    await first.window.waitForTimeout(1_500);
    const home = first.home;
    await first.close();

    // two docked leaves, the persisted-layout recipe (dockview's drag state is
    // not producible synthetically, and a real split workspace restores from
    // exactly this blob)
    const ws = readWorkspaceFile(home);
    const layout = persistedLayout(ws);
    const views = gridLeafViews(layout.grid.root.data[0]);
    expect(views.length, 'need two panels to split').toBeGreaterThan(1);
    const half = Math.floor(layout.grid.width / 2);
    layout.grid.root.data = [
      { type: 'leaf', data: { views: views.slice(0, 1), activeView: views[0], id: '1' }, size: half },
      { type: 'leaf', data: { views: views.slice(1), activeView: views[1], id: '2' }, size: half },
    ];
    writeWorkspaceFile(home, ws);

    a = await launchApp({ home, env: DIRECT });
    const w = a.window;
    await expect(w.locator('.dv-groupview')).toHaveCount(2, { timeout: 25_000 });
    await a.app.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
    }, doc);

    // focus the SECOND session, then open a file
    await w.locator('nav [draggable="true"]').filter({ hasText: n2 }).first().click();
    await w.waitForTimeout(1_000);
    const secondBox = await w
      .locator('.dv-groupview')
      .filter({ hasText: n2 })
      .first()
      .boundingBox();

    await clickOpenFile(a);
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('HERE.md', { timeout: 30_000 });

    // the document's group must overlap the region the FOCUSED session was in,
    // horizontally — that is "the same dock section" in the owner's words
    const docBox = await w
      .locator('.dv-groupview')
      .filter({ hasText: 'HERE.md' })
      .first()
      .boundingBox();
    expect(docBox, 'the document should have a group of its own').toBeTruthy();
    const overlap =
      Math.min(docBox!.x + docBox!.width, secondBox!.x + secondBox!.width) -
      Math.max(docBox!.x, secondBox!.x);
    expect(
      overlap,
      'the document opened in the other half — not the dock section the focused session was in'
    ).toBeGreaterThan(0);
  });

  test('the browser starts in the focused session folder, then where you last were', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const nested = path.join(folder, 'deeper');
    fs.mkdirSync(nested, { recursive: true });
    const first = path.join(nested, 'one.md');
    const second = path.join(nested, 'two.md');
    fs.writeFileSync(first, '# one\n', 'utf8');
    fs.writeFileSync(second, '# two\n', 'utf8');

    a = await launchApp({ seedFolder: folder, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // record what the dialog was asked to open at, and answer with a file
    await a.app.evaluate(
      ({ dialog }, files) => {
        const seen: string[] = [];
        (globalThis as unknown as { __seenDefaults: string[] }).__seenDefaults = seen;
        let n = 0;
        // TWO SHAPES, and getting this wrong reads exactly like a product bug:
        // `showOpenDialog` is called as (window, options) when there is a window
        // and as (options) when there is not, so a stub that assumes one
        // argument silently inspects the BrowserWindow and reports no
        // defaultPath at all.
        dialog.showOpenDialog = ((...args: Array<{ defaultPath?: string }>) => {
          const opts = args.length > 1 ? args[1] : args[0];
          seen.push(opts?.defaultPath ?? '');
          return Promise.resolve({ canceled: false, filePaths: [n++ === 0 ? files[0] : files[1]] });
        }) as typeof dialog.showOpenDialog;
      },
      [first, second]
    );

    await clickOpenFile(a);
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('one.md', { timeout: 30_000 });
    await clickOpenFile(a);
    await expect(w.locator('[data-testid="doc-name"]').last()).toHaveText('two.md', {
      timeout: 30_000,
    });

    const seen = await a.app.evaluate(
      () => (globalThis as unknown as { __seenDefaults: string[] }).__seenDefaults
    );
    // FIRST time: the working folder of the session you are looking at.
    expect(seen[0]).toBe(folder);
    // SECOND time: where you actually browsed to, which beats the session's
    // folder once you have been somewhere.
    expect(seen[1]).toBe(nested);
  });
});
