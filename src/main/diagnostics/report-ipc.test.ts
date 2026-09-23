import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { registerReportIpc, mailtoFor } from './report-ipc';
import { credentialStoreTokenFrom, type TokenSource } from '../update/token';
import type { IpcBroker } from '../ipc/broker';
import type { SecretStore } from '../secrets/store';
import type { Logger } from '../log/logger';
import type { BundleDeps } from './bundle';
import type { CreateIssueDeps, CreateIssueResult } from './github-issue';
import {
  GITHUB_TOKEN_SECRET_KEY,
  type ReportResult,
  type ReportStatus,
  type ReportWriteResult,
} from '../../shared/diagnostics';
import { UNKNOWN_BUILD_IDENTITY } from '../../shared/build-identity';
import { tempDir, cleanupTempDirs } from '../../test-temp-dirs';

afterEach(() => cleanupTempDirs());

/** captures what `registerReportIpc` registers so a test can call it */
function fakeBroker() {
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  const broker = {
    handle: (channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  } as unknown as IpcBroker;
  return {
    broker,
    submit: (draft: unknown) => handlers.get('diag:submit')?.(null, draft) as Promise<ReportResult>,
    status: () => handlers.get('diag:reportStatus')?.(null) as Promise<ReportStatus>,
    setToken: (v: unknown) =>
      handlers.get('diag:setGitHubToken')?.(null, v) as Promise<ReportWriteResult>,
  };
}

function harness(
  opts: {
    issue?: CreateIssueResult;
    ghToken?: string | null;
    storeAvailable?: boolean;
    /** make the store REFUSE writes, as a machine with no keyring does */
    writeOk?: boolean;
    outDirIsAFile?: boolean;
    tokenSources?: () => TokenSource[];
  } = {}
) {
  const root = tempDir('sb-report-ipc-');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'switchboard.log'), '{"msg":"hello"}\n');

  const outDir = path.join(root, 'out');
  if (opts.outDirIsAFile) fs.writeFileSync(outDir, 'blocked');

  const bundleDeps = (): BundleDeps => ({
    logsDir,
    userDataDir: root,
    outDir,
    version: '0.8.90',
    identity: UNKNOWN_BUILD_IDENTITY,
    uptimeMs: 1000,
    now: () => new Date('2026-09-18T14:32:00Z'),
  });

  // Captured as consts, and asserted on as consts: reading a mock back off the
  // object it lives on (`h.sh.openExternal`) is an unbound method reference.
  const showItemInFolder = vi.fn<(p: string) => void>();
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const fileIssue = vi.fn<(d: CreateIssueDeps) => Promise<CreateIssueResult>>(() =>
    Promise.resolve(opts.issue ?? { ok: true, url: 'https://github.com/o/r/issues/9', number: 9 })
  );

  // A REAL little store, not constant answers. `has()` used to be a fixed
  // boolean, which meant the "it stored the token" test would have passed with
  // `set` never called at all.
  const stored = new Map<string, string>();
  if (opts.ghToken) stored.set(GITHUB_TOKEN_SECRET_KEY, opts.ghToken);
  const setSecret = vi.fn<(k: string, v: string) => boolean>((k, v) => {
    if (opts.writeOk === false) return false;
    stored.set(k, v);
    return true;
  });
  const clearSecret = vi.fn<(k: string) => boolean>((k) => {
    stored.delete(k);
    return true;
  });
  const secrets = {
    available: () => opts.storeAvailable ?? true,
    has: (k: string) => stored.has(k),
    get: (k: string) => stored.get(k) ?? null,
    set: setSecret,
    clear: clearSecret,
  } as unknown as SecretStore;

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const f = fakeBroker();
  registerReportIpc({
    broker: f.broker,
    log,
    secrets,
    bundleDeps,
    sh: { showItemInFolder, openExternal },
    fileIssue,
    // THE CREDENTIAL STORE SOURCE ONLY — deliberately never `ghCliToken`.
    // Without this the chain falls through to the real one and the suite shells
    // out to `gh auth token` on whoever's machine is running it: slow, a live
    // read of a real credential store, and green for the wrong reason on any
    // machine where `gh` happens to be signed in.
    tokenSources: opts.tokenSources ?? (() => [credentialStoreTokenFrom(secrets)]),
  });
  return { ...f, showItemInFolder, openExternal, setSecret, clearSecret, fileIssue, stored, root };
}

describe('diag:submit — the guard', () => {
  it('refuses a report with no subject, and builds nothing', async () => {
    const h = harness();
    const r = await h.submit({ subject: '   ', description: 'x', destination: 'github' });
    expect(r.problem).toBe('empty-subject');
    expect(r.bundle.path).toBeNull();
    expect(h.fileIssue).not.toHaveBeenCalled();
  });
});

describe('diag:submit — the zip is always written and always revealed', () => {
  it.each(['zip', 'email', 'github'] as const)(
    'reveals the bundle for the %s destination',
    async (destination) => {
      // The fail-open half: whatever the network does next, the evidence is on
      // disk and the user is looking at it.
      const h = harness();
      const r = await h.submit({ subject: 's', description: 'd', destination });
      expect(r.bundle.ok).toBe(true);
      expect(h.showItemInFolder).toHaveBeenCalledWith(r.bundle.path);
    }
  );

  it('files the issue even when the zip could not be written', async () => {
    // Refusing here would lose the user's typed description as well as the
    // logs, and the inline diagnostics are most of the value anyway.
    const h = harness({ outDirIsAFile: true });
    const r = await h.submit({ subject: 's', description: 'd', destination: 'github' });
    expect(r.bundle.ok).toBe(false);
    expect(h.fileIssue).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});

describe('diag:submit — destinations', () => {
  it('github: posts the subject as the title and answers with the issue', async () => {
    const h = harness();
    const r = await h.submit({
      subject: 'CPU pegged',
      description: 'the fans spun up',
      destination: 'github',
    });
    expect(r.url).toBe('https://github.com/o/r/issues/9');
    expect(r.number).toBe(9);

    const arg = h.fileIssue.mock.calls[0][0];
    expect(arg.title).toBe('CPU pegged');
    expect(arg.body).toContain('the fans spun up');
    // the honest sentence about attachments travels with every issue
    expect(arg.body).toContain('not attached');
  });

  it('github: the performance numbers reach the issue body (#927)', async () => {
    const h = harness();
    await h.submit({
      subject: 's',
      description: 'd',
      destination: 'github',
      perf: {
        interactions: [{ name: 'keystroke', count: 20, p50: 8, p95: 400, worst: 400 }],
        longTasks: { count: 3, totalMs: 295, worstMs: 180 },
        detail: null,
        loop: { p50: 1.2, p99: 48, maxMs: 310 },
      },
    });
    const body = h.fileIssue.mock.calls[0][0].body;
    expect(body).toContain('### Responsiveness');
    expect(body).toContain('keystroke');
  });

  it('github: a hostile perf payload is REBUILT, not posted (#927)', async () => {
    // The one path in the app where local data leaves the machine on purpose,
    // so the draft crosses the same trust boundary as everything else the
    // renderer sends. `sanitizeSummary` rebuilds field by field.
    const h = harness();
    await h.submit({
      subject: 's',
      description: 'd',
      destination: 'github',
      perf: {
        prompt: 'the secret project plan',
        interactions: [
          { name: '/home/dan/secret-project.ts', count: 1, p50: 1, p95: 1, worst: 1 },
        ],
      },
    });
    const body = h.fileIssue.mock.calls[0][0].body;
    expect(body).not.toContain('secret');
    expect(body).not.toContain('project plan');
  });

  it('github: a report with NO perf still files, and says the section is missing (#927)', async () => {
    // Fail-open. A report about the app feeling slow is the last thing that
    // should be lost to a failure in the code that measures slowness.
    const h = harness();
    const r = await h.submit({ subject: 's', description: 'd', destination: 'github' });
    expect(r.ok).toBe(true);
    expect(h.fileIssue.mock.calls[0][0].body).toMatch(/Not collected/);
  });

  it('github: a refusal is reported WITH the bundle still on disk', async () => {
    const h = harness({ issue: { ok: false, url: null, number: null, problem: 'no-token' } });
    const r = await h.submit({ subject: 's', description: 'd', destination: 'github' });
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('no-token');
    expect(r.bundle.path).not.toBeNull();
  });

  it('email: opens a mailto and never touches GitHub', async () => {
    const h = harness();
    const r = await h.submit({ subject: 'Logs for you', description: 'd', destination: 'email' });
    expect(h.fileIssue).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    const url = h.openExternal.mock.calls[0][0];
    expect(url.startsWith('mailto:')).toBe(true);
    expect(url).toContain(encodeURIComponent('Logs for you'));
  });

  it('email: a mail app that will not open is a FAILURE, not a quiet success (#896)', async () => {
    // The dialog closes on success, so reporting ok here would close it on
    // words that went nowhere.
    const h = harness();
    h.openExternal.mockImplementationOnce(() => Promise.reject(new Error('no mail handler')));
    const r = await h.submit({ subject: 's', description: 'd', destination: 'email' });
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('mail-failed');
    // and the zip is still on disk and shown — the fail-open half
    expect(h.showItemInFolder).toHaveBeenCalled();
  });

  it('zip: builds and reveals, and calls nothing out', async () => {
    const h = harness();
    const r = await h.submit({ subject: 's', description: 'd', destination: 'zip' });
    expect(r.ok).toBe(true);
    expect(h.fileIssue).not.toHaveBeenCalled();
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('an unknown destination falls back to zip rather than guessing github', async () => {
    // It arrives over IPC, so it is untrusted input; the safe default is the
    // one that sends nothing anywhere.
    const h = harness();
    const r = await h.submit({ subject: 's', description: 'd', destination: 'nonsense' });
    expect(r.destination).toBe('zip');
    expect(h.fileIssue).not.toHaveBeenCalled();
  });
});

describe('mailtoFor', () => {
  it('names the zip path so it can be attached, and encodes the subject', () => {
    const url = mailtoFor('a subject & more', 'C:\\tmp\\bundle.zip');
    expect(url).toContain(encodeURIComponent('a subject & more'));
    expect(decodeURIComponent(url)).toContain('C:\\tmp\\bundle.zip');
  });

  it('does not claim the bundle is attached, in a mail that has no attachment', () => {
    expect(decodeURIComponent(mailtoFor('s', 'C:\\tmp\\b.zip'))).toContain('was written to');
  });

  it('says so when there is no zip, rather than naming nothing', () => {
    expect(decodeURIComponent(mailtoFor('s', null))).toContain('could not be written');
  });
});

describe('the credential channels', () => {
  it('stores a token and reports it, without ever answering with a value', async () => {
    const h = harness();
    const r = await h.setToken('  ghp_secret  ');
    expect(h.setSecret).toHaveBeenCalledWith('github.token', 'ghp_secret');
    expect(r.ok).toBe(true);
    // true because the write really happened — the fake store is stateful, so
    // this fails if `set` is never called
    expect(r.status.tokenStored).toBe(true);
    expect(JSON.stringify(r)).not.toContain('ghp_secret');
  });

  it('reports a REFUSED write instead of letting it read as success', async () => {
    // A machine with no keyring, an over-long paste, a failed encrypt: the
    // store answers false, and the user must not be left believing otherwise.
    const h = harness({ writeOk: false });
    const r = await h.setToken('ghp_secret');
    expect(r.ok).toBe(false);
    expect(r.status.tokenStored).toBe(false);
  });

  it('an empty string FORGETS the token, matching push:setSecret', async () => {
    const h = harness({ ghToken: 'ghp_old' });
    const r = await h.setToken('   ');
    expect(h.clearSecret).toHaveBeenCalledWith('github.token');
    expect(h.setSecret).not.toHaveBeenCalled();
    expect(r.status.tokenStored).toBe(false);
  });

  it('reportStatus says a token is resolvable when the store holds one', async () => {
    const h = harness({ ghToken: 'ghp_from_store' });
    const s = await h.status();
    expect(s.canFileIssue).toBe(true);
    expect(s.tokenStored).toBe(true);
  });

  it('reportStatus says NO when nothing can supply one', async () => {
    // The inverse case, which could not exist while the chain fell through to
    // the real `gh`: on a machine where it is signed in, this would have been
    // green no matter what the credential store did.
    const h = harness({ tokenSources: () => [] });
    expect((await h.status()).canFileIssue).toBe(false);
  });

  it('a token source that throws is a source with no token, not a crash', async () => {
    const h = harness({
      tokenSources: () => [
        {
          id: 'broken',
          resolve: () => Promise.reject(new Error('keyring exploded')),
        },
      ],
    });
    expect((await h.status()).canFileIssue).toBe(false);
  });

  it('reportStatus reports a machine that cannot keep secrets at all', async () => {
    const h = harness({ storeAvailable: false });
    expect((await h.status()).storeAvailable).toBe(false);
  });
});
