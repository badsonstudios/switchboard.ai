// P2-E18-08a — a real stream session runs, driven through the real app.
//
// THE criterion inherited from P2-E18-04, and this is the first point it is
// meetable: before now nothing constructed StreamService, and the composer
// submitted only over the PTY.
//
// Uses the stream-json fake (`SWITCHBOARD_FAKE_PROVIDER=stream`), so it needs
// no `claude` login and no network — the same property the PTY fake gives the
// other 98 specs.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, LaunchedApp } from './fixtures/app';

function tempProjectFolder(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stream-e2e-'));
  fs.writeFileSync(path.join(d, 'README.md'), '# stream\n');
  return d;
}

test.describe('a stream-json session (P2-E18-08a)', () => {
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  // Scoped to what E18-08a actually claims: the turn RUNS and COMPLETES.
  //
  // It deliberately does not assert on the Session view's rendered reply,
  // because the E18-04 fake writes no JSONL transcript and the Feed reads
  // transcripts until E18-10. That is a real gap in the fake — the REAL CLI
  // does write one (S-10) — and it belongs to E18-08b (#149), whose done-when
  // includes "the Feed renders a stream session's turn". Filed, not absorbed.
  test('runs a whole turn: prompt in, turn completes', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('hello stream');
    await box.press('Enter');

    // "Done." in the Events panel is the state machine reporting a `result`
    // message off the stream — which proves the whole chain: composer ->
    // submitPrompt -> stdin frame -> the fake -> stdout NDJSON -> decoder ->
    // streamStatusEvent -> the state machine -> the UI.
    await expect(w.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  });

  test('the .claude permission is asked ONCE and honoured', async () => {
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, env: { SWITCHBOARD_FAKE_PROVIDER: 'stream' } });
    const w = a.window;

    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({
      timeout: 25_000,
    });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.click();
    await box.fill('!perm .claude/scripts/coverage.sh');
    await box.press('Enter');

    // our bar, carrying the CLI's OWN prose — a hook payload has no equivalent
    await expect(w.getByText(/sensitive file/)).toBeVisible({ timeout: 30_000 });

    await w.getByRole('button', { name: /allow/i }).first().click();

    // and the file is actually written: the answer was HONOURED, which is the
    // thing the hook path cannot do for `.claude/` (measured 2026-08-01)
    const target = path.join(folder, '.claude', 'scripts', 'coverage.sh');
    await expect(async () => {
      expect(fs.existsSync(target)).toBe(true);
    }).toPass({ timeout: 20_000 });

    // and nothing asks a second time
    await expect(w.getByText(/sensitive file/)).toHaveCount(0);
  });
});
