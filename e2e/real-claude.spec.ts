// The REAL-CLAUDE Playwright lane (Dan's ask, 2026-07-22): drives an actual
// logged-in claude session through the Session tab — composer prompt in,
// rendered response out. Local-only: needs a logged-in CLI, so it runs ONLY
// with SWITCHBOARD_REAL_E2E=1 (CI keeps the fake provider; the local check
// layer + this spec cover the real-CLI integration).
//
//   SWITCHBOARD_REAL_E2E=1 npx playwright test e2e/real-claude.spec.ts
import { test, expect } from '@playwright/test';
import { launchApp, LaunchedApp, tempProjectFolder } from './fixtures/app';

test.describe('real claude end-to-end (opt-in)', () => {
  test.skip(process.env.SWITCHBOARD_REAL_E2E !== '1', 'set SWITCHBOARD_REAL_E2E=1 (needs a logged-in claude)');
  let a: LaunchedApp;
  test.afterEach(async () => a?.cleanup());

  test('composer prompt -> real claude -> rendered response in the Session tab', async () => {
    test.setTimeout(180_000); // a real model turn takes what it takes
    const folder = tempProjectFolder();
    a = await launchApp({ seedFolder: folder, realClaude: true });
    const w = a.window;
    await expect(w.getByText(folder.split(/[\\/]/).pop()!).first()).toBeVisible({ timeout: 30_000 });

    // wait for the CLI to be READY (SessionStart hook -> idle pill) before
    // prompting — keystrokes into a booting TUI go nowhere
    await expect(w.getByText('idle', { exact: true }).first()).toBeVisible({ timeout: 60_000 });

    const box = w.getByPlaceholder(/Prompt this session/);
    await box.fill('Reply with exactly: REAL_E2E_OK and nothing else, no tools.');
    await box.press('Enter');

    // the composer wrote to the real TUI and the model answered — assert via
    // the Terminal (PTY text). KNOWN ANOMALY (2026-07-23, tracked in
    // PROGRESS): claude 2.1.218 does not write conversation .jsonl files
    // under an isolated temp home (session-env/memory appear, transcript
    // doesn't), so Session-view block assertions are deferred until that's
    // understood — real-home usage writes transcripts normally.
    await w.getByRole('button', { name: 'Terminal' }).click();
    await expect(w.getByText(/REAL_E2E_OK/).first()).toBeVisible({ timeout: 120_000 });
  });
});
