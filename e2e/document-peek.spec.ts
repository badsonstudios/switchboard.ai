// The peek slot, pinning, and the viewer window (P2-E16-03, §5.30 + §5.8).
//
// `lib/document-panels.test.ts` owns the RULES — one peek slot, pin promotes,
// unpin reclaims, ids never collide — as pure state, and it can, because they
// are pure state. What only a real Electron window can prove is the half that
// is dockview's:
//
//   * a viewer never lands in a SESSION'S group, and never in a POPOUT. That is
//     the E8-04 defect in mirror image, and the plan says in as many words to
//     assert it and not reason about it. Reasoning about it is exactly what
//     produced E8-04.
//   * a viewer really does move to its own OS window and really does come back.
//   * a viewer is not a session: not in the rail, not in the urgency strip
//     (which is the attention queue's membership, on screen), and not taken by
//     a bulk close.
//   * quitting with viewers open does not cost a session.
//
// Every file here is opened through the Changes tab's ↗ — a real gesture on a
// real surface, and the only in-app path that can open a SECOND document
// without a native dialog. It doubles as the §5.24 attribution case: the ↗ is
// inside a session's tab, so the viewer it opens belongs to that session.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const viewer = (w: Page) => w.locator('[data-testid="document-viewer"]');
const docName = (w: Page) => w.locator('[data-testid="doc-name"]');
const tabs = (w: Page) => w.locator('.dv-tabs-container .dv-tab');
/** the viewer TABS, which survive being the inactive tab — the panel body does
 *  not, because dockview renders only what is visible */
const docTab = (w: Page, file: string) => tabs(w).filter({ hasText: file });
const rail = (w: Page) => w.locator('nav');
const railRows = (w: Page) => rail(w).locator('[draggable="true"]');
const lamps = (w: Page) => w.getByTestId('urgency-strip').locator('[data-urgency-lamp]');

/** Popouts need a real window manager; CI's Linux runner is headless-xvfb and
 *  the popped-out BrowserWindow never materialises there (see the E8 specs). */
function skipPopoutOnLinux(): void {
  test.skip(process.platform === 'linux', 'popout windows are unreliable under xvfb');
}

/**
 * A repo with `files` committed and then modified — one Changes row each.
 *
 * Their CONTENT matters: each is markdown with a distinct `# heading`, so the
 * assertions can say which document is on screen rather than merely that one
 * is.
 */
function tempGitProject(files: string[]): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-peek-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  // a runner with no global user.email cannot commit at all
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  for (const f of files) fs.writeFileSync(path.join(dir, f), `# ${f} as committed\n`);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  for (const f of files) fs.writeFileSync(path.join(dir, f), `# ${f} now\n\nchanged\n`);
  return dir;
}

/** Open the seeded session's Changes tab, the way a user does. */
async function openChanges(w: Page, folder: string): Promise<void> {
  const title = path.basename(folder);
  await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
  await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
  await w.getByRole('menuitem', { name: 'Open changes' }).click();
  await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
}

/** The ↗ at the end of a Changes row: "never mind the diff, show me the file". */
async function openInViewer(w: Page, file: string): Promise<void> {
  await w.getByRole('button', { name: `Open ${file} in the document viewer` }).click();
}

test.describe('the peek slot and pinning (P2-E16-03)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('a second file REPLACES the peek slot; pinning makes the next open a new panel', async () => {
    const dir = tempGitProject(['ONE.md', 'TWO.md', 'THREE.md']);
    a = await launchApp({ seedFolder: dir });
    const w = a.window;
    await openChanges(w, dir);

    // ── one glance ────────────────────────────────────────────────────────
    await openInViewer(w, 'ONE.md');
    await expect(viewer(w)).toBeVisible();
    await expect(docName(w)).toHaveText('ONE.md');
    await expect(docTab(w, 'ONE.md')).toHaveCount(1);

    // §5.24: opened from a session's surface, so it says which one — and the
    // name is the session's, not the folder's spelling by luck
    const chip = w.locator('[data-testid="doc-attribution"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(path.basename(dir));
    await expect(chip).toHaveAttribute('aria-label', `Opened from the session ${path.basename(dir)}`);

    // ── the next glance takes the SAME panel ──────────────────────────────
    await openInViewer(w, 'TWO.md');
    await expect(docName(w)).toHaveText('TWO.md');
    await expect(w.locator('[data-testid="doc-rendered"] h1')).toHaveText('TWO.md now');
    // the tab was re-titled, not duplicated: the first file is GONE from the
    // tab strip, which is the whole point of a peek slot
    await expect(docTab(w, 'TWO.md')).toHaveCount(1);
    await expect(docTab(w, 'ONE.md')).toHaveCount(0);

    // ── pin, and the next glance gets its own panel ───────────────────────
    const pin = viewer(w).getByTestId('doc-pin');
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');

    await openInViewer(w, 'THREE.md');
    await expect(docTab(w, 'TWO.md')).toHaveCount(1); // kept
    await expect(docTab(w, 'THREE.md')).toHaveCount(1); // and a fresh peek slot
    await expect(docName(w)).toHaveText('THREE.md');

    // ...and THAT one is transient again: a fourth glance replaces it and
    // still leaves the pinned one alone
    await openInViewer(w, 'ONE.md');
    await expect(docTab(w, 'TWO.md')).toHaveCount(1);
    await expect(docTab(w, 'ONE.md')).toHaveCount(1);
    await expect(docTab(w, 'THREE.md')).toHaveCount(0);
  });

  test('a viewer never opens as a tab inside a session’s group', async () => {
    // The E8-04 rule's docked half. With one session open there is exactly one
    // grid group, and taking "the first grid group" — which is what P2-E16-02
    // did — makes the viewer a tab BESIDE the card: selecting it hides the
    // session you were watching. The document area has to be its own group.
    const dir = tempGitProject(['ONE.md']);
    a = await launchApp({ seedFolder: dir });
    const w = a.window;
    await openChanges(w, dir);
    await openInViewer(w, 'ONE.md');
    await expect(viewer(w)).toBeVisible();

    // A SECOND group exists: the session's, and the document area beside it.
    await expect(w.locator('.dv-groupview')).toHaveCount(2);

    // And the behavioural proof, which is the one that matters: dockview
    // renders only the ACTIVE tab of a group, so bringing the session card back
    // to the front would hide the viewer if they shared a group. Both on screen
    // at once is "the viewer did not displace the session", stated as pixels.
    const title = path.basename(dir);
    await w
      .locator('.dv-tab')
      .filter({ hasText: title })
      .filter({ hasNotText: '· diff' })
      .first()
      .click();
    await expect(w.getByTestId('card-header')).toBeVisible();
    await expect(viewer(w)).toBeVisible();
  });
});

test.describe('the viewer window (P2-E16-03)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('a viewer pops out to its own window, keeps the next open OUT of it, and docks back', async () => {
    skipPopoutOnLinux();
    const dir = tempGitProject(['ONE.md', 'TWO.md']);
    a = await launchApp({ seedFolder: dir });
    const w = a.window;
    await openChanges(w, dir);
    await openInViewer(w, 'ONE.md');
    await expect(docName(w)).toHaveText('ONE.md');

    // ── out ───────────────────────────────────────────────────────────────
    await w.getByTitle('Open this document in its own window').click();
    // by URL, not by "the other one": devtools or a rescued window would both
    // satisfy `!== w` and neither hosts a viewer
    await expect
      .poll(() => a!.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');
    await expect(docName(popout)).toHaveText('ONE.md', { timeout: 15_000 });
    await expect(popout.locator('[data-testid="doc-rendered"] h1')).toHaveText('ONE.md now');
    // the main window no longer holds it — it MOVED, it was not copied
    await expect(viewer(w)).toHaveCount(0);

    // ── THE MIRROR OF E8-04 ───────────────────────────────────────────────
    // Pin the popped-out viewer (so the next open cannot simply re-point it),
    // then open another file from the main window. dockview's `addPanel`
    // defaults to the ACTIVE group — which is now the group in the popout —
    // so without the rule the second viewer would appear in this window,
    // silently, on the wrong monitor.
    await popout.getByTestId('doc-pin').click();
    await expect(popout.getByTestId('doc-pin')).toHaveAttribute('aria-pressed', 'true');

    await openInViewer(w, 'TWO.md');
    await expect(docName(w)).toHaveText('TWO.md', { timeout: 15_000 });
    // VISIBLE, not merely present. Popping a lone panel out leaves its old
    // group in the grid, empty and hidden, as the shell it docks back into —
    // and `addPanel` into that shell would put the new viewer in the layout at
    // zero height. "It is in the DOM" is the assertion that misses it.
    await expect(viewer(w)).toBeVisible();
    // ...and the viewer window is untouched: still ONE.md, still one viewer
    await expect(viewer(popout)).toHaveCount(1);
    await expect(docName(popout)).toHaveText('ONE.md');

    // ── and back ──────────────────────────────────────────────────────────
    // The control, not the OS: the same button now says dock back, which is the
    // toggle §5.30 asks for. (Handing the window back here also spares the
    // teardown a tree-kill; a live popout has outlived cleanup on CI before.)
    await popout.getByTitle('Put this document back in the main window').click();
    await expect
      .poll(() => a!.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(0);
    await expect(docTab(w, 'ONE.md')).toHaveCount(1, { timeout: 15_000 });
    await expect(docTab(w, 'TWO.md')).toHaveCount(1);
  });

  test('a file opened while a SESSION is popped out lands in the document area', async () => {
    // THE DONE-WHEN'S OWN SENTENCE, and the reason it insists on e2e rather than
    // reasoning: this is E8-04 in mirror image. dockview's `addPanel` defaults
    // to the ACTIVE group, and popping the card out both makes its new group
    // active AND leaves an empty, hidden shell behind in the grid — two
    // different ways for the viewer to end up somewhere the user cannot see it.
    skipPopoutOnLinux();
    const dir = tempGitProject(['ONE.md']);
    a = await launchApp({ seedFolder: dir });
    const w = a.window;
    await openChanges(w, dir);
    // The Changes tab is now the group's active tab, and the card's pop-out
    // control lives in the card HEADER — which dockview is not rendering while
    // another tab of that group is up. Bring the card forward to reach it; the
    // Changes tab stays behind in the grid when the card leaves, which is
    // exactly the surface this test needs to click ↗ from afterwards.
    await w
      .locator('.dv-tab')
      .filter({ hasText: path.basename(dir) })
      .filter({ hasNotText: '· diff' })
      .first()
      .click();
    await w.getByTitle('Pop out into its own window').click();
    await expect
      .poll(() => a!.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);
    const popout = a.app.windows().find((p) => p.url().includes('popout.html'))!;
    await popout.waitForLoadState('domcontentloaded');
    await expect(popout.getByTestId('card-header')).toBeVisible({ timeout: 15_000 });

    // the Changes tab stayed behind with the grid; open a file from it
    await openInViewer(w, 'ONE.md');
    await expect(viewer(w)).toBeVisible({ timeout: 15_000 });
    await expect(docName(w)).toHaveText('ONE.md');
    // NOT in the session's window — not as a tab, not at all
    await expect(viewer(popout)).toHaveCount(0);

    await popout.evaluate(() => window.close());
  });
});

test.describe('a viewer is not a session (P2-E16-03, §5.30)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  test('it is absent from the rail and the urgency strip, and a bulk close spares it', async () => {
    const dir = tempGitProject(['ONE.md']);
    a = await launchApp({ seedFolder: dir });
    const w = a.window;
    await expect(railRows(w)).toHaveCount(1, { timeout: 25_000 });
    await expect(lamps(w)).toHaveCount(1);

    await openChanges(w, dir);
    await openInViewer(w, 'ONE.md');
    await expect(viewer(w)).toBeVisible();

    // NOT IN THE RAIL, and NOT IN THE QUEUE — the urgency strip is the queue's
    // membership rendered, one lamp per session that could ever need a human.
    await expect(railRows(w)).toHaveCount(1);
    await expect(lamps(w)).toHaveCount(1);

    // NOT IN A BULK CLOSE. The session goes; the document stays open, because
    // it was never the session's to close.
    w.once('dialog', (d) => void d.accept());
    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('Close all sessions');
    await w.keyboard.press('Enter');

    await expect(railRows(w)).toHaveCount(0, { timeout: 20_000 });
    await expect(viewer(w)).toBeVisible();
    await expect(docName(w)).toHaveText('ONE.md');
  });

  test('quitting with viewers open costs no session state', async () => {
    const dir = tempGitProject(['ONE.md', 'TWO.md']);
    const first = await launchApp({ seedFolder: dir });
    a = first;
    const w = first.window;
    await openChanges(w, dir);
    await openInViewer(w, 'ONE.md');
    await expect(viewer(w)).toBeVisible();
    // Pinned, and then a SECOND one — so the quit happens with a kept viewer
    // AND a live peek slot, which is all of the state this item added.
    await w.getByTestId('doc-pin').click();
    await openInViewer(w, 'TWO.md');
    await expect(docTab(w, 'ONE.md')).toHaveCount(1);
    await expect(docTab(w, 'TWO.md')).toHaveCount(1);

    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;

    // the session came back, named and countable
    await expect(railRows(w2)).toHaveCount(1, { timeout: 25_000 });
    await expect(railRows(w2).first()).toContainText(path.basename(dir));
    // ...and the viewers did not (restoring open viewers is Phase 3) — stated
    // so that the day it changes, this line is the one that says so
    await expect(viewer(w2)).toHaveCount(0);
  });

  test('quitting with a viewer in its OWN window leaves no empty window behind', async () => {
    // A popped-out viewer IS a popout group in the saved layout, and popout
    // groups are restored before the `doc-` prune runs. Removing a popout
    // group's last panel is what makes dockview forget the window — so the
    // shell goes with the viewer — but "so it should" is the kind of claim the
    // E8 specs exist because nobody checked.
    skipPopoutOnLinux();
    const dir = tempGitProject(['ONE.md']);
    const first = await launchApp({ seedFolder: dir });
    a = first;
    const w = first.window;
    await openChanges(w, dir);
    await openInViewer(w, 'ONE.md');
    await w.getByTitle('Open this document in its own window').click();
    await expect
      .poll(() => first.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 15_000,
      })
      .toBe(1);

    await first.close();
    a = await launchApp({ home: first.home });
    const w2 = a.window;
    await expect(railRows(w2)).toHaveCount(1, { timeout: 25_000 });
    // no viewer, and — the point — no window left holding nothing
    await expect(viewer(w2)).toHaveCount(0);
    await expect
      .poll(() => a!.app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 20_000,
      })
      .toBe(0);
  });
});
