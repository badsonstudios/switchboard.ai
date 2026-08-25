// The MCP seam's §5.29 gate, and how it says no (#632).
//
// THE CLAIM UNDER TEST IS THE FOLDER CHECK, and it is the only real logic in
// `ipc.ts` — everything else delegates to `config.ts` and `health.ts`, which
// have their own files. It earns a test of its own because the folder is
// UNTRUSTED RENDERER INPUT that decides two dangerous things: which `.mcp.json`
// gets read off the disk, and which directory a child process is spawned in.
// Without the gate, `mcp:list` is a way to probe for any file called
// `.mcp.json` anywhere on the machine, and `mcp:health` is a way to run the
// `claude` binary in a directory nobody invited it into.
//
// The refusal shape follows the house rule (`group-ipc.ts`'s header): RESOLVE,
// never throw, and say so in the log at `warn`. It matters more here than most
// because both channels are driven from a modal the user opened on purpose —
// an exception behind a dialog is a dialog that does nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerMcpIpc } from './ipc';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import * as health from './health';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

function harness(folders: string[]) {
  const handlers = new Map<string, Handler>();
  const warnings: Array<{ msg: string; fields?: LogFields }> = [];
  const broker = {
    handle: (channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
      handlers.set(channel, fn);
    },
  } as unknown as IpcBroker;
  const noop = (): void => {};
  const log: Logger = {
    debug: noop,
    info: noop,
    warn: (msg: string, fields?: LogFields) => warnings.push({ msg, fields }),
    error: noop,
    child: () => log,
  };
  registerMcpIpc({
    broker,
    log,
    isSessionFolder: (f) => folders.includes(f),
  });
  return {
    warnings,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args),
    channels: [...handlers.keys()].sort(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('registration', () => {
  it('registers exactly the two read channels', () => {
    // PR 1 is read-only by decision (#632 Gate 1). A write channel appearing
    // here is PR 2 arriving, and should be a deliberate edit to this list.
    expect(harness([]).channels).toEqual(['mcp:health', 'mcp:list']);
  });
});

describe('the folder gate refuses, and does not throw (§5.29)', () => {
  const BAD: Array<[string, unknown]> = [
    ['a folder no session has', '/etc'],
    ['an empty string', ''],
    ['a number', 42],
    ['undefined', undefined],
    ['an object pretending to be a path', { toString: () => '/ok' }],
  ];

  for (const [label, folder] of BAD) {
    it(`refuses ${label} on mcp:list`, () => {
      const h = harness(['/ok']);
      const out = h.call('mcp:list', folder) as { servers: unknown[]; folder: string };
      expect(out.servers).toEqual([]);
      expect(h.warnings.map((w) => w.msg)).toHaveLength(1);
      expect(h.warnings[0].msg).toContain('mcp:list refused');
    });

    it(`refuses ${label} on mcp:health, without spawning anything`, async () => {
      // THE ASSERTION THAT MATTERS on this channel: not merely that it answered
      // empty, but that the CLI was never started. A gate that refuses AFTER
      // spawning has already done the thing it was there to prevent.
      const spy = vi.spyOn(health, 'checkHealth');
      const h = harness(['/ok']);
      const out = (await h.call('mcp:health', folder)) as { states: unknown };
      expect(out.states).toEqual({});
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('echoes back a string folder even when refusing, so a stale answer is discardable', () => {
    // Both channels echo the folder they were asked about; the pane uses it to
    // drop an answer that arrived after the user switched sessions. A refusal
    // that dropped the echo would be an answer the pane could not place.
    const h = harness(['/ok']);
    expect((h.call('mcp:list', '/nope') as { folder: string }).folder).toBe('/nope');
  });

  it('names the folder in the log for a real path, and cannot for a non-string', () => {
    const h = harness(['/ok']);
    h.call('mcp:list', '/nope');
    expect(h.warnings[0].fields).toEqual({ folder: '/nope' });
    const h2 = harness(['/ok']);
    h2.call('mcp:list', 42);
    expect(h2.warnings[0].msg).toContain('non-empty string');
  });
});

describe('an allowed folder gets through to the readers', () => {
  it('answers an inventory for a real session folder', () => {
    // ECHO AND SILENCE ARE THE CLAIM, not the contents. This calls the real
    // `readInventory`, which reads the DEVELOPER'S OWN `~/.claude.json` —
    // review flagged that asserting `unreadable` is `[]` here made the result
    // depend on whether the machine's home config happens to parse, which is a
    // unit test that goes red for somebody else's reason. What this owns is
    // that an allowed folder reaches the reader at all and is not refused; the
    // reader's own behaviour is `config.test.ts`'s, on fixtures.
    const h = harness(['/ok']);
    const out = h.call('mcp:list', '/ok') as { folder: string; servers: unknown[] };
    expect(out.folder).toBe('/ok');
    expect(Array.isArray(out.servers)).toBe(true);
    expect(h.warnings.filter((w) => w.msg.includes('refused'))).toEqual([]);
  });

  it('spawns the health check only for a folder that passed the gate', async () => {
    const spy = vi.spyOn(health, 'checkHealth').mockResolvedValue({ srv: 'connected' });
    const h = harness(['/ok']);
    const out = (await h.call('mcp:health', '/ok')) as { folder: string; states: unknown };
    expect(spy).toHaveBeenCalledWith('/ok');
    expect(out).toEqual({ folder: '/ok', states: { srv: 'connected' } });
  });
});
