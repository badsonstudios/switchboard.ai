// P2-E18-03 — the two guarantees that are about HOW we call spawn, and so
// cannot be observed from a real child's behaviour.
//
// Kept in their own file because `vi.mock('child_process')` is module-wide and
// would rob `stream-service.test.ts` of the real pipes that make it worth
// having.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

interface SpawnCall {
  file: string;
  argv: string[];
  opts: Record<string, unknown>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  writes: string[];
}

const spawnCalls: SpawnCall[] = [];
const stdoutPauses = { count: 0 };

vi.mock('child_process', () => ({
  spawn: (file: string, argv: string[], opts: Record<string, unknown>) => {
    const stdout = Object.assign(new EventEmitter(), {
      setEncoding: () => {},
      pause: () => {
        stdoutPauses.count++;
      },
      resume: () => {},
    });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const writes: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    });
    spawnCalls.push({ file, argv, opts, stdout, stderr, writes });
    return Object.assign(new EventEmitter(), { stdout, stderr, stdin, pid: 999, kill: () => {} });
  },
}));

import { StreamService, launchSpec } from './stream-service';

const last = (): SpawnCall => spawnCalls[spawnCalls.length - 1];

beforeEach(() => {
  spawnCalls.length = 0;
  stdoutPauses.count = 0;
});

describe('windowsHide (P2-E18-03)', () => {
  // S-11's first run set this on the interesting spawn and missed it on the
  // boring one, and flashed a console window on the owner's desktop 96 times
  // over an eight-hour run. There is exactly one spawn path here; this test is
  // what keeps it that way.
  it('is set on the spawn', () => {
    new StreamService().spawn({ id: 'a', command: 'anything', args: [], cwd: '.' });
    expect(spawnCalls).toHaveLength(1);
    expect(last().opts.windowsHide).toBe(true);
  });

  it('is set on EVERY spawn, not just the first', () => {
    const svc = new StreamService();
    svc.spawn({ id: 'a', command: 'x', args: [], cwd: '.' });
    svc.spawn({ id: 'b', command: 'y', args: [], cwd: '.' });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.every((c) => c.opts.windowsHide === true)).toBe(true);
  });

  it('pipes all three stdio streams', () => {
    new StreamService().spawn({ id: 'a', command: 'x', args: [], cwd: '.' });
    expect(last().opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('scrubs the S-01 landmines out of the child env', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      new StreamService().spawn({ id: 'a', command: 'x', args: [], cwd: '.' });
      const env = last().opts.env as NodeJS.ProcessEnv;
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });
});

describe('the stdout reader is never paused (P2-E18-03)', () => {
  // S-11 measured the CLI BLOCKING on a full stdout pipe and recovering — 359
  // KB piled up behind a 150 s stall and arrived intact. So falling behind is
  // survivable, but CHOOSING to stop reading applies real backpressure to the
  // CLI mid-turn. Bounding belongs in the ring, never in the reader.
  it('never calls pause(), even under a flood that overruns the ring 100x', () => {
    const svc = new StreamService();
    const s = svc.spawn({ id: 'a', command: 'x', args: [], cwd: '.', ringCapacity: 5 });

    for (let i = 0; i < 500; i++) last().stdout.emit('data', JSON.stringify({ i }) + '\n');

    expect(stdoutPauses.count).toBe(0);
    expect(s.messages.snapshot()).toHaveLength(5); // the RING did the bounding
    expect(s.messages.droppedCount).toBe(495);
  });

  it('keeps the NEWEST messages when it drops', () => {
    const svc = new StreamService();
    const s = svc.spawn({ id: 'a', command: 'x', args: [], cwd: '.', ringCapacity: 3 });

    for (let i = 0; i < 10; i++) last().stdout.emit('data', JSON.stringify({ i }) + '\n');

    expect(s.messages.snapshot()).toEqual([{ i: 7 }, { i: 8 }, { i: 9 }]);
  });
});

describe('launchSpec — Windows .cmd wrapping (P2-E18-03)', () => {
  // Both branches run on every CI leg. Reading process.platform inside would
  // make the win32 cases pass vacuously on ubuntu and macOS (#127's lesson).
  it('wraps a .cmd in cmd.exe /c on win32', () => {
    expect(launchSpec('claude.cmd', ['--verbose'], 'win32')).toEqual({
      file: 'cmd.exe',
      argv: ['/c', 'claude.cmd', '--verbose'],
    });
  });

  it('wraps a .bat too, case-insensitively', () => {
    expect(launchSpec('Thing.BAT', [], 'win32').file).toBe('cmd.exe');
  });

  it('does NOT wrap a .exe on win32', () => {
    expect(launchSpec('claude.exe', ['-v'], 'win32')).toEqual({
      file: 'claude.exe',
      argv: ['-v'],
    });
  });

  it('does NOT wrap on linux or darwin, even for a .cmd-named file', () => {
    // a POSIX file literally called `claude.cmd` is still just an executable
    for (const p of ['linux', 'darwin'] as NodeJS.Platform[]) {
      expect(launchSpec('claude.cmd', ['-v'], p)).toEqual({ file: 'claude.cmd', argv: ['-v'] });
      expect(launchSpec('claude', ['-v'], p)).toEqual({ file: 'claude', argv: ['-v'] });
    }
  });

  // `shell: true` would launch a .cmd just as well and hand command injection a
  // foothold: cwd, args and the resolved CLI path are all user-influenced, and
  // a shell re-parses them.
  it('never asks for a shell', () => {
    new StreamService().spawn({ id: 'a', command: 'x.cmd', args: [], cwd: '.' });
    expect(last().opts.shell).toBeUndefined();
  });
});

describe('send() framing (P2-E18-03)', () => {
  it('writes exactly one NDJSON frame per message', () => {
    const svc = new StreamService();
    const s = svc.spawn({ id: 'a', command: 'x', args: [], cwd: '.' });

    s.send({ type: 'user', n: 1 });
    s.send({ type: 'user', n: 2 });

    expect(last().writes).toEqual(['{"type":"user","n":1}\n', '{"type":"user","n":2}\n']);
  });
});
