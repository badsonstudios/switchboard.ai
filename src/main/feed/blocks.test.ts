// The shared block derivation (P2-E18-10).
//
// These cases used to be reachable only by writing a JSONL file and waiting out
// a poll (watcher.test.ts still does that end to end, and should). Here they are
// synchronous, because the derivation is now pure — and because the SECOND
// consumer, `StreamFeed`, has to be able to rely on exactly the same answers.
import { describe, it, expect } from 'vitest';
import {
  DISPLAY_CAPS,
  DerivedBlock,
  IDENTITY_ONLY_CAPS,
  deriveIntents,
  touchedPath,
  EmitIntent,
  ToolResultIntent,
} from './blocks';
import { wrapInjectedContext } from '../../shared/injected-context';

const blocks = (intents: ReturnType<typeof deriveIntents>): EmitIntent[] =>
  intents.filter((i): i is EmitIntent => i.t === 'block');
const results = (intents: ReturnType<typeof deriveIntents>): ToolResultIntent[] =>
  intents.filter((i): i is ToolResultIntent => i.t === 'tool-result');

describe('deriveIntents — one message, one set of blocks', () => {
  it('a plain user prompt (string content)', () => {
    const b = blocks(deriveIntents({ type: 'user', message: { role: 'user', content: 'do it' } }));
    expect(b).toHaveLength(1);
    expect(b[0].block).toMatchObject({ kind: 'user', text: 'do it' });
  });

  it('assistant text, thinking and tool_use, each in message order', () => {
    const intents = blocks(
      deriveIntents({
        type: 'assistant',
        timestamp: '2026-08-02T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'here you go' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' },
            },
          ],
        },
      })
    );
    expect(intents.map((i) => i.block.kind)).toEqual(['thinking', 'assistant', 'tool']);
    // the index is the CONTENT index, which is what a stream delta is addressed
    // by — off-by-one here and a streamed reply renders twice
    expect(intents.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(intents[2].toolUseId).toBe('toolu_1');
    expect(intents[2].block.tool).toMatchObject({
      name: 'Edit',
      category: 'edit',
      summary: 'C:/x.ts',
      filePath: 'C:/x.ts',
      oldString: 'a',
      newString: 'b',
    });
  });

  it('TodoWrite becomes a checklist block, not a tool row', () => {
    const b = blocks(
      deriveIntents({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't',
              name: 'TodoWrite',
              input: { todos: [{ content: 'one', status: 'completed' }] },
            },
          ],
        },
      })
    );
    expect(b[0].block.kind).toBe('todos');
    expect(b[0].block.todos).toEqual([{ content: 'one', status: 'completed' }]);
  });

  it('a tool_result attaches to its tool block instead of becoming one', () => {
    const intents = deriveIntents({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    });
    expect(blocks(intents)).toHaveLength(0);
    expect(results(intents)).toEqual([{ t: 'tool-result', toolUseId: 'toolu_1', out: 'ok' }]);
  });

  it('CLI-internal lines produce nothing: isMeta, and <local-command-*> user text', () => {
    expect(
      deriveIntents({ type: 'user', isMeta: true, message: { content: 'internal' } })
    ).toHaveLength(0);
    expect(
      deriveIntents({
        type: 'user',
        message: { content: '<local-command-caveat>ignore me</local-command-caveat>' },
      })
    ).toHaveLength(0);
  });

  it('an unknown shape produces nothing rather than throwing', () => {
    expect(deriveIntents({})).toEqual([]);
    expect(deriveIntents({ type: 'assistant' })).toEqual([]);
    expect(deriveIntents({ type: 'rate_limit_event', foo: 1 })).toEqual([]);
  });

  // #997. The test above pins the TRANSCRIPT spelling. The stream spells the
  // same flag `is_meta`, and until this landed nothing in `src/` matched that
  // string at all — so the guard had silently applied to one of the two
  // transports it is the single reader for.
  //
  // These cases are written from the CLI's own outbound wire schemas rather
  // than from anything observed on our wire: a run against 2.1.280 with
  // switchboard's exact flag list produced no `is_meta` frame
  // (`spike/findings/997-is-meta-on-the-stream.md`). They exist so that the
  // day one arrives the Feed is already right, and so that deleting the
  // clause is a red suite rather than a silent regression.
  describe('the stream spelling, is_meta (#997)', () => {
    it('drops a synthetic assistant frame that would otherwise derive a tool row', () => {
      // The exact frame the issue was filed about, from the binary's builder:
      // `model: "<synthetic>"`, a `PushNotification` tool_use, `is_meta: true`.
      // Without the clause this derives a tool block and the Feed renders a
      // `PushNotification` row the user was never meant to see.
      expect(
        deriveIntents({
          type: 'assistant',
          is_meta: true,
          message: {
            role: 'assistant',
            model: '<synthetic>',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_997',
                name: 'PushNotification',
                input: { message: 'Your session is ready', status: 'proactive' },
              },
            ],
          },
        })
      ).toEqual([]);
    });

    it('drops a synthetic user frame too — the wire declares the flag on both shapes', () => {
      expect(
        deriveIntents({ type: 'user', is_meta: true, message: { content: 'loop-synthesized' } })
      ).toEqual([]);
    });

    it('needs the literal true, so a non-empty string does not silently drop a real line', () => {
      // Same reason the transcript side is `=== true`: these frames come from
      // another process, and a truthy test turns a junk value into a
      // disappeared message. `'false'` is truthy.
      const intents = deriveIntents({
        type: 'assistant',
        is_meta: 'false',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a real reply' }] },
      });
      expect(blocks(intents).map((b) => b.block.text)).toEqual(['a real reply']);
    });
  });
});

// #458. Session find scans the FILE and then has to say which block on screen a
// hit belongs to. It used to make that join on the file's own timestamp, which a
// Direct session's Feed does not have — so the flagship gesture was dead on the
// default transport. `srcId` is the join that survives the transport: two ids
// the ANTHROPIC API put in the message, which both sources receive unchanged.
describe('srcId — the identity that crosses transports (#458)', () => {
  /** The same message a transcript wraps in file metadata and a stream does not. */
  const message = {
    role: 'assistant',
    id: 'msg_01abc',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'here you go' },
      { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_10', name: 'TodoWrite', input: { todos: [] } },
    ],
  };

  it('is the tool call’s id for a tool block, and the message’s for prose', () => {
    const b = blocks(deriveIntents({ type: 'assistant', timestamp: 't', message }));
    expect(b.map((i) => i.block.srcId)).toEqual([
      'msg:msg_01abc',
      'msg:msg_01abc',
      // A tool_use id is unique across the whole conversation, so it beats the
      // message's — it identifies THIS block even though the message made four.
      'tool:toolu_9',
      // ...including the checklist, which carries no `toolUseId` of its own
      // because it has no OUT section to wait for.
      'tool:toolu_10',
    ]);
  });

  // THE POINT: the file's copy and the stream's copy of one turn differ in the
  // wrapper and nowhere else, so they must derive the same identities. If this
  // ever stops being true, a Direct session's find goes quietly list-only.
  it('is identical for the file’s copy of a turn and the stream’s', () => {
    const fromFile = blocks(
      deriveIntents({ type: 'assistant', timestamp: '2026-08-13T00:00:00.000Z', message, uuid: 'u' })
    );
    const fromStream = blocks(
      deriveIntents({ type: 'assistant', timestamp: '2026-08-13T09:99:99.999Z', message })
    );
    expect(fromStream.map((i) => i.block.srcId)).toEqual(fromFile.map((i) => i.block.srcId));
    expect(fromFile.every((i) => i.block.srcId !== undefined)).toBe(true);
  });

  // Identity is not text, so the pass that builds no text still carries it —
  // the search engine derives EVERY line to keep its ordinals in step and only
  // builds text for lines that could match.
  it('survives an identity-only derivation, where every text cap is zero', () => {
    const b = blocks(deriveIntents({ type: 'assistant', message }, IDENTITY_ONLY_CAPS));
    expect(b.map((i) => i.block.srcId)).toEqual([
      'msg:msg_01abc',
      'msg:msg_01abc',
      'tool:toolu_9',
      'tool:toolu_10',
    ]);
  });

  it('is simply absent when the message gave nothing to hold on to', () => {
    // A user prompt has no id on either side, and a source that stopped sending
    // one must degrade to "cannot jump", never to a wrong jump.
    const prompt = blocks(deriveIntents({ type: 'user', message: { content: 'do it' } }));
    expect(prompt[0].block.srcId).toBeUndefined();
    const anon = blocks(
      deriveIntents({ type: 'assistant', message: { role: 'assistant', content: message.content } })
    );
    expect(anon.map((i) => i.block.srcId)).toEqual([
      undefined,
      undefined,
      'tool:toolu_9',
      'tool:toolu_10',
    ]);
  });
});

// #156 / S-11. The transcript records a local slash command as
// `system:local_command` and writes NO assistant entry, so the Feed dropped the
// output on the floor in BOTH transports — `/usage` displayed nothing at all.
describe('local slash-command output (#156)', () => {
  const line = {
    type: 'system',
    subtype: 'local_command',
    level: 'info',
    isMeta: false,
    timestamp: '2026-08-02T10:00:00.000Z',
    content: '<local-command-stdout>Current session: 2% used</local-command-stdout>',
  };

  it('renders, with the <local-command-stdout> wrapper stripped', () => {
    const b = blocks(deriveIntents(line));
    expect(b).toHaveLength(1);
    expect(b[0].block.text).toBe('Current session: 2% used');
  });

  it('is an ASSISTANT block — the same kind the stream delivers for the same turn', () => {
    // Not cosmetic. Over stream-json the identical `/usage` turn arrives as an
    // ordinary `assistant` message (measured, S-11), so a distinct kind here
    // would make one output render two ways depending on the transport.
    expect(blocks(deriveIntents(line))[0].block.kind).toBe('assistant');
  });

  it('empty output produces no block rather than an empty bubble', () => {
    expect(
      deriveIntents({ ...line, content: '<local-command-stdout></local-command-stdout>' })
    ).toEqual([]);
    expect(deriveIntents({ type: 'system', subtype: 'local_command' })).toEqual([]);
  });

  it('other system subtypes are still ignored', () => {
    expect(deriveIntents({ type: 'system', subtype: 'init', content: 'x' })).toEqual([]);
  });
});

// #491 — the Feed used to render a prompt's WORDS and nothing else, so a turn
// that carried a screenshot looked exactly like one that did not, and an
// attachment-only turn ("look at this", nothing typed) produced no block at
// all: the reply arrived under no prompt. The composer's chip strip clears on
// send, so the message itself is the only surviving record of what went.
describe('attachments that rode with a prompt (#491)', () => {
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const doc = {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: '# hi' },
    title: 'notes.md',
  };
  const user = (content: unknown[]): ReturnType<typeof deriveIntents> =>
    deriveIntents({ type: 'user', message: { role: 'user', content } });

  it('counts the image blocks that travelled with the prompt', () => {
    const b = blocks(user([png, png, { type: 'text', text: 'what is this?' }]));
    expect(b).toHaveLength(1);
    expect(b[0].block).toMatchObject({
      kind: 'user',
      text: 'what is this?',
      attachments: { images: 2, documents: 0 },
    });
  });

  it('counts documents — a PDF or a text file — separately from pictures', () => {
    expect(blocks(user([doc, { type: 'text', text: 'read this' }]))[0].block.attachments).toEqual({
      images: 0,
      documents: 1,
    });
    expect(blocks(user([png, doc, doc, { type: 'text', text: 'x' }]))[0].block.attachments).toEqual({
      images: 1,
      documents: 2,
    });
  });

  // The case that produced NOTHING before: `userMessage` sends no text block at
  // all for a turn with an empty prompt, so the loop had nothing to emit.
  it('an attachment-only turn still gets a block, carrying no text', () => {
    const b = blocks(user([png]));
    expect(b).toHaveLength(1);
    expect(b[0].block.kind).toBe('user');
    expect(b[0].block.text).toBeUndefined();
    expect(b[0].block.attachments).toEqual({ images: 1, documents: 0 });
    // it stands for the attachments, not for one content item — see the
    // comment in `userIntents`; a stream delta must not be able to address it
    expect(b[0].index).toBeUndefined();
  });

  // "zero attachments renders exactly as today" is the done-when, and ABSENT
  // rather than zeroed is how that is enforced rather than hoped for.
  it('is absent — not zeroed — on an ordinary prompt', () => {
    expect(blocks(user([{ type: 'text', text: 'do it' }]))[0].block.attachments).toBeUndefined();
    const asString = blocks(
      deriveIntents({ type: 'user', message: { role: 'user', content: 'do it' } })
    );
    expect(asString[0].block.attachments).toBeUndefined();
  });

  // The count is only trustworthy if it cannot be fed by anything but the
  // composer. A Read of a `.png` comes back as an image NESTED in a
  // tool_result, and rendering that as "the user attached a picture" would be
  // the confident lie this marker exists to remove.
  it('does not count an image or a document a TOOL returned', () => {
    const intents = user([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [png, doc, { type: 'text', text: 'ok' }],
      },
    ]);
    expect(blocks(intents)).toEqual([]);
    expect(results(intents)).toHaveLength(1);
  });

  it('exactly one block wears the counts, however many prose blocks a message has', () => {
    const b = blocks(user([png, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }]));
    expect(b.map((i) => i.block.attachments)).toEqual([{ images: 1, documents: 0 }, undefined]);
  });

  // The identity-only pass exists to keep the search engine's block ordinals in
  // step with the Feed's `seq`. An attachment-only turn is a block on one side,
  // so it has to be a block on the other — and the counts are not text, so no
  // cap may erase them.
  it('survives an identity-only derivation, counts intact', () => {
    const b = blocks(
      deriveIntents({ type: 'user', message: { role: 'user', content: [png, doc] } }, IDENTITY_ONLY_CAPS)
    );
    expect(b).toHaveLength(1);
    expect(b[0].block.attachments).toEqual({ images: 1, documents: 1 });
  });
});

// #704. A background task that emits an event or ends makes the CLI write a
// turn into the conversation to re-invoke the model. It has `role: user`, so
// the Feed gave it a NEW PROMPT divider over raw XML. The recognition rule and
// its measurements are `injected.ts`; this is what the derivation does with it.
describe('harness-injected turns are notices, not prompts (#704)', () => {
  const PAYLOAD = `<task-notification>
<task-id>bvhh1kfa7</task-id>
<summary>Monitor event: "CI matrix result for PR #36"</summary>
<event>ubuntu-latest: pass</event>
If this event is something the user would act on now, send a PushNotification.
</task-notification>`;
  const TN = { origin: { kind: 'task-notification' } };

  it('a string-content notification becomes one notice block', () => {
    const b = blocks(deriveIntents({ type: 'user', ...TN, message: { content: PAYLOAD } }));
    expect(b).toHaveLength(1);
    expect(b[0].block.kind).toBe('notice');
    expect(b[0].block.notice).toMatchObject({
      source: 'task-notification',
      summary: 'Monitor event: "CI matrix result for PR #36"',
      status: 'event',
      taskId: 'bvhh1kfa7',
    });
  });

  // NOT `text`, and this is the assertion that pins the fix rather than the
  // rendering of it. Every prose reader in the app keys off `text` —
  // `search.ts` collects it, `transcript-blocks.ts` labels it `User:`, the
  // fallback renderer sets it as markdown. Leaving the payload there would
  // leave it classified as a person's words everywhere except the one renderer
  // that was taught otherwise.
  it('carries the payload on `notice.raw` and NOT on `text`', () => {
    const b = blocks(deriveIntents({ type: 'user', ...TN, message: { content: PAYLOAD } }));
    expect(b[0].block.text).toBeUndefined();
    expect(b[0].block.notice?.raw).toBe(PAYLOAD);
    // the harness's instruction to the model is in the payload and nowhere else
    expect(b[0].block.notice?.raw).toContain('send a PushNotification');
    expect(b[0].block.notice?.summary).not.toContain('PushNotification');
  });

  // The transcript writes these as a plain string; the stream's user messages
  // carry text ITEMS. One rule, both shapes — or the same notification renders
  // correctly on one transport and as raw XML on the other.
  it('reads the same turn when it arrives as a text item', () => {
    const b = blocks(
      deriveIntents({ type: 'user', ...TN, message: { content: [{ type: 'text', text: PAYLOAD }] } })
    );
    expect(b).toHaveLength(1);
    expect(b[0].block.kind).toBe('notice');
    // the content index survives, because a stream delta is addressed by it
    expect(b[0].index).toBe(0);
  });

  it('a person quoting one still gets their prompt', () => {
    const quoted = `why does this render as a prompt?\n${PAYLOAD}`;
    const b = blocks(deriveIntents({ type: 'user', message: { content: quoted } }));
    expect(b[0].block.kind).toBe('user');
    expect(b[0].block.text).toBe(quoted);
    // ...and one who OPENS with it, when the CLI tagged the turn human
    const opened = blocks(
      deriveIntents({ type: 'user', origin: { kind: 'human' }, message: { content: PAYLOAD } })
    );
    expect(opened[0].block.kind).toBe('user');
  });

  // Fail-open. An unreadable body costs the summary, not the block — and NOT by
  // falling back to a user prompt, which is the defect.
  it('a body it cannot read is still a notice, holding everything', () => {
    const junk = '<task-notification>\n{"shape":"new"}\n</task-notification>';
    const b = blocks(deriveIntents({ type: 'user', message: { content: junk } }));
    expect(b[0].block.kind).toBe('notice');
    expect(b[0].block.notice?.summary).toBe('{"shape":"new"}');
    expect(b[0].block.notice?.raw).toBe(junk);
  });

  // One block in, one block out: the search engine derives every line to keep
  // its ordinals in step with the Feed's `seq`, so a kind change must not be a
  // COUNT change. `SESSION_TRANSCRIPT_FACTS.blocks` is the same 1579 it was.
  it('survives an identity-only derivation as one block', () => {
    const b = blocks(
      deriveIntents({ type: 'user', ...TN, message: { content: PAYLOAD } }, IDENTITY_ONLY_CAPS)
    );
    expect(b).toHaveLength(1);
    expect(b[0].block.kind).toBe('notice');
  });

  it('an isMeta notification is still nothing at all', () => {
    expect(
      deriveIntents({ type: 'user', ...TN, isMeta: true, message: { content: PAYLOAD } })
    ).toHaveLength(0);
  });
});

describe('touchedPath — which key names a file (#766)', () => {
  // Shared with `watcher.ts`'s `filesTouched` so the session card and #766's
  // handoff cannot describe the same session differently. Each case below is a
  // way the two could have drifted.
  it('reads the three keys a tool uses to name a file, in order', () => {
    expect(touchedPath({ file_path: 'a.ts' })).toBe('a.ts');
    expect(touchedPath({ path: 'src' })).toBe('src');
    expect(touchedPath({ notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    // `file_path` wins when a tool somehow carries two.
    expect(touchedPath({ path: 'src', file_path: 'a.ts' })).toBe('a.ts');
  });

  it('is NOT `toolIntent`\'s label rule — a command is not a file', () => {
    // The label falls through to `command`/`description`/`pattern` because any
    // of them will do for one line of text. Folding the two would file
    // `npm test` as a file the session touched.
    expect(touchedPath({ command: 'npm test' })).toBeUndefined();
    expect(touchedPath({ description: 'run the suite' })).toBeUndefined();
    expect(touchedPath({ pattern: '**/*.ts' })).toBeUndefined();
  });

  it('answers undefined for anything that is not a non-empty string', () => {
    expect(touchedPath(undefined)).toBeUndefined();
    expect(touchedPath({})).toBeUndefined();
    expect(touchedPath({ file_path: '' })).toBeUndefined();
    expect(touchedPath({ file_path: 42 })).toBeUndefined();
    expect(touchedPath({ file_path: null })).toBeUndefined();
    expect(touchedPath({ file_path: { toString: () => 'a.ts' } })).toBeUndefined();
  });
});

describe('deriveIntents — injected context inside a user turn (#830)', () => {
  const REF = 'a1b2c3d4';
  const section = (ref: string, name = 'TradingApp'): string =>
    wrapInjectedContext({ body: 'their recent output', name, sessionId: 'sess-1', ref });
  const userLine = (text: string): Record<string, unknown> => ({
    type: 'user',
    message: { role: 'user', content: text },
  });
  const blockOf = (intents: ReturnType<typeof deriveIntents>): DerivedBlock =>
    (intents[0] as EmitIntent).block;

  it('marks the stretch this app injected, and leaves `text` exactly as sent', () => {
    const prompt = `${section(REF)}\n\nwhat do you make of it?`;
    const b = blockOf(
      deriveIntents(userLine(prompt), DISPLAY_CAPS, { isMintedRef: (r) => r === REF })
    );
    expect(b.kind).toBe('user');
    expect(b.text).toBe(prompt);
    expect(b.context).toHaveLength(1);
    const s = b.context?.[0];
    expect(s?.name).toBe('TradingApp');
    expect(prompt.slice(s?.start, s?.end)).toBe(section(REF));
  });

  it('does NOT mark a look-alike nobody minted — the forgery case', () => {
    const prompt = `${section('deadbeef')}\n\nwhat do you make of it?`;
    const b = blockOf(
      deriveIntents(userLine(prompt), DISPLAY_CAPS, { isMintedRef: (r) => r === REF })
    );
    expect(b.text).toBe(prompt);
    expect('context' in b).toBe(false);
  });

  it('builds no sections at all without a guard — the fail-closed default', () => {
    const prompt = `${section(REF)}\n\nand?`;
    expect('context' in blockOf(deriveIntents(userLine(prompt)))).toBe(false);
  });

  it('leaves an ordinary prompt byte-for-byte what it always was', () => {
    const plain = blockOf(
      deriveIntents(userLine('just a question'), DISPLAY_CAPS, { isMintedRef: () => true })
    );
    expect(plain).toEqual({ kind: 'user', text: 'just a question', ts: undefined });
  });

  it('⚠️ still folds when the cap bites — the budget is spent on the PROSE first', () => {
    // The case the feature exists for. `queries.ts` caps one session's output at
    // the same 20,000 characters this block is capped at, so a mention of a busy
    // session is over budget by construction. Slicing first found no closing
    // marker, folded nothing, and truncated the user's question off the end.
    const question = 'so what should I do?';
    const long = wrapInjectedContext({
      body: 'x'.repeat(2_000),
      name: 'TradingApp',
      sessionId: 'sess-1',
      ref: REF,
    });
    const prompt = `${long}\n\n${question}`;
    const caps = { ...DISPLAY_CAPS, text: 1_000 };
    const b = blockOf(deriveIntents(userLine(prompt), caps, { isMintedRef: () => true }));
    expect(b.text?.length).toBeLessThanOrEqual(1_000);
    expect(b.text).toContain(question);
    expect(b.context).toHaveLength(1);
    const s = b.context?.[0];
    expect(b.text?.slice(s?.start, s?.end).startsWith('[Context ')).toBe(true);
  });

  it('falls back to an honest slice, and no sections, when even the prose will not fit', () => {
    const prompt = `${section(REF)}\n\n${'q'.repeat(500)}`;
    const caps = { ...DISPLAY_CAPS, text: 200 };
    const b = blockOf(deriveIntents(userLine(prompt), caps, { isMintedRef: () => true }));
    expect('context' in b).toBe(false);
    expect(b.text?.length).toBe(200);
  });

  it('marks the same stretch when the turn arrives as text ITEMS (the stream shape)', () => {
    const prompt = `${section(REF)}\n\nwell?`;
    const entry = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    };
    const b = blockOf(deriveIntents(entry, DISPLAY_CAPS, { isMintedRef: () => true }));
    expect(b.context).toHaveLength(1);
    expect(b.text).toBe(prompt);
  });

  it('builds nothing on the identity-only pass, which promises no text at all', () => {
    const prompt = `${section(REF)}\n\nwell?`;
    const b = blockOf(
      deriveIntents(userLine(prompt), IDENTITY_ONLY_CAPS, { isMintedRef: () => true })
    );
    expect('context' in b).toBe(false);
  });
});
