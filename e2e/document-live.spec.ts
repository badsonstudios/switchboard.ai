// The viewer FOLLOWS the file it has open (P2-E16-04, §5.30).
//
// The unit tests own the rules — one notice per burst, the debounce ceiling, the
// refcount, what a `gone` does to the pane. What only a real window can prove is
// the part every one of them stubs: that a real `fs.watch` on a real directory,
// a real `stat` and a real re-read actually reach the document a person is
// reading, and that the reader's PLACE in it survives the round trip.
//
// The scenario is the one the epic exists for, played out for real: a file in a
// session's folder is rewritten by something that is not us, while it is open.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { findFile, launchApp, LaunchedApp, poll, tempProjectFolder } from './fixtures/app';

/** Long enough that the pane really scrolls, short enough to write in a beat. */
function document(heading: string, extra = ''): string {
  const body = Array.from(
    { length: 120 },
    (_v, i) => `Paragraph ${i} of the document the agent is writing.`
  ).join('\n\n');
  return `# ${heading}\n\n${body}\n\n${extra}\n`;
}

function seeded(): { folder: string; doc: string } {
  const folder = tempProjectFolder();
  const doc = path.join(folder, 'PROGRESS.md');
  fs.writeFileSync(doc, document('Before'), 'utf8');
  return { folder, doc };
}

const viewer = (w: Page) => w.locator('[data-testid="document-viewer"]');
const rendered = (w: Page) => w.locator('[data-testid="doc-rendered"]');
const scroller = (w: Page) => w.locator('[data-testid="doc-scroll"]');

/** How many times main has released a file watch, according to its own log. */
function watchCloses(home: string): number {
  const file = findFile(home, 'switchboard.log');
  if (!file) return 0;
  return [...fs.readFileSync(file, 'utf8').matchAll(/"msg":"fs watch closed"/g)].length;
}

test.describe('live re-render (P2-E16-04)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('an external rewrite re-renders the open document, scroll intact', async () => {
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(viewer(w)).toBeVisible();
    await expect(rendered(w).locator('h1')).toHaveText('Before');

    // The reader is somewhere in the middle of it, as they would be.
    await scroller(w).evaluate((el) => {
      el.scrollTop = 400;
    });
    await expect.poll(() => scroller(w).evaluate((el) => el.scrollTop)).toBe(400);

    // Something that is not us rewrites the file.
    fs.writeFileSync(doc, document('After', 'A line the agent just added.'), 'utf8');

    await expect(rendered(w).locator('h1')).toHaveText('After', { timeout: 15_000 });
    await expect(rendered(w)).toContainText('A line the agent just added.');
    // THE POINT OF THE FEATURE: they did not lose their place.
    expect(await scroller(w).evaluate((el) => el.scrollTop)).toBe(400);
  });

  test('a burst of writes settles on the last one, not on ten renders', async () => {
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(rendered(w).locator('h1')).toHaveText('Before');

    // An agent's "write" is several writes. What the reader must end up with is
    // the LAST one — a viewer that renders an intermediate state and stops is
    // worse than one that never updated.
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(doc, document(`Pass ${i}`), 'utf8');
    }
    await expect(rendered(w).locator('h1')).toHaveText('Pass 9', { timeout: 15_000 });
  });

  test('deleting the open file shows a strip, not an error or a blank pane', async () => {
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(rendered(w).locator('h1')).toHaveText('Before');

    fs.rmSync(doc);
    await expect(w.locator('[data-testid="doc-gone"]')).toBeVisible({ timeout: 15_000 });
    // …and what they were reading is still on screen, still a document
    await expect(rendered(w).locator('h1')).toHaveText('Before');
    await expect(w.locator('[data-testid="doc-refusal"]')).toHaveCount(0);

    // it comes back — a `git checkout`, a rename that lands — and so does the
    // live view of it
    fs.writeFileSync(doc, document('Restored'), 'utf8');
    await expect(rendered(w).locator('h1')).toHaveText('Restored', { timeout: 15_000 });
    await expect(w.locator('[data-testid="doc-gone"]')).toHaveCount(0);
  });

  test('closing the panel tears the watch down in MAIN', async () => {
    const { folder, doc } = seeded();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    const home = a.home;
    await expect(rendered(w).locator('h1')).toHaveText('Before');

    // A leaked watcher per opened file is the thing that only shows up at
    // session 12, so this asserts against main's own record rather than against
    // the renderer having called the unsubscribe.
    const before = watchCloses(home);
    await w
      .locator('.dv-tab')
      .filter({ hasText: 'PROGRESS.md' })
      // "Close document" since #543 — every tab used to claim it ended a
      // session, which on a viewer closes no session at all
      .getByTitle('Close document')
      .click();
    await expect(viewer(w)).toHaveCount(0);

    const after = await poll(() => {
      const n = watchCloses(home);
      return n > before ? n : null;
    }, 20_000);
    expect(after).toBeGreaterThan(before);
  });
});
