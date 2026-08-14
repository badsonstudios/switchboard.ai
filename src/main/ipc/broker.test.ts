import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Logger } from '../log/logger';
import { IpcBroker } from './broker';
import {
  allCapabilities,
  capabilityFor,
  CHANNEL_CAPABILITIES,
  CAPABILITIES,
  StaticChannel,
} from '../../shared/ipc/capabilities';
import { isIpcRefusal } from '../../shared/ipc/refusal';

// The registrations `handle`/`on` make, captured. Electron is not present in a
// unit test, so until #346 the two REGISTERING methods were exercised only by
// the e2e suite and their refusal branch by nothing at all — which is how the
// broker kept a throw nobody had ever seen. A small fake is enough to run
// the wrapper the broker actually installs, so the contract is tested where it
// is written rather than inferred from the decision it wraps.
const registered = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  ons: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    // Real ipcMain throws on a second handler for the same channel. The fake
    // does too: a Map that silently overwrote would make every `clear()` below
    // cosmetic, and would happily accept a double registration in `index.ts`
    // that the real app would refuse to start with.
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      if (registered.handles.has(channel))
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      registered.handles.set(channel, fn);
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => registered.ons.set(channel, fn),
  },
}));

// What most of this file tests is the DECISION — who may call what — which is
// the part that matters when a caller other than our own renderer exists. The
// issue-346 blocks at the bottom test the ANSWER, through the fake above.

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
    // Every file that registers channels. A new registration FILE has to be
    // added here — otherwise its channels read as stale and this goes red,
    // which is the correct failure: the list is the test's whole input.
    const sources = [
      'src/main/index.ts',
      'src/main/sessions/ipc.ts',
      'src/main/workspace/group-ipc.ts',
      'src/main/fs/ipc.ts',
      'src/main/events/rules-ipc.ts',
      'src/main/events/push-ipc.ts',
      'src/main/events/sound-ipc.ts',
      // `audio:play` / `audio:speak` are OUTBOUND and both ends have to agree
      // on the name, so the two literals live in shared as constants and
      // `events/audio-sink.ts` sends them. Listing the file that NAMES them is
      // what this check can see; that they are really sent is
      // `audio-sink.test.ts`'s job.
      'src/shared/sounds.ts',
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

// ── the refusal contract (issue 346) ───────────────────────────────────────
//
// A refused `invoke` RESOLVES an IpcRefusal; it does not reject. Nothing
// shipped can reach this — first-party holds every capability — so there is no
// behaviour change to observe and these tests ARE the deliverable. They run the
// wrapper the broker installs on ipcMain, not a re-implementation of it.
describe('a refused call answers, it does not throw (issue 346)', () => {
  let broker: IpcBroker;
  let lines: string[];
  let calls: unknown[][];

  beforeEach(() => {
    registered.handles.clear();
    registered.ons.clear();
    const made = freshBroker();
    broker = made.broker;
    lines = made.lines;
    calls = [];
  });

  /** register `channel` with a handler that records its args and answers `answer` */
  const install = (channel: StaticChannel, answer: unknown = 'the answer'): void => {
    broker.handle(channel, (_e, ...args) => {
      calls.push(args);
      return answer;
    });
  };

  /** invoke the wrapper ipcMain really got, as Electron would */
  const invoke = (channel: StaticChannel, sender: unknown, ...args: unknown[]): unknown => {
    const wrapper = registered.handles.get(channel);
    if (!wrapper) throw new Error(`nothing registered for ${channel}`);
    return wrapper({ sender } as unknown, ...args);
  };

  it('an UNGRANTED caller gets a refusal value — the handler never runs', () => {
    install('sessions:create');
    const answer = invoke('sessions:create', fakeContents(1), { cardId: 'c1' });
    expect(isIpcRefusal(answer)).toBe(true);
    expect(answer).toEqual({
      __ipcRefused: true,
      channel: 'sessions:create',
      reason: 'not-granted',
    });
    expect(calls).toEqual([]);
  });

  it('a caller missing the capability gets a refusal that says so', () => {
    install('sessions:create');
    const wc = fakeContents(2);
    broker.grant(wc, { id: 'read-only-plugin', capabilities: new Set(['sessions.read']) });
    expect(invoke('sessions:create', wc)).toEqual({
      __ipcRefused: true,
      channel: 'sessions:create',
      reason: 'capability-not-held',
    });
    expect(calls).toEqual([]);
  });

  it('refusing is not silent — the log still names the channel, capability and caller', () => {
    // the whole reason a result shape is not a swallow: main said why, once,
    // in the place that knows. The payload stays coarse; the LOG is detailed.
    install('sessions:create');
    const wc = fakeContents(3);
    broker.grant(wc, { id: 'read-only-plugin', capabilities: new Set(['sessions.read']) });
    invoke('sessions:create', wc);
    const line = lines.find((l) => l.includes('capability not held'));
    expect(line).toBeDefined();
    expect(line).toContain('sessions:create');
    expect(line).toContain('sessions.spawn');
    expect(line).toContain('read-only-plugin');
  });

  it('NOTHING throws on the refusal path — the property this item exists for', () => {
    // Before this change every one of these threw `refused: <channel>`, which
    // reaches the caller as a rejected promise. An `invoke` in a plugin that
    // did not expect one is an unhandled rejection in third-party code.
    const ungranted = fakeContents(4);
    for (const channel of IpcBroker.knownChannels()) {
      broker.handle(channel, () => 'never');
      let answer: unknown;
      expect(() => (answer = invoke(channel, ungranted)), `${channel} threw`).not.toThrow();
      expect(isIpcRefusal(answer), `${channel} did not answer a refusal`).toBe(true);
    }
  });

  it('no channel is exempt — every refusal names ITSELF', () => {
    // a refusal that named the wrong channel would be worse than none: the
    // caller's own log line is the only place the channel appears on its side
    const ungranted = fakeContents(5);
    for (const channel of IpcBroker.knownChannels()) {
      broker.handle(channel, () => 'never');
      const answer = invoke(channel, ungranted);
      expect(isIpcRefusal(answer) && answer.channel).toBe(channel);
    }
  });

  it('a caller with no sender at all is refused rather than crashing', () => {
    // `event.sender` is always present in Electron; this is the defensive edge,
    // and the point is that it lands in the SAME answer shape
    install('sessions:cards');
    expect(invoke('sessions:cards', undefined)).toEqual({
      __ipcRefused: true,
      channel: 'sessions:cards',
      reason: 'not-granted',
    });
  });
});

describe('an ALLOWED call is untouched — the no-behaviour-change half (issue 346)', () => {
  let broker: IpcBroker;
  let wc: Electron.WebContents;

  beforeEach(() => {
    registered.handles.clear();
    registered.ons.clear();
    broker = freshBroker().broker;
    wc = fakeContents(1);
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
  });

  const invoke = (channel: StaticChannel, ...args: unknown[]): unknown =>
    registered.handles.get(channel)!({ sender: wc } as unknown, ...args);

  it('passes the handler its arguments and hands back its value unchanged', () => {
    const seen: unknown[][] = [];
    const answer = { id: 'g1', name: 'Work' };
    broker.handle('groups:update', (_e, ...args) => {
      seen.push(args);
      return answer;
    });
    // toBe, not toEqual: the claim is that the broker hands back the handler's
    // OWN value, which a deep clone or a rebuild would also satisfy
    expect(invoke('groups:update', 'g1', { name: 'Work' })).toBe(answer);
    expect(seen).toEqual([['g1', { name: 'Work' }]]);
  });

  it('does NOT wrap the answer — including the answers a refusal could be confused with', () => {
    // The success path is byte-identical to before, which is why this item
    // changes no shipped behaviour. Each of these is a real handler answer;
    // none of them may read as a refusal.
    const answers: unknown[] = [
      null, // groups:update, pty:attach, sessions:create
      undefined, // a void handler
      false, // submitPrompt / interrupt / decidePermission
      { ok: false, reason: 'unknown-card' }, // sessions:setTransport's own
      [], // sessions:cards on a fresh workspace
      'plain string',
    ];
    for (const answer of answers) {
      registered.handles.clear();
      broker.handle('sessions:cards', () => answer);
      const got = invoke('sessions:cards');
      expect(got).toBe(answer);
      expect(isIpcRefusal(got)).toBe(false);
    }
  });

  it("a HANDLER's own throw still rejects — the broker did not become a catch-all", () => {
    // Deliberate: whether a family throws is that family's contract (#326,
    // #347). If the broker swallowed handler errors it would turn every
    // genuine failure into a value the caller reads as a refusal.
    broker.handle('sessions:create', () => {
      throw new Error('folder is not a directory');
    });
    expect(() => invoke('sessions:create')).toThrow('folder is not a directory');
  });

  it('a promise-returning handler is passed through as its promise', async () => {
    broker.handle('git:status', async () => ({ dirty: true }));
    await expect(invoke('git:status')).resolves.toEqual({ dirty: true });
  });
});

describe('one-way channels drop a refusal, because they have nowhere to put it (issue 346)', () => {
  let broker: IpcBroker;

  beforeEach(() => {
    registered.ons.clear();
    broker = freshBroker().broker;
  });

  const fire = (channel: StaticChannel, sender: unknown): unknown =>
    registered.ons.get(channel)!({ sender } as unknown);

  it('a refused send() call runs no handler and throws nothing', () => {
    let ran = 0;
    broker.on('workspace:setUi', () => void ran++);
    expect(() => fire('workspace:setUi', fakeContents(1))).not.toThrow();
    expect(ran).toBe(0);
  });

  it('and a granted one still runs', () => {
    let ran = 0;
    broker.on('workspace:setUi', () => void ran++);
    const wc = fakeContents(2);
    broker.grant(wc, { id: 'renderer', capabilities: allCapabilities() });
    fire('workspace:setUi', wc);
    expect(ran).toBe(1);
  });
});
