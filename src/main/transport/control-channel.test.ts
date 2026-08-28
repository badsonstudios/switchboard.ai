// The outbound control channel (#721).
//
// The correlation rules are the whole product here, and two of them are only
// interesting because they were MEASURED to be counter-intuitive:
//
//   • the reply's `request_id` is NESTED, and absent at the top level — the
//     opposite of the inbound `can_use_tool` requests this app already parses;
//   • `set_model` with no `model` answers SUCCESS and does nothing, so a
//     dropped argument has to be refused before the wire.
//
// Everything else is the ordinary contract: one verdict per call, never a
// rejection, never a leaked pending entry.
import { describe, it, expect, vi } from 'vitest';
import { ControlChannel, type ControlPort } from './control-channel';
import { listModelsRequest, setModelRequest } from '../../shared/stream-protocol';

/** A port that records what was written and lets a test answer by hand. */
function harness(opts: { sendOk?: boolean } = {}) {
  const sent: Array<{ sessionId: string; msg: Record<string, unknown> }> = [];
  const listeners = new Set<(sessionId: string, msg: Record<string, unknown>) => void>();
  const port: ControlPort = {
    send: (sessionId, msg) => {
      sent.push({ sessionId, msg: msg as Record<string, unknown> });
      return opts.sendOk ?? true;
    },
    onMessage: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const fanOut = (sessionId: string, msg: Record<string, unknown>): void => {
    for (const l of [...listeners]) l(sessionId, msg);
  };
  return {
    port,
    sent,
    /** is the channel still subscribed to the fan-out? */
    listening: (): boolean => listeners.size > 0,
    /** add a second subscriber, the way the real app has several */
    alsoOnMessage: (l: (sessionId: string, msg: Record<string, unknown>) => void): void => {
      listeners.add(l);
    },
    /** the id the channel minted for the Nth request it wrote */
    idOf: (n = 0): string => String(sent[n]?.msg.request_id),
    /** deliver a reply in the CLI's real envelope — request_id NESTED */
    reply: (sessionId: string, requestId: string, body: Record<string, unknown>): void =>
      fanOut(sessionId, {
        type: 'control_response',
        response: { request_id: requestId, ...body },
      }),
    raw: (sessionId: string, msg: Record<string, unknown>): void => fanOut(sessionId, msg),
  };
}

describe('a request and its answer', () => {
  it('writes a control_request and resolves with the payload', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].sessionId).toBe('S1');
    expect(h.sent[0].msg.type).toBe('control_request');
    expect(h.sent[0].msg.request).toEqual({ subtype: 'list_models' });

    h.reply('S1', h.idOf(), { subtype: 'success', response: { models: [{ value: 'haiku' }] } });
    await expect(p).resolves.toEqual({ ok: true, response: { models: [{ value: 'haiku' }] } });
    expect(ch.inFlight).toBe(0);
  });

  it('normalises a success with NO response payload to {}', async () => {
    // Measured: `set_model` answers {subtype:"success", request_id} with no
    // `response` key at all. A caller reading `.response.x` must not see
    // `undefined.x`.
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', (id) => setModelRequest(id, 'haiku'));
    h.reply('S1', h.idOf(), { subtype: 'success' });
    await expect(p).resolves.toEqual({ ok: true, response: {} });
  });

  it('passes the CLI’s own refusal sentence through verbatim', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', (id) => setModelRequest(id, 'no-such-model-xyz'));
    h.reply('S1', h.idOf(), {
      subtype: 'error',
      error: 'Model "no-such-model-xyz" is not a recognized model id. Run /model to see available models.',
    });
    await expect(p).resolves.toEqual({
      ok: false,
      reason: 'refused',
      message:
        'Model "no-such-model-xyz" is not a recognized model id. Run /model to see available models.',
    });
  });

  it('still fails when the error subtype carries no readable sentence', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    h.reply('S1', h.idOf(), { subtype: 'error' });
    const v = await p;
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ reason: 'refused' });
  });

  it('treats an unrecognised subtype as an answer, not a refusal', async () => {
    // Fail-open: a CLI that grows a third subtype should degrade to "it
    // answered", never to a refusal we invented on its behalf.
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    h.reply('S1', h.idOf(), { subtype: 'partial_success_from_the_future', response: { a: 1 } });
    await expect(p).resolves.toEqual({ ok: true, response: { a: 1 } });
  });
});

describe('the nested request_id — the measured trap', () => {
  it('does NOT correlate on a top-level request_id', async () => {
    // The inbound `can_use_tool` requests carry theirs at the top level, so a
    // correlator written by copying that reader matches nothing for ever. This
    // pins the difference: a top-level-only envelope must leave the call
    // pending, not resolve it.
    const h = harness();
    const ch = new ControlChannel(h.port, { timeoutMs: 10_000 });
    const p = ch.request('S1', listModelsRequest);
    const settled = vi.fn();
    void p.then(settled);

    h.raw('S1', {
      type: 'control_response',
      request_id: h.idOf(), // top level ONLY — how the CLI does NOT reply
      response: { subtype: 'success', response: {} },
    });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(ch.inFlight).toBe(1);

    // ...and the correctly-nested one does settle it.
    h.reply('S1', h.idOf(), { subtype: 'success', response: {} });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('ignores messages that are not control responses at all', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    h.raw('S1', { type: 'assistant', message: { role: 'assistant' } });
    h.raw('S1', { type: 'system', subtype: 'init', model: 'claude-opus-5' });
    h.raw('S1', { type: 'control_response' }); // no response body
    h.raw('S1', { type: 'control_response', response: { subtype: 'success' } }); // no id
    await Promise.resolve();
    expect(ch.inFlight).toBe(1);
    h.reply('S1', h.idOf(), { subtype: 'success', response: {} });
    await expect(p).resolves.toMatchObject({ ok: true });
  });
});

describe('routing', () => {
  it('never lets one session’s reply settle another’s request', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    const settled = vi.fn();
    void p.then(settled);

    h.reply('S2', h.idOf(), { subtype: 'success', response: { models: [] } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    h.reply('S1', h.idOf(), { subtype: 'success', response: { models: [] } });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('keeps concurrent requests apart and answers them out of order', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const a = ch.request('S1', listModelsRequest);
    const b = ch.request('S1', (id) => setModelRequest(id, 'haiku'));
    const c = ch.request('S2', listModelsRequest);
    expect(ch.inFlight).toBe(3);
    expect(new Set([h.idOf(0), h.idOf(1), h.idOf(2)]).size).toBe(3); // ids are unique

    h.reply('S1', h.idOf(1), { subtype: 'success', response: { second: true } });
    h.reply('S2', h.idOf(2), { subtype: 'success', response: { third: true } });
    h.reply('S1', h.idOf(0), { subtype: 'success', response: { first: true } });

    await expect(a).resolves.toEqual({ ok: true, response: { first: true } });
    await expect(b).resolves.toEqual({ ok: true, response: { second: true } });
    await expect(c).resolves.toEqual({ ok: true, response: { third: true } });
    expect(ch.inFlight).toBe(0);
  });
});

describe('the ways it gives up', () => {
  it('times out rather than hanging, and leaks no pending entry', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const ch = new ControlChannel(h.port, { timeoutMs: 50 });
      const p = ch.request('S1', listModelsRequest);
      expect(ch.inFlight).toBe(1);
      await vi.advanceTimersByTimeAsync(51);
      await expect(p).resolves.toEqual({
        ok: false,
        reason: 'timed-out',
        message: 'the session did not answer',
      });
      expect(ch.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('absorbs a reply that arrives after its timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const ch = new ControlChannel(h.port, { timeoutMs: 50 });
      const p = ch.request('S1', listModelsRequest);
      await vi.advanceTimersByTimeAsync(51);
      await expect(p).resolves.toMatchObject({ reason: 'timed-out' });
      // The late answer must not throw, double-resolve, or resurrect an entry.
      expect(() => h.reply('S1', h.idOf(), { subtype: 'success', response: {} })).not.toThrow();
      expect(ch.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers not-stream when the transport cannot take a typed message', async () => {
    // This is the PTY. `SessionManager.sendToTransport` answers false when the
    // handle has no `send`, and #721 asked for that decision to be made ONCE
    // here rather than in every consumer.
    const h = harness({ sendOk: false });
    const ch = new ControlChannel(h.port);
    await expect(ch.request('S1', listModelsRequest)).resolves.toEqual({
      ok: false,
      reason: 'not-stream',
      message: 'this session has no control channel',
    });
    expect(ch.inFlight).toBe(0);
  });

  it('refuses an argument the CLI would silently ignore, without writing anything', async () => {
    // THE MEASUREMENT THIS EXISTS FOR: `set_model` with no `model` field
    // answers `success` and changes nothing. If we let that reach the wire the
    // surface reports a model change that never happened.
    const h = harness();
    const ch = new ControlChannel(h.port);
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      await expect(ch.request('S1', (id) => setModelRequest(id, bad))).resolves.toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(h.sent).toHaveLength(0); // nothing reached the CLI
    expect(ch.inFlight).toBe(0);
  });

  it('gives up a closed session’s requests at once instead of after the timeout', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port, { timeoutMs: 10_000 });
    const doomed = ch.request('S1', listModelsRequest);
    const other = ch.request('S2', listModelsRequest);
    const otherSettled = vi.fn();
    void other.then(otherSettled);

    ch.forgetSession('S1');
    await expect(doomed).resolves.toEqual({
      ok: false,
      reason: 'session-gone',
      message: 'the session has stopped',
    });
    // ...and only that session's.
    await Promise.resolve();
    expect(otherSettled).not.toHaveBeenCalled();
    expect(ch.inFlight).toBe(1);
  });

  it('settles everything on dispose and stops listening', async () => {
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    ch.dispose();
    await expect(p).resolves.toMatchObject({ ok: false, reason: 'session-gone' });
    expect(ch.inFlight).toBe(0);
    // ...and the SUBSCRIPTION is gone, not merely the pending entries. Asserted
    // on the harness rather than through behaviour, because a reply arriving
    // after dispose is a no-op either way — dropping `this.unsubscribe()` would
    // leave a listener wired into an app-wide fan-out for ever and no
    // behavioural test would notice.
    expect(h.listening()).toBe(false);
    expect(() => h.reply('S1', h.idOf(), { subtype: 'success', response: {} })).not.toThrow();
  });

  it('survives a listener that tears its own session down mid-fan-out', async () => {
    // A REAL PATH in this codebase, not a hypothetical: `StreamSession.detach`
    // documents that a message listener is free to tear its session down, which
    // reaches `forgetSession` from inside `ingest`'s fan-out. Safe here because
    // `settle` resolves a promise and continuations are microtasks — but "safe
    // by construction" is worth one test rather than one comment.
    const h = harness();
    const ch = new ControlChannel(h.port);
    const p = ch.request('S1', listModelsRequest);
    const id = h.idOf();

    // the app's own listener, reacting to the same message the channel reads
    h.alsoOnMessage((sessionId) => ch.forgetSession(sessionId));
    h.reply('S1', id, { subtype: 'success', response: { models: [] } });

    // Whichever listener ran first, exactly one verdict comes out and nothing
    // is left pending.
    const v = await p;
    expect(v.ok === true || (v as { reason: string }).reason === 'session-gone').toBe(true);
    expect(ch.inFlight).toBe(0);
  });
});
