// P2-E19-03: the update check, end to end, against a STUB feed.
//
// There is no release on this repo yet — and this suite must never create one,
// nor talk to the real GitHub, nor read the developer's real `gh` credentials.
// So the app is pointed at a tiny local server that answers exactly what the
// GitHub releases endpoint answers, which is the seam the checker was built
// with (`SWITCHBOARD_UPDATE_FEED`, honoured only in a non-packaged build).
//
// Every other spec in the suite gets `SWITCHBOARD_UPDATE_FEED=off` from the
// fixture, so nothing else in the run grows a surprise dialog the day a real
// release exists.
import { test, expect, Page } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import { AddressInfo } from 'net';
import { launchApp, LaunchedApp, poll, workspaceJsonPath } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const dialog = (w: Page) => w.locator('[role="dialog"][data-update-state]');
const stamp = (w: Page) =>
  w.getByRole('button', { name: 'Version and build — click for details' });

/** The shell is mounted and listening (the reason is in about.spec.ts). */
async function shellReady(w: Page): Promise<void> {
  await expect(stamp(w)).toBeVisible();
}

/** One GitHub-shaped release. */
function release(tag: string, body: string): Record<string, unknown> {
  return {
    tag_name: tag,
    name: tag,
    body,
    html_url: `https://github.com/badsonstudios/switchboard.ai/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-08-05T10:00:00Z',
  };
}

/** The stub feed. `serve` is swapped between launches to change the answer. */
class StubFeed {
  private server: http.Server | null = null;
  url = '';
  hits = 0;
  body: unknown = [];

  async start(): Promise<void> {
    const server = http.createServer((_req, res) => {
      this.hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.body));
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
  }

  /** Idempotent: one test deliberately kills the feed mid-test. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The workspace file's update prefs, once main has written them. */
interface UpdatesOnDisk {
  autoCheck?: boolean;
  skippedVersion?: string;
  lastCheck?: string;
}
function updatePrefs(home: string): UpdatesOnDisk | null {
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceJsonPath(home), 'utf8')) as {
      updates?: UpdatesOnDisk;
    };
    return raw.updates ?? null;
  } catch {
    return null; // not written yet
  }
}

/**
 * Wait until the automatic check has RUN.
 *
 * `lastCheck` is written by the service the moment a check completes, so this
 * is the deterministic "it happened" marker — far better than sleeping and
 * hoping, especially for the assertions that something did NOT appear.
 */
async function checkCompleted(a: LaunchedApp): Promise<void> {
  await poll(() => (updatePrefs(a.home)?.lastCheck ? true : null), 20_000);
}

test.describe('update check (E19-03)', () => {
  let feed: StubFeed;
  let a: LaunchedApp | undefined;

  test.beforeEach(async () => {
    feed = new StubFeed();
    await feed.start();
  });
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
    await feed.stop();
  });

  const launch = (home?: string): Promise<LaunchedApp> =>
    launchApp({ home, env: { SWITCHBOARD_UPDATE_FEED: feed.url } });

  test('a newer release shows the dialog, with its version and its notes rendered in-app', async () => {
    feed.body = [release('v9.9.9', '## Highlights\n\n- a **big** one\n- and another')];
    a = await launch();
    const w = a.window;
    await shellReady(w);

    await expect(dialog(w)).toBeVisible();
    await expect(dialog(w)).toHaveAttribute('data-update-state', 'available');
    // the version is in the title…
    await expect(dialog(w)).toContainText('9.9.9');
    // …and the notes are MARKDOWN, rendered here rather than in a browser
    await expect(dialog(w).locator('.feed-md h2')).toHaveText('Highlights');
    await expect(dialog(w).locator('.feed-md li')).toHaveCount(2);
    await expect(dialog(w).locator('.feed-md strong')).toHaveText('big');

    for (const label of ['Update', 'Ignore', 'Skip this version']) {
      await expect(dialog(w).getByRole('button', { name: label })).toBeVisible();
    }
    await w.keyboard.press('Escape');
    await expect(dialog(w)).toHaveCount(0);
  });

  test('Skip suppresses exactly that version — and a newer release prompts again', async () => {
    feed.body = [release('v9.9.9', 'notes')];
    a = await launch();
    const home = a.home;
    await shellReady(a.window);
    await expect(dialog(a.window)).toBeVisible();
    await dialog(a.window).getByRole('button', { name: 'Skip this version' }).click();
    await expect(dialog(a.window)).toHaveCount(0);
    await poll(() => (updatePrefs(home)?.skippedVersion === '9.9.9' ? true : null));
    await a.close(); // keep the home

    // Same release, second run: the check RUNS (lastCheck moves) and says
    // nothing. This is the assertion the whole feature's politeness rests on.
    a = await launch(home);
    await shellReady(a.window);
    await checkCompleted(a);
    await expect(dialog(a.window)).toHaveCount(0);
    // …but a MANUAL check still offers it — a button that silently does
    // nothing is worse than no button.
    await a.window.keyboard.press(`${MOD}+Shift+P`);
    await a.window.getByPlaceholder('Type a command or a session name…').fill('updates');
    await a.window.locator('[id="palette-row-help.checkForUpdates"]').click();
    await expect(dialog(a.window)).toBeVisible();
    await expect(dialog(a.window)).toContainText('9.9.9');
    await a.window.keyboard.press('Escape');
    await a.close();

    // A NEWER release is a different version, so the skip does not cover it.
    feed.body = [release('v9.9.10', 'newer still')];
    a = await launch(home);
    await shellReady(a.window);
    await expect(dialog(a.window)).toBeVisible();
    await expect(dialog(a.window)).toContainText('9.9.10');
  });

  test('an empty release list is silent, and a manual check says so gently', async () => {
    // 200 + [] is "we can see the repo, it has published nothing" — the case a
    // 404 must never be confused with.
    feed.body = [];
    a = await launch();
    const w = a.window;
    await shellReady(w);
    await checkCompleted(a);
    await expect(dialog(w)).toHaveCount(0);

    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('updates');
    await w.locator('[id="palette-row-help.checkForUpdates"]').click();
    await expect(dialog(w)).toHaveAttribute('data-update-state', 'up-to-date');
  });

  test('the About panel offers the check, and its auto-check toggle persists', async () => {
    feed.body = [];
    a = await launch();
    const w = a.window;
    const home = a.home;
    await shellReady(w);
    await checkCompleted(a);

    await stamp(w).click();
    const about = w.getByRole('dialog', { name: 'About this build' });
    await expect(about).toBeVisible();
    const toggle = about.locator('[data-about-field="autoCheck"]');
    await expect(toggle).toBeChecked(); // default ON
    await toggle.uncheck();
    await poll(() => (updatePrefs(home)?.autoCheck === false ? true : null));

    // the manual check still works with automatic checks turned off
    await about.getByRole('button', { name: 'Check for updates…' }).click();
    await expect(dialog(w)).toBeVisible();
    await w.keyboard.press('Escape');
    await a.close();

    // …and with it off, a relaunch makes no call at all
    const before = feed.hits;
    a = await launch(home);
    await shellReady(a.window);
    await stamp(a.window).click();
    const about2 = a.window.getByRole('dialog', { name: 'About this build' });
    await expect(about2.locator('[data-about-field="autoCheck"]')).not.toBeChecked();
    // A positive barrier, not a sleep: the manual check below proves the feed
    // is reachable and that a call from this run REGISTERS — so the +1 (rather
    // than +2) is what proves the startup check genuinely did not fire.
    await about2.getByRole('button', { name: 'Check for updates…' }).click();
    await expect(dialog(a.window)).toBeVisible();
    expect(feed.hits).toBe(before + 1);
  });

  test('Ignore is NOT persisted — the release is offered again next launch', async () => {
    // The soft answer. "Skip this version" is the durable one; conflating the
    // two would leave someone who clicked the gentle option unable to find the
    // release again.
    feed.body = [release('v9.9.9', 'notes')];
    a = await launch();
    const home = a.home;
    await shellReady(a.window);
    await dialog(a.window).getByRole('button', { name: 'Ignore' }).click();
    await expect(dialog(a.window)).toHaveCount(0);
    await checkCompleted(a);
    expect(updatePrefs(home)?.skippedVersion).toBeUndefined();
    await a.close();

    a = await launch(home);
    await shellReady(a.window);
    await expect(dialog(a.window)).toBeVisible();
    await expect(dialog(a.window)).toContainText('9.9.9');
  });

  test('a dead feed is silent on startup and gentle when asked', async () => {
    // The fail-open contract: an update check that cannot reach anything costs
    // the user nothing and says nothing until they ask.
    await feed.stop();
    a = await launchApp({ env: { SWITCHBOARD_UPDATE_FEED: feed.url } });
    const w = a.window;
    await shellReady(w);
    await checkCompleted(a);
    await expect(dialog(w)).toHaveCount(0);

    await w.keyboard.press(`${MOD}+Shift+P`);
    await w.getByPlaceholder('Type a command or a session name…').fill('updates');
    await w.locator('[id="palette-row-help.checkForUpdates"]').click();
    await expect(dialog(w)).toHaveAttribute('data-update-state', 'failed');
    await expect(dialog(w)).toContainText('Nothing is wrong with your app');
    // …and it is a plain dialog, not an alert demanding attention. Scoped to
    // the dialog: the shell has live regions of its own (the preflight
    // banner's, for one), and this is a claim about THIS box.
    await expect(dialog(w).locator('[role="alert"]')).toHaveCount(0);
    await expect(dialog(w)).toHaveAttribute('role', 'dialog');
  });
});
