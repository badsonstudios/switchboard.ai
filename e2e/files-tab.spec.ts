// The Files tab, in the real app (#521 layer 2, §5.35).
//
// WHAT ONLY AN E2E CAN SAY HERE. The unit tests own everything else: the
// containment guard (`src/main/fs/list-dir.test.ts`, with real `..` walks and a
// real Windows junction), the row model (`lib/file-tree-model.test.ts`) and the
// component's behaviour against a stubbed lister (`FileTree.test.tsx`). None of
// them can answer the four things below, because all four need the real bridge,
// the real main process and the real `ReadScope` wired to a real session:
//
//   1. the tab is IN the strip, in its place, and wide enough to click;
//   2. `fs:listDir` survives the real preload and the real capability gate —
//      a channel whose capability string were wrong would be refused by the
//      broker and the tree would show nothing but an error row;
//   3. clicking a file really opens a viewer, through the real §5.30 placement
//      policy rather than through an injected callback; and
//   4. the REAL main process refuses a real escape. The unit test proves the
//      guard; this proves the guard is the one wired to the channel.
//
// ⚠️ GEOMETRY. The tab strip crowds on a narrow card, and this spec asserts on
// the strip and on the tree's rows, so the window size is stated as code and the
// thing it enables is ASSERTED rather than assumed — the lesson `feed.spec.ts`'s
// #716/#981 test and `document-viewer.spec.ts`'s Outline test both carry. Every
// row here is located by TEST ID, not by role: a control hidden by CSS is *not
// found* by `getByRole` rather than *not visible*, which turns a layout problem
// into a mysterious absence.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, onTestDisplay, registerTempDir } from './fixtures/app';

/**
 * A project folder with something worth browsing in it.
 *
 * A nested folder (so expansion is testable), a file at each level (so opening
 * is), a `.git` (so the omission is), and a DIRECTORY OUTSIDE the project with a
 * recognisable secret in it — the escape target. That sibling lives inside the
 * same registered temp dir and is never anything real on the machine.
 */
function seededProject(): { folder: string; outside: string } {
  const base = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-files-')));
  const folder = path.join(base, 'project');
  const outside = path.join(base, 'not-the-project');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(folder, 'PROGRESS.md'), '# Progress\n\nA heading and a line.\n');
  fs.writeFileSync(path.join(folder, 'src', 'deep-file.md'), '# Deep\n\nInside src.\n');
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(outside, 'SECRET.md'), '# do-not-read-me\n');
  return { folder, outside };
}

const tree = (w: Page) => w.locator('[data-testid="file-tree"]');
const treeRow = (w: Page, name: string) =>
  w.locator('[data-testid^="file-tree-row-"]').filter({ hasText: name });
const viewTabs = (w: Page) => w.locator('[data-testid="view-tabs"]');
const filesTab = (w: Page) => viewTabs(w).locator('[data-vtab="files"]');

test.describe('the Files tab (#521 layer 2)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  /**
   * Boot on a seeded project, give the window room, and prove it got it.
   *
   * 1400x950 rather than the 1280 default: the strip holds four tabs now, and a
   * card narrow enough to crowd them is a card this spec cannot say anything
   * about. The assertion after the resize is the point — a resize CI declines
   * must read as "the strip was too narrow", not as "the Files tab is missing".
   */
  async function openFiles(): Promise<{ w: Page; folder: string; outside: string }> {
    const { folder, outside } = seededProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, width: 1400, height: 950 })
    );
    await expect(viewTabs(w).first()).toBeVisible({ timeout: 25_000 });
    // THE GEOMETRY PRECONDITION, ASSERTED. A tab crowded to zero width is in the
    // accessibility tree and unclickable, which is the failure this states as a
    // number instead of discovering as a flake.
    await expect
      .poll(
        () =>
          w.evaluate(
            () =>
              document
                .querySelector('[data-testid="view-tabs"] [data-vtab="files"]')
                ?.getBoundingClientRect().width ?? -1
          ),
        {
          message:
            'the Files tab never got any width, so the strip is crowded and this ' +
            'spec cannot say anything about the tab',
          timeout: 15_000,
        }
      )
      .toBeGreaterThan(10);
    await filesTab(w).first().click();
    await expect(tree(w).first()).toBeVisible({ timeout: 15_000 });
    return { w, folder, outside };
  }

  test('the tab is in the strip, in its place, and lists the session folder', async () => {
    const { w, folder } = await openFiles();

    // IN ITS PLACE: Session, Changes, Files, History. Read off the real strip
    // rather than asserted one tab at a time, because the ORDER is the claim.
    // It used to read "Files ahead of the permanently disabled History tab";
    // History works as of E24 Git v2 item 2, so the order is now simply the
    // order — working tree, then files, then the repository.
    const order = await w.evaluate(() =>
      [...document.querySelectorAll('[data-testid="view-tabs"] [role="tab"]')].map(
        (el) => (el as HTMLElement).dataset.vtab
      )
    );
    expect(order).toEqual(['feed', 'diff', 'files', 'history']);
    await expect(filesTab(w).first()).toHaveAttribute('aria-selected', 'true');

    // …and it went through the REAL bridge: a wrong capability string would have
    // had the broker refuse the channel and left an error row in place of these.
    await expect(w.locator('[data-testid="file-tree-root"]').first()).toHaveText(folder);
    await expect(treeRow(w, 'PROGRESS.md').first()).toBeVisible({ timeout: 15_000 });
    await expect(treeRow(w, 'src').first()).toBeVisible();
    // `.git` is not offered as a road
    await expect(treeRow(w, '.git')).toHaveCount(0);
    await expect(w.locator('[data-testid="file-tree-notice-error"]')).toHaveCount(0);
  });

  test('a folder expands lazily and a file opens in the viewer', async () => {
    const { w, folder } = await openFiles();

    // Nothing from inside `src` is on screen until it is asked for — the tree
    // expands one level at a time and main never walks ahead of it.
    await expect(treeRow(w, 'deep-file.md')).toHaveCount(0);
    await treeRow(w, 'src').first().click();
    await expect(treeRow(w, 'deep-file.md').first()).toBeVisible({ timeout: 15_000 });

    // THE PLACEMENT POLICY, FOR REAL. This is the one thing the component test
    // stubs out: there, `onOpenFile` is a spy. Here it is §5.30's real
    // `document-open` route, and what proves it ran is a viewer panel appearing
    // with the file's rendered content in it.
    await treeRow(w, 'deep-file.md').first().click();
    // The viewer panel, by its own test id — not by `.dv-active-tab`, which now
    // matches TWO elements (the session's group and the viewer's) and fails
    // strict mode rather than saying anything useful.
    await expect(w.locator('[data-testid="document-viewer"]').first()).toBeVisible({
      timeout: 15_000,
    });
    // …and it is holding THIS file, rendered: the heading came from the markdown
    // main read back through `fs:read`, which is the proof the click routed all
    // the way through §5.30 rather than merely opening an empty pane.
    await expect(w.locator('[data-testid="doc-rendered"] h1').first()).toHaveText('Deep', {
      timeout: 15_000,
    });
    await expect(w.getByText('Inside src.').first()).toBeVisible({ timeout: 15_000 });

    // §5.24, and the assertion this surface never had (#1055). A file opened
    // from a session's Files tab says which session — and for months it did
    // not: the tab passed the LIVE session id where a card id was wanted, the
    // lookup found nothing, and nothing looks exactly like "no attribution".
    // The viewer worked, so no test and no person noticed.
    const chip = w.locator('[data-testid="doc-attribution"]').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-label', `Opened from the session ${path.basename(folder)}`);
  });

  test('Refresh picks up a file written while the tab was open', async () => {
    const { w, folder } = await openFiles();
    await expect(treeRow(w, 'PROGRESS.md').first()).toBeVisible({ timeout: 15_000 });

    // The honest half of the refresh story, stated as a test: a new file does
    // NOT appear on its own. `FileWatchService` watches files by signature and
    // cannot see an entry arrive, so there is no directory watch — and this is
    // the assertion that would fail first if someone later claimed there was.
    fs.writeFileSync(path.join(folder, 'ARRIVED-LATE.md'), '# late\n');
    await expect(treeRow(w, 'ARRIVED-LATE.md')).toHaveCount(0);

    await w.locator('[data-testid="file-tree-refresh"]').first().click();
    await expect(treeRow(w, 'ARRIVED-LATE.md').first()).toBeVisible({ timeout: 15_000 });
  });

  test('coming back to the tab re-lists it, with no button pressed', async () => {
    const { w, folder } = await openFiles();
    await expect(treeRow(w, 'PROGRESS.md').first()).toBeVisible({ timeout: 15_000 });

    fs.writeFileSync(path.join(folder, 'WHILE-AWAY.md'), '# away\n');
    await viewTabs(w).locator('[data-vtab="feed"]').first().click();
    await expect(tree(w)).toHaveCount(0);
    await filesTab(w).first().click();
    await expect(treeRow(w, 'WHILE-AWAY.md').first()).toBeVisible({ timeout: 15_000 });
  });

  test('THE REAL MAIN PROCESS refuses a real escape, and says nothing about it', async () => {
    // `list-dir.test.ts` proves the guard. This proves the guard is the one
    // actually wired to the channel the renderer can reach — the gap a unit test
    // cannot close, and the reason a correct guard in an unwired module would
    // still be a hole.
    const { w, folder, outside } = await openFiles();
    await expect(treeRow(w, 'PROGRESS.md').first()).toBeVisible({ timeout: 15_000 });

    const answers = await w.evaluate(
      async ([root, out]) => {
        const api = window.switchboard.files;
        return {
          // a `..` walk out of the session folder
          climb: await api.listDir(root, `${root}/../not-the-project`),
          // the sibling, named outright
          named: await api.listDir(root, out),
          // the parent itself
          parent: await api.listDir(root, `${root}/..`),
          // and the sharpest renderer-side lie available: claim the off-limits
          // folder IS your root. Declaring a root grants nothing.
          lying: await api.listDir(out, out),
          // …while the folder it was actually given still works, which is what
          // proves the four above are refusals and not a broken channel.
          real: await api.listDir(root),
        };
      },
      [folder.split(path.sep).join('/'), outside.split(path.sep).join('/')]
    );

    expect(answers.climb).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(answers.named).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(answers.parent).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(answers.lying).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(answers.real.ok).toBe(true);
    // AND NOT ONE NAME LEAKED. A refusal that still carried the entry list
    // would pass every assertion above.
    expect(JSON.stringify(answers)).not.toContain('SECRET.md');
    expect(JSON.stringify(answers)).not.toContain('do-not-read-me');
  });

  // NOT HERE: "a folder-less session greys the tab". A card with no folder is
  // not reachable through the real ⊕ flow, so an e2e would have to invent one
  // through the store — which tests the fixture, not the tab. The rule lives on
  // the contribution and is pinned where it lives, in
  // `extensibility/points.test.ts`, alongside the identical rule for Changes.
});
