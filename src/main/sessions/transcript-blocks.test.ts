// `blocksFrom` / `renderBlock` had no test file of their own — they were
// exercised only through `queries.test.ts` and `context-package.test.ts`, which
// assert on the TEXT those two produce. That is the right level for almost
// everything here, and it has one blind spot #788's second mutation round found:
// a block's `agentId` never appears in the rendered text, so a mutant that
// stamped identity on a MAIN-conversation block survived a suite that could only
// look at the string. This file asserts the block SHAPE.
import { describe, expect, it } from 'vitest';
import { blocksFrom, renderBlock } from './transcript-blocks';
import { DISPLAY_CAPS } from '../feed/blocks';

const caps = DISPLAY_CAPS;

/** One assistant line, built as JSON text the way the transport delivers it. */
function line(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      ...o,
    })
  ) as Record<string, unknown>;
}

describe('blocksFrom stamps agent identity (#788)', () => {
  it('carries agentId and agentName off a sidechain line', () => {
    const [b] = blocksFrom([line({ isSidechain: true, agentId: 'a1', attributionAgent: 'Explore' })], caps);
    expect(b).toMatchObject({ sidechain: true, agentId: 'a1', agentName: 'Explore' });
  });

  it('stamps NOTHING on a main-conversation line that claims an agent', () => {
    // ⚠️ THE MUTANT THIS FILE EXISTS FOR. `renderBlock` gates its tag on
    // `block.sidechain`, so removing the gate inside `blocksFrom` changes no
    // rendered text at all — every text-level assertion stays green while the
    // block quietly carries another agent's identity. Anything that later reads
    // `agentId` off these blocks (the Feed's own grouping does) would attribute
    // the session's own voice to a subagent.
    const [b] = blocksFrom([line({ agentId: 'a1', attributionAgent: 'Explore' })], caps);
    expect(b.sidechain).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(b, 'agentId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(b, 'agentName')).toBe(false);
  });

  it('leaves both keys ABSENT on an ordinary sidechain line with no identity', () => {
    // A pre-2.1.226 transcript. The block shape must be the one every test
    // written before #788 pinned.
    const [b] = blocksFrom([line({ isSidechain: true })], caps);
    expect(b).toEqual({ kind: 'assistant', text: 'hi', seq: 0, sidechain: true });
  });

  it('gives two agents distinct identities in one fold', () => {
    const blocks = blocksFrom(
      [
        line({ isSidechain: true, agentId: 'a1', attributionAgent: 'Explore' }),
        line({ isSidechain: true, agentId: 'b2', attributionAgent: 'Plan' }),
      ],
      caps
    );
    expect(blocks.map((b) => [b.agentId, b.agentName])).toEqual([
      ['a1', 'Explore'],
      ['b2', 'Plan'],
    ]);
  });
});

describe('renderBlock names the agent', () => {
  it('names a subagent turn when the block knows the name', () => {
    expect(
      renderBlock({ seq: 0, kind: 'assistant', text: 'done', sidechain: true, agentId: 'a1', agentName: 'Explore' })
    ).toBe('[subagent: Explore] Claude: done');
  });

  it('falls back to the bare tag without a name', () => {
    expect(renderBlock({ seq: 0, kind: 'assistant', text: 'done', sidechain: true })).toBe(
      '[subagent] Claude: done'
    );
  });

  it('tags nothing on the main conversation', () => {
    expect(renderBlock({ seq: 0, kind: 'assistant', text: 'done', sidechain: false })).toBe(
      'Claude: done'
    );
  });
});
