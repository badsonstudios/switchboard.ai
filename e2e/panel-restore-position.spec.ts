// #562 — which scroll-holding panels lose their place, and to WHAT.
//
// #555 established one mechanism and fixed the conversation for it. #562 asked
// whether every other panel that holds a position is exposed to the same thing.
// The answer is that there are TWO mechanisms, no panel is exposed to both, and
// the fix for one cannot help the other:
//
//   A. THE DOCKVIEW MOVE (#555's). Activating a group re-runs `openPanel`,
//      which DETACHES the panel's element from the document and appends it
//      again. **The React tree stays alive** — same components, same refs, no
//      render — and the browser drops the `scrollTop` of every NATIVE scroll
//      container on the way through, firing nothing. The fix is a signal: hear
//      the dockview event and re-apply the position you still have.
//
//   B. A REAL UNMOUNT. Only the Terminal panel is `keepMounted`, so switching a
//      card's tab destroys the outgoing panel and every piece of state in it.
//      No signal can help — there is no component left to tell — so the fix is
//      memory that outlives the component.
//
// MEASURED, and the numbers are in the assertions rather than in a comment so a
// panel that changes its mind fails here:
//
//   | panel                | A (dockview move)      | B (unmount)              |
//   |----------------------|------------------------|--------------------------|
//   | conversation (#555)  | fixed in #555          | re-mounts at the tail    |
//   | Changes tab (Monaco) | IMMUNE — line 66 -> 66 | LOST — no file selected  |
//   | document viewer      | LOST — 722 -> 0        | n/a (never unmounts)     |
//   | Terminal (xterm)     | UNRESOLVED*            | keepMounted, n/a         |
//
//   * the xterm viewport IS a native scroller and the move DOES detach it
//     (measured, MutationObserver) — but the fake CLI never produces enough
//     output to overflow one screen, so there was no position to lose and
//     nothing to observe. Stated as unresolved rather than guessed either way;
//     a real session is the only way to settle it.
//
// TWO THINGS THAT MISLEAD, both of which cost real time here and are why the
// instrumentation below is not optional:
//
//   * ONLY ONE `doc-scroll` IS FINDABLE AT A TIME, which reads as "the inactive
//     viewer was unmounted". It was not. A detached element is not in the
//     document, so `querySelector` cannot see it while every ref inside it
//     still holds its value. Instrumenting the module state is what settled it:
//     the viewer never re-read its stored position because it never re-mounted.
//   * MONACO REPORTS `scrollTop` 0 AT EVERY SCROLL POSITION, because it scrolls
//     a virtual viewport — content translated inside an `overflow: hidden` box.
//     A test reading one would report "nothing moved" with equal confidence
//     whether or not anything had. Hence the first visible LINE NUMBER, which is
//     also the thing a user would describe. It is the same property that makes
//     the Changes tab immune to A in the first place.
//
// WINDOW SIZE IS STATED, not inherited (`feed-restore-position.spec.ts`'s
// reason): none of this exists unless the content overflows its pane.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  gridLeafViews,
  launchApp,
  LaunchedApp,
  persistedLayout,
  readWorkspaceFile,
  registerTempDir,
  tempProjectFolder,
  writeWorkspaceFile,
} from './fixtures/app';

const DIRECT = { SWITCHBOARD_FAKE_PROVIDER: 'stream' };
const WINDOW = { x: 0, y: 0, width: 1400, height: 900 };

async function sized(a: LaunchedApp): Promise<void> {
  await a.app.evaluate(({ BrowserWindow }, box) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(box);
  }, WINDOW);
  await a.window.waitForTimeout(400);
}

/**
 * A git repo whose changed files are LONG.
 *
 * `diff.spec.ts`'s repo is four lines — perfect for asserting a diff was
 * computed, useless for asserting where the reader is inside one.
 */
function tallGitProject(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-scroll-git-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  const body = (tag: string, edited: boolean): string =>
    Array.from({ length: 400 }, (_, i) =>
      edited && i === 380 ? `${tag} ${i} EDITED` : `${tag} ${i}`
    ).join('\n') + '\n';
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  for (const f of ['alpha.md', 'beta.md']) fs.writeFileSync(path.join(dir, f), body(f, false));
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  for (const f of ['alpha.md', 'beta.md']) fs.writeFileSync(path.join(dir, f), body(f, true));
  return dir;
}

/** Where Monaco is scrolled to, as the first line number on screen — see the header. */
const monacoTopLine = (w: Page): Promise<number> =>
  w.evaluate(() => {
    // the MODIFIED side only: a fixture with insertions numbers the two sides
    // differently, and a min across both would silently read the other one
    const nums = [...document.querySelectorAll('.monaco-diff-editor .editor.modified .line-numbers')]
      .map((el) => Number((el.textContent ?? '').trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? Math.min(...nums) : -1;
  });

/** A native scroll container's position, by test id. */
const scrollTopOf = (w: Page, testId: string): Promise<number> =>
  w.evaluate(
    (id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.scrollTop ?? -1,
    testId
  );

/**
 * WITHOUT THIS, "the panel kept its position" IS A VACUOUS PASS — and it caught
 * exactly that here on the first run: the document-viewer test passed while the
 * DOM had never moved at all.
 *
 * The hazard is invisible. Dockview detaches and reappends a subtree with no
 * event of any kind, and a click that triggers it looks identical to one that
 * does not. So every A-mechanism assertion is gated on this.
 *
 * It reads the mutation RECORDS rather than checking `isConnected` in the
 * callback: observer callbacks are batched microtasks, so a detach and its
 * reattach routinely land in one batch and the element is connected again by
 * the time anyone looks. The removal is only ever visible in the record.
 */
async function armDetachWatch(w: Page, selector: string): Promise<void> {
  await w.evaluate((sel) => {
    const win = window as unknown as { __sbDetach?: number; __sbMo?: MutationObserver };
    const el = document.querySelector(sel);
    win.__sbMo?.disconnect();
    win.__sbDetach = 0;
    if (!el) return;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.removedNodes)) {
          if (n === el || (n as Element).contains?.(el)) win.__sbDetach = (win.__sbDetach ?? 0) + 1;
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    win.__sbMo = mo;
  }, selector);
}

/** The gesture happened AND the DOM really moved — or the test measured nothing. */
async function expectReallyMoved(w: Page, what: string): Promise<void> {
  const seen = await w.evaluate(
    () => (window as unknown as { __sbDetach?: number }).__sbDetach ?? 0
  );
  expect(
    seen,
    `${what}: the DOM never left the document, so this measured nothing — fix the gesture, do not weaken the assertion`
  ).toBeGreaterThan(0);
}

/**
 * Two sessions restored side by side in two docked groups.
 *
 * `feed-restore-position.spec.ts`'s recipe and its argument: dockview's own
 * drag-and-drop state is not producible from a synthetic `dragstart`, and a real
 * user's split workspace restores from exactly this blob. Two groups is what
 * makes a rail click change the ACTIVE group, which is the whole of mechanism A.
 */
async function twoGroups(a: LaunchedApp, second: string): Promise<string> {
  const w = a.window;
  await a.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [d] });
  }, second);
  await w.getByRole('button', { name: '+ session' }).click();
  await expect(w.locator('nav').getByText(path.basename(second)).first()).toBeVisible({
    timeout: 25_000,
  });
  await w.waitForTimeout(1_500); // let the layout reach disk
  const home = a.home;
  await a.close();

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
  return home;
}

/** Scroll a Monaco editor the way a user does. One wheel event is ~2 lines, so
 *  this sends many — a single big delta moves almost nothing. */
async function wheelInto(w: Page, selector: string): Promise<void> {
  const box = (await w.locator(selector).first().boundingBox())!;
  await w.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  for (let i = 0; i < 25; i++) await w.mouse.wheel(0, 300);
  await w.waitForTimeout(1_000);
}

test.describe('scroll-holding panels under a dockview move (#562)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    // the detach observer watches the whole document subtree; leaving it
    // running would have it outlive the test that armed it
    await launched?.window
      .evaluate(() => (window as unknown as { __sbMo?: MutationObserver }).__sbMo?.disconnect())
      .catch(() => {});
    await launched?.cleanup();
  });

  // MECHANISM A, and the surprise: the Changes tab does not need fixing. Kept
  // as a test rather than written down as prose, because "Monaco is immune to a
  // detach" is exactly the kind of claim that stops being true in a Monaco
  // upgrade, silently, in a pane nobody is testing.
  test('the Changes tab is IMMUNE to a dockview move (measured, not assumed)', async () => {
    test.setTimeout(240_000);
    const repo = tallGitProject();
    const other = tempProjectFolder();
    const n1 = path.basename(repo);
    const n2 = path.basename(other);

    const first = await launchApp({ seedFolder: repo, env: DIRECT });
    a = first;
    await expect(first.window.getByText(n1).first()).toBeVisible({ timeout: 25_000 });
    await sized(first);
    const home = await twoGroups(first, other);

    a = await launchApp({ home, env: DIRECT });
    const w = a.window;
    await expect(w.locator('.dv-groupview')).toHaveCount(2, { timeout: 25_000 });
    await sized(a);

    const gitGroup = w.locator('.dv-groupview').filter({ hasText: n1 });
    await gitGroup.getByRole('tab', { name: 'Changes' }).first().click();
    await gitGroup.getByText('alpha.md').first().click();
    await expect(w.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
      timeout: 30_000,
    });
    await wheelInto(w, '.monaco-diff-editor');

    const before = await monacoTopLine(w);
    expect(before, 'the fixture must actually scroll, or this measures nothing').toBeGreaterThan(20);

    // the move: activate the OTHER group, then come back to this one
    await armDetachWatch(w, '.monaco-diff-editor');
    await w.locator('nav [draggable="true"]').filter({ hasText: n2 }).first().click();
    await w.waitForTimeout(900);
    await w.locator('nav [draggable="true"]').filter({ hasText: n1 }).first().click();
    await w.waitForTimeout(1_500);
    await expectReallyMoved(w, 'the Changes tab');

    expect(
      await monacoTopLine(w),
      'Monaco used to survive a detach because it scrolls a virtual viewport — if this fails, it no longer does, and the Changes tab now needs what the feed needed in #555'
    ).toBe(before);
  });

  // MECHANISM B — a real unmount, and the Changes tab's actual defect. Nothing
  // to do with dockview: `panels.tsx` renders only the ACTIVE panel (the
  // Terminal alone is `keepMounted`), so leaving the tab destroys the pane and
  // every piece of state in it. Against the unfixed build the pane comes back
  // with no file selected at all, let alone the same place in it.
  test('the Changes tab keeps its file and its place across a tab switch', async () => {
    test.setTimeout(180_000);
    const repo = tallGitProject();
    a = await launchApp({ seedFolder: repo, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(repo)).first()).toBeVisible({ timeout: 25_000 });
    await sized(a);

    await w.getByRole('tab', { name: 'Changes' }).first().click();
    await w.getByText('alpha.md').first().click();
    await expect(w.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
      timeout: 30_000,
    });
    await wheelInto(w, '.monaco-diff-editor');
    const before = await monacoTopLine(w);
    expect(before).toBeGreaterThan(20);

    // away and back — this UNMOUNTS the pane, which is why the fix is a memo
    // that outlives it rather than anything to do with dockview
    await w.getByRole('tab', { name: 'Session' }).first().click();
    await expect(w.locator('.monaco-diff-editor')).toHaveCount(0, { timeout: 20_000 });
    await w.getByRole('tab', { name: 'Changes' }).first().click();

    // the FILE is still chosen — against the unfixed build there is no
    // selection at all, so the pane comes back to an empty editor
    await expect(w.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
      timeout: 30_000,
    });
    // BOTH SIDES. `toBeGreaterThan` alone passes for any larger value — the
    // bottom of the file included — so a restore that clamped to the end would
    // read as success.
    await expect.poll(() => monacoTopLine(w), { timeout: 15_000 }).toBeGreaterThan(before - 10);
    expect(await monacoTopLine(w)).toBeLessThan(before + 10);
  });

  // MECHANISM A on the viewer the issue calls out by name — the #555 defect,
  // reached the way a reader reaches it: two documents open in one dockview
  // group, glance at the other one, come back. The panel is DETACHED, not
  // unmounted (see the header), so its remembered position was intact the whole
  // time and the only thing missing was a signal to re-apply it.
  test('the document viewer keeps its place across a tab switch', async () => {
    test.setTimeout(180_000);
    const repo = tallGitProject();
    a = await launchApp({ seedFolder: repo, env: DIRECT });
    const w = a.window;
    await expect(w.getByText(path.basename(repo)).first()).toBeVisible({ timeout: 25_000 });
    await sized(a);

    // open both files in the viewer, from the Changes tab's own control
    await w.getByRole('tab', { name: 'Changes' }).first().click();
    const openInViewer = w.locator('button.diff-open-viewer');
    await expect(openInViewer).toHaveCount(2, { timeout: 30_000 });
    await openInViewer.nth(0).click();
    await expect(w.locator('[data-testid="doc-scroll"]')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Changes' }).first().click();
    await openInViewer.nth(1).click();
    await expect(w.locator('.dv-tab').filter({ hasText: 'beta.md' })).toBeVisible({
      timeout: 30_000,
    });

    // WAIT FOR THE BODY, not just the tab: the markdown renders a beat after
    // the panel appears, and a scroll written before it has content is written
    // to a box with nothing in it — which is how this test first "measured" a
    // document that did not overflow.
    await expect
      .poll(
        () =>
          w.evaluate(() => {
            const el = document.querySelector<HTMLElement>('[data-testid="doc-scroll"]');
            return el ? el.scrollHeight - el.clientHeight : 0;
          }),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(200);

    // read some way down the second document
    await w.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="doc-scroll"]');
      if (el) el.scrollTop = 3_000;
    });
    await w.waitForTimeout(500);
    const before = await scrollTopOf(w, 'doc-scroll');
    expect(before, 'the fixture must actually overflow, or this measures nothing').toBeGreaterThan(
      100
    );

    // glance at the other document and come back — 722 -> 0 before the fix
    await armDetachWatch(w, '[data-testid="doc-scroll"]');
    await w.locator('.dv-tab').filter({ hasText: 'alpha.md' }).first().click();
    await w.waitForTimeout(1_200);
    await w.locator('.dv-tab').filter({ hasText: 'beta.md' }).first().click();
    await expect(w.locator('[data-testid="doc-scroll"]')).toBeVisible({ timeout: 20_000 });
    // gated like every other A-mechanism assertion here: the day dockview stops
    // detaching on tab activation, this test must fail rather than go quietly
    // vacuous — which is exactly what it did on its first run
    await expectReallyMoved(w, 'the document viewer');

    await expect
      .poll(() => scrollTopOf(w, 'doc-scroll'), { timeout: 15_000 })
      .toBeGreaterThan(before - 50);
    expect(await scrollTopOf(w, 'doc-scroll')).toBeLessThan(before + 100);
  });
});
