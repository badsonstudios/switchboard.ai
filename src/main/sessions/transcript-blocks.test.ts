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

// #704. THE SAME MISATTRIBUTION THE `[subagent]` TAG ABOVE EXISTS TO PREVENT,
// and it was worse: a background-task notification reached the reading model as
// `User: ` followed by raw XML, so a sibling agent handed this window would have
// read "If this event is something the user would act on now, send a
// PushNotification" as an instruction the HUMAN had typed to it.
describe('renderBlock labels a harness-injected turn (#704)', () => {
  const notice = {
    source: 'task-notification' as const,
    summary: 'Monitor event: "CI on PR 53"',
    status: 'event',
    raw: '<task-notification>\n<summary>Monitor event: "CI on PR 53"</summary>\n</task-notification>',
  };

  it('says what it is, and says the status', () => {
    expect(renderBlock({ seq: 0, kind: 'notice', notice, sidechain: false })).toBe(
      '[background task] (event) Monitor event: "CI on PR 53"'
    );
  });

  // The SUMMARY, not the payload: what is left of the payload is a task id and a
  // temp-file path on a machine the recipient cannot read.
  it('hands over the summary rather than the raw payload', () => {
    const line = renderBlock({ seq: 0, kind: 'notice', notice, sidechain: false });
    expect(line).not.toContain('<task-notification>');
    // and it is not labelled as a person speaking
    expect(line).not.toContain('User:');
  });

  it('drops the parenthesis when there was no status', () => {
    // Built rather than destructured-minus-`status`: the field is ABSENT here,
    // and `{ ...notice, status: undefined }` is a different object — it has the
    // own key, which is the distinction `originOf` in `blocks.ts` spells out.
    const rest = { source: notice.source, summary: notice.summary, raw: notice.raw };
    expect(renderBlock({ seq: 0, kind: 'notice', notice: rest, sidechain: false })).toBe(
      '[background task] Monitor event: "CI on PR 53"'
    );
  });

  it('still wears the subagent tag when one ran inside a subagent', () => {
    expect(
      renderBlock({ seq: 0, kind: 'notice', notice, sidechain: true, agentName: 'Explore' })
    ).toBe('[subagent: Explore] [background task] (event) Monitor event: "CI on PR 53"');
  });
});
