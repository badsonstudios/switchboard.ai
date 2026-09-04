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

  // #458. Session find lines the transcript up with the Feed on `srcId`, and a
  // Direct session's tool row exists for as long as the tool RUNS before the
  // `assistant` message that fills it in arrives — which for a Bash call is the
  // whole of it. A row that only became addressable at the end would leave find
  // refusing to jump for exactly the stretch a user is most likely to search.
  it('a tool row is addressable from the moment it opens, not once it finishes', () => {
    feed.offer(
      SID,
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      })
    );
    expect(feed.blocks(SID)[0]).toMatchObject({ srcId: 'tool:toolu_1', streaming: true });

    // …and the message that supersedes it derives the identical value, so the
    // block does not change identity underneath a search in flight.
    feed.offer(SID, assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]));
    expect(feed.blocks(SID)).toHaveLength(1);
    expect(emitted(1)).toMatchObject({ srcId: 'tool:toolu_1', streaming: false });
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

  // #491: the echo is the ONLY record of what was attached by the time the Feed
  // sees the turn — the composer's chips are already gone. An attachment-only
  // turn is the case that produced no block at all before.
  it('a replayed prompt carries the attachments it was sent with', () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    feed.offer(SID, {
      type: 'user',
      message: { role: 'user', content: [png, png, { type: 'text', text: 'what is this?' }] },
      isReplay: true,
      parent_tool_use_id: null,
    });
    expect(feed.blocks(SID)[0]).toMatchObject({
      kind: 'user',
      text: 'what is this?',
      attachments: { images: 2, documents: 0 },
    });

    feed.offer(SID, {
      type: 'user',
      message: { role: 'user', content: [png] },
      isReplay: true,
      parent_tool_use_id: null,
    });
    expect(feed.blocks(SID)).toHaveLength(2);
    expect(feed.blocks(SID)[1]).toMatchObject({
      kind: 'user',
      attachments: { images: 1, documents: 0 },
    });
    expect(feed.blocks(SID)[1].text).toBeUndefined();
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

// ── `conversation_reset`: the FIRST /clear wipes (#748) ─────────────────────
//
// The bug: the wipe used to be inferred from a `system:init` whose id differs
// from the last one seen, and **nothing announces an id until the first TURN**
// (measured, probe 2 — zero inits before any prompt). So on a session that has
// not replied yet, `/clear` landed on `conversationId === undefined`, which set
// the id and returned, wiping nothing. The second `/clear` finally had
// something to differ from. That is the whole of the owner's report.
//
// The shapes below are the real ones, from the probes on the issue — including
// the two-message sequence and its measured ORDER (reset first, init 12-20ms
// later), because the interaction between them is where the double-wipe would
// hide.
const RESET = (
  gone: string,
  next = 'a78738c8-2e7e-46e8-a4af-4049f97c8af6'
): Record<string, unknown> => ({
  type: 'conversation_reset',
  session_id: gone,
  // Carried by the real message, and DELIBERATELY IGNORED — see the test that
  // names it. Present in the fixture so a change that starts reading it fails
  // here rather than in front of the owner.
  new_conversation_id: next,
  uuid: 'c8145caf-4819-49c2-947c-2f7dce4da437',
});
const NEW_CONV = 'b21fb84e-f286-4363-8dc5-b5f72c741128';

describe('`/clear` wipes the FIRST time (#748)', () => {
  it('wipes a session that has never seen an init — THE BUG', () => {
    // No init has arrived, so `conversationId` is undefined. This is the card
    // you just opened and cleared, and it is where the old code did nothing at
    // all. The reset's `session_id` names a conversation this feed has never
    // heard of, which is exactly the state that must not be a precondition.
    feed.offer(SID, assistant([{ type: 'text', text: 'left over' }]));
    expect(feed.blocks(SID)).toHaveLength(1);

    feed.offer(SID, RESET('4d6adc68-394d-40ab-8250-ed44a4520a29'));

    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);
  });

  it('wipes a RESUMED card, which failed every single time', () => {
    // `hydrate()` deliberately never sets `conversationId` — seeding it would
    // make a forked `--resume` id look like a clear and wipe the history it
    // just replayed. Sound, and it left a card full of replayed history
    // guaranteed to swallow its first `/clear`.
    feed.hydrate(SID, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] } },
    ]);
    expect(feed.blocks(SID)).toHaveLength(1);

    feed.offer(SID, RESET('some-resumed-conversation'));

    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);
  });

  it('the measured sequence wipes exactly ONCE, reset then init', () => {
    // The real thing, in the real order: reset carrying the OLD id, then an
    // init 20ms later carrying a NEW one. Two triggers, two ids, one divider —
    // the ticket's idempotency requirement, which stopped being precautionary
    // the moment both signals started arriving.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'before' }]));

    feed.offer(SID, RESET(CONV));
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: NEW_CONV });

    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);

    // …and the session carries on in the new conversation, from seq 1
    feed.offer(SID, assistant([{ type: 'text', text: 'after' }]));
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1]);
    // a later turn's init for the SAME new conversation still wipes nothing
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: NEW_CONV });
    expect(feed.blocks(SID)).toHaveLength(1);
    expect(resets).toEqual(['clear']);
  });

  it('ignores `new_conversation_id`, which is not the id that follows', () => {
    // MEASURED: the reset carries `new_conversation_id`, and it matches NEITHER
    // the old conversation NOR the one the next init announces — three distinct
    // ids in one exchange. Adopting it (the obvious way to stop a double wipe)
    // would have guaranteed one, because the init would then differ from it.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'before' }]));

    feed.offer(SID, RESET(CONV, 'a78738c8-2e7e-46e8-a4af-4049f97c8af6'));
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: NEW_CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'after' }]));

    // one wipe, and the block that arrived AFTER it survived
    expect(resets).toEqual(['clear']);
    expect(texts()).toEqual(['after']);
  });

  it('ignores a reset naming a conversation the INIT path already discarded', () => {
    // The backstop fired first (an ordering we have never measured, so it is
    // guarded rather than assumed). The reset that follows names the
    // conversation the init already threw away, and must not wipe the fresh one
    // the user is now in.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: NEW_CONV });
    expect(resets).toEqual(['clear']);
    feed.offer(SID, assistant([{ type: 'text', text: 'in the new one' }]));

    feed.offer(SID, RESET(CONV)); // the OLD conversation, already gone

    expect(texts()).toEqual(['in the new one']);
    expect(resets).toEqual(['clear']);
  });

  it('ignores the SAME reset delivered twice, even with no init between', () => {
    // The case the first version of this guard got wrong. It suppressed on
    // "we hold a different id", which on a turn-less session is `undefined` —
    // so a duplicate sailed through and wiped twice, in exactly the sessions
    // this item exists for.
    feed.offer(SID, assistant([{ type: 'text', text: 'a' }]));
    feed.offer(SID, RESET('conv-1'));
    feed.offer(SID, RESET('conv-1'));
    expect(resets).toEqual(['clear']);
  });

  it('an init arriving FIRST does not swallow the reset behind it', () => {
    // The other direction the first guard got wrong, and the worse one: with
    // "we hold a different id", `init(B)` on a turn-less session set B, and the
    // reset naming A was then dropped as stale — ZERO wipes, which is #748
    // restored in the one ordering the guard was written to cover.
    feed.offer(SID, assistant([{ type: 'text', text: 'stale' }]));
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: NEW_CONV });
    feed.offer(SID, RESET(CONV));
    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);
  });

  it('two REAL clears in a row both wipe', () => {
    // The owner's own workaround, and the thing the duplicate guard must not
    // break: different conversations discarded, so both are real.
    feed.offer(SID, assistant([{ type: 'text', text: 'a' }]));
    feed.offer(SID, RESET('conv-1'));
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: 'conv-2' });
    feed.offer(SID, assistant([{ type: 'text', text: 'b' }]));
    feed.offer(SID, RESET('conv-2'));
    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear', 'clear']);
  });

  it('wipes mid-reply, and the message that lands after it starts a fresh block', () => {
    // "Clear Session while Claude is typing" is an ordinary gesture. The
    // half-built block has to go with everything else, and the `assistant`
    // message that was already in flight must not reconcile against a block
    // that no longer exists — it belongs to the conversation just discarded.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('half a th'));
    expect(feed.blocks(SID)).toHaveLength(1);

    feed.offer(SID, RESET(CONV));
    expect(feed.blocks(SID)).toHaveLength(0);

    // the in-flight message lands AFTER the wipe
    feed.offer(SID, assistant([{ type: 'text', text: 'half a thought' }]));
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1]);
    expect(texts()).toEqual(['half a thought']);
    expect(resets).toEqual(['clear']);
  });

  it('`/compact` resets NOTHING — measured: same id, and no reset message', () => {
    // The risk this fix had to clear before it could be written. Compaction
    // also replaces a conversation's contents, so a wipe keyed on the wrong
    // signal would fire on every compact. Measured (probe 3): status, then an
    // init carrying the SAME session_id, then compact_boundary — and zero
    // `conversation_reset`.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'survives compaction' }]));

    feed.offer(SID, { type: 'system', subtype: 'status', session_id: CONV });
    feed.offer(SID, { type: 'system', subtype: 'status', session_id: CONV, compact_result: {} });
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, { type: 'system', subtype: 'compact_boundary', session_id: CONV });

    expect(texts()).toEqual(['survives compaction']);
    expect(resets).toEqual([]);
  });

  it('a reset with no session_id at all still wipes', () => {
    // The field is not ours to depend on. It only ever NARROWS the wipe (the
    // already-left guard above); a message without it is still the CLI saying
    // the conversation is gone, and failing closed here would resurrect the
    // silent no-op this item exists to remove.
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, assistant([{ type: 'text', text: 'before' }]));

    feed.offer(SID, { type: 'conversation_reset' });

    expect(feed.blocks(SID)).toHaveLength(0);
    expect(resets).toEqual(['clear']);
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

// #395 — a RESUMED Direct session replays what is already on disk.
//
// The transcript entries below are the shapes the CLI really writes (and the
// stream fake mirrors): file metadata wrapped around an Anthropic `message`.
// Every claim here is about the SEAM — the join between "already happened" and
// "arriving now" — because that is the only place this can go wrong: a
// duplicate block, a missing one, or a seq the renderer's upsert collides on.
describe('replaying a resumed conversation (#395)', () => {
  const line = (type: 'user' | 'assistant', content: unknown): Record<string, unknown> => ({
    type,
    sessionId: CONV,
    cwd: '/repo',
    timestamp: '2026-08-10T10:00:00.000Z',
    isSidechain: false,
    isMeta: false,
    message: { role: type, content },
  });
  const history = [
    line('user', [{ type: 'text', text: 'what did we decide?' }]),
    line('assistant', [{ type: 'text', text: 'we decided to ship it' }]),
  ];

  it('puts the prior conversation in the Feed before anything streams', () => {
    expect(feed.hydrate(SID, history)).toBe(2);
    expect(feed.blocks(SID).map((b) => [b.kind, b.text])).toEqual([
      ['user', 'what did we decide?'],
      ['assistant', 'we decided to ship it'],
    ]);
    // replayed blocks are never "still taking tokens"
    expect(feed.blocks(SID).some((b) => b.streaming)).toBe(false);
    expect(feed.hasOpenBlocks(SID)).toBe(false);
  });

  it('the live tail appends above it — no duplicate at the join, and no gap', () => {
    feed.hydrate(SID, history);
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      session_id: CONV,
      parent_tool_use_id: null,
    });
    feed.offer(SID, ev({ type: 'message_start', message: { role: 'assistant', content: [] } }));
    feed.offer(SID, ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    feed.offer(SID, textDelta('now we '));
    feed.offer(SID, textDelta('resume'));
    feed.offer(SID, assistant([{ type: 'text', text: 'now we resume' }]));
    feed.offer(SID, { type: 'result', subtype: 'success' });

    expect(feed.blocks(SID).map((b) => [b.seq, b.kind, b.text])).toEqual([
      [1, 'user', 'what did we decide?'],
      [2, 'assistant', 'we decided to ship it'],
      [3, 'user', 'and now?'],
      [4, 'assistant', 'now we resume'],
    ]);
    // The renderer is PUSHED only the live half — the replayed half is served
    // to it as backlog when its panel mounts (see `hydrate`) — and the pushes
    // never reuse a seq the replay already spent, which is what would make the
    // upsert overwrite history with the live tail.
    const bySeq = new Map(seen.map((b) => [b.seq, b]));
    expect([...bySeq.keys()].sort()).toEqual([3, 4]);
    expect(bySeq.get(4)?.streaming).toBe(false);
  });

  it('replaying pushes nothing at the renderer — there is nobody there yet', () => {
    feed.hydrate(SID, [
      line('assistant', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      line('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }]),
      ...history,
    ]);

    expect(seen).toEqual([]); // not a block, and not a tool-result update either
    expect(feed.blocks(SID)).toHaveLength(3);
    // ...and the buffer is un-muted afterwards: the very next live block goes out
    feed.offer(SID, assistant([{ type: 'text', text: 'live' }]));
    expect(seen.map((b) => b.text)).toEqual(['live']);
  });

  it('a thinking block left open by the old conversation is not timed against the new one', () => {
    // the resumed conversation ended mid-thought, yesterday
    feed.hydrate(SID, [
      {
        ...line('assistant', [{ type: 'thinking', thinking: 'where was I' }]),
        timestamp: new Date(Date.now() - 24 * 3600_000).toISOString(),
      },
    ]);
    feed.offer(SID, assistant([{ type: 'text', text: '今日' }]));

    // "Thought for 86400s" is a claim, and it would be a false one: the gap is
    // the seam, not the thinking. No duration beats a wrong duration.
    expect(feed.blocks(SID)[0].durationMs).toBeUndefined();
  });

  it('an isSidechain line replays as a sidechain, not as the main conversation', () => {
    feed.hydrate(SID, [{ ...line('assistant', [{ type: 'text', text: 'subagent' }]), isSidechain: true }, ...history]);
    expect(feed.blocks(SID).map((b) => b.sidechain)).toEqual([true, false, false]);
  });

  it('a tool result that was already on disk still attaches to its call', () => {
    feed.hydrate(SID, [
      line('assistant', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      line('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }]),
    ]);
    expect(feed.blocks(SID)[0].tool?.out).toBe('a.txt');
  });

  it('the first system:init does NOT wipe it, even when --resume forked a new id', () => {
    feed.hydrate(SID, history);
    // hydration must not have claimed a conversation id: the CLI's first init
    // is the only thing that may, and it is allowed to name a DIFFERENT
    // conversation than the one we asked to resume
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: 'a-forked-conversation' });
    expect(feed.blocks(SID)).toHaveLength(2);
    expect(resets).toEqual([]);
  });

  it('the init BACKSTOP still resets a resumed session — replayed history included', () => {
    // Note what this needs: TWO inits, i.e. the resumed card must have run a
    // turn before an id change can be detected. That is the backstop's shape
    // and it is why it could never be the primary trigger — a `/clear` before
    // that first turn had nothing to differ from and silently did nothing
    // (#748). The `conversation_reset` suite above owns that case; this one
    // pins that the older path still works underneath it.
    feed.hydrate(SID, history);
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: CONV });
    feed.offer(SID, { type: 'system', subtype: 'init', session_id: 'after-the-clear' });
    expect(feed.blocks(SID)).toEqual([]);
    expect(resets).toEqual(['clear']);
    // and the fresh conversation numbers from 1 again
    feed.offer(SID, assistant([{ type: 'text', text: 'clean slate' }]));
    expect(feed.blocks(SID).map((b) => b.seq)).toEqual([1]);
  });

  it('nothing to replay is an empty Feed, not an error (fail-open)', () => {
    expect(feed.hydrate(SID, [])).toBe(0);
    expect(feed.blocks(SID)).toEqual([]);
  });

  it('refuses to replay twice — the past must not be appended onto the present', () => {
    feed.hydrate(SID, history);
    feed.offer(SID, assistant([{ type: 'text', text: 'live' }]));
    expect(feed.hydrate(SID, history)).toBe(0);
    expect(feed.blocks(SID)).toHaveLength(3);
  });

  it('ignores CLI-internal lines the transcript source ignores too', () => {
    feed.hydrate(SID, [
      { ...line('user', [{ type: 'text', text: 'meta' }]), isMeta: true },
      line('user', '<local-command-stdout>plumbing</local-command-stdout>'),
      line('user', [{ type: 'text', text: 'real' }]),
    ]);
    expect(feed.blocks(SID).map((b) => b.text)).toEqual(['real']);
  });
});
