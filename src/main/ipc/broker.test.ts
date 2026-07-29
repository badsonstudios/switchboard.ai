import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Logger } from '../log/logger';
import { IpcBroker } from './broker';
import {
  allCapabilities,
  capabilityFor,
  CHANNEL_CAPABILITIES,
  CAPABILITIES,
} from '../../shared/ipc/capabilities';

// Electron is not available in a unit test, so the broker's ipcMain
// registration is exercised by the e2e suite (which drives the real app).
// What is tested here is the DECISION — who may call what — which is the part
// that will matter when a caller other than our own renderer exists.

function freshBroker(): { broker: IpcBroker; lines: string[] } {
  // a plain object rather than a real LogSink: no disk I/O, nothing to clean up
  const lines: string[] = [];
  const rec =
    (level: string) =>
    (msg: string, meta?: unknown): void => {
      lines.push(`${level} ${msg} ${JSON.stringify(meta ?? {})}`);
    };
  const log = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
  };
  return { broker: new IpcBroker(log as unknown as Logger), lines };
}

/** the bits of a WebContents the broker actually touches */
function fakeContents(id: number) {
  return { id, once: () => {} } as unknown as Electron.WebContents;
}

describe('the IPC capability map (the done-when: no channel is untagged)', () => {
  it('every capability in the map is one we declared', () => {
    const declared = new Set<string>(CAPABILITIES);
    for (const [channel, capability] of Object.entries(CHANNEL_CAPABILITIES)) {
      expect(declared.has(capability), `${channel} -> unknown capability ${capability}`).toBe(true);
    }
  });

  it('every declared capability is used by at least one channel', () => {
    // a capability nothing needs is vocabulary we invented rather than found —
    // the same "a point with no registrant is a guess" rule as contributions
    const used = new Set(Object.values(CHANNEL_CAPABILITIES));
    for (const c of CAPABILITIES) expect(used.has(c), `${c} is declared but unused`).toBe(true);
  });

  it('resolves dynamic per-session channels by prefix', () => {
    // pty:data:<sessionId> is one channel per attached pane, so it can never
    // appear in a map of fixed names. A completeness check that only knew
    // about fixed names would have declared full coverage while missing the
    // single highest-volume channel in the app.
    expect(capabilityFor('pty:data:abc-123')).toBe('pty.read');
    expect(capabilityFor('pty:data:')).toBe('pty.read');
  });

  it('an unknown channel resolves to NO capability', () => {
    expect(capabilityFor('totally:madeUp')).toBeUndefined();
  });

  it('the map has no STALE entries — every tagged channel is really wired', () => {
    // The missing direction is already impossible: `broker.handle` takes a
    // channel typed as the map's key set, so an untagged channel will not
    // compile. This is the other direction — a tag left behind after the
    // channel it described was deleted, which reads like coverage and is not.
    const sources = [
      'src/main/index.ts',
      'src/main/sessions/ipc.ts',
      'src/main/workspace/group-ipc.ts',
    ]
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
      .join(' ');
    const stale = Object.keys(CHANNEL_CAPABILITIES).filter((c) => !sources.includes(`'${c}'`));
    expect(stale, 'tagged but never registered').toEqual([]);
  });
});

describe('IpcBroker decisions', () => {
  let broker: IpcBroker;
  let lines: string[];

  beforeEach(() => {
    const made = freshBroker();
    broker = made.broker;
    lines = made.lines;
  });

  /** reach the private decision the way the public methods do */
  const allowed = (channel: string, contents: Electron.WebContents | undefined): boolean =>
    (broker as unknown as { allowed: (c: string, s?: Electron.WebContents) => boolean }).allowed(
      channel,
      contents
    );

  it('a granted caller holding the capability is allowed', () => {
    const wc = fakeContents(1);
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
    expect(allowed('sessions:create', wc)).toBe(true);
  });

  it('a granted caller WITHOUT the capability is refused, and the log says which', () => {
    const wc = fakeContents(2);
    broker.grant(wc, { id: 'read-only-plugin', capabilities: new Set(['sessions.read']) });
    expect(allowed('sessions:cards', wc)).toBe(true); // it holds sessions.read
    expect(allowed('sessions:create', wc)).toBe(false); // but not sessions.spawn
    const refusal = lines.find((l) => l.includes('capability not held'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('sessions:create');
    expect(refusal).toContain('sessions.spawn');
    expect(refusal).toContain('read-only-plugin');
  });

  it('an UNGRANTED caller can do nothing at all', () => {
    // a window we never granted is either a wiring bug or something we did not
    // create; neither should get a free pass
    expect(allowed('sessions:cards', fakeContents(3))).toBe(false);
    expect(lines.some((l) => l.includes('ungranted caller'))).toBe(true);
  });

  it('an untagged channel is refused — this one fails CLOSED', () => {
    const wc = fakeContents(4);
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
    expect(allowed('nonsense:channel', wc)).toBe(false);
    expect(lines.some((l) => l.includes('UNTAGGED'))).toBe(true);
  });

  it('a revoked (destroyed) caller loses its grant', () => {
    let destroy = (): void => {};
    const wc = {
      id: 5,
      once: (_ev: string, cb: () => void) => (destroy = cb),
    } as unknown as Electron.WebContents;
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
    expect(allowed('sessions:cards', wc)).toBe(true);
    destroy();
    expect(allowed('sessions:cards', wc)).toBe(false);
  });

  it('send() pushes to a granted window and SKIPS an ungranted one', () => {
    // the outbound gate, through the public method — documented as a headline
    // of this item and previously proven by nothing
    const sent: string[] = [];
    const winFor = (id: number) =>
      ({
        isDestroyed: () => false,
        webContents: { id, once: () => {}, send: (c: string) => sent.push(c) },
      }) as unknown as Electron.BrowserWindow;

    const granted = winFor(10);
    broker.grant(granted.webContents, { id: 'renderer', capabilities: allCapabilities() });
    broker.send(granted, 'sessions:status', { x: 1 });
    expect(sent).toEqual(['sessions:status']);

    // a window we never granted receives nothing — the Phase-4 case where a
    // plugin host must not be handed every session event regardless of what it
    // declared
    broker.send(winFor(11), 'sessions:status', { x: 1 });
    expect(sent).toEqual(['sessions:status']);

    // and one granted only sessions.read gets a sessions channel but not a
    // transcript one
    const partial = winFor(12);
    broker.grant(partial.webContents, { id: 'observer', capabilities: new Set(['sessions.read']) });
    broker.send(partial, 'sessions:status', {});
    broker.send(partial, 'sessions:feedBlock', {});
    expect(sent).toEqual(['sessions:status', 'sessions:status']);
  });

  it('send() to a null or destroyed window is a no-op, not a throw', () => {
    expect(() => broker.send(null, 'sessions:status', {})).not.toThrow();
    const dead = { isDestroyed: () => true } as unknown as Electron.BrowserWindow;
    expect(() => broker.send(dead, 'sessions:status', {})).not.toThrow();
  });

  it('granting a second window leaves the first alone (macOS activate)', () => {
    const a = fakeContents(20);
    const b = fakeContents(21);
    broker.grant(a, { id: 'renderer', capabilities: allCapabilities() });
    broker.grant(b, { id: 'renderer-2', capabilities: new Set(['sessions.read']) });
    expect(allowed('sessions:create', a)).toBe(true);
    expect(allowed('sessions:create', b)).toBe(false);
  });

  it('the first-party grant covers every channel in the map', () => {
    // the contract of this item: nothing changes at runtime for our renderer
    const wc = fakeContents(6);
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
    for (const channel of IpcBroker.knownChannels()) {
      expect(allowed(channel, wc), `first-party refused ${channel}`).toBe(true);
    }
    expect(allowed('pty:data:some-session', wc)).toBe(true);
  });
});
