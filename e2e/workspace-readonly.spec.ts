import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp,
  LaunchedApp,
  registerTempDir,
  sweepTempDirs,
  workspaceJsonPath,
} from './fixtures/app';

// the banner's lead line, verbatim from en.json
const NOTICE = 'Nothing in this workspace will be saved.';

/**
 * The banner appears only after an IPC round-trip, so an instant "it is not
 * there" would pass while the answer was still in flight — and would keep
 * passing for the regression that matters (a banner that renders once
 * `isReadOnly()` resolves). Make the same call from the page and wait for it:
 * once THAT has answered, the component's own call has too.
 */
async function readOnlyAnswered(window: Page): Promise<void> {
  await window.evaluate(() =>
    (
      window as unknown as {
        switchboard: { workspace: { isReadOnly: () => Promise<boolean> } };
      }
    ).switchboard.workspace.isReadOnly()
  );
}

test.describe('a workspace file written by a newer version', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  test('says so on screen, and leaves the file byte-identical', async () => {
    // Seed the home BEFORE the first launch: launchApp only creates the AppData
    // folders, never workspace.json, so the app's very first load reads ours.
    // Ours, not the fixture's — so hand it to the fixture's registry and let
    // the sweep take it, with retries and a requeue if Electron is slow to let
    // go. The bare `rmSync` this replaced could THROW out of the `finally`
    // below and fail a test that had already passed (#213).
    const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-')));
    const wsPath = workspaceJsonPath(home);
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });
    const future = JSON.stringify({ version: 99, sessions: [], groups: [] }, null, 2);
    fs.writeFileSync(wsPath, future);

    try {
      a = await launchApp({ home });
    } catch (err) {
      // the fixture only self-cleans a home it created — this one is ours
      await sweepTempDirs();
      throw err;
    }
    // fail-open first: a future file must still BOOT (#110), not blank the app
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible();
    await expect(a.window.getByRole('status').filter({ hasText: NOTICE })).toBeVisible();

    // and the promise the banner makes is kept — quitting writes nothing, so
    // whatever the newer version put in that file survives the downgrade.
    // This test owns the teardown from here: `cleanup()` would close a second
    // time, and `app.process()` throws once the app is gone.
    const app = a;
    a = undefined;
    await app.close();
    try {
      expect(fs.readFileSync(wsPath, 'utf8')).toBe(future);
    } finally {
      await sweepTempDirs();
    }
  });

  test('is absent for a normal workspace', async () => {
    a = await launchApp();
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible();
    await readOnlyAnswered(a.window);
    await expect(a.window.getByText(NOTICE)).toHaveCount(0);
  });
});
