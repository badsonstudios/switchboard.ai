// The shared block derivation (P2-E18-10).
//
// These cases used to be reachable only by writing a JSONL file and waiting out
// a poll (watcher.test.ts still does that end to end, and should). Here they are
// synchronous, because the derivation is now pure — and because the SECOND
// consumer, `StreamFeed`, has to be able to rely on exactly the same answers.
import { describe, it, expect } from 'vitest';
import { deriveIntents, EmitIntent, ToolResultIntent } from './blocks';

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
