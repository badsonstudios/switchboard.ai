// The Feed from typed messages (P2-E18-10 / #140).
//
// Message shapes are the ones the real CLI emits — S-10's capture for the
// envelope, and the Anthropic streaming events the SDK's own accumulator inside
// the VS Code extension consumes (`message_start` / `content_block_start` /
// `content_block_delta` / `content_block_stop`, addressed by `index`).
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamFeed } from './stream-feed';
import { FeedBlock } from './blocks';

const SID = 'live-1';
const CONV = '00000000-conv-4000-8000-000000000000';

let feed: StreamFeed;
let seen: FeedBlock[];
let resets: Array<string | undefined>;

beforeEach(() => {
  feed = new StreamFeed();
  seen = [];
  resets = [];
  feed.onBlock((_sid, b) => seen.push({ ...b }));
  feed.onReset((_sid, cause) => resets.push(cause));
});

const ev = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event,
  session_id: CONV,
  parent_tool_use_id: null,
});
const textDelta = (text: string, index = 0) =>
  ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const assistant = (content: unknown[]): Record<string, unknown> => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  session_id: CONV,
  parent_tool_use_id: null,
});
const kinds = (): string[] => feed.blocks(SID).map((b) => b.kind);
const texts = (): Array<string | undefined> => feed.blocks(SID).map((b) => b.text);

/**
 * What the RENDERER last saw for a given seq.
 *
 * Claims about superseding have to be made here, not on `feed.blocks()`. The
 * buffer is the main process's copy; the renderer only ever knows what was
 * EMITTED — and the first version of this suite checked the buffer, which
 * passed while the renderer showed the last delta for ever. The defect and its
 * test were wrong in the same direction, which is the only way a test does not
 * catch its own bug.
 */
const emitted = (seq: number): FeedBlock | undefined =>
  [...seen].reverse().find((b) => b.seq === seq);

describe('token-by-token assistant text', () => {
  it('a block appears on the first delta and grows with each one', () => {
    feed.offer(SID, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('Hel'));
    expect(texts()).toEqual(['Hel']);
    feed.offer(SID, textDelta('lo '));
    feed.offer(SID, textDelta('world'));

    // ONE block, re-emitted as it filled — the renderer upserts on seq, so the
    // user watches a single bubble grow rather than seeing three
    expect(feed.blocks(SID)).toHaveLength(1);
    expect(texts()).toEqual(['Hello world']);
    expect(new Set(seen.map((b) => b.seq))).toEqual(new Set([1]));
    expect(seen).toHaveLength(4); // creation + three deltas
    expect(seen.at(-1)!.streaming).toBe(true);
  });

  it('the assistant message SUPERSEDES the streamed block, and the RENDERER sees it', () => {
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('Hello wor'));
    feed.offer(SID, ev({ type: 'content_block_stop', index: 0 }));
    feed.offer(SID, ev({ type: 'message_stop' }));
    // …and only THEN the assembled message, which is the order S-10 observed.
    // The assembly map has to outlive content_block_stop for this to hold.
    //
    // The final text differs from the deltas ON PURPOSE. When the two are equal
    // — as they are in the fake, and in every happy path — a supersede that
    // never reaches the renderer is invisible, and this test passed against
    // exactly that defect until it was made to look at `seen`.
    feed.offer(SID, assistant([{ type: 'text', text: 'Hello world (revised)' }]));

    expect(feed.blocks(SID)).toHaveLength(1);
    expect(texts()).toEqual(['Hello world (revised)']);
    expect(emitted(1)).toMatchObject({ text: 'Hello world (revised)', streaming: false });
  });

  // THE SHAPE THE REAL CLI ACTUALLY SENDS, measured 2026-08-02 against the PATH
  // CLI with our exact argument list (`spike/s11/probe-140-slash-flags.cjs`,
  // three turns, identical every time). One `assistant` message PER CONTENT
  // BLOCK, each arriving mid-stream before its own `content_block_stop`, and
  // each carrying a single-element `content` array — so EVERY one of them
  // reports content index 0 while the deltas were addressed 0, 1, 2…
  //
  // A purely index-based reconcile lines up the first block and appends a
  // duplicate of every block after it. The fake used to send one whole message
  // at the end, which is why nothing caught this.
  it('reconciles one assistant message PER CONTENT BLOCK, all reporting index 0', () => {
    feed.offer(SID, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    // block 0: thinking
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    feed.offer(
      SID,
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing it' } })
    );
    feed.offer(SID, assistant([{ type: 'thinking', thinking: 'weighing it up' }]));
    feed.offer(SID, ev({ type: 'content_block_stop', index: 0 }));
    // block 1: text — the assistant message for it ALSO reports content index 0
    feed.offer(SID, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('the ans', 1));
    feed.offer(SID, assistant([{ type: 'text', text: 'the answer' }]));
    feed.offer(SID, ev({ type: 'content_block_stop', index: 1 }));
    feed.offer(SID, ev({ type: 'message_stop' }));
    feed.offer(SID, { type: 'result', subtype: 'success' });

    // TWO blocks, not three: the second message superseded the streamed text
    // block rather than appending a second copy of the reply
    expect(kinds()).toEqual(['thinking', 'assistant']);
    expect(texts()).toEqual(['weighing it up', 'the answer']);
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1, 2]);
    expect(emitted(2)).toMatchObject({ text: 'the answer', streaming: false });
  });

  it('an empty thinking block (a bare signature) does not eat the reply', () => {
    // Exactly what the probe saw: `{"type":"thinking","thinking":"","signature":"CAIS…"}`.
    // The thinking block produces NO intent, so its assistant message claims
    // nothing — and must not retire the text block that follows it.
    feed.offer(SID, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    feed.offer(
      SID,
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'CAIS' } })
    );
    feed.offer(SID, assistant([{ type: 'thinking', thinking: '', signature: 'CAIS' }]));
    feed.offer(SID, ev({ type: 'content_block_stop', index: 0 }));
    feed.offer(SID, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('391', 1));
    feed.offer(SID, assistant([{ type: 'text', text: '391' }]));
    feed.offer(SID, { type: 'result', subtype: 'success' });

    expect(texts().filter((t) => t === '391')).toHaveLength(1); // ONE copy
    expect(feed.blocks(SID).filter((b) => b.kind === 'assistant')).toHaveLength(1);
  });

  // The other measured shape: a LOCAL slash command answers with a bare
  // `system:init -> assistant -> result` and no stream events at all.
  it('a turn with no stream events at all still renders (local slash commands)', () => {
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'Current model: Fable 5' }]));
    feed.offer(SID, { type: 'result', subtype: 'success' });

    expect(texts()).toEqual(['Current model: Fable 5']);
    expect(emitted(1)).toMatchObject({ streaming: false });
  });

  it('a content block that produced NO deltas still renders its text', () => {
    // Every delta of the block was a kind we filter (signature_delta), or the
    // CLI sent none. The block exists and is EMPTY until the message lands, so
    // if that update does not reach the renderer the bubble stays blank for
    // ever while the main process holds the answer.
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    feed.offer(SID, ev({ type: 'content_block_stop', index: 0 }));
    feed.offer(SID, assistant([{ type: 'text', text: 'the whole reply' }]));

    expect(feed.blocks(SID)).toHaveLength(1);
    expect(emitted(1)).toMatchObject({ text: 'the whole reply', streaming: false });
  });

  it('a `result` BEFORE the assistant message does not duplicate the reply', () => {
    // The measured case is an interrupted turn (#154), which ends with a
    // result. Forgetting the assembly map there would leave the message that
    // follows nothing to update, and it would append a second copy.
    feed.offer(SID, textDelta('partial'));
    feed.offer(SID, { type: 'result', subtype: 'error_during_execution', is_error: true });
    feed.offer(SID, assistant([{ type: 'text', text: 'partial reply' }]));

    expect(feed.blocks(SID)).toHaveLength(1);
    expect(texts()).toEqual(['partial reply']);
  });

  it('a turn that ended with nothing at all does not swallow the next one', () => {
    // No assistant message, no result, and the next message omits
    // `message_start`: the tokens must start a NEW block rather than growing
    // the abandoned one into an endless bubble.
    feed.offer(SID, textDelta('turn one'));
    feed.finalize(SID);
    feed.offer(SID, textDelta('turn two'));

    expect(texts()).toEqual(['turn one', 'turn two']);
  });

  it('keeps a message\'s blocks in the order the model produced them', () => {
    // `[tool_use, text]`: the tool row opens on content_block_start, which
    // carries the name whole. Opening only the text block would give it seq 1
    // and render the reply ABOVE the tool call that produced it.
    feed.offer(SID, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    feed.offer(
      SID,
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      })
    );
    feed.offer(SID, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('after the tool', 1));
    feed.offer(
      SID,
      assistant([
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:/x.ts' } },
        { type: 'text', text: 'after the tool' },
      ])
    );

    expect(kinds()).toEqual(['tool', 'assistant']);
    expect(feed.blocks(SID)[0].tool).toMatchObject({ name: 'Read', summary: 'C:/x.ts' });
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1, 2]);
  });

  it('deltas with no content_block_start still render (the CLI owns that message)', () => {
    feed.offer(SID, textDelta('sudden'));
    feed.offer(SID, assistant([{ type: 'text', text: 'sudden text' }]));
    expect(texts()).toEqual(['sudden text']);
  });

  it('thinking streams into a thinking block, not an assistant one', () => {
    feed.offer(
      SID,
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    );
    feed.offer(
      SID,
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
    );
    expect(kinds()).toEqual(['thinking']);
    expect(texts()).toEqual(['hmm']);
  });

  it('two content blocks in one message keep their own text (index is honoured)', () => {
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    feed.offer(SID, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }));
    feed.offer(SID, ev({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('answer', 1));
    feed.offer(
      SID,
      assistant([
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'answer' },
      ])
    );
    expect(kinds()).toEqual(['thinking', 'assistant']);
    expect(texts()).toEqual(['plan', 'answer']);
  });

  it('a second turn does not append to the first turn\'s block', () => {
    feed.offer(SID, textDelta('one'));
    feed.offer(SID, assistant([{ type: 'text', text: 'one' }]));
    feed.offer(SID, { type: 'result', subtype: 'success' });
    feed.offer(SID, textDelta('two'));
    feed.offer(SID, assistant([{ type: 'text', text: 'two' }]));
    expect(texts()).toEqual(['one', 'two']);
  });
});

// "every existing Feed block type renders from the stream source" — the
// done-when, one case per kind, all from typed messages only.
describe('every block type, from the stream', () => {
  it('user prompts arrive as replayed `user` messages (--replay-user-messages)', () => {
    feed.offer(SID, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
      parent_tool_use_id: null,
    });
    expect(kinds()).toEqual(['user']);
    expect(texts()).toEqual(['do the thing']);
  });

  it('tool blocks, and their OUT when the tool_result comes back', () => {
    feed.offer(
      SID,
      assistant([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', description: 'list' } },
      ])
    );
    expect(kinds()).toEqual(['tool']);
    expect(feed.blocks(SID)[0].tool).toMatchObject({
      name: 'Bash',
      category: 'shell',
      summary: 'ls',
      description: 'list',
    });

    feed.offer(SID, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }] },
      parent_tool_use_id: null,
    });
    expect(feed.blocks(SID)).toHaveLength(1); // attached, not appended
    expect(feed.blocks(SID)[0].tool!.out).toBe('a.ts\nb.ts');
  });

  it('an edit block carries its diff fields', () => {
    feed.offer(
      SID,
      assistant([
        {
          type: 'tool_use',
          id: 't',
          name: 'Edit',
          input: { file_path: 'C:/x.ts', old_string: 'a', new_string: 'b' },
        },
      ])
    );
    expect(feed.blocks(SID)[0].tool).toMatchObject({ filePath: 'C:/x.ts', oldString: 'a', newString: 'b' });
  });

  it('todos render as a checklist block', () => {
    feed.offer(
      SID,
      assistant([
        {
          type: 'tool_use',
          id: 't',
          name: 'TodoWrite',
          input: { todos: [{ content: 'ship it', status: 'in_progress' }] },
        },
      ])
    );
    expect(kinds()).toEqual(['todos']);
    expect(feed.blocks(SID)[0].todos).toEqual([{ content: 'ship it', status: 'in_progress' }]);
  });

  it('a tool row opens with its NAME but never with its half-written input', () => {
    // `content_block_start` carries the tool's name whole, so the row can open
    // in the right place in the message. `input_json_delta` carries fragments
    // of half-written JSON — a row built from half a path is worse than one
    // that appears a beat later, so the input waits for the message.
    feed.offer(
      SID,
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'Edit', input: {} },
      })
    );
    feed.offer(
      SID,
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } })
    );

    expect(feed.blocks(SID)).toHaveLength(1);
    expect(feed.blocks(SID)[0].tool).toMatchObject({ name: 'Edit', summary: '' });
    expect(JSON.stringify(feed.blocks(SID))).not.toContain('file_pa');

    // …and the message fills it in, in place
    feed.offer(
      SID,
      assistant([{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: 'C:/x.ts' } }])
    );
    expect(feed.blocks(SID)).toHaveLength(1);
    expect(emitted(1)).toMatchObject({ kind: 'tool', tool: { summary: 'C:/x.ts' } });
  });

  it('a TodoWrite row opened as a tool becomes the checklist, in place', () => {
    feed.offer(
      SID,
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'TodoWrite', input: {} },
      })
    );
    expect(kinds()).toEqual(['tool']);

    feed.offer(
      SID,
      assistant([
        { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } },
      ])
    );

    expect(feed.blocks(SID)).toHaveLength(1);
    expect(emitted(1)).toMatchObject({ kind: 'todos', todos: [{ content: 'x', status: 'pending' }] });
    // the tool shell is GONE, not merged underneath — a field-by-field update
    // would have left it there (the #153 defect shape)
    expect(emitted(1)!.tool).toBeUndefined();
  });
});

// #156 — the named case Dan added to this item. Over the stream a local slash
// command is an ORDINARY assistant turn; the transcript records it as
// `system:local_command` with no assistant entry, which is why the Session view
// showed nothing at all before the Feed read the stream.
describe('a local slash command renders (#156)', () => {
  it('`/usage` output reaches the Feed as ordinary assistant text', () => {
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '/usage' }] },
      parent_tool_use_id: null,
    });
    feed.offer(SID, textDelta('Current session: '));
    feed.offer(SID, textDelta('2% used'));
    feed.offer(SID, assistant([{ type: 'text', text: 'Current session: 2% used' }]));
    feed.offer(SID, { type: 'result', subtype: 'success' });

    expect(kinds()).toEqual(['user', 'assistant']);
    expect(texts()).toEqual(['/usage', 'Current session: 2% used']);
  });
});

describe('no block is left open for ever', () => {
  it('`result` closes a block the deltas left streaming', () => {
    feed.offer(SID, textDelta('half a sen'));
    expect(feed.hasOpenBlocks(SID)).toBe(true);
    feed.offer(SID, { type: 'result', subtype: 'success' });
    expect(feed.hasOpenBlocks(SID)).toBe(false);
    expect(feed.blocks(SID)[0].streaming).toBe(false);
    expect(feed.blocks(SID)[0].text).toBe('half a sen'); // the text SURVIVES
  });

  it('a session that exits without a result closes its blocks too', () => {
    feed.offer(SID, textDelta('crashed mid-'));
    feed.finalize(SID); // what SessionManager.onSessionExit calls
    expect(feed.hasOpenBlocks(SID)).toBe(false);
    expect(feed.blocks(SID)[0].streaming).toBe(false);
  });

  it('an assistant message that claims nothing still retires the open block', () => {
    feed.offer(SID, textDelta('orphan'));
    feed.offer(SID, assistant([{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'x' } }]));
    expect(feed.hasOpenBlocks(SID)).toBe(false);
    expect(kinds()).toEqual(['assistant', 'tool']);
  });

  it('`finalize` on a session that never streamed anything is a no-op', () => {
    expect(() => feed.finalize('never-seen')).not.toThrow();
    expect(feed.hasOpenBlocks('never-seen')).toBe(false);
  });
});

describe('the conversation being replaced', () => {
  it('a NEW session_id on init resets the view; the same one does not', () => {
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'before' }]));
    // S-11: init arrives once per TURN. Same id -> nothing happens, or every
    // turn would wipe the Feed.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    expect(feed.blocks(SID)).toHaveLength(1);
    expect(resets).toEqual([]);

    feed.offer(SID, { type: 'system', subtype: 'init', session_id: 'a-different-conversation' });
    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);
  });

  it('re-numbers from seq 1 after a reset, so the renderer cannot interleave', () => {
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'before' }]));
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: 'other' });
    feed.offer(SID, assistant([{ type: 'text', text: 'after' }]));
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1]);
  });
});

describe('what the Feed deliberately ignores', () => {
  it('sidechain traffic — rendering it is E18-13, behind the S-11 probes', () => {
    feed.offer(SID, { ...assistant([{ type: 'text', text: 'subagent says' }]), parent_tool_use_id: 'toolu_9' });
    feed.offer(SID, { ...textDelta('subagent thinks'), parent_tool_use_id: 'toolu_9' });
    expect(feed.blocks(SID)).toHaveLength(0);
  });

  it('lifecycle and plumbing messages', () => {
    for (const m of [
      { type: 'rate_limit_event', status: {} },
      { type: 'control_request', request: { subtype: 'can_use_tool' } },
      { type: 'keep_alive' },
      { type: 'system', subtype: 'status' },
    ]) {
      feed.offer(SID, m);
    }
    expect(feed.blocks(SID)).toHaveLength(0);
  });

  it('a listener that throws does not take the feed down (P6)', () => {
    feed.onBlock(() => {
      throw new Error('boom');
    });
    expect(() => feed.offer(SID, assistant([{ type: 'text', text: 'hi' }]))).not.toThrow();
    expect(feed.blocks(SID)).toHaveLength(1);
  });
});

describe('sessions are independent, and forgotten when they close', () => {
  it('two sessions do not share blocks or seq numbers', () => {
    feed.offer('a', assistant([{ type: 'text', text: 'for a' }]));
    feed.offer('b', assistant([{ type: 'text', text: 'for b' }]));
    expect(feed.blocks('a').map((x) => x.text)).toEqual(['for a']);
    expect(feed.blocks('b').map((x) => x.seq)).toEqual([1]);
  });

  it('forgetSession drops the backlog — the next session under the card starts clean', () => {
    feed.offer(SID, assistant([{ type: 'text', text: 'old' }]));
    feed.forgetSession(SID);
    expect(feed.blocks(SID)).toEqual([]);
  });
});
