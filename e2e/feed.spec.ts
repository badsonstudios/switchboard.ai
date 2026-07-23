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

    // rich blocks v2 (E10-06): Edit diff panes + Bash IN/OUT + todos checklist
    fs.appendFileSync(
      path.join(dir, 'native-e2e.jsonl'),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'echo RICH_OUT', description: 'Check output' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/tmp/y.ts', old_string: 'OLD_LINE', new_string: 'NEW_LINE' } },
            { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'first step', status: 'completed' }] } },
          ],
        },
      }) +
        line({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'RICH_OUT' }] },
        })
    );
    await expect(w.getByText('Check output')).toBeVisible(); // Bash header description
    await expect(w.getByText('NEW_LINE')).toBeVisible(); // Edit new pane (open by default)
    await expect(w.getByText('+1 / -1 lines')).toBeVisible(); // edit stats subtitle
    await expect(w.getByText('Update Todos')).toBeVisible();
    await expect(w.getByText('first step')).toBeVisible();
    // OUT section expands to the tool result
    await w.getByText('▸ OUT').click();
    await expect(w.getByText('RICH_OUT', { exact: true }).last()).toBeVisible();

    // verbosity presets switch live (E12-07): quiet hides tool rows
    await w.getByRole('button', { name: 'quiet' }).click();
    await expect(w.getByText('Read', { exact: true })).toHaveCount(0);
    await expect(w.getByText('Hello from the')).toBeVisible(); // prose stays
    await w.getByRole('button', { name: 'normal' }).click();
    await expect(w.getByText('Read', { exact: true })).toBeVisible();
  });

  test('a long history opens scrolled to the BOTTOM (Dan 2026-07-23)', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 25_000 });

    const dir = path.join(a.home, '.claude', 'projects', slugForCwd(folder));
    fs.mkdirSync(dir, { recursive: true });
    const line = (o: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'native-scroll', cwd: folder, timestamp: new Date().toISOString(), ...o }) + '\n';
    let body = '';
    for (let i = 1; i <= 60; i++) {
      body += line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `SCROLL_BLOCK_${i}` }] },
      });
    }
    fs.writeFileSync(path.join(dir, 'native-scroll.jsonl'), body);

    // the tail is on screen, the head is not — we're pinned to the bottom
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeVisible({ timeout: 15_000 });
    await expect(w.getByText('SCROLL_BLOCK_60')).toBeInViewport();
    await expect(w.getByText('SCROLL_BLOCK_1', { exact: true })).not.toBeInViewport();
  });

  test('composer autonomy chip cycles and survives a relaunch (E10-05)', async () => {
    const folder = tempProjectFolder();
    const title = folder.split(/[\\/]/).pop()!;
    const first = await launchApp({ seedFolder: folder });
    const w = first.window;
    await expect(w.getByText(title).first()).toBeVisible({ timeout: 25_000 });

    const chip = w.getByTitle('Autonomy for this session (applies on next resume)');
    await expect(chip).toContainText('ask');
    await chip.click(); // -> plan
    await expect(chip).toContainText('plan');

    await w.waitForTimeout(900); // debounced store save
    await first.close();
    a = await launchApp({ home: first.home });
    await expect(a.window.getByText(title).first()).toBeVisible({ timeout: 25_000 });
    await expect(
      a.window.getByTitle('Autonomy for this session (applies on next resume)')
    ).toContainText('plan', { timeout: 20_000 });
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
