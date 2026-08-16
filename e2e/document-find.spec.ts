// Ctrl+F in a document viewer (#533, §5.30 + §5.31).
//
// THE DONE-WHEN, and the reason this is an e2e rather than three more unit
// tests: the bug was never in the searching. The viewer has had a correct,
// correctly-scoped find since P2-E16-02 and it was UNREACHABLE — `find.open`
// was enabled on `activeCardId !== null` and a `doc-` panel answers null, and
// the viewer's own fallback keydown was a bubbling listener on a subtree with
// nothing focusable in it. Both of those are facts about the real dispatcher,
// the real dockview and the real focus, and every one of them is stubbed in
// jsdom. So what is asserted here is the KEYSTROKE arriving:
//
//   * Ctrl+F with a document in front of you opens the bar over THAT document,
//     scoped to it — the session's transcript is not searched and cannot be;
//   * the matches are visibly marked and step (#520's lesson: a jump with no
//     visible mark reads as broken), and closing takes the marks with it;
//   * the same keystroke works in a popped-out viewer's OWN window, and opens
//     the bar THERE rather than yanking the main window in front of it.
//
// The provider's mapping, the marking itself and the bar's rhythm are unit
// work (`document-find.test.ts`, `find-providers.test.ts`, `FindBar.test.tsx`).
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, skipPopoutOnLinux, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Four `needle`s, and one of them inside a code fence — that is where the
 *  command you half-remember lives, and it must be searchable. */
const DOC = `# The needle document

A paragraph with a needle in it, and a second needle right after.

\`\`\`sh
npm run needle -- --once
\`\`\`

The last needle is down here.
`;

function seeded(): { folder: string; doc: string } {
  const folder = tempProjectFolder();
  const doc = path.join(folder, 'NEEDLES.md');
  fs.writeFileSync(doc, DOC, 'utf8');
  return { folder, doc };
}

const viewer = (w: Page) => w.locator('[data-testid="document-viewer"]');
const bar = (w: Page) => w.locator('[data-testid="find-bar"]');
const count = (w: Page) => w.locator('[data-testid="find-count"]');
const marks = (w: Page) => w.locator('[data-testid="doc-rendered"] mark[data-doc-match]');
const current = (w: Page) => w.locator('[data-testid="doc-rendered"] mark[data-doc-match-current]');

test.describe('find in a document (#533)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('Ctrl+F searches the document in front of you, marks the matches and steps them', async () => {
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(viewer(w)).toBeVisible({ timeout: 25_000 });
    await expect(w.locator('[data-testid="doc-rendered"] h1')).toHaveText('The needle document');

    // THE KEYSTROKE, with focus wherever the app left it — this is the half
    // that was broken, and pressing it after clicking something in the viewer
    // would test the wrong thing.
    await w.keyboard.press(`${MOD}+f`);
    await expect(bar(w)).toHaveCount(1);

    await w.locator('[data-testid="find-input"]').fill('needle');
    // 4 in the prose and the fence; the h1's "needle" makes 5
    await expect(count(w)).toHaveText('1 of 5', { timeout: 10_000 });
    await expect(marks(w)).toHaveCount(5);
    // VISIBLY marked, not merely counted
    await expect(current(w)).toHaveCount(1);

    // ...and stepping moves that mark, which is the whole gesture
    const at = async (): Promise<number> =>
      w.evaluate(() => {
        const all = [...document.querySelectorAll('[data-testid="doc-rendered"] mark[data-doc-match]')];
        return all.findIndex((m) => m.hasAttribute('data-doc-match-current'));
      });
    expect(await at()).toBe(0);
    await w.keyboard.press('Enter');
    await expect(count(w)).toHaveText('2 of 5');
    expect(await at()).toBe(1);
    await w.keyboard.press('Shift+Enter');
    await expect(count(w)).toHaveText('1 of 5');
    expect(await at()).toBe(0);

    // ONE GROUP: there is no session behind a document, so the session and
    // terminal groups are absent rather than reporting a hollow 0 — and the
    // transcript is never searched, which is the "never matches another card"
    // guarantee stated for a surface that is not a card at all.
    await expect(w.locator('[data-testid="find-groups"]')).toHaveCount(0);

    // Esc closes and takes the marks with it — they are real nodes, and leaving
    // them would make the next search match inside its own highlights.
    await w.keyboard.press('Escape');
    await expect(bar(w)).toHaveCount(0);
    await expect(marks(w)).toHaveCount(0);
  });

  test('Ctrl+F works in a popped-out viewer’s own window, and opens the bar THERE', async () => {
    skipPopoutOnLinux();
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(viewer(w)).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Open this document in its own window').click();
    // by URL, not "the other one": devtools would also satisfy `!== w`
    await expect
      .poll(() => a!.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');
    await expect(viewer(popout)).toBeVisible({ timeout: 15_000 });

    // CLICK THE WINDOW FIRST, and it is the harness that needs it rather than
    // the app: `page.keyboard.press` on a popout Page that has never been
    // interacted with delivers NOTHING — a probe recorded zero keydowns
    // reaching that window's own listener. One click and the very same press
    // arrives. (It is also what a user does: you click the window you are
    // reading before you type in it.) The header name is a safe target — it is
    // not a control, so nothing but focus happens.
    await popout.locator('[data-testid="doc-name"]').click();

    // The command context claims a popped-out DOCUMENT where it refuses a
    // popped-out card, and the difference is that the bar renders inside the
    // panel — which dockview moved into this window along with the viewer.
    await popout.keyboard.press(`${MOD}+f`);
    await expect(bar(popout)).toHaveCount(1);
    // ...and NOT in the main window, which no longer holds the document
    await expect(bar(w)).toHaveCount(0);

    await popout.locator('[data-testid="find-input"]').fill('needle');
    await expect(count(popout)).toHaveText('1 of 5', { timeout: 10_000 });
    await expect(marks(popout)).toHaveCount(5);
    await expect(current(popout)).toHaveCount(1);

    // Dock back through the window's own close, which is what the popout
    // teardown wants (the geometry spec's rule) rather than leaving an OS
    // window behind for the next test to trip over.
    await popout.evaluate(() => window.close());
    await expect(viewer(w)).toBeVisible({ timeout: 15_000 });
  });
});
