// P2-E18-06 — prompt submission over stdin.
//
// The PTY path (`renderer/lib/composer.ts`) wraps multiline text in a bracketed
// paste and sends the carriage return 75ms LATER, because text+CR in one chunk
// registers as a paste and never submits (S-03, refound live 2026-07-22). None
// of that exists here: a prompt is a struct, and a newline inside a JSON string
// cannot be mistaken for a frame boundary. These tests are mostly about proving
// that claim rather than trusting it.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions } from '../extensibility/contributions';
import { SessionTransport } from '../transport/transport';
import { userMessage, controlResponse } from '../../shared/stream-protocol';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_BYTES,
  sanitizePromptImages,
} from '../../shared/prompt-images';
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
  dir = tempDir('sb-sp-');
  stream = new SendingTransport();
});
afterEach(() => cleanupTempDirs()); // one per test, gone at the end of it (#213)

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
    expect(userMessage(nasty).message.content).toEqual([{ type: 'text', text: nasty }]);
  });
});

// THE CONTRACT, PINNED (P2-E10-09). Every shape below was read out of the VS
// Code extension's webview bundle (2.1.226) — the known-correct consumer — and
// not invented. The greps that produced them are in the item's hand-off; what
// this file exists to do is make a drift from them fail a test rather than a
// turn.
describe('userMessage with images — the extension’s own block shape', () => {
  const png = { mediaType: 'image/png' as const, data: 'AQIDBA==' };
  const jpg = { mediaType: 'image/jpeg' as const, data: 'BQYHCA==' };

  //   case"image": a.push({type:"image",source:{type:"base64",media_type:p,data:u}});break;
  // `p` is the lower-cased MIME, `u` is `dataUrl.split(",")[1]` — the base64
  // payload with the `data:image/png;base64,` prefix STRIPPED.
  it('is the Messages-API image block, base64 inline, no data: prefix', () => {
    expect(userMessage('what is this?', [png]).message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' },
    });
  });

  // `input_image` and `image_url` — the OpenAI spellings — count ZERO in both
  // bundles. This is the only shape on offer.
  it('never uses the OpenAI spellings', () => {
    const block = JSON.stringify(userMessage('x', [png]));
    expect(block).not.toContain('input_image');
    expect(block).not.toContain('image_url');
  });

  // Their builder pushes attachments and only then
  // `a.push({type:"text",text:e})` with the typed prompt. The prompt refers to
  // the images above it, so the order is part of the contract.
  it('puts the images FIRST and the typed prompt LAST', () => {
    expect(userMessage('compare these', [png, jpg]).message.content.map((c) => c.type)).toEqual([
      'image',
      'image',
      'text',
    ]);
  });

  // An image sent with nothing typed is a legitimate turn; a zero-length text
  // block is not a thing the message format accepts.
  it('omits the text block entirely when nothing was typed', () => {
    expect(userMessage('', [png]).message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } },
    ]);
  });

  // The regression that would be invisible: every existing caller passes no
  // images at all and must keep producing byte-identical envelopes.
  it('is unchanged for a plain text prompt', () => {
    expect(userMessage('hi', [])).toEqual(userMessage('hi'));
    expect(userMessage('hi').message.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  // NDJSON is the transport, so a base64 payload has to survive framing — the
  // same property `\n` in a prompt needed, on a string three orders of
  // magnitude longer.
  it('a turn carrying an image is still ONE frame', () => {
    const big = { mediaType: 'image/png' as const, data: 'A'.repeat(200_000) };
    const frame = encodeFrame(userMessage('look', [big]));
    expect(frame.split('\n').filter(Boolean)).toHaveLength(1);
    const d = new NdjsonDecoder<{ message: { content: Array<Record<string, unknown>> } }>();
    const out = d.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].ok && (out[0].value.message.content[0].source as { data: string }).data).toBe(
      big.data
    );
  });
});

describe('sanitizePromptImages — main’s own check, not the renderer’s (P2-E10-09)', () => {
  const ok = { mediaType: 'image/png', data: 'AQIDBA==' };

  it('lets a well-formed image through, lower-cased', () => {
    expect(sanitizePromptImages([{ mediaType: 'IMAGE/PNG', data: 'AQIDBA==' }])).toEqual([
      { mediaType: 'image/png', data: 'AQIDBA==' },
    ]);
  });

  // The overwhelmingly common case: a text prompt must not be able to trip this.
  it('reads a missing list as no images, not as a refusal', () => {
    expect(sanitizePromptImages(undefined)).toEqual([]);
    expect(sanitizePromptImages([])).toEqual([]);
  });

  it('refuses a media type outside the reference allow-list', () => {
    expect(sanitizePromptImages([{ mediaType: 'image/svg+xml', data: 'AQIDBA==' }])).toBeNull();
    expect(sanitizePromptImages([{ mediaType: 'text/html', data: 'AQIDBA==' }])).toBeNull();
  });

  // A `data:` prefix would ride into the block verbatim and be decoded as
  // garbage by the API — the one malformation that looks plausible.
  it('refuses anything that is not bare base64', () => {
    expect(
      sanitizePromptImages([{ mediaType: 'image/png', data: 'data:image/png;base64,AQIDBA==' }])
    ).toBeNull();
    expect(sanitizePromptImages([{ mediaType: 'image/png', data: 'AQID\nBA==' }])).toBeNull();
    expect(sanitizePromptImages([{ mediaType: 'image/png', data: '' }])).toBeNull();
  });

  it('refuses a payload past the ceiling, and a list past the count', () => {
    expect(
      sanitizePromptImages([{ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1) }])
    ).toBeNull();
    expect(sanitizePromptImages(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ok))).toBeNull();
  });

  it('refuses junk rather than coercing it', () => {
    expect(sanitizePromptImages('nope')).toBeNull();
    expect(sanitizePromptImages([null])).toBeNull();
    expect(sanitizePromptImages([{ mediaType: 'image/png' }])).toBeNull();
    expect(sanitizePromptImages([{ mediaType: 7, data: 'AQIDBA==' }])).toBeNull();
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

    // the assistant message carrying TEXT — the real CLI sends one message per
    // CONTENT BLOCK and the first of them is the thinking block (measured
    // 2026-08-02, `spike/s11/probe-140-slash-flags.cjs`; the fake reproduces it)
    const replied = out
      .filter((m) => m.type === 'assistant')
      .flatMap(
        (m) => (m.message as { content: Array<{ type?: string; text?: string }> }).content ?? []
      )
      .find((c) => c.type === 'text')?.text;
    expect(replied).toBe(`FAKE-REPLY: ${text}`);
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

// #154 — the stop button did nothing in Direct mode.
//
// It wrote Esc to the PTY unconditionally. A stream session HAS no PTY, so
// `ptys.get(id)?.write()` was a silent no-op — Dan reproduced it every time:
// submit a prompt, click stop repeatedly, watch the turn run to completion.
//
// Third instance of one class: a PTY-shaped affordance surviving into a mode
// with no PTY (the others were the Terminal tab and the hand-off bar).
describe('interrupt (#154)', () => {
  it('sends the SDK control_request shape, not a keystroke', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);

    expect(mgr.interrupt(rec.id)).toBe(true);
    expect(stream.sent).toHaveLength(1);
    const sent = stream.sent[0] as { type: string; request_id: string; request: unknown };
    expect(sent.type).toBe('control_request');
    expect(sent.request).toEqual({ subtype: 'interrupt' });
    // a real id, because the CLI answers by echoing it back
    expect(sent.request_id).toMatch(/[0-9a-f-]{36}/);
  });

  it('gives every interrupt its own request id', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    mgr.interrupt(rec.id);
    mgr.interrupt(rec.id);
    const ids = (stream.sent as Array<{ request_id: string }>).map((m) => m.request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // The PTY's interrupt is an Esc keystroke — a genuinely different operation,
  // so this reports "not mine" and the renderer falls back.
  it('returns FALSE on a PTY session so the caller can send Esc instead', () => {
    const mgr = new SessionManager(
      registryFor('pty'),
      new ByteTransport(),
      createLogger(new LogSink({ dir }), 'sessions'),
      dir
    );
    const rec = mgr.create(identity);
    expect(mgr.interrupt(rec.id)).toBe(false);
  });

  it('returns false for a session that does not exist', () => {
    expect(streamManager().interrupt('nope')).toBe(false);
  });

  it('interrupting does NOT count as a prompt — the status must not go working', () => {
    const mgr = streamManager();
    const rec = mgr.create(identity);
    mgr.interrupt(rec.id);
    expect(mgr.get(rec.id)!.status).toBe('idle');
  });
});
