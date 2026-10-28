// A new session asks for its name and always starts fresh (#1282), in the real app.
//
// The units pin the rule (`main/sessions/session-title.test.ts`), the channel
// (`ipc.test.ts`) and the dialog against a stub (`NameSessionDialog.test.tsx`).
// What only the real app can show: the real preload and channel, the
// suggestion arriving pre-filled, the name OK'd being the name the session
// really gets in main, and — the half of the item that is a REMOVAL — no
// history picker, in a folder that has an earlier conversation for it to offer.
//
// Every other spec runs with `SWITCHBOARD_NO_NAME_PROMPT=1` (the fixtures set
// it); this one turns it off.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  launchApp,
  LaunchedApp,
  pollAsync,
  registerTempDir,
  sessionStatuses,
  tempProjectFolder,
} from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** `slugForCwd`, restated — see session-history.spec.ts for why it is a copy */
const slug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

const dialog = (w: Page) => w.getByTestId('name-session-dialog');
const field = (w: Page) => w.locator('[data-name-session-input]');
const titles = async (a: LaunchedApp): Promise<string[]> => [...(await sessionStatuses(a)).keys()].sort();

test.describe('naming a new session (#1282)', () => {
  let a: LaunchedApp;

  test.afterEach(async () => {
    await a?.cleanup();
  });

  test('pre-filled, OK as shown, edited, taken, cancelled — and never the history picker', async () => {
    test.setTimeout(180_000);
    const folder = tempProjectFolder();
    const base = path.basename(folder);
    // AN EARLIER CONVERSATION IN THIS FOLDER: exactly what used to put the
    // history picker in front of `+ session`. Its absence is now the assertion.
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-name-')));
    const dir = path.join(home, '.claude', 'projects', slug(folder));
    fs.mkdirSync(dir, { recursive: true });
    const conversation = '12828282-1282-4282-8282-128212821282';
    fs.writeFileSync(
      path.join(dir, `${conversation}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          cwd: folder,
          message: { role: 'user', content: 'an earlier conversation' },
          uuid: 'u1',
        }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'An earlier conversation', sessionId: conversation }),
      ].join('\n') + '\n'
    );

    a = await launchApp({
      home,
      env: { SWITCHBOARD_FAKE_PROVIDER: 'stream', SWITCHBOARD_NO_NAME_PROMPT: '' },
    });
    const w = a.window;
    await a.app.evaluate(({ dialog: d }, f) => {
      d.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder);
    const plus = w.getByRole('button', { name: '+ session' });
    await expect(plus).toBeVisible({ timeout: 25_000 });
    // The precondition, checked rather than assumed: the folder really does
    // have a conversation to offer, so "no picker" below means removed, not
    // merely "nothing to show".
    const listed = (await w.evaluate(
      (f) => window.switchboard.transcripts.history({ scope: 'folder', folder: f }),
      folder
    )) as { status: string; rows?: unknown[] };
    expect(listed.status).toBe('ok');
    expect(listed.rows?.length ?? 0).toBeGreaterThan(0);

    // ── 1. pre-filled with the folder's name; OK as shown ───────────────────
    await plus.click();
    await expect(dialog(w)).toBeVisible({ timeout: 15_000 });
    await expect(field(w)).toHaveValue(base);
    await expect(field(w)).toBeFocused();
    await expect(dialog(w)).toContainText(folder);
    // no history picker, now or after
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0);
    await field(w).press('Enter');
    await expect(dialog(w)).toHaveCount(0);
    await pollAsync(async () => ((await titles(a)).includes(base) ? true : null), 'the first session');
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0);

    // ── 2. the same folder again: the suggestion is main's de-dup ───────────
    await plus.click();
    await expect(field(w)).toHaveValue(`${base}-2`, { timeout: 15_000 });
    // …and an edited name is used exactly as typed
    await field(w).fill('my review');
    await w.locator('[data-name-session-ok]').click();
    await pollAsync(async () => ((await titles(a)).includes('my review') ? true : null), 'the renamed session');

    // ── 3. a typed name that is taken: warned, and OK gives main's -N ───────
    await plus.click();
    await expect(field(w)).toHaveValue(`${base}-2`, { timeout: 15_000 });
    await field(w).fill(base.toUpperCase());
    const note = w.locator('[data-name-session-note="taken"]');
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(note).toContainText(`${base.toUpperCase()}-2`);
    await field(w).press('Enter');
    await pollAsync(
      async () => ((await titles(a)).includes(`${base.toUpperCase()}-2`) ? true : null),
      'the taken name, de-duplicated'
    );

    // ── 4. Cancel creates nothing — from the palette's Mod+N this time ──────
    const before = await titles(a);
    expect(before).toHaveLength(3);
    await w.keyboard.press(`${MOD}+N`);
    await expect(dialog(w)).toBeVisible({ timeout: 15_000 });
    await field(w).press('Escape');
    await expect(dialog(w)).toHaveCount(0);
    await w.waitForTimeout(1_000);
    expect(await titles(a)).toEqual(before);
    await expect(w.locator('[data-history-dialog]')).toHaveCount(0);
  });
  test("a group's ⊕ asks too, and the named session lands in that group", async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ env: { SWITCHBOARD_NO_NAME_PROMPT: '' } });
    const w = a.window;
    await w.getByTitle('Create a persistent group').click();
    await expect(w.getByText('New group')).toBeVisible({ timeout: 25_000 });
    await a.app.evaluate(({ dialog: d }, f) => {
      d.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, folder);

    // Cancel first: the group stays empty
    await w.getByTitle('New session in this group').click();
    await expect(field(w)).toHaveValue(path.basename(folder), { timeout: 15_000 });
    await w.locator('[data-name-session-cancel]').click();
    await expect(dialog(w)).toHaveCount(0);
    await expect(w.getByText('empty', { exact: true })).toHaveCount(1);

    await w.getByTitle('New session in this group').click();
    await field(w).fill('grouped one');
    await field(w).press('Enter');
    await pollAsync(async () => ((await titles(a)).includes('grouped one') ? true : null), 'the grouped session');
    await expect(w.getByText('empty', { exact: true })).toHaveCount(0);
  });
});
