// P2-E18-06 — prompt submission over stdin.
//
// The PTY path (`renderer/lib/composer.ts`) wraps multiline text in a bracketed
// paste and sends the carriage return 75ms LATER, because text+CR in one chunk
// registers as a paste and never submits (S-03, refound live 2026-07-22). None
// of that exists here: a prompt is a struct, and a newline inside a JSON string
// cannot be mistaken for a frame boundary. These tests are mostly about proving
// that claim rather than trusting it.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from '../extensibility/contributions';
import { SessionTransport } from '../transport/transport';
import { userMessage, controlResponse } from '../../shared/stream-protocol';
import { NdjsonDecoder, encodeFrame } from '../transport/ndjson';
import { FakeStreamProtocol } from '../providers/fake-stream-protocol';
import { LogSink, createLogger } from '../log/logger';

class SendingTransport implements SessionTransport {
  sent: unknown[] = [];
  spawn() {
    return {
      pid: 1,
      onExit: () => () => {},
      onMessage: () => () => {},
      send: (m: unknown) => {
        this.sent.push(m);
      },
      kill: () => {},
    };
  }
  remove(): void {}
}

/** PTY-shaped: bytes only, no typed send. */
class ByteTransport implements SessionTransport {
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
let dir: string;
let stream: SendingTransport;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sp-'));
  stream = new SendingTransport();
});

function streamManager(): SessionManager {
  return new SessionManager(
    registryFor('stream'),
    new ByteTransport(),
    createLogger(new LogSink({ dir }), 'sessions'),
    dir,
    { stream }
  );
}

describe('userMessage — the envelope S-10 wrote to the real CLI (P2-E18-06)', () => {
  it('is the SDK shape, with an EMPTY session_id', () => {
    expect(userMessage('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  });

  // Echoing a stale id is how a message gets attributed to a conversation that
  // has since been replaced — `/clear` mints a new one (#107).
  it('never carries a session id we happen to know', () => {
    expect(userMessage('hi').session_id).toBe('');
  });

  it('passes the text through completely untouched', () => {
    const nasty = '/slash `backtick` "quote" \\backslash\nsecond line\n';
    expect(userMessage(nasty).message.content[0].text).toBe(nasty);
  });
});

describe('framing — what bracketed paste was faking (P2-E18-06)', () => {
  // The whole S-03 problem restated: a newline inside the prompt must not end
  // the message. JSON escaping gives that for free.
  it('a multi-line prompt is ONE frame, not several', () => {
    const frame = encodeFrame(userMessage('line one\nline two\nline three'));
    expect(frame.split('\n').filter(Boolean)).toHaveLength(1);
    expect(frame.endsWith('\n')).toBe(true);
  });

  it('round-trips backticks, a leading slash and a trailing newline verbatim', () => {
    const text = '/hello `code` \u00e9\n';
    const d = new NdjsonDecoder<{ message: { content: Array<{ text: string }> } }>();
    const out = d.push(encodeFrame(userMessage(text)));

    expect(out).toHaveLength(1);
    expect(out[0].ok && out[0].value.message.content[0].text).toBe(text);
    expect(d.parseFailures).toBe(0);
  });

  // Closing the loop through the REAL fake: our encoder and its decoder have to
  // agree, and asserting against the fake's echo is what the item asks for.
  it('the FAKE receives exactly the text we submitted', () => {
    const out: Record<string, unknown>[] = [];
    const proto = new FakeStreamProtocol(
      {
        cwd: () => '/w',
        writeFile: () => {},
        stderr: () => {},
        exit: () => {},
        resolve: (c, t) => `${c}/${t}`,
      },
      (m) => out.push(m)
    );
    const text = 'first `line`\nsecond line\n/not-a-command\n';

    // encode exactly as the transport would, then decode exactly as the fake does
    const d = new NdjsonDecoder<Record<string, unknown>>();
    for (const r of d.push(encodeFrame(userMessage(text)))) {
      if (r.ok) proto.handle(r.value);
    }

    const assistant = out.find((m) => m.type === 'assistant') as {
      message: { content: Array<{ text: string }> };
    };
    expect(assistant.message.content[0].text).toBe(`FAKE-REPLY: ${text}`);
  });
});

describe('SessionManager.submitPrompt (P2-E18-06)', () => {
  it('sends the envelope on the session transport', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);

    expect(mgr.submitPrompt(rec.id, 'hello')).toBe(true);
    expect(stream.sent).toEqual([userMessage('hello')]);
  });

  // No round trip: we know the turn began because we began it. The PTY path
  // waits on a UserPromptSubmit hook to learn the same thing.
  it('marks the session working immediately', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);

    mgr.submitPrompt(rec.id, 'hello');

    expect(mgr.get(rec.id)!.status).toBe('working');
    expect(mgr.transitions(rec.id).map((t) => t.cause)).toContain('prompt-sent');
  });

  // The PTY needs composer.ts's bracketed paste + delayed CR, which is a
  // different operation, not this one in different clothes.
  it('returns FALSE on a PTY session so the caller can use the other route', () => {
    const mgr = new SessionManager(
      registryFor('pty'),
      new ByteTransport(),
      createLogger(new LogSink({ dir }), 'sessions'),
      dir
    );
    const rec = mgr.create(identity);

    expect(mgr.submitPrompt(rec.id, 'hello')).toBe(false);
    expect(mgr.get(rec.id)!.status).toBe('starting'); // and nothing was claimed
  });

  it('returns false for a session that does not exist', () => {
    expect(streamManager().submitPrompt('nope', 'hello')).toBe(false);
  });

  // A handle outliving its record is a reference to a child nobody can reach.
  it('a removed session cannot be submitted to', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    mgr.remove(rec.id);

    expect(mgr.submitPrompt(rec.id, 'hello')).toBe(false);
    expect(stream.sent).toEqual([]);
  });

  it('sendToTransport carries a control response through unchanged', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);

    const msg = controlResponse('req-1', { behavior: 'allow' });
    expect(mgr.sendToTransport(rec.id, msg)).toBe(true);
    expect(stream.sent).toEqual([msg]);
    // and it is NOT a prompt: the status must not move. (It reads `idle`, not
    // `starting`, since P2 #153's follow-up made transport-ready synchronous —
    // the point of the assertion is that sending did not change it.)
    expect(mgr.get(rec.id)!.status).toBe('idle');
  });
});

describe('controlResponse — the reply shape S-10 used (P2-E18-06)', () => {
  it('nests request_id and the payload the way the CLI expects', () => {
    expect(controlResponse('abc', { behavior: 'allow' })).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'abc', response: { behavior: 'allow' } },
    });
  });
});
