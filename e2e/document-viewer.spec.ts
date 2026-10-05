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
import {
  launchApp,
  LaunchedApp,
  onTestDisplay,
  readWorkspaceFile,
  registerTempDir,
  tempProjectFolder,
} from './fixtures/app';

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

## A looser plan

- [ ] first, with a blank line after it

- [x] second

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

/** `tokens.css`: `@container (max-width: 420px) { .doc-outline { display: none } }`. */
const OUTLINE_MIN_PANE = 420;

test.describe('document viewer (P2-E16-02)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  /**
   * Give the viewer a pane the outline can actually live in, and SAY SO (#1010).
   *
   * `.doc-outline` has carried a `@container (max-width: 420px)` rule since
   * #530's cramped-pane finding — below that width the outline is navigation
   * that has stopped serving the thing it navigates, so it yields the whole
   * pane to the prose. #1010 hides the toolbar chip under the same threshold,
   * because a control over something already gone reads as broken.
   *
   * Which means a small screen leaves the nav IN THE DOM AND HIDDEN and the
   * chip unclickable — exactly how this test first failed on the Windows CI
   * runner while passing on the developer's desktop. MEASURED here, one
   * document beside one session card, 2026-09-30:
   *
   *     window 1024 -> pane 348px   outline hidden, chip hidden
   *     window 1100 -> pane 386px   outline hidden, chip hidden
   *     window 1280 -> pane 476px   outline shown    <- the default, 56px of luck
   *     window 1700 -> pane 686px   outline shown
   *
   * The pane is roughly the window less ~600px of rail and session card, so the
   * default 1280 cleared the threshold by a margin no one had measured. This
   * asks for 1700x950 — the geometry `document-peek.spec.ts`'s ROOMY pane test
   * already uses and proves CI honours — and then ASSERTS the pane it got, so
   * the next failure of this kind reads "the pane was too narrow" rather than
   * "the chip is broken".
   */
  /**
   * Put the main window at a size. Only the WIDTH is ever under test here; the
   * corner rides `onTestDisplay` (#479) so this is not the one place in the
   * suite that drags the window back onto the developer's working monitor.
   */
  async function setBounds(width: number, height: number): Promise<void> {
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, width, height })
    );
  }

  async function roomyPane(w: Page): Promise<void> {
    await setBounds(1700, 950);
    const paneWidth = (): Promise<number> =>
      w.evaluate(
        () => document.querySelector('.doc-rendered-wrap')?.getBoundingClientRect().width ?? -1
      );
    await expect
      .poll(paneWidth, {
        message:
          `the viewer pane never grew past ${OUTLINE_MIN_PANE}px, so the outline is ` +
          'suppressed by its container query and this test cannot say anything ' +
          'about the Outline chip',
      })
      .toBeGreaterThan(OUTLINE_MIN_PANE);
  }

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
    // The task lists, which since #612 are a `☐`/`☑` glyph rather than a
    // disabled `<input>` — `input` is in the sanitizer's `FORBID_TAGS`, so the
    // marker is written by `marked`'s renderer before the sanitizer ever runs.
    // `.doc-task` is what takes the bullet off, and it is the class the pass now
    // sets. FOUR, because the fixture carries both a TIGHT list and a LOOSE one
    // (blank line between the items): `marked` wraps a loose item's content in a
    // `<p>`, which the first cut of the glyph pass did not look through.
    await expect(rendered(w).locator('li.doc-task')).toHaveCount(4);
    await expect(rendered(w).locator('.doc-task-list')).toHaveCount(2);
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

  test('an open document is not counted as a session (#1084)', async () => {
    // The status bar counted dockview PANELS, and a document is a panel: one
    // session beside one README read "2 sessions" at the bottom of the window
    // and "1 session" at the bottom of the rail.
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    const w = a.window;
    await expect(rendered(w).locator('h1')).toBeVisible();
    const statusBar = w.locator('footer').last();
    // the premise: this IS the bar with the count in it, and the document is open
    await expect(statusBar).toContainText(/[0-9]+ sessions?/);
    await expect(viewer(w)).toBeVisible();
    await expect(statusBar).toContainText('1 session');
    await expect(statusBar).not.toContainText('2 sessions');
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

  // #1010. The unit tests own the chip's states; what only a real window can
  // prove is the two halves they cannot reach — that removing the nav actually
  // WIDENS the document (jsdom has no layout, so `getBoundingClientRect` is all
  // zeroes there), and that the choice is still made after a quit and a
  // relaunch, which is the acceptance criterion that decided where the
  // preference is stored.
  //
  // THE TWO CLAIMS ARE DELIBERATELY ASKED UNDER DIFFERENT CONDITIONS, after
  // this test failed twice on CI and once in three local repeats:
  //
  //   * the REFLOW needs a pane wide enough to have an outline at all, so that
  //     half sizes the window first and asserts the size it got (`roomyPane`);
  //   * the PERSISTENCE needs no geometry, so that half asserts nothing that a
  //     window width could change — and is run in the NARROW shape on purpose.
  //
  // Resizing a just-relaunched window is what could not be made reliable: main
  // restores the saved bounds and a `setBounds` that lands first is silently
  // stomped. Rather than guess at a third geometry, the relaunch leg stopped
  // needing one.
  test('the Outline chip hides the outline, widens the document, and is remembered', async () => {
    const { folder, doc } = seededProject();
    a = await launchApp({ seedFolder: folder, seedDocument: doc });
    let w = a.window;
    await roomyPane(w);
    await expect(rendered(w).locator('h1')).toBeVisible();

    const outline = viewer(w).locator('.doc-outline');
    const chip = viewer(w).getByRole('button', { name: 'Outline', exact: true });
    await expect(outline).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    const withOutline = (await rendered(w).boundingBox())!.width;
    await chip.click();
    await expect(outline).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    // THE CLAIM ONLY A REAL ENGINE CAN SETTLE: the outline's width went to the
    // prose. jsdom has no layout, so every box there is zero.
    expect((await rendered(w).boundingBox())!.width).toBeGreaterThan(withOutline);

    // ...and back on again — the whole round trip, here on the window this test
    // sized itself rather than after a relaunch that resizes itself.
    await chip.click();
    await expect(outline).toBeVisible();
    expect((await rendered(w).boundingBox())!.width).toBe(withOutline);

    // ── and the OFF choice survives a quit ────────────────────────────────
    //
    // Turned off again, because that is the state worth persisting: "shown" is
    // also the default, so a relaunch showing an outline proves nothing.
    await chip.click();
    await expect(outline).toHaveCount(0);

    // SHRINK BEFORE THE QUIT, deliberately: `window-state` restores bounds, so
    // this makes the relaunch come back in the NARROW shape a small-screened CI
    // runner has anyway — the shape that broke this test's first two versions.
    // Nothing after the relaunch touches the window's size, which is the other
    // half of the lesson: `setBounds` on a JUST-RESTORED window races main's
    // own restore and loses about one run in three (measured), so the relaunch
    // leg is written to need no geometry at all.
    await setBounds(1024, 768);
    const home = a.home;
    await a.close();
    // 1. it was written
    expect(readWorkspaceFile(home).ui?.documentOutline).toBe(false);

    a = await launchApp({ seedFolder: folder, seedDocument: doc, home });
    w = a.window;
    // 2. ...and it is read back. The PANEL does not survive — `isDerivedPanelId`
    // drops every `doc-` panel out of a restored layout on purpose — so this is
    // the seed seam opening a FRESH viewer, which finds the preference waiting.
    // Measured on a 1024-wide relaunch: viewer present, body present, pane
    // 348px, chip in the DOM reading `aria-pressed="false"`.
    await expect(viewer(w)).toBeVisible();
    await expect(rendered(w).locator('h1')).toBeVisible();
    await expect(viewer(w).locator('.doc-outline')).toHaveCount(0);
    // BY TEST ID, and that is a fix rather than a detail. `getByRole` matches
    // the ACCESSIBILITY TREE, and #1010's own CSS takes the chip out of it in a
    // pane under 420px — so on a narrow relaunch the role query resolves to
    // nothing and the failure reads "element(s) not found", which is exactly
    // what CI reported. What survives a restart is the remembered STATE, and
    // asking about it must not depend on the window's width. The chip's a11y
    // reachability is asserted above, on a pane this test gave room to.
    await expect(viewer(w).locator('[data-testid="doc-outline-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
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
    // ⚠️ HOVER THE ROW FIRST, AND REACH IT BY CSS. Since item 6 the row's verbs
    // are `visibility: hidden` until the row is hovered or focused — which also
    // removes them from the ACCESSIBILITY TREE, so `getByRole` resolves to
    // nothing and the chain cannot start at the button. CI found this, on both
    // platforms.
    const row = w.locator('.scm-row').filter({ hasText: file }).first();
    await row.hover();
    await row.locator(`button[aria-label="Open ${file} in the document viewer"]`).click();

    await expect(viewer(w)).toBeVisible();
    await expect(w.locator('[data-testid="doc-name"]')).toHaveText(file);
    await expect(rendered(w).locator('h1')).toHaveText('committed');
  });
});
