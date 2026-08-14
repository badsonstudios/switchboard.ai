// P2-E17-02: Ctrl+F — the find bar and the `find-provider` seam (§5.31).
//
// The done-when this file exists for: **Ctrl+F searches the FOCUSED session
// and never matches text in another card.** §5.31 rejects Electron's
// `webContents.findInPage` precisely because it searches the whole
// webContents, so on a grid it would match the sessions you are not looking
// at — and the plan says out loud that it is the obvious thing for someone to
// reach for later. So the test puts THE SAME STRING in two cards, a different
// number of times in each, and checks the count follows the focus.
//
// TRANSPORT SCOPE (P2-E18-18, #404): the first group is `[pty]` — it seeds a
// JSONL file and lets the watcher tail it, which is how a PTY session's Feed is
// built and is switched off for a stream one. The SECOND group is Direct, and
// exists because the two transports used to disagree about the headline gesture:
// a Direct session's blocks carry the moment the message reached us rather than
// the CLI's timestamp, so the engine could not line the file up with the view
// and every hit came back read-only (#458). It now lines them up on the API's
// own ids instead, and that group is the proof — on the transport that has been
// the default since #381.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp, registerTempDir, showTerminal, tempProjectFolder } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

/** Write a transcript the watcher will tail, with `term` repeated `times`. */
function seedTranscript(home: string, folder: string, term: string, times: number, unique: string): void {
  const dir = path.join(home, '.claude', 'projects', slugForCwd(folder));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: Record<string, unknown>): string =>
    JSON.stringify({ sessionId: 'native-e2e', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
  let out = line({ type: 'user', message: { role: 'user', content: `build ${unique}` } });
  for (let i = 0; i < times; i += 1) {
    out += line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `attempt ${i} said ${term} while doing ${unique}` }] },
    });
  }
  fs.writeFileSync(path.join(dir, 'native-e2e.jsonl'), out);
}

const bar = (w: Page) => w.locator('[data-testid="find-bar"]');
const count = (w: Page) => w.locator('[data-testid="find-count"]');
const groups = (w: Page) => w.locator('[data-testid="find-groups"]');

test.describe('[pty] Session find (E17-02)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('Ctrl+F searches the focused session and NEVER matches text in another card', async () => {
    const folderA = tempProjectFolder();
    const folderB = tempProjectFolder();
    a = await launchApp({ seedFolder: folderA });
    const w = a.window;
    const first = path.basename(folderA);
    const second = path.basename(folderB);
    await expect(w.getByText(first).first()).toBeVisible({ timeout: 25_000 });

    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, folderB);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(second).first()).toBeVisible({ timeout: 25_000 });

    // THE SAME STRING in both, a different number of times. If the search ever
    // reached across cards the count would be 5 on both.
    seedTranscript(a.home, folderA, 'SHARED_NEEDLE', 2, 'ONLY_IN_A');
    seedTranscript(a.home, folderB, 'SHARED_NEEDLE', 3, 'ONLY_IN_B');
    await expect(w.getByText(/ONLY_IN_B/).first()).toBeVisible({ timeout: 25_000 });

    // the second card is the focused one
    await w.keyboard.press(`${MOD}+f`);
    await expect(bar(w)).toHaveCount(1);
    await w.locator('[data-testid="find-input"]').fill('SHARED_NEEDLE');
    await expect(count(w)).toHaveText('1 of 3', { timeout: 15_000 });

    // ...and a term that exists ONLY in the other card is simply not found
    await w.locator('[data-testid="find-input"]').fill('ONLY_IN_A');
    await expect(count(w)).toHaveText('No results', { timeout: 15_000 });

    // now focus the first card and ask again: its own count, its own text
    await w.locator('[data-testid="find-close"]').click();
    await w.keyboard.press(`${MOD}+1`);
    await w.keyboard.press(`${MOD}+f`);
    await w.locator('[data-testid="find-input"]').fill('SHARED_NEEDLE');
    await expect(count(w)).toHaveText('1 of 2', { timeout: 15_000 });
  });

  test('Enter and Shift+Enter step the matches, and Esc closes and gives focus back', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    seedTranscript(a.home, folder, 'STEP_ME', 3, 'ONE_CARD');
    await expect(w.getByText(/ONE_CARD/).first()).toBeVisible({ timeout: 25_000 });

    // focus something identifiable first, so "gives focus back" is checkable
    const composer = w.locator('textarea').first();
    await composer.click();

    await w.keyboard.press(`${MOD}+f`);
    await w.locator('[data-testid="find-input"]').fill('STEP_ME');
    await expect(count(w)).toHaveText('1 of 3', { timeout: 15_000 });

    await w.keyboard.press('Enter');
    await expect(count(w)).toHaveText('2 of 3');
    await w.keyboard.press('Enter');
    await expect(count(w)).toHaveText('3 of 3');
    await w.keyboard.press('Enter'); // wraps
    await expect(count(w)).toHaveText('1 of 3');
    await w.keyboard.press('Shift+Enter');
    await expect(count(w)).toHaveText('3 of 3');

    await w.keyboard.press('Escape');
    await expect(bar(w)).toHaveCount(0);
    await expect(composer).toBeFocused();

    // the term is STICKY: re-opening finds it still there
    await w.keyboard.press(`${MOD}+f`);
    await expect(w.locator('[data-testid="find-input"]')).toHaveValue('STEP_ME');
  });

  // The Terminal used to be this file's "a tab with no provider greys the bar"
  // case. It has one as of P2-E17-03, and the only panel left without a
  // provider (History) is deliberately not clickable, so the greyed-bar paths —
  // the reason text, focus landing on the close button, Escape from there —
  // are asserted in `components/FindBar.test.tsx` instead of here.
  test('the Terminal is a group of its own, labelled scrollback-only (E17-03)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });
    // three in the transcript, none of them ever printed to the terminal
    seedTranscript(a.home, folder, 'TRANSCRIPT_ONLY', 3, 'GROUPED');
    await expect(w.getByText(/GROUPED/).first()).toBeVisible({ timeout: 25_000 });

    // BEFORE the Terminal has ever been shown there is no Terminal group at
    // all — the xterm is fed only while its tab is visible (S-07), so a
    // "0 in Terminal (scrollback only)" here would be a confident statement
    // about a buffer that was never filled
    await w.keyboard.press(`${MOD}+f`);
    await w.locator('[data-testid="find-input"]').fill('TRANSCRIPT_ONLY');
    await expect(count(w)).toHaveText('1 of 3', { timeout: 15_000 });
    await expect(groups(w)).toHaveCount(0);
    await w.keyboard.press('Escape');

    // put something in the scrollback that is NOT in the transcript. The fake
    // provider spawns the OS shell, so this is real PTY output.
    await showTerminal(w);
    await w.locator('.xterm-screen').first().click();
    await w.keyboard.type('echo SCROLLBACK_ONLY_MARKER');
    await w.keyboard.press('Enter');
    await expect(w.getByText(/SCROLLBACK_ONLY_MARKER/).first()).toBeVisible({ timeout: 15_000 });

    // Ctrl+F cannot come from INSIDE the xterm — the terminal owns every key it
    // can see and E17-03 declined to claim Ctrl+F from the CLI (it is bound to
    // scroll:fullPageDown). Clicking the tab is how a user leaves the surface.
    await w.locator('[data-testid="view-tabs"] [data-vtab="terminal"]').click();
    await w.keyboard.press(`${MOD}+f`);
    await expect(bar(w)).toHaveCount(1);
    await expect(w.locator('[data-testid="find-input"]')).toBeEnabled();

    // a term that is ONLY in the scrollback: found here, zero in the session,
    // and the session's zero is stated rather than implied by silence
    await w.locator('[data-testid="find-input"]').fill('SCROLLBACK_ONLY_MARKER');
    await expect(groups(w)).toContainText('scrollback only', { timeout: 15_000 });
    await expect(groups(w)).toContainText('0 in Session');
    await expect(groups(w)).not.toContainText('0 in Terminal');

    // …and the reverse, which is the item's third done-when: a term present
    // only in the TRANSCRIPT still shows its Session count from this tab, with
    // the terminal's 0 labelled so it cannot be read as "not in this session"
    await w.locator('[data-testid="find-input"]').fill('TRANSCRIPT_ONLY');
    await expect(groups(w)).toContainText('3 in Session', { timeout: 15_000 });
    await expect(groups(w)).toContainText('0 in Terminal (scrollback only)');
    // the count is a position inside ONE group, never a total across two
    await expect(count(w)).toHaveText('1 of 3');
  });
});

// ---------------------------------------------------------------------------
// #458 — the same gesture on the DEFAULT transport.
//
// §5.31's flagship gesture is "click a hit, land on the block", and until this
// item it did not work on Direct sessions: the engine scans the transcript FILE
// and then has to say which rendered block a hit belongs to, and the join it
// made was on the file's own timestamp — which a stream-built Feed does not
// have. Every row came back read-only, on the transport most sessions use.
//
// One app, `serial`: launching a Direct session and driving a tool turn is most
// of the cost, and both tests read the same conversation.
// ---------------------------------------------------------------------------
test.describe('Session find on a Direct session (#458)', () => {
  test.describe.configure({ mode: 'serial' });

  let a: LaunchedApp;
  let folder: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // NOT `tempProjectFolder()` — that registers the folder with the sweep and
    // the first `cleanup()` would delete it out from under the second test.
    // Registered in `afterAll` instead (stream-feed.spec.ts's rule).
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-find-direct-'));
    fs.writeFileSync(path.join(folder, 'README.md'), '# e2e\n');
    // no SWITCHBOARD_TRANSPORT: Direct is the default, and a test about the
    // default must not name it. `stream` picks the dual-capable fake.
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    // It really IS Direct — without this the whole group could quietly become a
    // second transcript test that happens to pass.
    await w.getByRole('tab', { name: 'Terminal' }).first().click();
    await expect(w.getByText('No terminal for this session')).toBeVisible({ timeout: 30_000 });
    await w.getByRole('tab', { name: 'Session', exact: true }).first().click();

    // A turn of real tool calls, in the shape the CLI emits them — and the fake
    // writes the same turn to a JSONL transcript, as the real CLI does in
    // stream mode (S-10). Those are the two sides find has to line up.
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!tools');
    await box.press('Enter');
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    registerTempDir(folder);
    await a?.cleanup();
  });

  test('a hit is jumpable, not merely readable', async () => {
    const w = a.window;
    await w.keyboard.press(`${MOD}+f`);
    await expect(bar(w)).toHaveCount(1);
    await w.locator('[data-testid="find-input"]').fill('STREAM_PROSE');
    await expect(count(w)).toHaveText('1 of 1', { timeout: 20_000 });

    // The regression this whole item is: the bar used to say it could not line
    // this session up, and every row was a read-only div.
    await expect(w.locator('[data-testid="find-notice"]')).toHaveCount(0);
    await w.locator('[data-testid="find-results-toggle"]').click();
    await expect(w.locator('[data-find-hit]')).toHaveCount(1);
    // A jumpable hit is a real `<button>`; one that is not is a plain div with
    // the marker saying why (`FindBar.HitRow`). That asymmetry IS the fix.
    await expect(w.locator('[data-find-hit-readonly]')).toHaveCount(0);
    await expect(w.locator('[data-find-hit]')).toHaveJSProperty('tagName', 'BUTTON');

    await w.keyboard.press('Escape');
    await expect(bar(w)).toHaveCount(0);
  });

  test('clicking a hit opens the block that was hiding it', async () => {
    const w = a.window;
    // `quiet` hides tool calls entirely — and tool OUTPUT is exactly where an
    // error string lives, which is why §5.31 says a find must see through the
    // verbosity filter and jumping to a hit must open what was covering it.
    await w.getByRole('button', { name: 'quiet', exact: true }).click();
    await expect(w.locator('[data-feed-box="bash"]')).toHaveCount(0);

    await w.keyboard.press(`${MOD}+f`);
    // A string that exists ONLY in the hidden tool result — so finding it at
    // all proves the search read the file rather than the screen.
    await w.locator('[data-testid="find-input"]').fill('STREAM_OUT_LINE2');
    await expect(count(w)).toHaveText('1 of 1', { timeout: 20_000 });

    await w.locator('[data-testid="find-results-toggle"]').click();
    await w.locator('[data-find-hit]').first().click();

    // The block the hit belongs to is back on screen, out of the fold the
    // verbosity preset had put it in.
    await expect(w.locator('[data-feed-box="bash"]')).toBeVisible({ timeout: 15_000 });

    // …and it is the RIGHT block, with the fold inside it opened too: the
    // matched line is readable IN THE FEED, not only in the results list.
    // Scoped to the box on purpose — the snippet in the list contains the same
    // string, and an unscoped assertion would pass without a jump at all.
    await expect(
      w.locator('[data-feed-box="bash"]').getByText('STREAM_OUT_LINE2')
    ).toBeVisible({ timeout: 15_000 });

    await w.keyboard.press('Escape');
    await w.getByRole('button', { name: 'normal', exact: true }).click();
  });
});
