// The Changes tab / Monaco diff pane (P1-E5-02) — e2e coverage, #161.
//
// This surface had NONE until now, which is why every CSP-adjacent PR ended
// with "please open the Changes tab by hand". It is the only pane in the app
// that spawns a Web Worker, and one of the few that injects <style> elements
// at runtime, so it is the first thing a policy change breaks and the last
// thing anything automated would notice.
//
// WHAT COUNTS AS PROOF THE WORKER RAN
//
// Not the editor div: that mounts whether or not the worker ever loaded.
// Not syntax highlighting either — Monaco tokenizes with Monarch on the MAIN
// thread, so coloured text says nothing about the worker.
//
// And — the finding that shaped this spec — NOT the rendered diff on its own.
// The diff is genuinely the worker's output: `EditorWorkerService.computeDiff`
// posts both models to `editor.worker` and awaits the reply
// (.../browser/services/editorWorkerService.js), and the `line-insert` /
// `line-delete` / `char-insert` / `char-delete` decorations only exist once it
// comes back. But when the worker cannot be created Monaco does not fail — it
// loads the worker code into the MAIN THREAD and carries on
// (.../base/common/worker/webWorker.js), so the decorations come out
// byte-identical. MEASURED, by making `MonacoEnvironment.getWorker` throw and
// re-running this spec: every assertion below still passed.
//
// So proving the worker ran takes two things together:
//   1. the decorations  -> a diff was really computed, not just an editor
//      mounted; and
//   2. no fallback warning -> it was computed in a WORKER.
//
// (2) matters more than it looks. A CSP regression that blocks the worker
// would leave the Changes tab looking perfect and quietly move Monaco onto the
// UI thread — which is exactly why the hand-check this spec replaces could
// never have caught it.
//
// ONE TRAP, and it dictates the fixture: `WorkerBasedDocumentDiffProvider`
// short-circuits an EMPTY original and synthesizes the whole-file "added"
// result on the main thread, without the worker
// (.../diffEditor/diffProviderFactoryService.js). A brand-new/untracked file
// would therefore light up `line-insert` with the worker stone dead. So the
// fixture commits the file first and then MODIFIES it: a non-empty original,
// and a `line-delete` that no short-circuit can manufacture.
import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';

/** Committed at HEAD. Multi-line and non-empty — see the trap above. */
const COMMITTED = [
  '// switchboard e2e fixture',
  "export const GREETING = 'hello';",
  'export function greet(name: string): string {',
  "  return GREETING + ', ' + name;",
  '}',
  'export const ANSWER = 42;',
  '',
].join('\n');

/**
 * The working copy. Two lines differ and each keeps a long identical prefix,
 * so the diff has to come back with line-level AND character-level changes.
 */
const WORKING = [
  '// switchboard e2e fixture',
  "export const GREETING = 'howdy';",
  'export function greet(name: string): string {',
  "  return GREETING + ', ' + name;",
  '}',
  'export const ANSWER = 99;',
  '',
].join('\n');

const FILE = 'greeting.ts';

/**
 * A throwaway git repo with one committed file and an uncommitted edit to it.
 *
 * Local to this spec on purpose: it is the only one that needs a repo, and the
 * content above and the assertions below are one thought.
 *
 * Takes the tracking array rather than returning a path for the caller to
 * register, so the directory is owned for teardown from the line it exists
 * (#180 — specs leaking temp dirs). Registering it after the `git` calls would
 * leak the folder on any machine where they fail.
 */
function tempGitProject(track: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-git-'));
  track.push(dir);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  // local identity: a machine (or CI runner) with no global user.email cannot
  // commit at all, and the commit is what gives us a non-empty original
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  fs.writeFileSync(path.join(dir, FILE), COMMITTED);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(dir, FILE), WORKING);
  return dir;
}

const diffEditor = (w: Page) => w.locator('.monaco-diff-editor');

/**
 * Monaco's own words when it could not spawn a worker and ran the worker code
 * on the UI thread instead — `console.warn` in
 * monaco-editor/esm/vs/base/common/worker/webWorker.js. Matched on the stable
 * head of the sentence, not the whole string with its FAQ link.
 */
const WORKER_FALLBACK = /could not create web worker/i;

/** A CSP refusal, in either of the two shapes Chromium words them. */
const CSP_REFUSAL = /content security policy|refused to/i;

/** Every distinct `mtkN` class the rendered diff put on screen. */
async function tokenClasses(w: Page): Promise<string[]> {
  return w.evaluate(() => {
    const seen = new Set<string>();
    for (const el of document.querySelectorAll('.monaco-diff-editor .view-line span')) {
      for (const c of el.classList) if (/^mtk\d+$/.test(c)) seen.add(c);
    }
    return [...seen].sort();
  });
}

test.describe('Changes tab (Monaco diff pane)', () => {
  let a: LaunchedApp | undefined;
  const projects: string[] = [];

  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    await launched?.cleanup();
    // the app is down first: on Windows a live child holds handles into the
    // folder and rmSync throws EBUSY (#167)
    while (projects.length) {
      try {
        fs.rmSync(projects.pop()!, { recursive: true, force: true });
      } catch {
        /* best-effort — never fail a green test on teardown */
      }
    }
  });

  /**
   * Boot on a real repo and open the Changes tab, the way the rail does.
   *
   * Also returns everything the page logged from launch onwards. The pane's
   * two interesting acts — spawning the worker and injecting <style> elements
   * — both happen when the tab opens, well after that, so nothing is missed.
   */
  async function openChanges(): Promise<{ w: Page; logged: string[] }> {
    const folder = tempGitProject(projects);
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    // Everything the page said, from before the pane existed. The worker is
    // not created until the first diff is computed, well after this point.
    const logged: string[] = [];
    w.on('console', (msg) => logged.push(msg.text()));

    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
    return { w, logged };
  }

  test('renders a real diff, computed in a real worker', async () => {
    const { w, logged } = await openChanges();

    // the file list is the git status, live: one tracked file, modified
    const entry = w.getByText(FILE, { exact: true });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    // the VCS badge is the path span's sibling — scoped, because a bare "M"
    // matches plenty of other single letters on screen
    await expect(entry.locator('xpath=following-sibling::span')).toHaveText('M');

    await entry.click();
    await expect(diffEditor(w)).toBeVisible({ timeout: 15_000 });

    // both sides carry the real file contents
    await expect(diffEditor(w)).toContainText('greet', { timeout: 15_000 });
    await expect(diffEditor(w)).toContainText("'hello'");
    await expect(diffEditor(w)).toContainText("'howdy'");

    // HALF ONE: a diff was really computed. A delete decoration cannot be
    // produced by the empty-original short-circuit, so something did the work.
    //
    // COUNT, not visibility: a decoration is an absolutely-positioned overlay,
    // and tying a load-bearing assertion to its geometry would make this spec
    // hostage to how Chromium lays the overlay out under CI's 8-bit xvfb.
    // `not.toHaveCount(0)` still auto-waits for the worker's round trip.
    await expect(
      diffEditor(w).locator('.line-delete'),
      'no delete decoration — the diff worker never replied'
    ).not.toHaveCount(0, { timeout: 15_000 });
    await expect(diffEditor(w).locator('.line-insert')).not.toHaveCount(0);

    // character-level inner changes: computed by the same worker call, and
    // only reachable through the real diff algorithm — the short-circuit
    // returns one whole-file range mapping
    await expect(
      diffEditor(w).locator('.char-delete'),
      'no inline char decorations — the worker returned no inner changes'
    ).not.toHaveCount(0);
    await expect(diffEditor(w).locator('.char-insert')).not.toHaveCount(0);

    // and the text went through the tokenizer: view lines are rendered as
    // `mtkN` spans rather than raw text.
    //
    // Deliberately `> 0` and not "more than one class". #161 set out to assert
    // real syntax highlighting here and MEASURED that there isn't any: the
    // pane creates its models with no language id, so everything is
    // `plaintext` and the whole diff comes back with a single `mtk1`. That is
    // a product bug, reported separately — it is NOT a one-line fix, because
    // naming a language activates monaco's rich TS/JSON/CSS/HTML services and
    // they immediately throw `Missing requestHandler or method: ...` against
    // the plain editor worker this app bundles.
    //
    // So this asserts what is true now AND will still be true once the bug is
    // fixed, instead of freezing the defect into the suite. Note that syntax
    // highlighting was never the worker evidence anyway — Monarch tokenizes on
    // the main thread. The decorations above are the evidence.
    await expect
      .poll(async () => (await tokenClasses(w)).length, {
        message: 'no mtk token spans — nothing tokenized',
      })
      .toBeGreaterThan(0);

    // HALF TWO, and the half that makes this spec worth having: the work above
    // happened in a WORKER. Without this, a blocked worker is invisible —
    // every assertion above passes on Monaco's main-thread fallback. Verified
    // by sabotage: with `getWorker` throwing, this is the only line that goes
    // red.
    expect(
      logged.filter((m) => WORKER_FALLBACK.test(m)),
      'Monaco fell back to the main thread — the worker never started'
    ).toEqual([]);

    // ...and nothing was refused by the policy. This is the hand-check PR #160
    // asked Dan for, asserted here rather than in its own test because the
    // assertions above are what force the worker to have been needed — a
    // listener with nothing to hear proves nothing, and one more Electron
    // launch is real time on every CI job.
    expect(
      logged.filter((m) => CSP_REFUSAL.test(m)),
      'CSP refused something the diff pane needs'
    ).toEqual([]);
  });

  test('a folder that is not a repo says so instead of failing', async () => {
    // fail-open: the pane is opened from a rail row, so it has no say in what
    // folder it is handed
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-plain-'));
    projects.push(folder);
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.getByText('Not a git repository')).toBeVisible({ timeout: 15_000 });
  });
});
