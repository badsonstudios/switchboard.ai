// The install orchestrator (P2-E19-04).
//
// The four claims worth holding, in the order the item makes them:
//
//   1. **nothing is executed before the checksum matches** — and a mismatch
//      deletes the file rather than keeping it around "to retry";
//   2. **one install at a time**, so a timer tick or a double-click cannot put
//      two writers on one temp file;
//   3. **the handshake** survives the only process that could have reported it
//      being replaced — and is cleared either way, so nothing nags forever;
//   4. **fail-open**: every unhappy path is a record with a reason, and the
//      user is left exactly where they were before this feature existed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { UpdateInstaller, pickInstallerAsset, resolveHandshake, resolveOffer } from './install';
import { DownloadError } from './download';
import type { UpdateCheckResult, UpdateInstallStatus, UpdatePrefs } from '../../shared/update';

const ASSET = 'https://api.github.com/repos/o/r/releases/assets/1';
const SIDECAR = 'https://api.github.com/repos/o/r/releases/assets/2';
const NAME = 'switchboard-Setup-9.9.9.exe';

function offer(over: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    ok: true,
    state: 'available',
    currentVersion: '0.1.0',
    latestVersion: '9.9.9',
    url: 'https://github.com/badsonstudios/switchboard.ai/releases/tag/v9.9.9',
    checkedAt: '2026-08-06T00:00:00.000Z',
    download: { name: NAME, url: ASSET, checksumUrl: SIDECAR, size: 100 },
    ...over,
  };
}

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

interface Harness {
  installer: UpdateInstaller;
  dir: string;
  pushed: UpdateInstallStatus[];
  prefs: UpdatePrefs;
  launched: string[];
  download: ReturnType<typeof vi.fn>;
}

/**
 * A whole installer under test, plus the temp dir it stages into.
 *
 * The directory is registered rather than remembered here (#213, #360): every
 * one of them is per-test, and `cleanupTempDirs()` in the `afterEach` below
 * takes them all — including the ones belonging to a test that threw before it
 * could reach a teardown of its own.
 */
function make(over: Record<string, unknown> = {}): Harness {
  const dir = tempDir('sb-install-');
  const pushed: UpdateInstallStatus[] = [];
  const prefs: UpdatePrefs = { autoCheck: true };
  const launched: string[] = [];
  // The default happy path: write the bytes, vouch for them, launch.
  const download = vi.fn(async (o: { dest: string; onProgress?: (r: number, t: number) => void }) => {
    o.onProgress?.(50, 100);
    await fs.promises.mkdir(path.dirname(o.dest), { recursive: true });
    await fs.promises.writeFile(o.dest, 'installer');
    o.onProgress?.(100, 100);
    return 100;
  });
  const installer = new UpdateInstaller({
    currentVersion: '0.1.0',
    updateDir: path.join(dir, 'updates'),
    getPrefs: () => ({ ...prefs }),
    setPrefs: (p) => Object.assign(prefs, p),
    push: (s) => pushed.push(s),
    log: silentLog,
    platform: 'win32',
    skipToken: true,
    quitAndRun: (file) => {
      launched.push(file);
      return 'quit' as const;
    },
    downloadImpl: download as never,
    fetchTextImpl: (async () => 'sidecar-text') as never,
    verifyImpl: (async () => true) as never,
    ...over,
  });
  return { installer, dir, pushed, prefs, launched, download };
}

const phases = (h: Harness): string[] => h.pushed.map((s) => s.phase);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanupTempDirs();
});

describe('the happy path, in order', () => {
  it('downloads, verifies, remembers the pending version, THEN launches', async () => {
    const h = make();
    const final = await h.installer.install(offer());

    expect(phases(h)).toEqual(['downloading', 'downloading', 'downloading', 'verifying', 'launching']);
    expect(final.phase).toBe('launching');
    expect(h.launched).toEqual([path.join(h.dir, 'updates', NAME)]);
    // Written BEFORE the launch — after it there may be no process left to write.
    expect(h.prefs.pendingUpdateVersion).toBe('9.9.9');
  });

  it('carries the release page along, so every face has a fallback to offer', async () => {
    const h = make();
    await h.installer.install(offer());
    for (const s of h.pushed) expect(s.url).toContain('/releases/tag/v9.9.9');
  });

  it('progress is reported with real numbers', async () => {
    const h = make();
    await h.installer.install(offer());
    expect(h.pushed[1]).toMatchObject({ phase: 'downloading', received: 50, total: 100 });
  });
});

describe('nothing runs unless the checksum matches', () => {
  it('a MISMATCH deletes the file, never executes it, and says why', async () => {
    // The item's second done-when, and the reason an unsigned build is
    // acceptable at all.
    const h = make({ verifyImpl: async () => false });
    const final = await h.installer.install(offer());

    expect(final).toMatchObject({ phase: 'failed', reason: 'checksum' });
    expect(h.launched).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, 'updates', NAME))).toBe(false);
    expect(h.prefs.pendingUpdateVersion).toBeUndefined();
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not match its checksum'),
      expect.anything()
    );
  });

  it('an unfetchable sidecar is a failure too — no sidecar, no install', async () => {
    const h = make({
      fetchTextImpl: async () => {
        throw new DownloadError('auth', 'nope');
      },
    });
    const final = await h.installer.install(offer());
    expect(final).toMatchObject({ phase: 'failed', reason: 'auth' });
    expect(h.launched).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, 'updates', NAME))).toBe(false);
  });
});

describe('re-entrancy — one install at a time', () => {
  it('a second install() joins the first instead of starting another download', async () => {
    // "A timer tick during a download must not double-prompt", one layer down:
    // even if something does call twice, there is one download.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = make({
      downloadImpl: async (o: { dest: string }) => {
        await gate;
        await fs.promises.writeFile(o.dest, 'installer');
        return 100;
      },
    });
    const a = h.installer.install(offer());
    const b = h.installer.install(offer());
    expect(h.installer.busy()).toBe(true);
    release();
    expect(await a).toEqual(await b);
    expect(h.launched).toHaveLength(1);
    expect(h.installer.busy()).toBe(false);
  });

  it('busy() is false again after a failure, so a retry is possible', async () => {
    const h = make({ verifyImpl: async () => false });
    await h.installer.install(offer());
    expect(h.installer.busy()).toBe(false);
  });
});

describe('cancel', () => {
  it('reports a CANCEL rather than a network failure, and leaves nothing behind', async () => {
    const h = make({
      downloadImpl: async (o: { dest: string; signal?: AbortSignal }) => {
        await fs.promises.mkdir(path.dirname(o.dest), { recursive: true });
        await fs.promises.writeFile(o.dest, 'half');
        await new Promise<void>((_r, reject) =>
          o.signal?.addEventListener('abort', () => reject(new DownloadError('network', 'cancelled')))
        );
        return 0;
      },
    });
    const p = h.installer.install(offer());
    // one turn of the loop, so the download is genuinely under way rather than
    // cancelled before it started (which would prove nothing)
    await new Promise((r) => setTimeout(r, 20));
    expect(h.installer.busy()).toBe(true);
    h.installer.cancel();
    const final = await p;

    expect(final.phase).toBe('cancelled');
    expect(final.reason).toBeUndefined(); // a cancel is not a failure
    expect(h.launched).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, 'updates', NAME))).toBe(false);
    expect(h.prefs.pendingUpdateVersion).toBeUndefined();
  });

  it('cancel with nothing running is a no-op, not a crash', () => {
    const h = make();
    expect(() => h.installer.cancel()).not.toThrow();
  });
});

describe('the refusals — every one of them fail-open', () => {
  it('refuses on a platform we do not package an installer for', async () => {
    const h = make({ platform: 'darwin' });
    expect(await h.installer.install(offer())).toMatchObject({
      phase: 'failed',
      reason: 'unsupported',
    });
    expect(h.download).not.toHaveBeenCalled();
  });

  it('refuses a release with no verifiable installer', async () => {
    const h = make();
    expect(await h.installer.install(offer({ download: undefined }))).toMatchObject({
      reason: 'no-asset',
    });
  });

  it('refuses an asset NAME that is not a plain file name', async () => {
    // The name comes off the network and becomes a path. Matched, not escaped.
    const h = make();
    for (const name of ['../../evil.exe', 'a\\b.exe', 'setup.exe.txt', '.exe', '']) {
      const result = await h.installer.install(
        offer({ download: { name, url: ASSET, checksumUrl: SIDECAR, size: 1 } })
      );
      expect(result, name).toMatchObject({ reason: 'no-asset' });
    }
    expect(h.download).not.toHaveBeenCalled();
  });

  it('refuses when no token can be resolved, rather than downloading anonymously', async () => {
    const h = make({ skipToken: false, tokenSources: [] });
    expect(await h.installer.install(offer())).toMatchObject({ reason: 'no-token' });
    expect(h.download).not.toHaveBeenCalled();
  });

  it('a declined quit rolls the pending version back — nothing was replaced', async () => {
    // The user answered "cancel" to the mid-task quit question. A pending
    // version left behind would warn on the next launch about an install that
    // never happened.
    const h = make({ quitAndRun: () => 'declined' as const });
    const final = await h.installer.install(offer());
    expect(final.phase).toBe('cancelled');
    // A decline is not a failure — nothing went wrong and nothing is offered
    // as a fix.
    expect(final.reason).toBeUndefined();
    expect(h.prefs.pendingUpdateVersion).toBeFalsy();
    // …and the ~120 MB nobody is going to run goes with it, rather than sitting
    // in temp until the next startup sweep.
    expect(fs.existsSync(path.join(h.dir, 'updates', NAME))).toBe(false);
  });

  it('an OS that will not start the installer is a FAILURE, not a silent re-offer', async () => {
    // Distinct from a decline on purpose: this one needs the browser fallback,
    // and reporting it as a cancel left the user pressing a button that had
    // just quietly done nothing.
    const h = make({ quitAndRun: () => 'failed' as const });
    expect(await h.installer.install(offer())).toMatchObject({
      phase: 'failed',
      reason: 'launch',
    });
    expect(h.prefs.pendingUpdateVersion).toBeFalsy();
  });

  it('a quitAndRun that THROWS rolls the pending version back too', async () => {
    // It reaches a native message box and a spawn. The rollback lives in the
    // catch as well as the branch, because the pending flag is the only update
    // state that outlives this process — left set, the next run warns about an
    // install that never started.
    const h = make({
      quitAndRun: () => {
        throw new Error('showMessageBoxSync blew up');
      },
    });
    expect(await h.installer.install(offer())).toMatchObject({
      phase: 'failed',
      reason: 'launch',
    });
    expect(h.prefs.pendingUpdateVersion).toBeFalsy();
  });

  it('a download that throws something unexpected is still just a record', async () => {
    const h = make({
      downloadImpl: () => {
        throw new TypeError('something nobody predicted');
      },
    });
    expect(await h.installer.install(offer())).toMatchObject({ phase: 'failed', reason: 'network' });
  });

  it('a push that throws does not take the install down', async () => {
    // The window died mid-download. The install is not the window's business.
    const h = make({
      push: () => {
        throw new Error('window is gone');
      },
    });
    expect(await h.installer.install(offer())).toMatchObject({ phase: 'launching' });
  });
});

describe('the startup sweep', () => {
  it('empties the staging directory — a stranded installer is ~120 MB', async () => {
    const h = make();
    const dir = path.join(h.dir, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old-Setup-1.0.0.exe'), 'x');
    fs.writeFileSync(path.join(dir, 'old-Setup-1.0.0.exe.sha256'), 'x');
    await h.installer.sweep();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a missing directory is the ordinary case, not an error', async () => {
    const h = make();
    await expect(h.installer.sweep()).resolves.toBeUndefined();
  });
});

describe('the post-update handshake', () => {
  const deps = (prefs: UpdatePrefs, currentVersion: string) => {
    const log = { info: vi.fn(), warn: vi.fn() };
    return {
      currentVersion,
      getPrefs: () => ({ ...prefs }),
      setPrefs: (p: Partial<UpdatePrefs>) => Object.assign(prefs, p),
      log,
    };
  };

  it('an ordinary launch has no news', () => {
    expect(resolveHandshake(deps({ autoCheck: true }, '0.1.0'))).toBeNull();
  });

  it('pending === running is the confirmation — and the flag is cleared', () => {
    const prefs: UpdatePrefs = { autoCheck: true, pendingUpdateVersion: '0.2.0' };
    const d = deps(prefs, '0.2.0');
    expect(resolveHandshake(d)).toEqual({ updatedTo: '0.2.0' });
    expect(prefs.pendingUpdateVersion).toBe('');
    expect(d.log.info).toHaveBeenCalled();
    // …and a second run says nothing, because the flag is gone
    expect(resolveHandshake(deps(prefs, '0.2.0'))).toBeNull();
  });

  it('pending !== running is a WARNING, not a congratulation — and still clears', () => {
    // The installer was closed at the first prompt, or failed. Left set, this
    // would warn on every launch for the rest of the install's life.
    const prefs: UpdatePrefs = { autoCheck: true, pendingUpdateVersion: '0.2.0' };
    const d = deps(prefs, '0.1.0');
    expect(resolveHandshake(d)).toBeNull();
    expect(d.log.warn).toHaveBeenCalledWith(expect.any(String), {
      expected: '0.2.0',
      running: '0.1.0',
    });
    expect(prefs.pendingUpdateVersion).toBe('');
  });
});

describe('the stale offer — pressing Update on a release that is gone (#315)', () => {
  // The race: a window is open on "v9.9.9 is available", the release is
  // withdrawn, the daily check notices, and THEN the user presses Update. Main
  // is the side that decides what gets installed, so the press is refused —
  // this block is about refusing it with the right reason attached.

  it('lets a live offer through, unchanged', () => {
    const live = offer();
    const decision = resolveOffer(live);
    expect(decision.ok).toBe(true);
    // The same object, not a copy: what gets installed is what was checked.
    expect(decision.ok && decision.offer).toBe(live);
  });

  it('refuses a WITHDRAWN release as `no-offer` — never as `no-asset`', () => {
    // THE defect. The release went away, so the next check answered
    // "up-to-date"; the dialog on screen still shows the old offer.
    const decision = resolveOffer({
      ok: true,
      state: 'up-to-date',
      currentVersion: '0.1.0',
      checkedAt: '2026-08-06T01:00:00.000Z',
    });
    expect(decision).toEqual({
      ok: false,
      status: { phase: 'failed', version: '', received: 0, total: 0, reason: 'no-offer' },
    });
  });

  it('names no version — the newest release is not the one they pressed Update on', () => {
    // `latestVersion` on an up-to-date result is whatever is newest NOW, which
    // is a different release from the one whose notes are on screen. Reporting
    // it would be a second small lie in the same sentence.
    const decision = resolveOffer({
      ok: true,
      state: 'up-to-date',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      checkedAt: '2026-08-06T01:00:00.000Z',
    });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.status.version).toBe('');
  });

  it('refuses every not-available state, and a check that never ran', () => {
    // Withdrawn, superseded, or a later check that could not reach the feed:
    // main is not standing behind a release in any of them, and the user's next
    // move — ask again — is the same.
    const base = { currentVersion: '0.1.0', checkedAt: '2026-08-06T01:00:00.000Z' };
    const states: Array<UpdateCheckResult> = [
      { ...base, ok: true, state: 'up-to-date' },
      { ...base, ok: false, state: 'failed', reason: 'network' },
      { ...base, ok: false, state: 'failed', reason: 'auth' },
      { ...base, ok: false, state: 'disabled', reason: 'no-token' },
    ];
    for (const result of states) {
      const decision = resolveOffer(result);
      expect(decision.ok, result.state + '/' + result.reason).toBe(false);
      expect(!decision.ok && decision.status.reason).toBe('no-offer');
    }
    // …and the boundary case: an install requested before any check completed.
    expect(resolveOffer(null)).toMatchObject({ ok: false, status: { reason: 'no-offer' } });
  });

  it('is a fail-open record like every other refusal — nothing thrown, nothing running', () => {
    const decision = resolveOffer(null);
    expect(!decision.ok && decision.status.phase).toBe('failed');
    // A terminal phase with no bytes claimed: the dialog must not show a
    // progress bar for a download that never started.
    expect(!decision.ok && decision.status.received).toBe(0);
    expect(!decision.ok && decision.status.total).toBe(0);
  });
});

describe('picking the installer out of a release', () => {
  const asset = (name: string, id: number) => ({
    name,
    url: `https://api.github.com/repos/o/r/releases/assets/${id}`,
    size: 1234,
  });

  it('takes the installer AND its sidecar, by API url', () => {
    const picked = pickInstallerAsset([asset(NAME, 7), asset(`${NAME}.sha256`, 8)], 'win32');
    expect(picked).toEqual({
      name: NAME,
      url: 'https://api.github.com/repos/o/r/releases/assets/7',
      checksumUrl: 'https://api.github.com/repos/o/r/releases/assets/8',
      size: 1234,
    });
  });

  it('BOTH or neither — an installer with no sidecar is not offered', () => {
    // No checksum, no integrity check, no auto-install. This is also why the
    // release workflow treats a missing sidecar as a build failure.
    expect(pickInstallerAsset([asset(NAME, 7)], 'win32')).toBeNull();
    expect(pickInstallerAsset([asset(`${NAME}.sha256`, 8)], 'win32')).toBeNull();
  });

  it('prefers the artifact electron-builder is configured to produce', () => {
    const picked = pickInstallerAsset(
      [asset('something-else.exe', 1), asset(NAME, 7), asset(`${NAME}.sha256`, 8)],
      'win32'
    );
    expect(picked?.name).toBe(NAME);
  });

  it('two unrecognised installers is no installer — never a coin toss', () => {
    expect(
      pickInstallerAsset(
        [asset('a.exe', 1), asset('a.exe.sha256', 2), asset('b.exe', 3), asset('b.exe.sha256', 4)],
        'win32'
      )
    ).toBeNull();
  });

  it('finds nothing on a platform we do not package for, and survives junk', () => {
    expect(pickInstallerAsset([asset(NAME, 7), asset(`${NAME}.sha256`, 8)], 'linux')).toBeNull();
    expect(pickInstallerAsset(null, 'win32')).toBeNull();
    expect(pickInstallerAsset([null, 42, { name: 5 }, {}], 'win32')).toBeNull();
  });

  it('a missing or nonsense size becomes 0 — indeterminate, not NaN in the UI', () => {
    const picked = pickInstallerAsset(
      [{ name: NAME, url: ASSET, size: 'huge' }, { name: `${NAME}.sha256`, url: SIDECAR }],
      'win32'
    );
    expect(picked?.size).toBe(0);
  });
});
