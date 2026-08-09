import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, LaunchedApp, registerTempDir, sweepTempDirs, workspaceJsonPath } from './fixtures/app';

// #207 — a workspace write that FAILS at runtime used to be a log line and
// nothing else: the same silent-loss shape #168 fixed for read-only mode, one
// failure mode over. The layout on disk quietly stops keeping up with the one
// on screen, and the next launch restores a stale workspace with no hint why.
//
// The half that has no equivalent in #168 is RECOVERY. Read-only lasts the whole
// run by definition; this condition is expected to end, and a notice that
// outlives its condition teaches people to ignore notices. Both halves are
// checked here, in one launch, because "it went up" and "it came down" are only
// worth anything together.

/** the banner's lead line, verbatim from en.json */
const NOTICE = "This workspace isn't being saved.";

/**
 * A home where every save is doomed, by the only means that behaves the same on
 * all three platforms: the store writes `workspace.json.tmp` and renames it, so
 * a DIRECTORY sitting on that name makes the write fail with EISDIR every time.
 *
 * The alternatives are all platform-specific (chmod does nothing useful on
 * Windows, ACLs do not exist elsewhere, and a real full disk is not something a
 * test may arrange), and this one is also reversible in a single call — which is
 * what makes the recovery half testable at all.
 */
function unwritableWorkspaceHome(): { home: string; tmpDir: string } {
  // Ours, not the fixture's — so hand it to the fixture's registry and let the
  // sweep take it, with retries and a requeue if Electron is slow to let go.
  const home = registerTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-')));
  const wsPath = workspaceJsonPath(home);
  fs.mkdirSync(path.dirname(wsPath), { recursive: true });
  const tmpDir = `${wsPath}.tmp`;
  fs.mkdirSync(tmpDir);
  return { home, tmpDir };
}

test.describe('a workspace that cannot be written', () => {
  let a: LaunchedApp | undefined;
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
  });

  test('says so on screen once it is more than a blip, and stops saying it when saving works again', async () => {
    const { home, tmpDir } = unwritableWorkspaceHome();
    const wsPath = workspaceJsonPath(home);

    try {
      a = await launchApp({ home });
    } catch (err) {
      // the fixture only self-cleans a home it created — this one is ours
      await sweepTempDirs();
      throw err;
    }
    const w = a.window;
    // fail-open first: a workspace it cannot write must still BOOT and work
    await expect(w.getByRole('button', { name: '+ session' })).toBeVisible();

    // Something that definitely wants saving. The theme round-trips through the
    // same file as everything else on the workspace page.
    await w.getByRole('button', { name: 'daylight', exact: true }).click();

    // The threshold is what keeps this from being noise, so it costs a few
    // seconds of retries before anything appears — deliberately.
    await expect(w.getByRole('status').filter({ hasText: NOTICE })).toBeVisible({
      timeout: 30_000,
    });
    // and it NAMES the file, which is the only actionable thing in it. The
    // basename rather than the whole path: main derives its own from
    // `app.getPath('userData')`, which on macOS canonicalises `/var/folders/…`
    // to `/private/var/folders/…` — a difference that has nothing to do with
    // what is being asserted. The exact string is pinned in the store's unit
    // tests, and the interpolation is pinned in the component's.
    await expect(
      w.getByRole('status').filter({ hasText: path.basename(wsPath) })
    ).toBeVisible();
    // nothing is blocked while it is up
    await expect(w.getByRole('button', { name: '+ session' })).toBeEnabled();

    // Now let the disk relent. Nothing in the app is touched: the store's own
    // retry is what has to notice, and taking the notice back down is the half
    // #168 never needed.
    fs.rmdirSync(tmpDir);
    await expect(w.getByRole('status').filter({ hasText: NOTICE })).toHaveCount(0, {
      timeout: 30_000,
    });

    // …and the retry did not merely notice, it SAVED — which is the whole
    // reason for retrying rather than waiting for the user to change something.
    const saved = JSON.parse(fs.readFileSync(wsPath, 'utf8')) as { ui?: { theme?: string } };
    expect(saved.ui?.theme).toBe('daylight');
  });

  test('is absent for a workspace that saves normally', async () => {
    a = await launchApp();
    await expect(a.window.getByRole('button', { name: '+ session' })).toBeVisible();
    await a.window.getByRole('button', { name: 'daylight', exact: true }).click();
    // long enough that the threshold's three backed-off retries would have
    // elapsed — an instant check would pass even for a banner that always shows
    await a.window.waitForTimeout(5_000);
    await expect(a.window.getByText(NOTICE)).toHaveCount(0);
  });
});
