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
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  sanitizePromptAttachments,
} from '../../shared/prompt-attachments';
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
  const png = { kind: 'image' as const, mediaType: 'image/png' as const, data: 'AQIDBA==' };
  const jpg = { kind: 'image' as const, mediaType: 'image/jpeg' as const, data: 'BQYHCA==' };

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
    const big = { kind: 'image' as const, mediaType: 'image/png' as const, data: 'A'.repeat(200_000) };
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

describe('sanitizePromptAttachments — main’s own check, not the renderer’s (P2-E10-09)', () => {
  const ok = { kind: 'image', mediaType: 'image/png', data: 'AQIDBA==' };

  it('lets a well-formed image through, lower-cased', () => {
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 'IMAGE/PNG', data: 'AQIDBA==' }])).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'AQIDBA==' },
    ]);
  });

  // The overwhelmingly common case: a text prompt must not be able to trip this.
  it('reads a missing list as no images, not as a refusal', () => {
    expect(sanitizePromptAttachments(undefined)).toEqual([]);
    expect(sanitizePromptAttachments([])).toEqual([]);
  });

  it('refuses a media type outside the reference allow-list', () => {
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/svg+xml', data: 'AQIDBA==' }])).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 'text/html', data: 'AQIDBA==' }])).toBeNull();
  });

  // A `data:` prefix would ride into the block verbatim and be decoded as
  // garbage by the API — the one malformation that looks plausible.
  it('refuses anything that is not bare base64', () => {
    expect(
      sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png', data: 'data:image/png;base64,AQIDBA==' }])
    ).toBeNull();
    expect(
      sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png', data: 'AQID\nBA==' }])
    ).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png', data: '' }])).toBeNull();
  });

  it('refuses a payload past the ceiling, and a list past the count', () => {
    expect(
      sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png', data: 'A'.repeat(MAX_ATTACHMENT_PAYLOAD_BYTES + 1) }])
    ).toBeNull();
    expect(sanitizePromptAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ok))).toBeNull();
  });

  it('refuses junk rather than coercing it', () => {
    expect(sanitizePromptAttachments('nope')).toBeNull();
    expect(sanitizePromptAttachments([null])).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png' }])).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'image', mediaType: 7, data: 'AQIDBA==' }])).toBeNull();
  });
});

// THE DOCUMENT CONTRACT, PINNED (P2-E10-10). Same provenance as the image
// block above: read out of the 2.1.226 webview bundle's `Wbe` builder, and
// verified against the CLI on PATH once. The asymmetry between the two sources
// is the thing most likely to be "tidied up" by someone who has not read the
// reference, so it gets its own tests.
describe('userMessage with documents — the extension’s own block shape', () => {
  const md = { kind: 'text' as const, title: 'notes.md', text: '# hello\n' };
  const pdf = { kind: 'pdf' as const, title: 'spec.pdf', data: 'AQIDBA==' };
  const png = { kind: 'image' as const, mediaType: 'image/png' as const, data: 'AQIDBA==' };

  //   case"text": {let g=atob(u);
  //     a.push({type:"document",source:{type:"text",media_type:"text/plain",data:g},title:c.file.name});break}
  it('sends a text file as a document whose source is the CONTENTS, in the clear', () => {
    expect(userMessage('read this', [md]).message.content[0]).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: '# hello\n' },
      title: 'notes.md',
    });
  });

  // The failure this exists to prevent: base64 in a `type:"text"` source is
  // valid JSON, is accepted, and reaches the model as a wall of gibberish. A
  // regression here would look like the model being unhelpful, not like a bug.
  it('never base64s a text attachment', () => {
    const data = (
      userMessage('x', [{ kind: 'text', title: 'a.txt', text: 'plain words' }]).message
        .content[0] as { source: { data: string } }
    ).source.data;
    expect(data).toBe('plain words');
    expect(data).not.toBe(btoa('plain words'));
  });

  //   case"pdf": a.push({type:"document",source:{type:"base64",media_type:"application/pdf",data:u},title:…});
  it('sends a PDF as a document whose source IS base64', () => {
    expect(userMessage('read this', [pdf]).message.content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'AQIDBA==' },
      title: 'spec.pdf',
    });
  });

  // `title` is on both document arms and on NEITHER image arm — verified by
  // grep, not assumed.
  it('titles documents and never titles an image', () => {
    const [image, text] = userMessage('x', [png, md]).message.content;
    expect(image).not.toHaveProperty('title');
    expect(text).toHaveProperty('title', 'notes.md');
  });

  // Mixed kinds keep the USER'S order, not a per-kind grouping — "compare the
  // first with the second" has to mean what it says.
  it('preserves the order across kinds, with the typed prompt still last', () => {
    expect(userMessage('compare', [md, png, pdf]).message.content.map((c) => c.type)).toEqual([
      'document',
      'image',
      'document',
      'text',
    ]);
  });

  it('omits the text block entirely when only a file was sent', () => {
    expect(userMessage('', [md]).message.content).toHaveLength(1);
  });

  // A text attachment carrying newlines is the ordinary case, and NDJSON is the
  // transport — the same framing property the prompt text needed, on a payload
  // that is nothing but newlines.
  it('a multi-line text attachment is still ONE frame', () => {
    const doc = { kind: 'text' as const, title: 'a.log', text: 'l1\nl2\nl3\n'.repeat(5_000) };
    const frame = encodeFrame(userMessage('look', [doc]));
    expect(frame.split('\n').filter(Boolean)).toHaveLength(1);
    const d = new NdjsonDecoder<{ message: { content: Array<Record<string, unknown>> } }>();
    const out = d.push(frame);
    expect(out[0].ok && (out[0].value.message.content[0].source as { data: string }).data).toBe(
      doc.text
    );
  });

  // Non-ASCII is the DIVERGENCE from the reference made visible: theirs
  // `atob`s to latin1 and mojibakes this; ours carries the characters.
  it('carries non-ASCII text through verbatim', () => {
    const text = 'em—dash, café, 日本語';
    const d = new NdjsonDecoder<{ message: { content: Array<{ source: { data: string } }> } }>();
    const out = d.push(encodeFrame(userMessage('x', [{ kind: 'text', title: 'u.md', text }])));
    expect(out[0].ok && out[0].value.message.content[0].source.data).toBe(text);
  });
});

describe('sanitizePromptAttachments — documents (P2-E10-10)', () => {
  it('lets a well-formed text and pdf attachment through', () => {
    expect(
      sanitizePromptAttachments([
        { kind: 'text', title: 'a.md', text: 'hi' },
        { kind: 'pdf', title: 'b.pdf', data: 'AQIDBA==' },
      ])
    ).toEqual([
      { kind: 'text', title: 'a.md', text: 'hi' },
      { kind: 'pdf', title: 'b.pdf', data: 'AQIDBA==' },
    ]);
  });

  it('refuses an unknown kind rather than guessing one', () => {
    expect(sanitizePromptAttachments([{ kind: 'video', title: 'a.mp4', data: 'AQ==' }])).toBeNull();
    expect(sanitizePromptAttachments([{ title: 'a.md', text: 'hi' }])).toBeNull();
  });

  // A title is a LABEL. Letting a renderer put a path or a control character in
  // a field the model reads is a seam with no upside — the reference only ever
  // sends `File.name`, and `webkitRelativePath` counts zero in both bundles.
  it('refuses a title that is not a bare file name', () => {
    expect(sanitizePromptAttachments([{ kind: 'text', title: '../etc/pw', text: 'x' }])).toBeNull();
    expect(
      sanitizePromptAttachments([{ kind: 'text', title: 'a\\b.md', text: 'x' }])
    ).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'text', title: 'a\nb.md', text: 'x' }])).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'text', title: '', text: 'x' }])).toBeNull();
    expect(sanitizePromptAttachments([{ kind: 'pdf', title: 'a/b.pdf', data: 'AQ==' }])).toBeNull();
  });

  // An empty document block claims to carry a file and carries nothing — which
  // the model cannot tell apart from a genuinely empty file, and whose far more
  // likely cause is that we failed to read it.
  it('refuses an empty text attachment', () => {
    expect(sanitizePromptAttachments([{ kind: 'text', title: 'a.md', text: '' }])).toBeNull();
  });

  it('refuses a pdf payload that is not bare base64, and one past the ceiling', () => {
    expect(
      sanitizePromptAttachments([{ kind: 'pdf', title: 'a.pdf', data: 'data:x;base64,AQ==' }])
    ).toBeNull();
    expect(
      sanitizePromptAttachments([
        { kind: 'pdf', title: 'a.pdf', data: 'A'.repeat(MAX_ATTACHMENT_PAYLOAD_BYTES + 1) },
      ])
    ).toBeNull();
  });

  // The ceiling on text is measured in UTF-8 BYTES, not characters: a string of
  // multi-byte characters costs more on the wire than its `.length` suggests.
  it('measures the text ceiling in UTF-8 bytes', () => {
    const justUnder = 'a'.repeat(MAX_ATTACHMENT_PAYLOAD_BYTES);
    expect(sanitizePromptAttachments([{ kind: 'text', title: 'a.md', text: justUnder }])).toEqual([
      { kind: 'text', title: 'a.md', text: justUnder },
    ]);
    // three bytes each, so half the character count is one and a half ceilings
    const multibyte = '日'.repeat(Math.floor(MAX_ATTACHMENT_PAYLOAD_BYTES / 2));
    expect(sanitizePromptAttachments([{ kind: 'text', title: 'a.md', text: multibyte }])).toBeNull();
  });

  // THE SEAM. The check short-circuits: anything shorter than a third of the
  // ceiling is provably fine (UTF-8 is at most 3 bytes per UTF-16 code unit) and
  // is never encoded to find out. A wrong constant there would silently start
  // refusing perfectly valid files, and both tests above sit far away from it.
  it('accepts a string just past the short-circuit whose UTF-8 still fits', () => {
    const justPast = 'a'.repeat(Math.floor(MAX_ATTACHMENT_PAYLOAD_BYTES / 3) + 1000);
    const out = sanitizePromptAttachments([{ kind: 'text', title: 'a.md', text: justPast }]);
    expect(out).toHaveLength(1);
  });

  it('refuses a string under the character ceiling whose UTF-8 is over the byte one', () => {
    // 2 bytes each in UTF-8, 1 UTF-16 unit each: 60% of the ceiling in
    // characters is 120% of it in bytes — the exact case a character-count
    // check would wave through.
    const chars = Math.floor(MAX_ATTACHMENT_PAYLOAD_BYTES * 0.6);
    const text = 'é'.repeat(chars);
    expect(text.length).toBeLessThan(MAX_ATTACHMENT_PAYLOAD_BYTES);
    expect(sanitizePromptAttachments([{ kind: 'text', title: 'a.md', text }])).toBeNull();
  });

  it('refuses base64 whose length is not a multiple of four', () => {
    expect(sanitizePromptAttachments([{ kind: 'pdf', title: 'a.pdf', data: 'AQI' }])).toBeNull();
    expect(
      sanitizePromptAttachments([{ kind: 'image', mediaType: 'image/png', data: 'AQI' }])
    ).toBeNull();
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
