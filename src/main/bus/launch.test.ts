import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { busLaunch, busServerPath } from './launch';

const ENDPOINT = { pipePath: '\\\\.\\pipe\\switchboard-bus-abc123', tokenPath: '/state/sb-1/bus-token' };
const recipe = (): ReturnType<typeof busLaunch> => busLaunch('sb-1', ENDPOINT, '/out/main/bus-server.js');

describe('busLaunch — which binary runs the server', () => {
  it('runs the ELECTRON binary, not node on PATH', () => {
    // Measured 2026-09-08: `ELECTRON_RUN_AS_NODE=1 electron.exe <app.asar>/x.js`
    // runs and can read siblings inside the archive; `node <app.asar>/x.js` is
    // MODULE_NOT_FOUND. The bus server is a rollup entry, so packaged it lives
    // INSIDE app.asar — node cannot run it at all. `findNodeOnPath()` is the
    // hook forwarder's precedent and the wrong one here.
    expect(recipe().command).toBe(process.execPath);
  });

  it('sets ELECTRON_RUN_AS_NODE deliberately', () => {
    // `providers/claude.ts` STRIPS this from the session's own environment (an
    // S-01 landmine), so it has to be re-added on the server entry's env block.
    expect(recipe().env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('puts the token PATH on argv and never the token (S-03)', () => {
    const { args } = recipe();
    expect(args).toContain('--token-file');
    expect(args[args.indexOf('--token-file') + 1]).toBe(ENDPOINT.tokenPath);
    // argv is world-readable on every platform we ship. Nothing that looks
    // like a 64-hex secret may appear in it.
    expect(args.join(' ')).not.toMatch(/[0-9a-f]{64}/);
  });

  it('carries the identity the CLI passes through verbatim (§5.4)', () => {
    const { args } = recipe();
    expect(args[args.indexOf('--session') + 1]).toBe('sb-1');
    expect(args[args.indexOf('--pipe') + 1]).toBe(ENDPOINT.pipePath);
  });

  it('names the script FIRST — a flag before it would be parsed as the entry', () => {
    expect(recipe().args[0]).toBe('/out/main/bus-server.js');
  });

  it('every flag has a value', () => {
    const { args } = recipe();
    for (const flag of ['--session', '--pipe', '--token-file']) {
      const i = args.indexOf(flag);
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBeTruthy();
      expect(args[i + 1].startsWith('--')).toBe(false);
    }
  });

  it('does not scrub the caller’s environment — it is a DELTA', () => {
    // #763 merges this into the MCP config's `env` block. Returning a whole
    // environment here would silently drop everything the child inherits.
    expect(Object.keys(recipe().env)).toEqual(['ELECTRON_RUN_AS_NODE']);
  });
});

describe('busServerPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bus-path-'));
    fs.mkdirSync(path.join(dir, 'chunks'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('throws a NAMED error when the bundle is missing', () => {
    // `fake-stream.ts`'s lesson: a wrong path failed as a 15-second spawn
    // timeout rather than an error, because a child that cannot resolve its
    // script dies on stderr while the parent waits on stdout.
    expect(() => busServerPath(dir)).toThrow(/bus-server\.js not found|npm run build/);
  });

  it('finds the bundle beside it (the unbundled case)', () => {
    const file = path.join(dir, 'bus-server.js');
    fs.writeFileSync(file, '');
    expect(busServerPath(dir)).toBe(file);
  });

  it('finds the bundle ONE UP when rollup put this module in chunks/', () => {
    // The arm that existed for a real failure and was executed by nothing: the
    // only test asserted the not-found throw, which passes precisely because
    // NEITHER candidate exists. Deleting this candidate left every test green.
    const file = path.join(dir, 'bus-server.js');
    fs.writeFileSync(file, '');
    expect(busServerPath(path.join(dir, 'chunks'))).toBe(path.join(dir, 'chunks', '..', 'bus-server.js'));
  });

  it('prefers the sibling over the one above it', () => {
    fs.writeFileSync(path.join(dir, 'bus-server.js'), '');
    fs.writeFileSync(path.join(dir, 'chunks', 'bus-server.js'), '');
    expect(busServerPath(path.join(dir, 'chunks'))).toBe(path.join(dir, 'chunks', 'bus-server.js'));
  });
});
