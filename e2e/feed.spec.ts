// P2-E12-06: Feed view v1 — read-only rendered blocks from the transcript.
// The fake provider writes no transcript, so the test plays Claude's part:
// it writes JSONL into the isolated HOME and the watcher tails it live.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { launchApp, LaunchedApp, showTerminal, tempProjectFolder } from './fixtures/app';

function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

test.describe('Feed view (E12-06)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('renders assistant text and a collapsed tool row from live transcript lines', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    const title = folder.split(/[\\/]/).pop()!;
    await expect(w.getByText(title).first()).toBeVisible();

    // Feed is the DEFAULT view (E12-07) — the empty state shows with no click
    await expect(w.getByText('No activity yet — the Feed renders the conversation once it starts.')).toBeVisible();

    // simulate the CLI writing its transcript in the isolated HOME
    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-e2e', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    fs.writeFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'summarize this repo' } }) +
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Hello from the **feed**' },
              { type: 'tool_use', name: 'Read', input: { file_path: 'C:/tmp/x.md' } },
            ],
          },
        })
    );

    await expect(w.getByText('summarize this repo')).toBeVisible();
    await expect(w.getByText('Hello from the')).toBeVisible();
    await expect(w.locator('.feed-md strong', { hasText: 'feed' })).toBeVisible(); // markdown rendered
    await expect(w.getByText('Read', { exact: true })).toBeVisible(); // collapsed tool row
    // expanding the tool row reveals the input detail
    await w.getByText('Read', { exact: true }).click();
    await expect(w.getByText(/file_path/)).toBeVisible();

    // verbosity presets switch live (E12-07): quiet hides tool rows
    await w.getByRole('button', { name: 'quiet' }).click();
    await expect(w.getByText('Read', { exact: true })).toHaveCount(0);
    await expect(w.getByText('Hello from the')).toBeVisible(); // prose stays
    await w.getByRole('button', { name: 'normal' }).click();
    await expect(w.getByText('Read', { exact: true })).toBeVisible();
  });

  test('the composer drives the real CLI over the PTY (E10-02)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    // type a prompt in the Session tab's composer and hit Enter — the fake
    // provider is a real shell, so the command actually executes
    const box = w.getByPlaceholder(/Prompt this session/);
    await box.fill('echo COMPOSER_OK_42');
    await box.press('Enter');
    await expect(box).toHaveValue(''); // cleared on submit

    // proof it reached the CLI: the (hidden) Terminal shows the output
    await showTerminal(w);
    await expect(w.getByText(/COMPOSER_OK_42/).first()).toBeVisible({ timeout: 15_000 });
  });
});
