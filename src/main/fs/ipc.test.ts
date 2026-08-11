// The `fs:read` channel end to end in main (P2-E16-01, §5.30 + §5.23).
//
// `read-scope.test.ts` pins the RULE and `read-file.test.ts` pins the READ;
// this pins that the handler obeys both and, just as importantly, that a
// refusal is written down. "Refused and logged" is the done-when, and a check
// that refuses silently is a check nobody can debug at 11pm.
//
// The fake broker is `sessions/ipc.test.ts`'s, for the same reason it exists
// there: it lets a channel be called without an Electron process.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { tempDir } from '../../test-temp-dirs';
import { Logger } from '../log/logger';
import { FileReadResult } from '../../shared/ipc/fs';
import { registerFsIpc } from './ipc';
import { ReadScope } from './read-scope';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

function fakeBroker() {
  const handlers = new Map<string, Handler>();
  return {
    broker: {
      handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    } as never,
    channels: () => [...handlers.keys()],
    call: (channel: string, ...args: unknown[]): Promise<FileReadResult> => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`nothing registered on ${channel}`);
      return Promise.resolve(fn({}, ...args) as FileReadResult);
    },
  };
}

/** A logger that keeps its lines, so "and logged" is assertable. */
function recordingLog(): { log: Logger; lines: Array<{ level: string; msg: string; fields?: unknown }> } {
  const lines: Array<{ level: string; msg: string; fields?: unknown }> = [];
  const at =
    (level: string) =>
    (msg: string, fields?: unknown): void => {
      lines.push({ level, msg, fields });
    };
  const log = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => log,
  } as unknown as Logger;
  return { log, lines };
}

const BASE = tempDir('sb-fsipc-');
const ROOT = path.join(BASE, 'project');
const OUTSIDE = path.join(BASE, 'secrets');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'PROGRESS.md'), '# progress\n');
fs.writeFileSync(path.join(ROOT, 'big.log'), 'z'.repeat(500));
fs.writeFileSync(path.join(OUTSIDE, 'id_rsa'), 'PRIVATE KEY\n');

describe('fs:read', () => {
  let bus: ReturnType<typeof fakeBroker>;
  let rec: ReturnType<typeof recordingLog>;
  let scope: ReadScope;

  beforeEach(() => {
    bus = fakeBroker();
    rec = recordingLog();
    scope = new ReadScope({ sessionFolders: () => [ROOT], log: rec.log });
    registerFsIpc({ broker: bus.broker, log: rec.log, scope, cap: 100 });
  });

  it('registers exactly one channel, and it is the one in the capability map', () => {
    expect(bus.channels()).toEqual(['fs:read']);
  });

  it('reads a file inside an open session folder', async () => {
    const r = await bus.call('fs:read', path.join(ROOT, 'PROGRESS.md'));
    expect(r).toMatchObject({ ok: true, text: '# progress\n', truncated: false });
  });

  it('refuses a path outside every root — AND logs it', async () => {
    const target = path.join(OUTSIDE, 'id_rsa');
    const r = await bus.call('fs:read', target);
    expect(r).toEqual({ ok: false, reason: 'out-of-scope' });
    // no bytes came back
    expect(JSON.stringify(r)).not.toContain('PRIVATE KEY');
    const line = rec.lines.find((l) => l.msg === 'fs:read refused: out-of-scope');
    expect(line?.level).toBe('warn');
    expect(line?.fields).toMatchObject({ path: target });
  });

  it('refuses a ../ climb out of the root, and logs the path that was ASKED for', async () => {
    const asked = path.join(ROOT, '..', 'secrets', 'id_rsa');
    expect(await bus.call('fs:read', asked)).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(rec.lines.some((l) => l.msg === 'fs:read refused: out-of-scope')).toBe(true);
  });

  it('refuses a path that is not a path at all, without touching the disk', async () => {
    expect(await bus.call('fs:read', 42)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(await bus.call('fs:read')).toEqual({ ok: false, reason: 'invalid-path' });
    expect(rec.lines.filter((l) => l.msg === 'fs:read refused: invalid-path')).toHaveLength(2);
  });

  it('answers not-found for a missing file in a folder it may read', async () => {
    expect(await bus.call('fs:read', path.join(ROOT, 'nope.md'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(rec.lines.some((l) => l.msg === 'fs:read refused: not-found')).toBe(true);
  });

  it('an over-cap file comes back truncated-with-a-flag, and the log says so', async () => {
    const r = await bus.call('fs:read', path.join(ROOT, 'big.log'));
    expect(r).toMatchObject({ ok: true, size: 500, truncated: true });
    expect(r.ok && r.text).toHaveLength(100);
    const line = rec.lines.find((l) => l.msg === 'fs:read truncated at the cap');
    // info, not warn: the caller got what it asked for. A user reporting "the
    // file looks cut off" and a 900 MB file are the same report from one side.
    expect(line?.level).toBe('info');
    expect(line?.fields).toMatchObject({ size: 500, cap: 100 });
  });

  it('a path picked by the user becomes readable through the same channel', async () => {
    // The seam P2-E16-02's `Open file…` calls. Nothing in the shipped app calls
    // it yet, which is exactly why it is asserted here.
    const target = path.join(OUTSIDE, 'id_rsa');
    expect(await bus.call('fs:read', target)).toEqual({ ok: false, reason: 'out-of-scope' });
    scope.addPicked(target);
    expect(await bus.call('fs:read', target)).toMatchObject({ ok: true, text: 'PRIVATE KEY\n' });
  });

  it('the handler resolves — it never rejects, whatever it is handed', async () => {
    // Every bridge call in the renderer is a bare `void x().then(...)` (#347).
    await expect(bus.call('fs:read', null)).resolves.toMatchObject({ ok: false });
    await expect(bus.call('fs:read', { toString: () => 'x' })).resolves.toMatchObject({ ok: false });
    await expect(bus.call('fs:read', ROOT)).resolves.toEqual({ ok: false, reason: 'not-a-file' });
  });
});
