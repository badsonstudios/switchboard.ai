// The shared block derivation (P2-E18-10).
//
// These cases used to be reachable only by writing a JSONL file and waiting out
// a poll (watcher.test.ts still does that end to end, and should). Here they are
// synchronous, because the derivation is now pure — and because the SECOND
// consumer, `StreamFeed`, has to be able to rely on exactly the same answers.
import { describe, it, expect } from 'vitest';
import { IDENTITY_ONLY_CAPS, deriveIntents, EmitIntent, ToolResultIntent } from './blocks';

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
