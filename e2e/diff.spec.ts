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
import { launchApp, LaunchedApp, registerTempDir } from './fixtures/app';

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
 * Two more files, so one launch can prove all three halves of #191: a
 * TypeScript file is tokenized as TypeScript, a Markdown file is tokenized as
 * something ELSE (i.e. the language really comes from the path, it is not one
 * hard-coded grammar), and an extension nothing maps to falls back to plain
 * text instead of guessing.
 *
 * Each is committed and then modified for the same reason `greeting.ts` is —
 * see the trap above — so clicking any of them exercises a real diff.
 */
const EXTRAS: Record<string, { committed: string; working: string }> = {
  'notes.md': {
    committed: ['# Notes', '', 'A paragraph with `code` in it.', ''].join('\n'),
    working: ['# Notes', '', 'A paragraph with `code` and **bold** in it.', ''].join('\n'),
  },
  // `.log` is mapped by nothing on purpose: this is the plaintext fallback
  'output.log': {
    committed: ['2026-01-01 boot ok', 'const export function 42', ''].join('\n'),
    working: ['2026-01-02 boot ok', 'const export function 42', ''].join('\n'),
  },
};

/**
 * A throwaway git repo with one committed file and an uncommitted edit to it.
 *
 * Local to this spec on purpose: it is the only one that needs a repo, and the
 * content above and the assertions below are one thought.
 *
 * Registered on the line it exists rather than by the caller once it is built
 * (#180 — specs leaking temp dirs): registering after the `git` calls would
 * leak the folder on any machine where they fail. As of #213 that registry is
 * the fixture's own, so `cleanup()` sweeps it with the retries and the requeue
 * this file's hand-rolled `rmSync` loop did not have.
 */
function tempGitProject(): string {
  const dir = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-git-')));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  };
  git(['init', '-b', 'main']);
  // local identity: a machine (or CI runner) with no global user.email cannot
  // commit at all, and the commit is what gives us a non-empty original
  git(['config', 'user.email', 'e2e@switchboard.test']);
  git(['config', 'user.name', 'switchboard e2e']);
  fs.writeFileSync(path.join(dir, FILE), COMMITTED);
  for (const [name, v] of Object.entries(EXTRAS)) {
    fs.writeFileSync(path.join(dir, name), v.committed);
  }
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(dir, FILE), WORKING);
  for (const [name, v] of Object.entries(EXTRAS)) {
    fs.writeFileSync(path.join(dir, name), v.working);
  }
  return dir;
}

const diffEditor = (w: Page) => w.locator('.monaco-diff-editor');

/**
 * Pop-out tests open a real second OS window, which is reliable on Windows and
 * macOS but flaky under Linux CI's headless xvfb (second-window creation
 * intermittently never completes). Third local copy of this three-liner —
 * session.spec.ts and urgency.spec.ts each carry their own; it belongs in
 * `fixtures/app.ts`, but hoisting it is not this fix's to take.
 */
const skipPopoutOnLinux = (): void =>
  test.skip(
    process.platform === 'linux',
    'dockview popout opens a 2nd OS window — unreliable under headless xvfb; covered on Windows + macOS'
  );

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

  test.afterEach(async () => {
    const launched = a;
    a = undefined;
    // `cleanup()` takes the app down FIRST and then sweeps the registered
    // folders — the order this file's own rm loop existed to guarantee, since
    // on Windows a live child holds handles into the folder and the rm throws
    // EBUSY (#167). It also retries and requeues, which that loop did not (#213).
    await launched?.cleanup();
  });

  /**
   * Boot on a real repo and open the Changes tab, the way the rail does.
   *
   * Also returns everything the page logged from launch onwards. The pane's
   * two interesting acts — spawning the worker and injecting <style> elements
   * — both happen when the tab opens, well after that, so nothing is missed.
   */
  async function openChanges(): Promise<{ w: Page; logged: string[]; crashed: string[] }> {
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    // Everything the page said, from before the pane existed. The worker is
    // not created until the first diff is computed, well after this point.
    const logged: string[] = [];
    w.on('console', (msg) => logged.push(msg.text()));
    // ...and everything it THREW. This is #191's gate, and it is the reason
    // that bug outlived the pane by months: naming a language is a one-line
    // change that looks perfect on screen while monaco's rich language
    // services fire `Missing requestHandler or method: ...` at the plain
    // worker behind it — 8 uncaught rejections per session, measured, visible
    // nowhere in the DOM. Nothing in this suite would have seen them.
    const crashed: string[] = [];
    w.on('pageerror', (e) => crashed.push(e.message));

    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
    return { w, logged, crashed };
  }

  test('renders a real diff, computed in a real worker', async () => {
    const { w, logged, crashed } = await openChanges();

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

    // and the text went through a REAL tokenizer: a `.ts` file comes back with
    // several distinct `mtkN` classes — comment, keyword, string, number,
    // identifier all painted differently.
    //
    // This used to read `> 0`, which #161 chose knowing it proved nothing: the
    // pane created its models with no language id, so every file was
    // `plaintext` and the whole diff came back as one `mtk1`. #191 gave the
    // models a language derived from the path. Note that highlighting is NOT
    // worker evidence — Monarch tokenizes on the main thread; the decorations
    // above are the evidence. This is about the pane being readable.
    await expect
      .poll(async () => (await tokenClasses(w)).length, {
        message: 'a .ts file came back with one token class — no syntax highlighting',
      })
      .toBeGreaterThan(3);
    const tsClasses = (await tokenClasses(w)).join();

    // the language really comes from the PATH, not one hard-coded grammar.
    //
    // "more than one class" would NOT show that — the TypeScript grammar would
    // also find something to colour in this markdown (backticks read as a
    // template string). A DIFFERENT set of classes is the thing that can only
    // happen if a different grammar ran, so that is what this asserts.
    await w.getByText('notes.md', { exact: true }).click();
    await expect(diffEditor(w)).toContainText('bold', { timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const classes = await tokenClasses(w);
          return classes.length > 1 && classes.join() !== tsClasses;
        },
        {
          message: 'notes.md tokenized identically to the .ts file — one grammar for everything',
        }
      )
      .toBe(true);

    // ...and an extension nothing maps to falls back to plain text rather than
    // guessing. `output.log` contains `const export function 42` precisely so
    // that a stray tokenizer would light it up and be caught here.
    await w.getByText('output.log', { exact: true }).click();
    await expect(diffEditor(w)).toContainText('boot ok', { timeout: 15_000 });
    await expect
      .poll(async () => (await tokenClasses(w)).join(), {
        message: 'an unmapped extension was tokenized as something',
      })
      .toBe('mtk1');

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

    // #191's gate, and the one this whole item turns on: giving the models a
    // language must cost ZERO uncaught errors. Last, because every assertion
    // above is what forces the tokenizers — and the lazily-loaded language
    // chunks behind them — to have actually run.
    expect(crashed, 'the diff pane threw').toEqual([]);
  });

  test('switching theme repaints the diff instead of blanking it', async () => {
    // #191. `colorScheme` used to be a dependency of the effect that CREATES
    // the editor, so a theme switch disposed the editor and both models and
    // built an empty one — and nothing put the models back, because the model
    // effect only re-runs when the SELECTION changes. The pane went blank and
    // stayed blank until you clicked another file, which is exactly the shape
    // of bug a screenshot review misses and nothing in this suite watched for.
    //
    // Its own launch, unlike the extra files above: this test drives the
    // titlebar and then comes back to the pane, and folding that into the test
    // above would tangle two subjects for the sake of ~2 seconds.
    const { w, crashed } = await openChanges();

    await w.getByText(FILE, { exact: true }).click();
    await expect(diffEditor(w)).toContainText("'howdy'", { timeout: 15_000 });

    for (const theme of ['daylight', 'nordic'] as const) {
      await w.getByRole('button', { name: theme, exact: true }).click();
      await expect(w.locator('html')).toHaveAttribute('data-theme', theme);
      // the diff is still there, still the same file, still tokenized
      await expect(diffEditor(w)).toContainText("'howdy'", { timeout: 15_000 });
      await expect(diffEditor(w).locator('.line-delete')).not.toHaveCount(0);
      expect(
        (await tokenClasses(w)).length,
        `no highlighting after switching to ${theme}`
      ).toBeGreaterThan(3);
    }

    expect(crashed, 'switching theme threw').toEqual([]);
  });

  test('a folder that is not a repo says so instead of failing', async () => {
    // fail-open: the pane is opened from a rail row, so it has no say in what
    // folder it is handed
    const folder = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-plain-')));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w.getByText('Not a git repository')).toBeVisible({ timeout: 15_000 });
  });

  test('a Changes tab opens in the main window, not the active popout (E8-04, #434)', async () => {
    skipPopoutOnLinux();
    // #434. `openDiff` called `addPanel` with no `position`, and dockview's
    // `addPanel` defaults to the ACTIVE group — which is the popout group the
    // moment a card is torn off. So "Open changes" on a popped-out session
    // (from the rail, which only exists in the MAIN window) built the tab
    // inside that session's OS window. The mirror of the session-card
    // assertion in session.spec.ts, for the surface that predates it.
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const { app, window: w } = a;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.getByTitle('Pop out into its own window').click();
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
    const popout = app.windows().find((p) => p !== w)!;
    // the card really is over there — i.e. the main grid is now empty and the
    // popout group is the active one, which is the whole precondition
    await expect(popout.getByTestId('card-header')).toBeVisible({ timeout: 15_000 });

    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();

    // it landed HERE, in the window the user asked from...
    await expect(w.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
    await expect(w.getByText(FILE, { exact: true })).toBeVisible({ timeout: 15_000 });
    // ...and NOT as a tab inside the popped-out session's window. The count-1
    // assertion first, so the count-0 one below cannot pass vacuously on a
    // window that renders no `.dv-tab` at all: the popout has exactly one tab,
    // the session card's, and nothing joined it.
    await expect(popout.locator('.dv-tab')).toHaveCount(1);
    await expect(popout.locator('.dv-tab').filter({ hasText: '· diff' })).toHaveCount(0);
    expect(app.windows().length, 'the diff opened a window of its own').toBe(2);
  });
});
