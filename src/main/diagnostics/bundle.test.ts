import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildBundle, bundleName, bundleInfo, type BundleDeps } from './bundle';
import { UNKNOWN_BUILD_IDENTITY } from '../../shared/build-identity';
import { tempDir, cleanupTempDirs } from '../../test-temp-dirs';

afterEach(() => cleanupTempDirs());

function harness(opts: { logs?: Record<string, string>; workspace?: string } = {}): BundleDeps {
  const root = tempDir('sb-bundle-');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  for (const [name, body] of Object.entries(opts.logs ?? { 'switchboard.log': '{"a":1}\n' })) {
    fs.writeFileSync(path.join(logsDir, name), body);
  }
  if (opts.workspace !== undefined) {
    fs.writeFileSync(path.join(root, 'workspace.json'), opts.workspace);
  }
  return {
    logsDir,
    userDataDir: root,
    outDir: path.join(root, 'out'),
    version: '0.8.90',
    identity: UNKNOWN_BUILD_IDENTITY,
    uptimeMs: 65_000,
    now: () => new Date('2026-09-18T14:32:00Z'),
  };
}

describe('bundleName', () => {
  it('carries the version and a timestamp, so the file identifies itself', () => {
    // A bug report arrives as a file. "Which build, and when" has to be
    // answerable before anyone opens it.
    const name = bundleName('0.8.90', new Date(2026, 8, 18, 14, 32));
    expect(name).toBe('switchboard-logs-v0.8.90-2026-09-18-1432.zip');
  });

  it('pads single-digit months, days and times', () => {
    expect(bundleName('1.0.0', new Date(2026, 0, 3, 9, 5))).toBe(
      'switchboard-logs-v1.0.0-2026-01-03-0905.zip'
    );
  });
});

describe('bundleInfo', () => {
  it('states that transcripts are excluded ON PURPOSE', () => {
    // Otherwise a reader cannot tell "there were none" from "we chose not to
    // include them", and conversation content being absent is a DECISION.
    const info = bundleInfo(harness(), new Date(), []);
    expect(info).toMatch(/transcripts are deliberately NOT included/);
  });

  it('lists what could not be collected, rather than silently omitting it', () => {
    const info = bundleInfo(harness(), new Date(), [{ name: 'logs/x.log', reason: 'EBUSY' }]);
    expect(info).toContain('files that could not be included:');
    expect(info).toContain('logs/x.log: EBUSY');
  });

  it('carries the version and core count', () => {
    const info = bundleInfo(harness(), new Date(), []);
    expect(info).toContain('version:       0.8.90');
    expect(info).toMatch(/logical cores: \d+/);
  });
});

describe('buildBundle', () => {
  it('writes a real zip containing the logs', async () => {
    const deps = harness({ logs: { 'switchboard.log': 'x\n', 'switchboard.log.1': 'y\n' } });
    const r = await buildBundle(deps);

    expect(r.ok).toBe(true);
    expect(r.path).not.toBeNull();
    expect(r.bytes).toBeGreaterThan(0);
    // Assert it is genuinely a zip rather than unzipping it — the local zip
    // header magic. Reading it back would need a second dependency for no
    // extra confidence about OUR code.
    const head = fs.readFileSync(r.path as string).subarray(0, 4);
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('includes workspace.json when it exists, and says so when it does not', async () => {
    const withIt = await buildBundle(harness({ workspace: '{}' }));
    expect(withIt.skipped.map((s) => s.name)).not.toContain('workspace.json');

    const without = await buildBundle(harness());
    expect(without.ok).toBe(true); // still a bundle — this is not a failure
    expect(without.skipped).toContainEqual({ name: 'workspace.json', reason: 'not present' });
  });

  it('survives a missing logs directory instead of throwing', async () => {
    // Ordinary first-boot state, and the one moment someone is most likely to
    // be reporting a problem.
    const deps = harness();
    fs.rmSync(deps.logsDir, { recursive: true, force: true });

    const r = await buildBundle(deps);
    expect(r.ok).toBe(true);
    expect(r.skipped.some((s) => s.name === 'logs')).toBe(true);
  });

  it('reports a failure to write rather than throwing it', async () => {
    const deps = harness();
    // A file where the output DIRECTORY should be: mkdir cannot succeed.
    fs.writeFileSync(deps.outDir, 'not a directory');

    const r = await buildBundle(deps);
    expect(r.ok).toBe(false);
    expect(r.problem).toBe('bundle-failed');
    expect(r.path).toBeNull();
    expect(r.skipped.some((s) => s.name === 'the bundle itself')).toBe(true);
  });

  it('names the zip after the build and the moment, in the out dir', async () => {
    const r = await buildBundle(harness());
    expect(path.basename(r.path as string)).toMatch(/^switchboard-logs-v0\.8\.90-2026-09-18-\d{4}\.zip$/);
  });
});
