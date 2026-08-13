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

  it('registers exactly the channels the capability map tags to this family', () => {
    expect(bus.channels()).toEqual([
      'fs:read',
      'fs:pickFile',
      'fs:openExternal',
      'fs:openPath',
      'fs:reveal',
    ]);
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

// ─── P2-E16-02: the viewer's three doors out of the app ────────────────────

/** A fake `FsShell` that records every call instead of touching the OS. */
function fakeShell() {
  const calls: Array<{ what: string; arg: string }> = [];
  let picked: string | null = null;
  return {
    calls,
    setPick: (p: string | null) => {
      picked = p;
    },
    shell: {
      openExternal: async (url: string) => {
        calls.push({ what: 'openExternal', arg: url });
      },
      openPath: async (p: string) => {
        calls.push({ what: 'openPath', arg: p });
        return '';
      },
      showItemInFolder: (p: string) => {
        calls.push({ what: 'reveal', arg: p });
      },
      pickFile: async () => picked,
    },
  };
}

describe('the document viewer’s shell channels (P2-E16-02)', () => {
  let bus: ReturnType<typeof fakeBroker>;
  let rec: ReturnType<typeof recordingLog>;
  let scope: ReadScope;
  let sh: ReturnType<typeof fakeShell>;

  beforeEach(() => {
    bus = fakeBroker();
    rec = recordingLog();
    sh = fakeShell();
    scope = new ReadScope({ sessionFolders: () => [ROOT], log: rec.log });
    registerFsIpc({
      broker: bus.broker,
      log: rec.log,
      scope,
      cap: 100,
      shell: sh.shell,
      getWindow: () => null,
    });
  });

  describe('fs:openExternal', () => {
    it('hands http, https and mailto to the browser', async () => {
      for (const url of ['http://example.com/a', 'https://example.com/b', 'mailto:a@b.c']) {
        expect(await bus.call('fs:openExternal', url)).toBe(true);
      }
      expect(sh.calls.map((c) => c.arg)).toEqual([
        'http://example.com/a',
        'https://example.com/b',
        'mailto:a@b.c',
      ]);
    });

    it('does NOTHING AT ALL for javascript:, and says so in the log', async () => {
      // The done-when names this one: "a `javascript:` link does nothing at
      // all". Not a warning dialog, not the browser — nothing.
      expect(await bus.call('fs:openExternal', 'javascript:alert(1)')).toBe(false);
      expect(sh.calls).toEqual([]);
      expect(rec.lines.some((l) => l.msg === 'fs:openExternal refused: scheme')).toBe(true);
    });

    it('refuses every other scheme a hostile document might reach for', async () => {
      const hostile = [
        'JavaScript:alert(1)', // case is not a defence
        'java\nscript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'file:///etc/passwd',
        'vbscript:msgbox(1)',
        'ms-msdt:/id',
        'smb://host/share',
        'chrome://settings',
        '',
        '   ',
        null,
        42,
        {},
      ];
      for (const url of hostile) {
        expect(await bus.call('fs:openExternal', url)).toBe(false);
      }
      expect(sh.calls).toEqual([]);
    });
  });

  describe('fs:openPath and fs:reveal', () => {
    it('open and reveal a file inside the scope, using its RESOLVED path', async () => {
      const target = path.join(ROOT, 'PROGRESS.md');
      expect(await bus.call('fs:openPath', target)).toBe(true);
      expect(await bus.call('fs:reveal', target)).toBe(true);
      expect(sh.calls).toHaveLength(2);
      expect(sh.calls[0]).toMatchObject({ what: 'openPath' });
      expect(sh.calls[1]).toMatchObject({ what: 'reveal' });
      // fs.realpathSync.native may spell the temp dir differently than we do
      for (const c of sh.calls) expect(c.arg.endsWith('PROGRESS.md')).toBe(true);
    });

    it('refuses a path outside the scope — "open externally" is not a way past it', async () => {
      // `shell.openPath` on a `.exe` is EXECUTION, which is the whole reason
      // this re-checks the scope instead of trusting the renderer's string.
      const target = path.join(OUTSIDE, 'id_rsa');
      expect(await bus.call('fs:openPath', target)).toBe(false);
      expect(await bus.call('fs:reveal', target)).toBe(false);
      expect(sh.calls).toEqual([]);
      expect(rec.lines.filter((l) => l.msg.endsWith('refused: out-of-scope'))).toHaveLength(2);
    });

    it('refuses a ../ climb, because the check runs on the resolved path', async () => {
      const climb = path.join(ROOT, '..', 'secrets', 'id_rsa');
      expect(await bus.call('fs:openPath', climb)).toBe(false);
      expect(sh.calls).toEqual([]);
    });
  });

  describe('fs:pickFile', () => {
    it('grants what the user picked, so the read that follows succeeds', async () => {
      const target = path.join(OUTSIDE, 'id_rsa');
      expect(await bus.call('fs:read', target)).toEqual({ ok: false, reason: 'out-of-scope' });
      sh.setPick(target);
      expect(await bus.call('fs:pickFile')).toBe(target);
      expect(await bus.call('fs:read', target)).toMatchObject({ ok: true });
    });

    it('a cancelled dialog grants nothing and answers null', async () => {
      sh.setPick(null);
      expect(await bus.call('fs:pickFile')).toBe(null);
      expect(scope.pickedPaths()).toEqual([]);
    });
  });
});
