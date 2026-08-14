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
// TRANSPORT SCOPE (P2-E18-18, #404): `[pty]` for the whole group. The Session
// view's provider searches the TRANSCRIPT FILE and maps hits onto blocks the
// watcher derived from that same file — the pipeline that is switched off for
// a stream session (`deriveFeed: record.transport !== 'stream'`). A Direct
// session's transcript is still searched, but E17-01 records that its feed
// blocks carry arrival timestamps rather than the CLI's, so nothing lines up
// and every hit comes back snippet-only. There is no Direct counterpart to
// write until that is fixed; the bar's behaviour on it (results readable, no
// jump, and a notice saying so) is covered by the unit tests.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

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
