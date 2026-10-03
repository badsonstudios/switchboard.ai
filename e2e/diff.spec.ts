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
import { launchApp, LaunchedApp, registerTempDir, skipPopoutOnLinux, setTheme } from './fixtures/app';

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
  async function openChanges(): Promise<{
    w: Page;
    logged: string[];
    crashed: string[];
    folder: string;
  }> {
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
    return { w, logged, crashed, folder };
  }

  test('renders a real diff, computed in a real worker', async () => {
    const { w, logged, crashed } = await openChanges();

    // the file list is the git status, live: one tracked file, modified
    const entry = w.getByText(FILE, { exact: true });
    await expect(entry).toBeVisible({ timeout: 15_000 });
    // ⚠️ THE ROW SHAPE CHANGED IN E24 Git v2 ITEM 6 and this assertion changed
    // with it. It used to read "the VCS badge is the path span's sibling" and
    // match the word chip `M`; the row is now name-first with a coloured LETTER
    // ahead of it, so the badge is a PRECEDING sibling and it carries a class.
    // Located by class rather than by position, because position is what made
    // this brittle: the empty directory span of a root-level file was its next
    // sibling and matched instead.
    await expect(w.locator(`.scm-row[data-path="${FILE}"] .scm-letter`)).toHaveText('M');
    // ⚠️ **THE VERBS ARE HIDDEN AT REST, AND ONLY AN E2E CAN SAY SO.** The unit
    // test loads `tokens.css` into jsdom and reads `getComputedStyle`, which is
    // good — but the version BEFORE it asserted on the stylesheet's TEXT and
    // passed while an inline `display: flex` in the component overrode the rule
    // and painted the buttons on every row. This is the same claim against a real
    // browser with the real cascade.
    const row = w.locator(`.scm-row[data-path="${FILE}"]`);
    await expect(row.locator('.scm-row-acts')).not.toBeVisible();
    await row.hover();
    await expect(row.locator('.scm-row-acts')).toBeVisible();

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
      await setTheme(w, theme);
      await expect(w.locator('html')).toHaveAttribute('data-theme', theme);
      // the diff is still there, still the same file, still tokenized
      await expect(diffEditor(w)).toContainText("'howdy'", { timeout: 15_000 });
      await expect(diffEditor(w).locator('.line-delete')).not.toHaveCount(0);
      // POLLED, not sampled once (drive-by, #434): Monaco re-tokenizes after a
      // theme change asynchronously, so the classes are briefly down to one
      // and a single `await tokenClasses(w)` catches that window. Measured on
      // unmodified main at bc305b6: 2 of 3 runs failed with `Received: 1`;
      // polling the same assertion is 3 of 3 and returns in ~1.7s, i.e. the
      // highlighting really does come back — this was a race, not a repaint
      // bug, and the assertion still demands the colours actually appear.
      await expect
        .poll(async () => (await tokenClasses(w)).length, {
          timeout: 15_000,
          message: `no highlighting after switching to ${theme}`,
        })
        .toBeGreaterThan(3);
    }

    expect(crashed, 'switching theme threw').toEqual([]);
  });

  test('the side-by-side / inline toggle switches live and is remembered', async () => {
    // #532. Two things this can only be proved with a real Monaco:
    //
    //   1. the `side-by-side` class on `.monaco-diff-editor` is toggled by the
    //      widget itself, from the option AND its own width rule together
    //      (diffEditorWidget.js: `classList.toggle('side-by-side', showSash)`).
    //      That makes it the one assertion that catches the actual bug —
    //      `useInlineViewWhenSpaceIsLimited` silently overriding a pane that
    //      had asked for two columns since P1-E5-02. A unit test on the
    //      preference cannot see it, which is why the bug lived this long.
    //   2. `updateOptions` changes the shape of a LIVE editor. The pane must
    //      not be rebuilt for it — that is the #191 blanking bug — so the
    //      assertions below re-check the diff is still on screen afterwards.
    const { w, folder, crashed } = await openChanges();
    const first = a!;
    const title = path.basename(folder);

    await w.getByText(FILE, { exact: true }).click();
    await expect(diffEditor(w)).toContainText("'howdy'", { timeout: 15_000 });

    // the default, on a pane with room for it: two columns
    await expect(diffEditor(w)).toHaveClass(/side-by-side/);
    await expect(w.getByTestId('diff-layout-side-by-side')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // ...and it switches LIVE, without losing the file or the diff
    await w.getByTestId('diff-layout-inline').click();
    await expect(diffEditor(w)).not.toHaveClass(/side-by-side/);
    await expect(w.getByTestId('diff-layout-inline')).toHaveAttribute('aria-pressed', 'true');
    await expect(diffEditor(w)).toContainText("'howdy'", { timeout: 15_000 });
    await expect(
      diffEditor(w).locator('.line-delete'),
      'switching layout blanked the diff instead of re-laying it out'
    ).not.toHaveCount(0);

    // ...and back, from the keyboard this time — §5.32 rule 1 is that these
    // are real buttons, so Enter is the platform's job and not ours
    await w.getByTestId('diff-layout-side-by-side').focus();
    await w.keyboard.press('Enter');
    await expect(diffEditor(w)).toHaveClass(/side-by-side/);

    // the preference lives in the workspace `ui` blob, so it survives a
    // restart — the half of #532 that localStorage could not have delivered
    // (the packaged renderer's origin changes port every launch, P2-E15-06)
    await w.getByTestId('diff-layout-inline').click();
    await expect(w.getByTestId('diff-layout-inline')).toHaveAttribute('aria-pressed', 'true');
    await w.waitForTimeout(900); // debounced store save
    await first.close();

    a = await launchApp({ home: first.home });
    const w2 = a.window;
    const crashed2: string[] = [];
    w2.on('pageerror', (e) => crashed2.push(e.message));
    await expect(w2.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    // Opened the same deterministic way `openChanges` does, NOT conditionally
    // on whether one was restored: `SessionGrid.restoreLayout` drops every
    // diff panel on purpose, so a "reuse it if it is there" branch is dead
    // today and a two-DiffPane strict-mode violation the day that changes.
    await w2
      .locator('nav [draggable="true"]', { hasText: title })
      .first()
      .click({ button: 'right' });
    await w2.getByRole('menuitem', { name: 'Open changes' }).click();
    await expect(w2.locator('.dv-active-tab')).toContainText('· diff', { timeout: 15_000 });
    await expect(w2.getByTestId('diff-layout-inline')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 20_000,
    });
    // and the editor really came up that way, not just the button
    await w2.getByText(FILE, { exact: true }).click();
    await expect(diffEditor(w2)).toContainText("'howdy'", { timeout: 15_000 });
    await expect(diffEditor(w2)).not.toHaveClass(/side-by-side/);

    expect(crashed, 'the layout toggle threw').toEqual([]);
    expect(crashed2, 'restoring the layout preference threw').toEqual([]);
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

  test('a repository switchboard could NOT read says why, not "not a repository" (#785)', async () => {
    // The other half of the test above, and the only end-to-end proof that
    // #785's reason reaches glass: `gitPaneState` is unit-tested and the
    // `GitService` branches are unit-tested, but between them sits one
    // `t('diff.unreadable', …)` call in `DiffPane` that no unit test renders —
    // swap it for `t('diff.notRepo')` and the whole suite stays green while the
    // fix silently reverts to the bug.
    //
    // A `.git` FILE pointing at a directory that is not there is the cheapest
    // deterministic damaged repository: no race, no fixture timing, and git
    // says "not a git repository: <path>" for it — the very message whose
    // resemblance to the benign one is what this ticket turns on.
    const folder = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-damaged-')));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    fs.writeFileSync(path.join(folder, '.git'), 'gitdir: /switchboard-e2e/definitely-not-there\n');
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    // GIT'S OWN WORDS GOT THROUGH the IPC and the ICU interpolation, asserted
    // in ONE locator so a reason dropped on the way cannot pass.
    //
    // ⚠️ NOT the gitdir path, which is what this asserted first: the dev
    // machine's git echoes it into the message and BOTH CI runners print
    // `(null)` instead — a git BUILD difference, measured the hard way. What is
    // common to every git is that it says "not a git repository" here, and that
    // phrase is only in the pane if the reason arrived.
    await expect(
      w.getByText(/couldn't read this project's git — not a git repository/i)
    ).toBeVisible({ timeout: 15_000 });
    // …and the placeholder itself never reaches a screen. i18next-icu expands
    // `{reason}`; a `{{reason}}` written out of mustache habit renders verbatim,
    // which is the defect `locales.test.ts` exists for and this pins end to end.
    await expect(w.getByText(/\{reason\}/)).toHaveCount(0);
    // …and the answers it must NOT give. `exact`, because git's own message
    // contains the phrase "not a git repository" and `getByText` is a
    // case-insensitive SUBSTRING match by default — without it this asserts
    // against the very string it is reading.
    await expect(w.getByText('Not a git repository', { exact: true })).toHaveCount(0);
    await expect(w.getByText('Working tree clean', { exact: true })).toHaveCount(0);
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

  test('a Changes tab opened while a DOCUMENT is focused lands with the sessions, not among the documents (#504)', async () => {
    // #504, the mirror of the rule above. `openDiff` only overrode dockview's
    // default — "the active group" — when that group was not in the grid at
    // all. A document area IS in the grid, so with a viewer focused the
    // session's Changes tab opened as a tab AMONG THE DOCUMENTS: a session's own
    // surface in the one place a session never goes.
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder, seedDocument: path.join(folder, FILE) });
    const w = a.window;
    const title = path.basename(folder);
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    const viewer = w.locator('[data-testid="document-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 25_000 });

    // FOCUS THE DOCUMENT, which is the whole precondition: its group is now the
    // active one. The file's name in the header is not a control.
    await w.locator('[data-testid="doc-name"]').click();

    await w.locator('nav [draggable="true"]', { hasText: title }).first().click({ button: 'right' });
    await w.getByRole('menuitem', { name: 'Open changes' }).click();
    const diffTab = w.locator('.dv-tab', { hasText: '· diff' });
    await expect(diffTab).toHaveCount(1, { timeout: 15_000 });

    // WHICH GROUP, read off the DOM rather than asked of our own code: the tab
    // strip the diff tab is in must not be the one the document's tab is in.
    const groups = await w.evaluate((docName) => {
      const groupOf = (needle: string): Element | null => {
        const tab = [...document.querySelectorAll('.dv-tab')].find((el) =>
          (el.textContent ?? '').includes(needle)
        );
        return tab?.closest('.dv-groupview') ?? null;
      };
      const diffGroup = groupOf('· diff');
      const docGroup = groupOf(docName);
      const box = diffGroup?.getBoundingClientRect();
      return {
        found: !!diffGroup && !!docGroup,
        sameGroup: diffGroup === docGroup,
        // the tabs sharing the diff's strip — it should be WITH the session
        diffGroupTabs: diffGroup
          ? [...diffGroup.querySelectorAll('.dv-tab')].map((el) => el.textContent ?? '')
          : [],
        width: box?.width ?? 0,
        height: box?.height ?? 0,
      };
    }, FILE);
    expect(groups.found, 'both tabs are on screen').toBe(true);
    expect(groups.sameGroup, 'the Changes tab joined the document area').toBe(false);
    expect(groups.diffGroupTabs.some((text) => text.includes(FILE))).toBe(false);
    // WITH ITS SESSION, which is the other half of the claim: "not among the
    // documents" would also be satisfied by a brand-new group holding nothing
    // else, and that is not where a session's Changes tab belongs.
    expect(
      groups.diffGroupTabs.some((text) => text.includes(title) && !text.includes('· diff')),
      `the Changes tab is beside its session's own tab — saw ${JSON.stringify(groups.diffGroupTabs)}`
    ).toBe(true);
    // GEOMETRY, not `toBeVisible()`: a panel in a hidden dock-back husk is in
    // the DOM and "visible" at one pixel wide (#434 measured 1.33px).
    expect(groups.width).toBeGreaterThan(200);
    expect(groups.height).toBeGreaterThan(200);
    // …and the document is still there, untouched
    await expect(w.locator('.dv-tab', { hasText: FILE })).toHaveCount(1);
  });

  // ───────────────────────────── E24 Git v2 item 5 ────────────────────────────
  //
  // ⚠️ **THE STRUCTURAL ITEM, AND ITS CLAIM IS ABOUT TWO SURFACES BEING VISIBLE
  // AT ONCE.** Design §1.2 cause 3: card tabs are mutually exclusive, so reading
  // a diff inside one costs you sight of the conversation that produced it. These
  // two tests are the only place that can be checked, because it is a fact about
  // dockview and the real window rather than about a component.

  test('⚠️ ⧉ moves the diff OUT of the tab, so the conversation stays visible', async () => {
    // ⚠️ **THE CARD'S OWN Changes TAB, NOT `openChanges()`.** That helper opens
    // #504's relocated panel (`diff-<cardId>`) from the rail's context menu,
    // which is ALREADY out of the tab strip — so a test built on it cannot say
    // anything about the constraint this item removes. The claim is about a
    // surface that is mutually exclusive with the Session view, and that is the
    // in-card tab. Found by writing the test against the wrong harness first.
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('[data-testid="view-tabs"]').first()).toBeVisible({ timeout: 25_000 });
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
    await w.getByText(FILE, { exact: true }).click();
    await expect(diffEditor(w)).toBeVisible({ timeout: 15_000 });

    // The escalation. ABSENT until a file is picked, which is the owner's rule
    // about a control with nothing to do — asserted as a count so a missing
    // button reads as missing rather than as "not visible".
    const popout = w.locator('[data-testid="diff-popout"]');
    await expect(popout).toHaveCount(1);
    await popout.click();

    // A panel of its OWN, in the document area — not a tab inside the session's
    // group, which is the rule `documentHomeGroup` enforces and the reason the
    // prefix is `gitdiff-` and not `diff-`.
    const panel = w.locator('.git-diff-view');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // …with a real diff in it, computed by the real worker: the same assertions
    // the in-tab pane earns above, now inside the panel.
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText("'howdy'", { timeout: 15_000 });
    await expect(panel.locator('.line-insert')).not.toHaveCount(0, { timeout: 15_000 });

    // ⭐ THE CLAIM: the Session view and the diff are on screen TOGETHER. Inside
    // the tab that is impossible however the pane is drawn.
    await w.getByRole('tab', { name: 'Session', exact: true }).click();
    await expect(w.getByText('No conversation yet')).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible();

    // Asking again FOCUSES rather than opening a second copy — `planDiffOpen`'s
    // rule, through the real dockview.
    await w.getByRole('tab', { name: 'Changes' }).click();
    await w.locator('[data-testid="diff-popout"]').click();
    await expect(w.locator('.git-diff-view')).toHaveCount(1);
  });

  test('the diff panel pops out to its own window, and docks back', async () => {
    // A SECOND OS WINDOW, so the same skip every other popout test in this repo
    // opens with — including the one sixty lines above. Found missing by review;
    // without it this fails under the Linux runner's xvfb.
    skipPopoutOnLinux();
    const { w } = await openChanges();
    const app = a!.app;
    await w.getByText(FILE, { exact: true }).click();
    await w.locator('[data-testid="diff-popout"]').click();
    await expect(w.locator('.git-diff-view')).toBeVisible({ timeout: 15_000 });

    const before = app.windows().length;
    await w.locator('[data-testid="git-diff-popout"]').click();
    // A WINDOW, which is what design §3 promises and what dockview's popout
    // group gives us for free. Polled rather than asserted once: `addPopoutGroup`
    // is async and the window arrives a tick later.
    await expect
      .poll(() => app.windows().length, { timeout: 20_000 })
      .toBe(before + 1);

    // The same control now reads "dock back" — one gesture in two directions,
    // which is what the document viewer's header does and why there is one
    // button rather than two with one of them always dead.
    const win = app.windows().find((p) => p !== w)!;
    const dockBack = win.locator('[data-testid="git-diff-popout"]');
    await expect(dockBack).toBeVisible({ timeout: 20_000 });
    await expect(dockBack).toHaveAttribute('aria-label', /back in the main window/);
    await dockBack.click();
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(before);
    await expect(w.locator('.git-diff-view')).toBeVisible({ timeout: 15_000 });
  });

  test('Ctrl+F in a diff panel opens the editor’s own find (#1054)', async () => {
    // It did NOTHING: the panel published a find surface under its own slot and
    // no provider read it, and the command that Ctrl+F runs was disabled over
    // any panel that was neither a session card nor a document.
    const { w } = await openChanges();
    await w.getByText(FILE, { exact: true }).click();
    await w.locator('[data-testid="diff-popout"]').click();
    const panel = w.locator('.git-diff-view');
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText("'howdy'", { timeout: 15_000 });

    // THE PATH, NOT THE EDITOR. A click inside Monaco focuses it, and a focused
    // Monaco answers Ctrl+F by itself — which would pass with the route still
    // broken. The path label is not a control: the panel becomes the active
    // one and focus stays outside the editor, which is the case that was dead.
    await panel.locator('.git-diff-path').click();
    await expect(panel.locator('.find-widget.visible')).toHaveCount(0);
    await w.keyboard.press('Control+f');
    await expect(panel.locator('.find-widget.visible')).toHaveCount(1, { timeout: 10_000 });
    // DELEGATED: our own bar steps out of the way rather than sitting on top of
    // a better find.
    await expect(w.locator('[data-testid="find-bar"]')).toHaveCount(0);
  });

  test('Ctrl+F in a POPPED-OUT diff panel opens find in that window (#1054)', async () => {
    skipPopoutOnLinux();
    const { w } = await openChanges();
    const app = a!.app;
    await w.getByText(FILE, { exact: true }).click();
    await w.locator('[data-testid="diff-popout"]').click();
    await expect(w.locator('.git-diff-view')).toBeVisible({ timeout: 15_000 });
    await w.locator('[data-testid="git-diff-popout"]').click();
    // by URL, not "the other one": devtools would also satisfy `!== w`
    await expect
      .poll(() => app.windows().filter((p) => p.url().includes('popout.html')).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const win = app.windows().find((p) => p.url().includes('popout.html'))!;
    await win.waitForLoadState('domcontentloaded');
    const panel = win.locator('.git-diff-view');
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText("'howdy'", { timeout: 15_000 });

    // Click the window first — `document-find.spec`'s note: a popout Page that
    // has never been interacted with receives no key presses at all. The path
    // again, so the editor is not what has focus.
    await panel.locator('.git-diff-path').click();
    await win.keyboard.press('Control+f');
    // THERE, where the diff is — dockview's active panel does not follow the
    // user into another window, so this is the half that needs the source
    // window passed rather than inferred.
    await expect(panel.locator('.find-widget.visible')).toHaveCount(1, { timeout: 10_000 });
    // delegated: no bar of ours in the window that could have had one…
    await expect(win.locator('[data-testid="find-bar"]')).toHaveCount(0);
    // …and nothing opened back in the main window either
    await expect(w.locator('[data-testid="find-bar"]')).toHaveCount(0);
    await expect(w.locator('.find-widget.visible')).toHaveCount(0);

    await win.evaluate(() => window.close());
    await expect(w.locator('.git-diff-view')).toBeVisible({ timeout: 15_000 });
  });

  test('⚠️ the Files tab and the Changes tab AGREE — one status, two surfaces', async () => {
    // E24 Git v2 item 11, and its acceptance bar is exactly this: design §4 says
    // the tree "must read the SAME status source as screen 1 or the two tabs will
    // disagree". The unit tests prove the store fetches once; what only this can
    // say is that the two tabs really are reading it — the badge in the tree and
    // the row in the sidebar, for one file, in one app.
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('[data-testid="view-tabs"]').first()).toBeVisible({ timeout: 25_000 });

    // The Changes tab first, which is the reader that asks for the numbers.
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
    await expect(w.locator(`.scm-row[data-path="${FILE}"] .scm-letter`)).toHaveText('M', {
      timeout: 20_000,
    });

    // …and now the tree, which must say the same thing about the same file.
    await w.locator('[data-testid="view-tabs"] [data-vtab="files"]').first().click();
    const treeRow = w.locator(`[data-testid^="file-tree-row-"][data-path$="${FILE}"]`);
    await expect(treeRow).toHaveCount(1, { timeout: 20_000 });
    await expect(treeRow.locator('.file-vcs')).toHaveText('M', { timeout: 20_000 });
    // ⚠️ AND IT IS NOT A ROLL-UP: this is the file's own status, where a folder's
    // badge would be marked and drawn dimmer.
    await expect(treeRow.locator('.file-vcs')).not.toHaveAttribute('data-rolled-up', 'true');
  });
  test('⚠️ EVERY CHANGE IN ONE SCROLL — and the budget really bounds what mounts', async () => {
    // E24 Git v2 item 9, end to end. The budget is unit-tested as a rule and the
    // panel is unit-tested against a stubbed editor; what only this can say is
    // that the REAL Monaco diff editors mount, stacked, inside one real dockview
    // panel — which is the only version of the claim that could ever freeze the
    // app if the policy were wrong.
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('[data-testid="view-tabs"]').first()).toBeVisible({ timeout: 25_000 });
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();

    // The entry point, in the filter row — screen 2's own place for it.
    const open = w.locator('[data-testid="scm-all-changes"]');
    await expect(open).toHaveCount(1, { timeout: 20_000 });
    await open.click();

    const panel = w.locator('.all-changes-view');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // All three changed files of the fixture, stacked, in ONE panel.
    await expect(panel.locator('.all-changes-file')).toHaveCount(3, { timeout: 20_000 });
    // …each with its own sticky header naming it.
    for (const name of [FILE, 'notes.md', 'output.log']) {
      await expect(panel.locator(`.all-changes-file[data-path="${name}"]`)).toHaveCount(1);
    }
    // ⭐ REAL editors, not placeholders: every file here is small, so all three
    // fit the budget and all three mounted.
    await expect(panel.locator('.monaco-diff-editor')).toHaveCount(3, { timeout: 25_000 });
    await expect(panel).toContainText("'howdy'", { timeout: 20_000 });

    // ⭐ THE CLAIM BEHIND THE SURFACE: read it beside the conversation. A card's
    // tabs are mutually exclusive, so in the tab this is impossible.
    await w.getByRole('tab', { name: 'Session', exact: true }).click();
    await expect(w.getByText('No conversation yet')).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('.monaco-diff-editor').first()).toBeVisible();

    // Folding is real, and it UNMOUNTS the editor rather than merely hiding it —
    // which is the whole reason the budget means anything.
    await panel.locator('[data-testid="all-changes-fold"]').click();
    await expect(panel.locator('.monaco-diff-editor')).toHaveCount(0, { timeout: 15_000 });
    await expect(panel.locator('.all-changes-folded')).toHaveCount(3);
    // One header back open, by itself.
    await panel.locator('.all-changes-file[data-path="notes.md"] .all-changes-toggle').click();
    await expect(panel.locator('.monaco-diff-editor')).toHaveCount(1, { timeout: 20_000 });

    // Asking again FOCUSES rather than opening a second copy — one panel per
    // card, which is why this family needs no registry.
    // ⚠️ BY `data-vtab`, NOT BY ACCESSIBLE NAME. Playwright's `name` is a
    // case-insensitive SUBSTRING match, so `{ name: 'Changes' }` now also
    // matches the dock tab titled "All changes" that this very test opened — a
    // strict-mode violation, and a reminder that a role query is only as
    // specific as the strings on screen happen to be.
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
    await w.locator('[data-testid="scm-all-changes"]').click();
    await expect(w.locator('.all-changes-view')).toHaveCount(1);
  });

  test('a file in the stack opens its OWN panel, rather than being a second route', async () => {
    const folder = tempGitProject();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.locator('[data-testid="view-tabs"]').first()).toBeVisible({ timeout: 25_000 });
    await w.locator('[data-testid="view-tabs"] [data-vtab="diff"]').first().click();
    await w.locator('[data-testid="scm-all-changes"]').click();
    const panel = w.locator('.all-changes-view');
    await expect(panel.locator('.all-changes-file')).toHaveCount(3, { timeout: 20_000 });

    // ⧉ on one header reaches item 5's `gitdiff-` family — the same seam the
    // sidebar row uses, so there is ONE route to a single-file diff.
    await panel
      .locator(`.all-changes-file[data-path="${FILE}"] [data-testid="all-changes-file-popout"]`)
      .click();
    const single = w.locator('.git-diff-view');
    await expect(single).toBeVisible({ timeout: 20_000 });
    await expect(single.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
    // …and both panels are OPEN at once, because they are two different
    // surfaces.
    //
    // ⚠️ **ASSERTED ON THE TAB, NOT ON THE BODY, AND THE REASON IS DOCKVIEW.**
    // Both panels open into the document group, so the second arrives as a TAB
    // beside the first — and dockview DETACHES an inactive tab's content, so
    // `.all-changes-view` really is absent from the DOM while the single-file
    // diff is in front. The first version of this line asserted the body and
    // failed, which is the test discovering a fact about the host rather than a
    // bug: "open" and "rendered" are different questions, and the tab is where
    // the first one is answered.
    await expect(w.locator('.dv-tab').filter({ hasText: 'All changes' })).toHaveCount(1);
  });

});
