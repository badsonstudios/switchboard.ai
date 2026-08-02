// P2-E18-05 — session status and lifecycle from the stream.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager, StatusChange } from './session-manager';
import { transition } from './state-machine';
import { streamStatusEvent } from './stream-status';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from '../extensibility/contributions';
import { SessionTransport, TransportSpawnOptions } from '../transport/transport';
import { LogSink, createLogger } from '../log/logger';

// ---- the mapper, pure -------------------------------------------------------

describe('streamStatusEvent — which messages mean anything (P2-E18-05)', () => {
  // THE trap. `system:init` reads like "the session started", and it is emitted
  // ONCE PER TURN (S-11: 4 turns -> 4 inits), ~10-20ms after a prompt WE sent.
  // A host that transitions on it re-initialises every single turn.
  it('system:init means NOTHING — it is a per-turn marker, not a session start', () => {
    expect(streamStatusEvent({ type: 'system', subtype: 'init', session_id: 'x' })).toBeNull();
  });

  it('other system subtypes are informational too', () => {
    expect(streamStatusEvent({ type: 'system', subtype: 'status' })).toBeNull();
    expect(streamStatusEvent({ type: 'system', subtype: 'commands_changed' })).toBeNull();
  });

  it('assistant output and deltas mean a turn is running', () => {
    expect(streamStatusEvent({ type: 'assistant' })).toEqual({
      kind: 'stream',
      event: 'assistant',
      subtype: undefined,
    });
    expect(streamStatusEvent({ type: 'stream_event' })?.kind).toBe('stream');
  });

  it('result ends the turn, and carries its subtype', () => {
    expect(streamStatusEvent({ type: 'result', subtype: 'success' })).toEqual({
      kind: 'stream',
      event: 'result',
      subtype: 'success',
    });
  });

  it('a can_use_tool control request is a held permission', () => {
    expect(
      streamStatusEvent({ type: 'control_request', request: { subtype: 'can_use_tool' } })
    ).toEqual({ kind: 'permission-held' });
  });

  // hook_callback and mcp_message ride the same channel; treating every control
  // request as a permission would park a working session on needs-permission
  // with nothing to answer.
  it('other control requests do NOT touch status', () => {
    expect(
      streamStatusEvent({ type: 'control_request', request: { subtype: 'hook_callback' } })
    ).toBeNull();
    expect(
      streamStatusEvent({ type: 'control_request', request: { subtype: 'mcp_message' } })
    ).toBeNull();
    expect(streamStatusEvent({ type: 'control_request' })).toBeNull();
  });

  it('content and telemetry messages are not lifecycle signals', () => {
    for (const type of ['rate_limit_event', 'transcript_mirror', 'active_goal', 'keep_alive', 'user']) {
      expect(streamStatusEvent({ type })).toBeNull();
    }
  });

  it('a message with no type at all is ignored rather than throwing', () => {
    expect(streamStatusEvent({})).toBeNull();
    expect(streamStatusEvent({ type: 42 })).toBeNull();
  });
});

// ---- the transitions --------------------------------------------------------

describe('stream transitions (P2-E18-05)', () => {
  it('transport-ready promotes starting -> idle', () => {
    expect(transition('starting', { kind: 'transport-ready' })).toMatchObject({
      status: 'idle',
      changed: true,
    });
  });

  // A late or duplicated ready must never drag a running turn backwards.
  it('transport-ready does NOTHING once the session has moved on', () => {
    for (const from of ['working', 'needs-permission', 'done', 'idle'] as const) {
      expect(transition(from, { kind: 'transport-ready' }).changed).toBe(false);
    }
  });

  it('prompt-sent starts a turn, including out of done', () => {
    expect(transition('idle', { kind: 'prompt-sent' })).toMatchObject({ status: 'working' });
    expect(transition('done', { kind: 'prompt-sent' })).toMatchObject({ status: 'working' });
  });

  it('result ends the turn', () => {
    expect(transition('working', { kind: 'stream', event: 'result', subtype: 'success' })).toMatchObject({
      status: 'done',
    });
  });

  // A failed turn is FINISHED, not running. The error belongs in the feed, not
  // in a badge that says the session is still busy.
  it('an ERROR result also ends the turn', () => {
    expect(
      transition('working', { kind: 'stream', event: 'result', subtype: 'error_during_execution' })
    ).toMatchObject({ status: 'done' });
  });

  // S-11 watched a message written during a 150s stall get picked up 144s after
  // we resumed reading — a turn we never saw begin.
  it('output arriving revives a done session even with no prompt-sent', () => {
    expect(transition('done', { kind: 'stream', event: 'assistant' })).toMatchObject({
      status: 'working',
    });
  });

  it('an unknown stream event is logged, never transitioned (§5.26 posture)', () => {
    const r = transition('working', { kind: 'stream', event: 'something_new' });
    expect(r.changed).toBe(false);
    expect(r.note).toContain('unknown-stream');
  });

  it('crashed stays terminal against stream traffic too', () => {
    expect(transition('crashed', { kind: 'stream', event: 'assistant' }).changed).toBe(false);
    expect(transition('crashed', { kind: 'transport-ready' }).changed).toBe(false);
  });
});

// ---- the manager wiring -----------------------------------------------------

class MessageTransport implements SessionTransport {
  listeners = new Map<string, (m: Record<string, unknown>) => void>();
  exits = new Map<string, (c: number) => void>();
  spawn(opts: TransportSpawnOptions) {
    return {
      pid: 1,
      onExit: (l: (c: number) => void) => {
        this.exits.set(opts.id, l);
        return () => {};
      },
      onMessage: (l: (m: Record<string, unknown>) => void) => {
        this.listeners.set(opts.id, l);
        return () => {};
      },
      kill: () => {},
    };
  }
  remove(): void {}
  emit(id: string, m: Record<string, unknown>): void {
    this.listeners.get(id)?.(m);
  }
}

/** A PTY-shaped transport: bytes, no typed messages. */
class SilentTransport implements SessionTransport {
  spawn() {
    return { pid: 2, onExit: () => () => {}, kill: () => {} };
  }
  remove(): void {}
}

function registryFor(transport: 'pty' | 'stream'): ContributionRegistry<MainContributions> {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: () => ({ command: 'cli', args: [], env: {}, transport }),
  });
  return r;
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

let dir: string;
let stream: MessageTransport;
let changes: StatusChange[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sl-'));
  stream = new MessageTransport();
  changes = [];
});

function streamManager(): SessionManager {
  const sink = new LogSink({ dir });
  const mgr = new SessionManager(
    registryFor('stream'),
    new SilentTransport(),
    createLogger(sink, 'sessions'),
    dir,
    { stream }
  );
  mgr.onStatusChange((c) => changes.push(c));
  return mgr;
}

describe('a stream session, end to end (P2-E18-05)', () => {
  // MEASURED (S-11): the CLI emits nothing between spawn and our first prompt,
  // so if readiness did not come from the spawn a session would sit on
  // 'starting' until the user typed.
  it('becomes idle on spawn, with no message from the CLI at all', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);

    expect(mgr.get(rec.id)!.status).toBe('idle');
    expect(changes[0].cause).toBe('transport-ready');
  });

  // The RETURNED record must already say idle. The renderer learns a session's
  // id from this response, so anything pushed before it lands is filtered out
  // for an id nobody knows yet — that is exactly how a stream card sat on
  // 'starting' for ever and grew a "start-up dialog" bar at 8s (#153
  // follow-up). A deferred transition is unobservable to the only consumer that
  // matters.
  it('the RETURNED record already reports idle, not starting', () => {
    const mgr = streamManager();
    expect(mgr.create(identity).status).toBe('idle');
  });

  it('a PTY session is NOT marked ready this way — it still waits for hooks', () => {
    const sink = new LogSink({ dir });
    const mgr = new SessionManager(
      registryFor('pty'),
      new SilentTransport(),
      createLogger(sink, 'sessions'),
      dir
    );
    const rec = mgr.create(identity);
    // a TUI still has to boot, and can stop on a trust dialog: 'starting' is
    // the honest answer until SessionStart says otherwise
    expect(mgr.get(rec.id)!.status).toBe('starting');
  });

  it('walks idle -> working -> done across a whole turn', async () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    await tick();

    mgr.apply(rec.id, { kind: 'prompt-sent' });
    expect(mgr.get(rec.id)!.status).toBe('working');

    stream.emit(rec.id, { type: 'system', subtype: 'init' });
    stream.emit(rec.id, { type: 'stream_event' });
    stream.emit(rec.id, { type: 'assistant' });
    expect(mgr.get(rec.id)!.status).toBe('working');

    stream.emit(rec.id, { type: 'result', subtype: 'success' });
    expect(mgr.get(rec.id)!.status).toBe('done');
  });

  // The headline trap at the end-to-end level. NOTE what actually guards it:
  // mapping init to `transport-ready` does NOT fail this test, because
  // `transport-ready` only promotes out of 'starting' — two independent
  // defences, and this one is the second. The test that catches a wrong mapping
  // directly is 'system:init means NOTHING' above. Recorded so nobody deletes
  // that one believing this covers it.
  it('three turns produce three inits and NO spurious transitions', async () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    await tick();
    changes.length = 0;

    for (let i = 0; i < 3; i++) {
      mgr.apply(rec.id, { kind: 'prompt-sent' });
      stream.emit(rec.id, { type: 'system', subtype: 'init' }); // once per TURN
      stream.emit(rec.id, { type: 'assistant' });
      stream.emit(rec.id, { type: 'result', subtype: 'success' });
    }

    // exactly working/done per turn — no init-driven detour
    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual([
      'idle->working',
      'working->done',
      'done->working',
      'working->done',
      'done->working',
      'working->done',
    ]);
  });

  it('a can_use_tool request parks the session on needs-permission', async () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    await tick();
    mgr.apply(rec.id, { kind: 'prompt-sent' });

    stream.emit(rec.id, {
      type: 'control_request',
      request: { subtype: 'can_use_tool', tool_name: 'Write' },
    });

    expect(mgr.get(rec.id)!.status).toBe('needs-permission');
  });

  it('the transition log says stream:, not hook:', async () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    await tick();
    mgr.apply(rec.id, { kind: 'prompt-sent' });
    stream.emit(rec.id, { type: 'result', subtype: 'success' });

    const causes = mgr.transitions(rec.id).map((t) => t.cause);
    expect(causes).toContain('stream:result:success');
    expect(causes.some((c) => c.startsWith('hook:'))).toBe(false);
  });

  it('a stream session that dies is still a crash, not a wind-down', async () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    await tick();

    stream.exits.get(rec.id)!(1);

    expect(mgr.get(rec.id)!.status).toBe('crashed');
  });

  // This test used to assert the OPPOSITE — that the transition landed AFTER
  // create() returned — which is what `setImmediate` bought and what broke the
  // renderer (#153 follow-up). What actually matters is that a listener firing
  // DURING create() sees a COMPLETE session, not that it fires late.
  it('a listener firing during create() sees a complete record', () => {
    const mgr = streamManager();
    let seen: { status: string; pid?: number } | undefined;
    mgr.onStatusChange((c) => {
      const r = mgr.get(c.sessionId);
      seen = r && { status: r.status, pid: r.pid };
    });

    const rec = mgr.create(identity);

    expect(seen).toBeTruthy();
    expect(seen!.pid).toBe(1); // the record is in the map WITH its pid
    expect(mgr.get(rec.id)!.status).toBe('idle');
  });
});
