// The History tab, in the real app (E24 Git v2 item 2, §5.7).
//
// ⚠️ **THIS TAB WAS A PLACEHOLDER WHILE TWO OF OUR OWN DOCUMENTS SAID IT HAD
// SHIPPED**, and the thing that eventually told us was the owner clicking it. So
// this spec exists for a reason the other e2e specs do not have: it is the check
// that the tab is really there and really full, which is exactly the check no
// document could make.
//
// WHAT ONLY AN E2E CAN SAY. The unit tests own everything else — the log parser
// against fixture bytes (`main/git/git-log.test.ts`), the service against real
// git in temp repositories (`main/git/git-service.test.ts`), the state ordering
// (`lib/git-log-dto.test.ts`) and the component against injected readers
// (`components/HistoryPane.test.tsx`). None of them can answer these:
//
//   1. the tab is IN the strip, in its place, enabled, and wide enough to click;
//   2. `git:log` survives the real preload and the real capability gate — a
//      wrong capability string would have the broker refuse the channel, and the
//      pane would sit on "Reading the history…" for ever;
//   3. the REAL `git` binary, driven by the REAL main process, produces bytes the
//      REAL parser reads — the whole pipe, end to end, in one assertion;
//   4. a folder that is not a repository says so here too, rather than throwing.
//
// ⚠️ GEOMETRY, and the lesson is `files-tab.spec.ts`'s: the strip crowds on a
// narrow card, and a tab crowded to zero width is in the accessibility tree and
// unclickable — so the width is asserted as a number before anything is clicked.
//
// The TAB is located by `data-vtab`; the pane's own rows are located by CLASS,
// which is a deliberate difference from `FileTree`'s test-id convention and worth
// naming rather than leaving as an inconsistency. These classes exist for the
// component's unit tests, which are the detailed ones; adding a parallel set of
// test ids for this spec alone would be two naming schemes over one surface.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, onTestDisplay, registerTempDir } from './fixtures/app';

/**
 * A project folder with a real git history in it.
 *
 * Two commits and a tag, made with the real binary, so what the tab draws came
 * out of `git log` rather than out of a fixture. The identity is set locally
 * rather than relying on the runner having a global one — CI does not.
 */
function seededRepo(): { folder: string; subject: string } {
  const folder = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-hist-')));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: folder, stdio: 'ignore' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@test');
  git('config', 'user.name', 'E2E Tester');
  // Switchboard's own guard points `core.hooksPath` somewhere empty, but these
  // calls are the test's own and run without it — so commit signing, which a
  // developer machine may have on globally, is turned off locally.
  git('config', 'commit.gpgsign', 'false');
  // ⚠️ **AND THE GLOBAL HOOKS PATH IS NEUTRALISED ON EVERY COMMIT (review).** The
  // comment above used to claim these calls ran without switchboard's guard and
  // then only disabled signing — but this very machine has a global
  // `core.hooksPath` (the Co-Authored-By stripper), so a `commit-msg` or
  // `pre-commit` hook would run against the fixture repo and a failing one makes
  // `execFileSync` throw inside the fixture rather than inside a test. An empty
  // value is how "no hooks path" is spelled.
  const commit = (...args: string[]): void => git('-c', 'core.hooksPath=', 'commit', ...args);
  fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
  git('add', '.');
  commit('-m', 'the first commit, in the e2e repo');
  git('tag', 'v-e2e');
  fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n\nmore\n');
  const subject = 'HISTORY_E2E_SUBJECT the second commit';
  commit('-am', subject);
  return { folder, subject };
}

const viewTabs = (w: Page) => w.locator('[data-testid="view-tabs"]');
const historyTab = (w: Page) => viewTabs(w).locator('[data-vtab="history"]');
const rows = (w: Page) => w.locator('.history-row');

test.describe('the History tab (E24 Git v2 item 2)', () => {
  let a: LaunchedApp | undefined;

  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
  });

  /** Boot on a folder, give the window room, and prove the tab got width. */
  async function openHistory(folder: string): Promise<Page> {
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await a.app.evaluate(
      ({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0]?.setBounds(box),
      onTestDisplay(a, { x: 20, y: 20, width: 1400, height: 950 })
    );
    await expect(viewTabs(w).first()).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(
        () =>
          w.evaluate(
            () =>
              document
                .querySelector('[data-testid="view-tabs"] [data-vtab="history"]')
                ?.getBoundingClientRect().width ?? -1
          ),
        {
          message:
            'the History tab never got any width, so the strip is crowded and this ' +
            'spec cannot say anything about the tab',
          timeout: 15_000,
        }
      )
      .toBeGreaterThan(10);
    await historyTab(w).first().click();
    await expect(historyTab(w).first()).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
    return w;
  }

  test('⚠️ the tab is ENABLED and full of the repository’s real history', async () => {
    const { folder, subject } = seededRepo();
    const w = await openHistory(folder);

    // THE WHOLE PIPE: real git → real main process → real IPC through the real
    // capability gate → real parser → these rows. A wrong capability string would
    // leave the pane on "Reading the history…" for ever, which is why the absence
    // of that text is asserted alongside the presence of the rows.
    await expect(rows(w).first()).toBeVisible({ timeout: 20_000 });
    await expect(rows(w)).toHaveCount(2);
    await expect(w.locator('.history-subject').filter({ hasText: subject })).toHaveCount(1);
    await expect(w.getByText('Reading the history…')).toHaveCount(0);

    // The branch, read off `%D` — not asked for separately, so this also proves
    // `--decorate=full` survived the trip.
    await expect(w.locator('.history-branch')).toContainText('main');
    // The tag chip, which is the half `--decorate=full` exists for: a short
    // decoration cannot tell a tag from a branch.
    await expect(w.locator('.history-ref-tag')).toContainText('v-e2e');
    // Real numbers out of `--shortstat`, and a real abbreviated sha.
    await expect(w.locator('.history-stats').first()).toContainText('+');
    await expect(w.locator('.history-hash').first()).toHaveText(/^[0-9a-f]{8}$/);

    // THE GRAPH (item 3), end to end. The allocator is unit-tested at eight
    // lanes; what only this can say is that the geometry reaches the DOM at all
    // and that it is drawn from `parentIds` that survived the trip.
    await expect(w.locator('.history-lane')).toHaveCount(2);
    // One dot per row…
    await expect(w.locator('.history-lane circle')).toHaveCount(2);
    // …and the two rows differ exactly where they should: the newest commit has
    // only a line BELOW its dot and the root has only one ABOVE. Counted rather
    // than measured, because the count is the claim — three lines total, not four.
    await expect(w.locator('.history-lane line')).toHaveCount(2);
  });

  test('a folder that is not a repository says so, and does not break the card', async () => {
    const plain = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-hist-plain-')));
    fs.writeFileSync(path.join(plain, 'README.md'), '# not a repo\n');
    const w = await openHistory(plain);

    await expect(w.getByText('Not a git repository').first()).toBeVisible({ timeout: 20_000 });
    await expect(rows(w)).toHaveCount(0);
    // ⚠️ AND THE COUNT IS NOT THERE. An ungated commit count rendered "no
    // commits" over every state including this one — a confident zero above a
    // pane saying it could not find out. A unit test caught it; this is the
    // end-to-end witness.
    await expect(w.getByText('no commits')).toHaveCount(0);

    // Fail-open: the rest of the card still works. ⚠️ This is a WEAK assertion and
    // is labelled as one (review) — a throw inside the pane would be caught by the
    // contribution boundary and the Session tab would work either way. The
    // load-bearing assertion is the one above it; this is here because the cost of
    // a broken card is high enough that the cheap check is worth its line.
    await w.getByRole('tab', { name: 'Session', exact: true }).click();
    await expect(w.getByText('No conversation yet')).toBeVisible({ timeout: 10_000 });
  });
});
