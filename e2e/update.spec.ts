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
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { launchApp, LaunchedApp, poll, workspaceJsonPath } from './fixtures/app';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** The name `electron-builder.js` produces, which is what the picker looks for. */
const INSTALLER_NAME = 'switchboard-Setup-9.9.9.exe';
/** What `app.getVersion()` answers in an unpackaged run — the handshake's other half. */
const APP_VERSION = (
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const dialog = (w: Page) => w.locator('[role="dialog"][data-update-state]');
const stamp = (w: Page) =>
  w.getByRole('button', { name: 'Version and build — click for details' });

/** The shell is mounted and listening (the reason is in about.spec.ts). */
async function shellReady(w: Page): Promise<void> {
  await expect(stamp(w)).toBeVisible();
}

/** One GitHub-shaped release. */
function release(tag: string, body: string, assets?: unknown[]): Record<string, unknown> {
  return {
    tag_name: tag,
    name: tag,
    body,
    html_url: `https://github.com/badsonstudios/switchboard.ai/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    published_at: '2026-08-05T10:00:00Z',
    ...(assets ? { assets } : {}),
  };
}

/**
 * The stub feed. `serve` is swapped between launches to change the answer.
 *
 * E19-04 gave it two more routes: `/assets/installer` and `/assets/sidecar`,
 * so the download → verify → install path can be driven end to end without
 * publishing a release to test against. `download.ts` only reaches a loopback
 * http host because the feed override is set (and a packaged build cannot set
 * it) — that seam is exactly what makes this possible.
 */
class StubFeed {
  private server: http.Server | null = null;
  url = '';
  hits = 0;
  body: unknown = [];
  /** the bytes served as the "installer" */
  installer = Buffer.from('a pretend NSIS installer');
  /** what the sidecar says. Set to a wrong digest to corrupt the download. */
  sidecarDigest: string | null = null;
  /** stall the installer body forever, so a cancel has something to cancel */
  stall = false;
  /** see `holdBody()` */
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/assets/installer')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(this.installer.length),
        });
        // HALF the body, then a pause: the renderer gets a determinate bar
        // sitting at an exact 50%, and the test gets a download that is
        // genuinely in flight when it presses Cancel or looks at the bar.
        const half = Math.floor(this.installer.length / 2);
        res.write(this.installer.subarray(0, half));
        if (this.stall) return; // ...and never the rest; only a cancel ends it
        const finish = (): void => {
          res.end(this.installer.subarray(half));
        };
        // `holdBody()` decides WHEN the second half lands. Resolving the gate
        // before the request arrives is fine — the promise is already settled,
        // so `finish` runs on the next tick and the body simply is not held.
        if (this.gate) void this.gate.then(finish);
        else finish();
        return;
      }
      if (req.url?.startsWith('/assets/sidecar')) {
        const digest =
          this.sidecarDigest ?? crypto.createHash('sha256').update(this.installer).digest('hex');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${digest}  ${INSTALLER_NAME}\n`);
        return;
      }
      this.hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.body));
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
  }

  /** The two assets a release needs before E19-04 will install it. */
  assets(): unknown[] {
    const origin = this.url.replace(/\/releases$/, '');
    return [
      { name: INSTALLER_NAME, url: `${origin}/assets/installer`, size: this.installer.length },
      { name: `${INSTALLER_NAME}.sha256`, url: `${origin}/assets/sidecar`, size: 78 },
    ];
  }

  /**
   * Hold the installer body open, half-served, until `releaseBody()`.
   *
   * Without this the download, the checksum fetch and the hand-over all land
   * inside a millisecond or two against a loopback stub serving 24 bytes — the
   * `downloading` phase is real but far too brief to observe, and CI proved it
   * by racing past the progress bar before the first poll could see it. The
   * pause belongs to the TEST, not to the product: nothing here weakens what
   * the bar has to be, it only keeps it on screen long enough to be checked.
   */
  holdBody(): void {
    this.gate = new Promise<void>((resolve) => {
      this.openGate = resolve;
    });
  }

  /** Let a held body finish. Safe to call twice, or never. */
  releaseBody(): void {
    const open = this.openGate;
    this.openGate = null;
    open?.();
  }

  /** Idempotent: one test deliberately kills the feed mid-test. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    // A held or stalled body would keep `close()` waiting on a live socket for
    // the rest of the run if the test that opened it failed before releasing.
    this.releaseBody();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

/** The workspace file's update prefs, once main has written them. */
interface UpdatesOnDisk {
  autoCheck?: boolean;
  skippedVersion?: string;
  lastCheck?: string;
  pendingUpdateVersion?: string;
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

// ---------------------------------------------------------------------------
// P2-E19-04: the download -> verify -> install path, end to end.
//
// **Windows-only, and that is the feature, not the test.** E19 decision 3
// packages an NSIS installer and nothing else; on any other platform the check
// deliberately offers no `download` at all and the browser fallback is the
// whole answer (unit-tested in `install.test.ts`).
//
// Nothing here publishes a release, and nothing here runs an installer:
//   - the feed and both assets are the local stub above;
//   - `SWITCHBOARD_UPDATE_NO_LAUNCH` (a non-packaged-build seam, like the feed
//     override itself) stops main spawning the .exe and quitting, so
//     `launching` becomes an observable terminal phase instead of the suite
//     losing its window.
// ---------------------------------------------------------------------------
test.describe('one-click download + verified install (E19-04)', () => {
  test.skip(process.platform !== 'win32', 'the installer, and this path, are Windows-only');

  let feed: StubFeed;
  let a: LaunchedApp | undefined;
  let temp: string;

  test.beforeEach(async () => {
    feed = new StubFeed();
    await feed.start();
    // Our own temp: the staged installer is asserted on, and a suite that
    // swept the machine's real temp directory would be a rude thing to run.
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-temp-'));
  });
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
    await feed.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const launch = (home?: string): Promise<LaunchedApp> =>
    launchApp({
      home,
      env: {
        SWITCHBOARD_UPDATE_FEED: feed.url,
        SWITCHBOARD_UPDATE_NO_LAUNCH: '1',
        TEMP: temp,
        TMP: temp,
      },
    });

  const staged = (): string => path.join(temp, 'switchboard-updates', INSTALLER_NAME);

  test('Update downloads with progress, verifies, and hands over to the installer', async () => {
    feed.body = [release('v9.9.9', 'notes', feed.assets())];
    // The download does not get to finish until this test says so — see
    // `holdBody`. Half the installer, and then it waits.
    feed.holdBody();
    a = await launch();
    const w = a.window;
    const home = a.home;
    await shellReady(w);
    await expect(dialog(w)).toBeVisible();

    await dialog(w).getByRole('button', { name: 'Update' }).click();
    await expect(dialog(w)).toHaveAttribute('data-update-phase', 'downloading');
    // A REAL progress element, so what the user sees is a determinate bar and
    // not a spinner pretending to know something: a `<progress>` out of 100
    // carrying an actual `value` attribute — and the value is the bytes, not
    // decoration. Half the body is on the wire, so it reads exactly 50.
    const bar = dialog(w).locator('[data-update-field="bar"]');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveJSProperty('max', 100);
    await expect(bar).toHaveAttribute('value', '50');
    await expect(dialog(w).locator('[data-update-field="progress"]')).toContainText('50%');

    feed.releaseBody(); // ...and now let the rest of the bytes through.
    // It ends at the handover, having passed through verification.
    await expect(dialog(w)).toHaveAttribute('data-update-phase', 'launching', { timeout: 20_000 });

    // The verified installer is on disk, in the directory main owns.
    expect(fs.existsSync(staged())).toBe(true);
    expect(fs.readFileSync(staged())).toEqual(feed.installer);
    // ...and the handshake is armed BEFORE the handover, because after it there
    // is no process left to arm it.
    await poll(() => (updatePrefs(home)?.pendingUpdateVersion === '9.9.9' ? true : null));
  });

  test('the next run confirms the handshake and says which version you are on', async () => {
    // The other half, driven the only way it can be driven without actually
    // replacing the running build: a pending version that matches what IS
    // running is exactly the state the installer's relaunch produces.
    feed.body = [];
    a = await launch();
    const home = a.home;
    await shellReady(a.window);
    await checkCompleted(a);
    await a.close();

    const file = workspaceJsonPath(home);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      updates?: Record<string, unknown>;
    };
    saved.updates = { ...saved.updates, pendingUpdateVersion: APP_VERSION };
    fs.writeFileSync(file, JSON.stringify(saved));

    a = await launch(home);
    await shellReady(a.window);
    const notice = a.window.locator('[data-events-notice="installed"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(APP_VERSION);
    // Consumed: the flag is cleared on read, so it cannot congratulate forever.
    await poll(() => (updatePrefs(home)?.pendingUpdateVersion ? null : true));
    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toHaveCount(0);
  });

  test('a mismatched checksum is DELETED, never run, and falls back to the browser', async () => {
    // The done-when's second clause. The stub vouches for bytes it did not
    // send, which is what a corrupted download looks like from in here.
    feed.sidecarDigest = 'f'.repeat(64);
    feed.body = [release('v9.9.9', 'notes', feed.assets())];
    a = await launch();
    const w = a.window;
    await shellReady(w);
    await dialog(w).getByRole('button', { name: 'Update' }).click();

    await expect(dialog(w)).toHaveAttribute('data-update-phase', 'failed', { timeout: 20_000 });
    await expect(dialog(w)).toHaveAttribute('data-update-reason', 'checksum');
    await expect(dialog(w)).toContainText('deleted and nothing was run');
    // Gone from disk, not kept "in case it was a fluke".
    expect(fs.existsSync(staged())).toBe(false);
    // ...and the way out is the same release page E19-03 offered.
    await expect(dialog(w).getByRole('button', { name: 'Open the release page' })).toBeVisible();
    expect(updatePrefs(a.home)?.pendingUpdateVersion).toBeUndefined();
  });

  test('Cancel mid-download stops it, and the offer is still there afterwards', async () => {
    feed.stall = true; // the body never finishes; only a cancel ends it
    feed.body = [release('v9.9.9', 'notes', feed.assets())];
    a = await launch();
    const w = a.window;
    await shellReady(w);
    await dialog(w).getByRole('button', { name: 'Update' }).click();
    await expect(dialog(w)).toHaveAttribute('data-update-phase', 'downloading');

    await dialog(w).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(w)).toHaveAttribute('data-update-phase', 'cancelled', { timeout: 20_000 });
    // The offer is intact: all three answers are back, and nothing was staged.
    for (const label of ['Update', 'Ignore', 'Skip this version']) {
      await expect(dialog(w).getByRole('button', { name: label })).toBeVisible();
    }
    expect(fs.existsSync(staged())).toBe(false);

    // ...and closing the dialog without answering leaves the affordance standing.
    await w.keyboard.press('Escape');
    await expect(dialog(w)).toHaveCount(0);
    const notice = w.locator('[data-events-notice="available"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('9.9.9');
    await notice.getByRole('button', { name: 'Update' }).click();
    await expect(dialog(w)).toBeVisible();
  });

  test('a release with no sidecar takes the browser path — it never downloads', async () => {
    // A release built before the sidecar existed. E19-03's behaviour, intact:
    // Update hands off to the browser and the dialog closes.
    //
    // The release deliberately has NO `html_url`, so this stops one step short
    // of actually launching a browser: a suite that opened a real tab on every
    // run would be an unpleasant thing to leave behind, and `openExternal`'s
    // own allowlist is covered in `service.test.ts`. What is proved here is the
    // branch — no download, no staged file, dialog closed.
    const noUrl = release('v9.9.9', 'notes', [feed.assets()[0]]);
    delete noUrl.html_url;
    feed.body = [noUrl];
    a = await launch();
    const w = a.window;
    await shellReady(w);
    await dialog(w).getByRole('button', { name: 'Update' }).click();
    await expect(dialog(w)).toHaveCount(0);
    expect(fs.existsSync(staged())).toBe(false);
  });

  test('stale installers are swept at startup', async () => {
    // ~120 MB each in real life. One left by a crash is a bill nobody agreed to.
    const dir = path.join(temp, 'switchboard-updates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'switchboard-Setup-0.0.1.exe'), 'stale');
    feed.body = [];
    a = await launch();
    await shellReady(a.window);
    await poll(() => (fs.readdirSync(dir).length === 0 ? true : null));
  });
});
