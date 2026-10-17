// Settings → AIs and "Add an AI" (E40 item 09, #1292), in the real app.
//
// `SWITCHBOARD_FAKE_PROVIDER=acp` registers the fake ACP agent first (so it
// is the default) and the Claude fake beside it. Detection is REAL: it runs
// after first paint in main, exactly as on a user's machine, so the rows show
// what the probes actually answered.
//
// What only the real app can show:
//  1. the tab draws main's detection results, and Look again re-runs them;
//  2. a "Something else" AI added through the dialog (pointed at the fake ACP
//     agent run as a plain program) is registered at once, and — made the
//     default — a NEW session starts on it and it answers. That is also the
//     issue's "Make default changes which AI new sessions start on".
//
// The issue also says the custom AI "appears in the AI switch". The switch
// chip is #1294 and is not built yet; asserting it is that item's job. What
// this spec proves is the part this item owns: added, registered, default,
// and a live session on it.
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, openSettingsTab, closeSettings } from './fixtures/app';
import { tempProjectFolder, teardown } from './fixtures/stream-session';

test.afterAll(async () => teardown());

/** The fake agent as a program anyone could have typed in: plain Node + its script. */
const FAKE_SCRIPT = path.resolve(__dirname, '..', 'out', 'main', 'fake-acp-cli.js');

async function send(w: Page, text: string): Promise<void> {
  // the new session's composer: the one on screen (the seeded card's is behind its tab)
  const box = w.getByPlaceholder(/Prompt this session/).filter({ visible: true }).last();
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

test.describe('Settings → AIs (#1292)', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    const launched = a;
    a = undefined; // cleared BEFORE the close — see `teardown`
    await teardown(launched);
  });

  test('shows real detection results; Look again runs it again', async () => {
    test.setTimeout(90_000);
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'acp' } });
    const w = a.window;
    await expect(w.getByText(path.basename(folder)).first()).toBeVisible({ timeout: 25_000 });

    const d = await openSettingsTab(w, 'ais');
    const found = d.locator('[data-ai-list="found"]');
    // the fake ACP agent: registered first, so it is the default; its probe
    // answers installed, logged in, version 0.0.0
    const fake = found.locator('[data-ai-row="fake-acp"]');
    await expect(fake).toBeVisible({ timeout: 15_000 });
    await expect(fake).toContainText('default');
    await expect(fake.locator('[data-ai-status]')).toContainText('Logged in', { timeout: 15_000 });
    await expect(fake.locator('[data-ai-status]')).toContainText('version 0.0.0');
    await expect(d.locator('[data-ais-default]')).toHaveValue('fake-acp');
    // the Claude fake answers to the catalog's Claude Code row; whatever its
    // PATH probe found on this machine, it has answered (not "checking…")
    const claude = found.locator('[data-ai-row="claude-code"]');
    await expect(claude).toBeVisible();
    await expect(claude).not.toHaveAttribute('data-ai-presence', 'checking', { timeout: 15_000 });
    // every catalog AI is on the tab, found or not (15 shipped today), plus the fake
    expect(await d.locator('[data-ai-row]').count()).toBeGreaterThanOrEqual(16);
    await expect(d.locator('[data-ai-row="gemini"]')).toBeVisible();
    await expect(d.locator('[data-ai-row][data-ai-presence="checking"]')).toHaveCount(0, { timeout: 15_000 });
    // no credential field anywhere
    await expect(d.locator('[data-settings-section="ais"] input[type="password"]')).toHaveCount(0);

    // Look again: main runs detection again and the rows are redrawn
    const before = await fake.getAttribute('data-ai-probed');
    expect(before).toBeTruthy();
    await d.getByRole('button', { name: 'Look again', exact: true }).click();
    // a NEW answer, not the startup one
    await expect(fake).not.toHaveAttribute('data-ai-probed', before!, { timeout: 20_000 });
    await expect(d.getByRole('button', { name: 'Look again', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(fake.locator('[data-ai-status]')).toContainText('Logged in');
    await expect(d.locator('[data-ai-row][data-ai-presence="checking"]')).toHaveCount(0);
    await closeSettings(w);
  });

  test('a custom AI added through Something else is Tested, Added, made the default, and a new session runs on it', async () => {
    test.setTimeout(150_000);
    expect(fs.existsSync(FAKE_SCRIPT), `built fake agent at ${FAKE_SCRIPT}`).toBe(true);
    const first = tempProjectFolder();
    const second = tempProjectFolder();
    a = await launchApp({ seedFolder: first, env: { SWITCHBOARD_FAKE_PROVIDER: 'acp' } });
    const w = a.window;
    await expect(w.getByText(path.basename(first)).first()).toBeVisible({ timeout: 25_000 });

    const d = await openSettingsTab(w, 'ais');
    await d.getByRole('button', { name: '+ Add an AI…', exact: true }).click();
    const add = w.getByRole('dialog', { name: 'Add an AI' });
    await expect(add).toBeVisible();
    // From the list is first, and it says it installs nothing
    await expect(add.locator('[data-ai-add-panel="list"]')).toContainText('does not install anything');
    await add.getByRole('tab', { name: 'Something else' }).click();

    await add.locator('[data-ai-custom-field="name"]').fill('My fake agent');
    // the Playwright runner's own Node: an absolute path, the way a person
    // points at a program that is not on PATH
    await add.locator('[data-ai-custom-field="command"]').fill(process.execPath);
    await add.locator('[data-ai-custom-field="args"]').fill(FAKE_SCRIPT);
    const addButton = add.getByRole('button', { name: 'Add', exact: true });
    await expect(addButton).toBeDisabled();
    await add.getByRole('button', { name: 'Test', exact: true }).click();
    const result = add.locator('[data-ai-custom-result]');
    await expect(result).toHaveAttribute('data-ai-custom-result', 'ok', { timeout: 30_000 });
    await expect(result).toContainText('fake-acp 0.0.0, protocol 1');
    await expect(addButton).toBeEnabled();
    await addButton.click();
    await expect(add).toBeHidden({ timeout: 30_000 });

    // it is on the tab, under Found, added by you
    const mine = d.locator('[data-ai-list="found"] [data-ai-row="custom:my-fake-agent"]');
    await expect(mine).toBeVisible({ timeout: 15_000 });
    await expect(mine).toContainText('added by you');
    // and it is a choice for new sessions
    await expect(d.locator('[data-ais-default] option[value="custom:my-fake-agent"]')).toHaveCount(1);

    // Make default → the picker and the tag follow
    await mine.getByRole('button', { name: 'Make default', exact: true }).click();
    await expect(d.locator('[data-ais-default]')).toHaveValue('custom:my-fake-agent', { timeout: 10_000 });
    await expect(mine).toContainText('default');
    await closeSettings(w);

    // A NEW session starts on it…
    await a.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, second);
    await w.getByRole('button', { name: '+ session' }).click();
    await expect(w.getByText(path.basename(second)).first()).toBeVisible({ timeout: 25_000 });
    // …and it answers
    await send(w, 'hello custom');
    await expect(w.getByText('ACP reply to: hello custom')).toBeVisible({ timeout: 30_000 });

    // the session that answered is on the custom AI (its declared controls
    // name it), and the seeded one stayed on the fake it started on
    const ais = await w.evaluate(async () => {
      const sb = (
        window as unknown as {
          switchboard: {
            sessions: {
              list: () => Promise<Array<{ id: string; cwd?: string; folder?: string }>>;
              controls: (id: string) => Promise<{ ai: string } | null>;
            };
          };
        }
      ).switchboard;
      const live = await sb.sessions.list();
      return Promise.all(live.map(async (s) => (await sb.sessions.controls(s.id))?.ai ?? null));
    });
    expect(ais).toContain('My fake agent');
    expect(ais).toContain('Fake ACP');
  });
});
