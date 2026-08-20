// The §5.30 document viewer, end to end (P2-E16-02).
//
// The unit tests own the dispatch table, the sanitizer and the link rules; what
// only a real Electron window can prove is the part the done-when insists on
// not assuming:
//
//   * a remote `<img>` in a markdown file issues NO NETWORK REQUEST. The CSP is
//     `default-src 'self'`, and "the policy says so" is a different claim from
//     "nothing was requested" — so this listens to the page's own request
//     stream and asserts an empty list. A regression that relaxed the CSP would
//     leave every unit test green.
//   * the source body is really Monaco, really read-only. jsdom stubs it.
//
// It reaches the viewer through the `SWITCHBOARD_SEED_DOCUMENT` seam, which
// GRANTS NOTHING — the file is only readable because it sits inside the seeded
// session's folder, which is the ordinary `fs.read` scope.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir, tempProjectFolder } from './fixtures/app';

/** A tracking pixel's host. `.invalid` can never resolve, belt to the braces. */
const TRACKER = 'https://tracker.invalid/pixel.gif';

const DOC = `# The document viewer

Some prose with a [real link](https://example.invalid/docs) in it, and a
[hostile one](javascript:window.__pwned=1) that must do nothing.

![a tracking pixel](${TRACKER})

<script>window.__pwned = 1</script>
<img src="${TRACKER}" onerror="window.__pwned = 1">

## A table

| column | other |
|---|---|
| one | two |

## A plan

- [ ] not done
- [x] done

## Some code

\`\`\`ts
const answer = 42;
\`\`\`

## Other files

- [the source file](sample.ts)
- [the pdf](report.pdf)
- [a second document](second.md)
`;

/**
 * A second markdown file carrying the same tracking pixel.
 *
 * The whole point of it is timing. The first document renders during the
 * renderer's own bootstrap, which can be BEFORE the spec's request listener is
 * attached — so an empty request list for that render would be an empty list
 * for the wrong reason, and the one done-when the plan says to "assert, don't
 * assume" would be passing vacuously. Navigating here happens long after the
 * listener is provably in place.
 */
const SECOND = `# The second document

![another tracking pixel](${TRACKER}?second)

<img src="${TRACKER}?third" onerror="window.__pwned = 1">
`;

/** A project folder with the fixtures this spec opens. */
function seededProject(): { folder: string; doc: string } {
  const folder = tempProjectFolder();
  const doc = path.join(folder, 'NOTES.md');
  fs.writeFileSync(doc, DOC, 'utf8');
  fs.writeFileSync(path.join(folder, 'sample.ts'), 'export const answer = 42;\n', 'utf8');
  fs.writeFileSync(path.join(folder, 'second.md'), SECOND, 'utf8');
  // A minimal but honest PDF: the magic header, then a NUL, so main's sniff
  // sees a binary and the extension dispatch sees a PDF.
  fs.writeFileSync(
    path.join(folder, 'report.pdf'),
    Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.from([0x00, 0x01, 0x02])])
  );
  return { folder, doc };
}

const viewer = (w: Page) => w.locator('[data-testid="document-viewer"]');
const rendered = (w: Page) => w.locator('[data-testid="doc-rendered"]');

test.describe('document viewer (P2-E16-02)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('a .md opens rendered, renders hostile input inert, and fetches NOTHING', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;

    // Every request the renderer makes, from the moment the window exists.
    const requests: string[] = [];
    w.on('request', (r) => requests.push(r.url()));

    await expect(viewer(w)).toBeVisible();
    // rendered by DEFAULT — no click got us here
    await expect(rendered(w).locator('h1')).toHaveText('The document viewer');
    await expect(rendered(w).locator('table')).toBeVisible();
    await expect(rendered(w).locator('.doc-table-wrap')).toBeVisible();
    // The task list, which since #612 is a `☐`/`☑` glyph rather than a disabled
    // `<input>` — `input` is in the sanitizer's `FORBID_TAGS`, so the marker is
    // written by `marked`'s renderer before the sanitizer ever runs. `.doc-task`
    // is what takes the bullet off, and it is the class the pass now sets.
    await expect(rendered(w).locator('li.doc-task')).toHaveCount(2);
    await expect(rendered(w).locator('input')).toHaveCount(0);
    await expect(rendered(w).locator('.doc-code-lang')).toHaveText('ts');

    // THE SECURITY ASSERTIONS.
    // 1. the remote image is a chip, and there is no <img> anywhere in the body
    await expect(rendered(w).locator('.doc-image-chip').first()).toBeVisible();
    await expect(rendered(w).locator('img')).toHaveCount(0);
    // 2. NOTHING WAS FETCHED — not "blocked", never asked for. Proven on a
    //    document rendered well after the listener above was attached, so an
    //    empty list cannot be an artefact of having started listening late.
    await rendered(w).getByText('a second document').click();
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('second.md');
    await expect(rendered(w).locator('.doc-image-chip').first()).toBeVisible();
    await expect(rendered(w).locator('img')).toHaveCount(0);
    expect(requests.filter((u) => u.includes('tracker.invalid'))).toEqual([]);
    await viewer(w).getByRole('button', { name: 'Back' }).click();
    await expect(rendered(w).locator('h1')).toHaveText('The document viewer');
    // 3. the script and the onerror handler never ran
    expect(await w.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined
    );
    // 4. a javascript: link is inert — clicking it does nothing at all
    const blocked = rendered(w).locator('[data-doc-link="blocked"]');
    await expect(blocked).toHaveText('hostile one');
    const before = w.url();
    await blocked.click();
    expect(w.url()).toBe(before);
    expect(await w.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined
    );
    // and no external link survived as a real href anywhere
    expect(await rendered(w).locator('a[href]').count()).toBe(0);
  });

  test('the toggle round-trips to a real, read-only Monaco and back', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(rendered(w).locator('h1')).toBeVisible();

    await viewer(w).getByRole('button', { name: 'Source', exact: true }).click();
    const editor = w.locator('[data-testid="doc-source"] .monaco-editor');
    await expect(editor).toBeVisible();
    // the SOURCE, not the render: the markdown syntax is on screen
    await expect(w.locator('[data-testid="doc-source"] .view-lines')).toContainText(
      '# The document viewer'
    );

    // READ-ONLY FOREVER (PHILOSOPHY §5). Typing into it changes nothing.
    await w.locator('[data-testid="doc-source"] .view-lines').click();
    await w.keyboard.type('EDITED');
    await expect(w.locator('[data-testid="doc-source"] .view-lines')).not.toContainText('EDITED');

    await viewer(w).getByRole('button', { name: 'Rendered', exact: true }).click();
    await expect(rendered(w).locator('h1')).toHaveText('The document viewer');
  });

  test('a relative link navigates in the viewer; Back returns; a PDF gets the card', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(rendered(w).locator('h1')).toBeVisible();

    // → a .ts, which opens in highlighted source
    await rendered(w).getByText('the source file').click();
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('sample.ts');
    await expect(w.locator('[data-testid="doc-source"] .view-lines')).toContainText(
      'const answer = 42'
    );
    // tokenised, not a wall of one colour — Monarch coloured at least one span
    expect(await w.locator('[data-testid="doc-source"] .mtk1').count()).toBeGreaterThan(0);

    // ← back to the markdown
    await viewer(w).getByRole('button', { name: 'Back' }).click();
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText('NOTES.md');
    await expect(rendered(w).locator('h1')).toHaveText('The document viewer');

    // → a PDF, which is named rather than rendered
    await rendered(w).getByText('the pdf').click();
    const card = w.locator('[data-testid="doc-card"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('report.pdf');
    await expect(card).toContainText('PDF');
    await expect(card.getByRole('button', { name: 'Open externally' })).toBeVisible();
    await expect(w.locator('[data-testid="doc-rendered"]')).toHaveCount(0);
    await expect(w.locator('[data-testid="doc-source"]')).toHaveCount(0);
  });
});

test.describe('opening a document from the Changes tab (P2-E16-02)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  /** A repo with one committed, then modified, file — enough for a status row. */
  function tempGitProject(): { dir: string; file: string } {
    const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-docgit-')));
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
    };
    git(['init', '-b', 'main']);
    // a runner with no global user.email cannot commit at all
    git(['config', 'user.email', 'e2e@switchboard.test']);
    git(['config', 'user.name', 'switchboard e2e']);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '# committed\n');
    git(['add', '.']);
    git(['commit', '-m', 'fixture']);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '# committed\n\nand then changed\n');
    return { dir, file: 'NOTES.md' };
  }

  test('the ↗ beside a changed file opens it in the viewer, rendered', async () => {
    const { dir, file } = tempGitProject();
    a = await launchApp({ seedFolder: dir });
    const w = a.window;

    const title = path.basename(dir);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });

    // the ROW still belongs to the diff; the viewer has its own labelled button
    await expect(w.getByText(file, { exact: true })).toBeVisible({ timeout: 15_000 });
    await w.getByRole('button', { name: `Open ${file} in the document viewer` }).click();

    await expect(viewer(w)).toBeVisible();
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText(file);
    await expect(rendered(w).locator('h1')).toHaveText('committed');
  });
});
