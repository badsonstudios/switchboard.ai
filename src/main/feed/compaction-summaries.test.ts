// #1374 — the CLI's compaction summary, kept beside the divider in main and
// handed to the page only by handle, on request.
import { describe, it, expect } from 'vitest';
import { CompactionSummaryStore, compactionSummaryAnswer } from './compaction-summaries';
import { FeedBuffer } from './buffer';
import { FeedPictureStore } from './pictures';
import type { DerivedBlock, FeedBlock } from './blocks';
import { compactionSummaryText } from '../providers/claude-transcript';

const store = (budget = 1000): CompactionSummaryStore => {
  let n = 0;
  return new CompactionSummaryStore(budget, () => `s-${++n}`);
};

const buffer = (summaries: CompactionSummaryStore, cap?: number): { buf: FeedBuffer; emitted: FeedBlock[] } => {
  const emitted: FeedBlock[] = [];
  return { buf: new FeedBuffer((b) => emitted.push(b), cap, new FeedPictureStore(), summaries), emitted };
};

const divider: DerivedBlock = { kind: 'compaction', compaction: { trigger: 'manual', preTokens: 100, postTokens: 10 } };
const prose = (text: string): DerivedBlock => ({ kind: 'assistant', text });
const MAIN = { sidechain: false };

describe('CompactionSummaryStore', () => {
  it('answers a handle for the text and gives the text back by it', () => {
    const s = store();
    const id = s.keep({}, 'the summary')!;
    expect(s.get(id)).toBe('the summary');
    expect(compactionSummaryAnswer(s, id)).toEqual({ ok: true, text: 'the summary' });
  });

  it('refuses anything that is not a handle it holds', () => {
    const s = store();
    for (const id of [undefined, null, 7, '', 'never-minted', { id: 's-1' }]) {
      expect(compactionSummaryAnswer(s, id)).toEqual({ ok: false });
    }
  });

  it('lets the OLDEST go past the budget, and keeps none too big to hold', () => {
    const s = store(10);
    const a = s.keep({}, 'aaaaaa')!;
    const b = s.keep({}, 'bbbbbb')!;
    expect(s.get(a)).toBeUndefined();
    expect(s.get(b)).toBe('bbbbbb');
    // too big to hold at all: NO handle, so no button offers it
    expect(s.keep({}, 'x'.repeat(11))).toBeUndefined();
    expect(s.heldChars).toBe(6);
  });

  it('drops by handle and by owner', () => {
    const s = store();
    const me = {};
    const other = {};
    const a = s.keep(me, 'a')!;
    const b = s.keep(me, 'b')!;
    const c = s.keep(other, 'c')!;
    s.drop(a);
    expect(s.get(a)).toBeUndefined();
    s.dropOwner(me);
    expect(s.get(b)).toBeUndefined();
    expect(s.get(c)).toBe('c');
    expect(s.size).toBe(1);
  });
});

describe('FeedBuffer.attachCompactionSummary — keyed by position', () => {
  it('lands on the divider pushed just before, and re-emits it with a handle (never the text)', () => {
    const s = store();
    const { buf, emitted } = buffer(s);
    const block = buf.push(divider, MAIN);
    expect(buf.attachCompactionSummary('what it remembers')).toBe(true);
    expect(block.compaction).toEqual({ trigger: 'manual', preTokens: 100, postTokens: 10, summaryId: 's-1' });
    expect(s.get('s-1')).toBe('what it remembers');
    expect(emitted).toHaveLength(2);
    expect(emitted[1].seq).toBe(block.seq);
    expect(JSON.stringify(emitted)).not.toContain('what it remembers');
  });

  it('a block in between breaks the pairing: the summary attaches to nothing', () => {
    const s = store();
    const { buf } = buffer(s);
    const block = buf.push(divider, MAIN);
    buf.push(prose('something else'), MAIN);
    expect(buf.attachCompactionSummary('late')).toBe(false);
    expect(block.compaction?.summaryId).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it('only once per divider, and never with no divider at all', () => {
    const s = store();
    const { buf } = buffer(s);
    expect(buf.attachCompactionSummary('orphan')).toBe(false);
    const block = buf.push(divider, MAIN);
    expect(buf.attachCompactionSummary('first')).toBe(true);
    expect(buf.attachCompactionSummary('second')).toBe(false);
    expect(s.get(block.compaction!.summaryId!)).toBe('first');
  });

  it('only from the SAME place: a subagent summary never lands on the session divider, or another agent\'s', () => {
    const s = store();
    const { buf } = buffer(s);
    const main = buf.push(divider, MAIN);
    expect(buf.attachCompactionSummary('a subagent summary', { sidechain: true, agentId: 'a1' })).toBe(false);
    expect(main.compaction?.summaryId).toBeUndefined();
    // ...and it did not use up the divider's wait: its own summary still lands
    expect(buf.attachCompactionSummary('the session summary')).toBe(true);
    const sub = buf.push(divider, { sidechain: true, agentId: 'a1' });
    expect(buf.attachCompactionSummary('another agent', { sidechain: true, agentId: 'a2' })).toBe(false);
    expect(sub.compaction?.summaryId).toBeUndefined();
    buf.push(divider, { sidechain: true, agentId: 'a1' });
    expect(buf.attachCompactionSummary('its own', { sidechain: true, agentId: 'a1' })).toBe(true);
  });

  it('a summary too large to keep puts no button on the divider', () => {
    const s = store(5);
    const { buf } = buffer(s);
    const block = buf.push(divider, MAIN);
    expect(buf.attachCompactionSummary('much too long')).toBe(false);
    expect(block.compaction?.summaryId).toBeUndefined();
  });

  it('an empty summary attaches nothing (no button over nothing)', () => {
    const { buf } = buffer(store());
    const block = buf.push(divider, MAIN);
    expect(buf.attachCompactionSummary('')).toBe(false);
    expect(block.compaction?.summaryId).toBeUndefined();
  });

  it('a reset and a dispose let the summaries go with the blocks', () => {
    const s = store();
    const { buf } = buffer(s);
    buf.push(divider, MAIN);
    buf.attachCompactionSummary('one');
    buf.reset();
    expect(s.size).toBe(0);
    buf.push(divider, MAIN);
    buf.attachCompactionSummary('two');
    buf.dispose();
    expect(s.size).toBe(0);
  });

  it('a divider trimmed past the block cap takes its summary with it', () => {
    const s = store();
    const { buf } = buffer(s, 2);
    buf.push(divider, MAIN);
    buf.attachCompactionSummary('old');
    buf.push(prose('a'), MAIN);
    buf.push(prose('b'), MAIN);
    expect(s.size).toBe(0);
  });
});

describe('compactionSummaryText — both spellings, never a derivation', () => {
  const SUMMARY = 'This session is being continued from a previous conversation…';
  it('reads the transcript spelling and the stream spelling', () => {
    expect(
      compactionSummaryText({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: SUMMARY } })
    ).toBe(SUMMARY);
    expect(compactionSummaryText({ type: 'user', is_compact_summary: true, message: { content: SUMMARY } })).toBe(SUMMARY);
    expect(compactionSummaryText({ type: 'user', isSynthetic: true, isReplay: false, message: { content: SUMMARY } })).toBe(SUMMARY);
  });

  it('joins the text items of an array, and ignores the rest', () => {
    const content = [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }];
    expect(compactionSummaryText({ type: 'user', isCompactSummary: true, message: { content } })).toBe(
      ['one', 'two'].join(String.fromCharCode(10, 10))
    );
  });

  it('is null for everything else', () => {
    expect(compactionSummaryText({ type: 'user', message: { content: 'a typed prompt' } })).toBeNull();
    expect(compactionSummaryText({ type: 'user', isCompactSummary: 'true', message: { content: SUMMARY } })).toBeNull();
    expect(compactionSummaryText({ type: 'assistant', isSynthetic: true, message: { content: SUMMARY } })).toBeNull();
    expect(compactionSummaryText({ type: 'user', isSynthetic: true, isMeta: true, message: { content: SUMMARY } })).toBeNull();
    expect(compactionSummaryText({ type: 'user', isCompactSummary: true, message: { content: '   ' } })).toBeNull();
    expect(compactionSummaryText({ type: 'user', isCompactSummary: true })).toBeNull();
  });
});
