// The SessionManager ↔ ControlChannel seam (#721).
//
// `control-channel.test.ts` drives the correlator through a hand-rolled port,
// which proves the correlation rules and NOTHING about whether the port is
// plugged into the right two methods. Swap `sendToTransport` for `submitPrompt`
// in the constructor and every test over there still passes — this file is what
// notices.
//
// It also covers the two things only the manager can decide:
//
//   • a PTY answers `not-stream` (no typed send at all);
//   • a session the manager NO LONGER HOLDS answers `session-gone` rather than
//     `not-stream`, which would have told the user to go and use a terminal
//     that has nothing to do with their problem.
//
// …and it drives the FAKE PROVIDER's implementations of the verbs, so the fake
// and the real reader are exercised against each other rather than each against
// its own assumptions.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from '../extensibility/contributions';
import { SessionTransport } from '../transport/transport';
import { FakeStreamProtocol, FAKE_MODELS } from '../providers/fake-stream-protocol';
import { readModels } from '../../shared/stream-protocol';
import { LogSink, createLogger } from '../log/logger';
import type { TransportKind } from '../../shared/transport';

/**
 * A stream transport whose messages a test can drive, and which runs the FAKE
 * PROVIDER over the wire when asked to.
 *
 * `deliver` is the CLI talking back. `protocol` mode routes everything we send
 * through `FakeStreamProtocol` and feeds its output back in, which is as close
 * to end-to-end as it gets without a child process.
 */
class DrivableTransport implements SessionTransport {
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Set<(m: Record<string, unknown>) => void>();
  private protocol: FakeStreamProtocol | null = null;

  constructor(private readonly useProtocol = false) {}

  spawn() {
    if (this.useProtocol) {
      this.protocol = new FakeStreamProtocol(
        {
          cwd: () => 'C:/tmp/x',
          writeFile: () => {},
          stderr: () => {},
          exit: () => {},
          resolve: (cwd: string, target: string) => `${cwd}/${target}`,
        },
        (m) => this.deliver(m)
      );
    }
    return {
      pid: 1,
      onExit: () => () => {},
      onMessage: (l: (m: Record<string, unknown>) => void) => {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
      },
      send: (m: unknown) => {
        this.sent.push(m as Record<string, unknown>);
        this.protocol?.handle(m as Record<string, unknown>);
      },
      kill: () => {},
    };
  }
  remove(): void {}

  /** the CLI answering */
  deliver(msg: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(msg);
  }

  /** the id the channel minted for the Nth thing it wrote */
  idOf(n = 0): string {
    return String(this.sent[n]?.request_id);
  }
}

/** PTY-shaped: bytes only, no typed send — so no control channel at all. */
class ByteTransport implements SessionTransport {
  spawn() {
    return { pid: 2, onExit: () => () => {}, kill: () => {} };
  }
  remove(): void {}
}

function registryFor(transport: TransportKind): ContributionRegistry<MainContributions> {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: () => ({ command: 'cli', args: [], env: {}, transport }),
  });
  return r;
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };
let dir: string;

beforeEach(() => {
  dir = tempDir('sb-ctl-');
});
afterEach(() => cleanupTempDirs());

function managerOn(
  kind: TransportKind,
  stream?: DrivableTransport
): SessionManager {
  return new SessionManager(
    registryFor(kind),
    new ByteTransport(),
    createLogger(new LogSink({ dir }), 'sessions'),
    dir,
    stream ? { stream } : undefined
  );
}

describe('the port is wired to the right two methods', () => {
  it('writes the request down the session’s own transport and reads its reply', async () => {
    const t = new DrivableTransport();
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    const p = m.listModels(rec.id);
    // It reached the transport as a control_request…
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'list_models' } });

    // …and the reply comes back through `onStreamMessage`, nested id and all.
    t.deliver({
      type: 'control_response',
      response: { subtype: 'success', request_id: t.idOf(), response: { models: [{ value: 'x' }] } },
    });
    await expect(p).resolves.toEqual({ ok: true, response: { models: [{ value: 'x' }] } });
  });

  it('keeps two live sessions’ requests apart', async () => {
    const t = new DrivableTransport();
    const m = managerOn('stream', t);
    const a = m.create(identity);
    const b = m.create(identity);

    const pa = m.listModels(a.id);
    const pb = m.listModels(b.id);
    // Both share this transport instance, so both listeners hear everything —
    // which is exactly the condition the session check in the channel exists
    // for, and why this is worth asserting through the real manager.
    t.deliver({
      type: 'control_response',
      response: { subtype: 'success', request_id: t.idOf(1), response: { which: 'b' } },
    });
    t.deliver({
      type: 'control_response',
      response: { subtype: 'success', request_id: t.idOf(0), response: { which: 'a' } },
    });
    await expect(pa).resolves.toEqual({ ok: true, response: { which: 'a' } });
    await expect(pb).resolves.toEqual({ ok: true, response: { which: 'b' } });
  });
});

describe('the two verdicts only the manager can tell apart', () => {
  // `not-stream` NAMES A MISSING CONTROL CHANNEL, not a transport (#952). It was
  // driven with a PTY session because that was the transport that had none; the
  // verdict, its wording and the code path are unchanged, and a handle without
  // `onMessage` still reaches them.
  it('a session with no control channel answers not-stream', async () => {
    const m = managerOn('stream');
    const rec = m.create(identity);
    await expect(m.listModels(rec.id)).resolves.toEqual({
      ok: false,
      reason: 'not-stream',
      message: 'this session has no control channel',
    });
    await expect(m.setModel(rec.id, 'haiku')).resolves.toMatchObject({ reason: 'not-stream' });
  });

  it('a session the manager no longer holds is GONE, not a terminal', async () => {
    // The restart path drops the handle while a renderer may still hold the old
    // live id. Answering `not-stream` there would tell the user to go and use
    // the CLI's picker in a terminal — advice for a completely different
    // problem, on a session that is simply dead.
    const t = new DrivableTransport();
    const m = managerOn('stream', t);
    const rec = m.create(identity);
    m.remove(rec.id);

    await expect(m.listModels(rec.id)).resolves.toEqual({
      ok: false,
      reason: 'session-gone',
      message: 'the session has stopped',
    });
    await expect(m.setModel(rec.id, 'haiku')).resolves.toMatchObject({ reason: 'session-gone' });
    expect(t.sent).toHaveLength(0); // and nothing was written at a dead child
  });

  it('never asks a session that does not exist at all', async () => {
    const t = new DrivableTransport();
    const m = managerOn('stream', t);
    await expect(m.listModels('nobody')).resolves.toMatchObject({ reason: 'session-gone' });
    expect(t.sent).toHaveLength(0);
  });

  it('refuses a model id the CLI would silently ignore, without writing', async () => {
    const t = new DrivableTransport();
    const m = managerOn('stream', t);
    const rec = m.create(identity);
    await expect(m.setModel(rec.id, '')).resolves.toMatchObject({ reason: 'invalid' });
    await expect(m.setModel(rec.id, undefined)).resolves.toMatchObject({ reason: 'invalid' });
    expect(t.sent).toHaveLength(0);
  });
});

describe('driven against the fake provider’s own implementation', () => {
  it('lists the models the fake offers, in the real payload’s shape', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    const v = await m.listModels(rec.id);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const models = readModels(v.response);
    expect(models.map((x) => x.value)).toEqual(FAKE_MODELS.map((x) => x.value));
    // the fields a picker actually renders survive the round trip
    const dflt = models.find((x) => x.value === 'default');
    expect(dflt?.displayName).toBe('Default (recommended)');
    expect(dflt?.description).toContain('Opus 5');
  });

  it('switches the model, and the switch is visible on the NEXT turn’s init', async () => {
    // BY EFFECT, not by the acknowledgement — the same standard `set_model` was
    // held to against the real CLI. A fake that acked and went on reporting the
    // old model would let a consumer that applies nothing pass.
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    const inits: unknown[] = [];
    m.onStreamMessage((_id, msg) => {
      if (msg.type === 'system' && msg.subtype === 'init') inits.push(msg.model);
    });

    await expect(m.setModel(rec.id, 'haiku')).resolves.toEqual({ ok: true, response: {} });
    m.submitPrompt(rec.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(inits.at(-1)).toBe('haiku');
  });

  it('passes the fake’s refusal sentences through as the CLI’s own words', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    await expect(m.setModel(rec.id, 'no-such-model-xyz')).resolves.toEqual({
      ok: false,
      reason: 'refused',
      message:
        'Model "no-such-model-xyz" is not a recognized model id. Run /model to see available models.',
    });
  });

  it('reads the effort level and the levels the session’s model takes (#1115)', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    await expect(m.effort(rec.id)).resolves.toEqual({
      ok: true,
      // the model rides on the same answer (#1174): one read serves both chips
      response: {
        effort: 'medium',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        model: 'claude-fake-1',
      },
    });
  });

  it('sets the level, and the set is visible on the next read', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    await expect(m.setEffort(rec.id, 'high')).resolves.toEqual({
      ok: true,
      response: { effort: 'high' },
    });
    await expect(m.effort(rec.id)).resolves.toMatchObject({ response: { effort: 'high' } });
  });

  it('⚠️ a level the CLI ignores is REFUSED, although the CLI said success', async () => {
    // the measured trap: `apply_flag_settings` acknowledges anything. The
    // fake does the same, so only the read-back can produce this verdict.
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);
    await m.setEffort(rec.id, 'high');

    await expect(m.setEffort(rec.id, 'no-such-level')).resolves.toEqual({
      ok: false,
      reason: 'refused',
      message: 'the session did not take "no-such-level"; it is still on "high"',
    });
    await expect(m.effort(rec.id)).resolves.toMatchObject({ response: { effort: 'high' } });
  });

  it('refuses an empty level without writing anything', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);
    const before = t.sent.length;
    await expect(m.setEffort(rec.id, '  ')).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    await expect(m.setEffort(rec.id, undefined)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(t.sent.length).toBe(before);
  });

  it('a model with no effort levels answers null, and one with fewer lists fewer', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);
    await m.setEffort(rec.id, 'max');

    await m.setModel(rec.id, 'haiku');
    await expect(m.effort(rec.id)).resolves.toEqual({
      ok: true,
      response: { effort: null, levels: [], model: 'haiku' },
    });

    // back on a model that has levels, the level is the one set before the
    // switch (measured: it survives) — and it is offered even though this
    // model's own list does not carry it, so the menu can show what is on.
    // ⚠️ NOT MEASURED: what the real CLI reports when the surviving level is
    // one the new model lacks (the probe came back to a model that has
    // `max`). This is the fake's choice, and what it pins is OUR handling of
    // "the level in force is not in the list", not the CLI.
    await m.setModel(rec.id, 'sonnet');
    await expect(m.effort(rec.id)).resolves.toEqual({
      ok: true,
      response: { effort: 'max', levels: ['low', 'medium', 'high', 'max'], model: 'sonnet' },
    });
  });

  it('a session that is gone answers session-gone for both', async () => {
    const m = managerOn('stream', new DrivableTransport(true));
    await expect(m.effort('nope')).resolves.toMatchObject({ ok: false, reason: 'session-gone' });
    await expect(m.setEffort('nope', 'high')).resolves.toMatchObject({
      ok: false,
      reason: 'session-gone',
    });
  });

  it('an unknown verb fails CLEAN and leaves the session usable (P6)', async () => {
    const t = new DrivableTransport(true);
    const m = managerOn('stream', t);
    const rec = m.create(identity);

    const v = await m.control.request(rec.id, (id) => ({
      type: 'control_request' as const,
      request_id: id,
      request: { subtype: 'no_such_verb_xyz' },
    }));
    expect(v).toMatchObject({ ok: false, reason: 'refused' });
    expect((v as { message: string }).message).toContain('Unsupported control request subtype');

    // …and the session still answers the next thing it is asked.
    await expect(m.listModels(rec.id)).resolves.toMatchObject({ ok: true });
  });
});
