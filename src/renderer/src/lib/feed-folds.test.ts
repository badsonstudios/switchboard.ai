import { describe, it, expect } from 'vitest';
import type { FeedBlockDto } from './feed';
import { applyFolds, foldRuns, isExploration, FOLD_MIN } from './feed-folds';

let next = 1;
const tool = (name: string, category: string, over: Partial<FeedBlockDto> = {}): FeedBlockDto =>
  ({
    seq: next++,
    kind: 'tool',
    sidechain: false,
    tool: { name, category, summary: `${name.toLowerCase()}-target` },
    ...over,
  }) as unknown as FeedBlockDto;
const read = (over: Partial<FeedBlockDto> = {}) => tool('Read', 'read', over);
const grep = (over: Partial<FeedBlockDto> = {}) => tool('Grep', 'read', over);
const glob = (over: Partial<FeedBlockDto> = {}) => tool('Glob', 'read', over);
const edit = () => tool('Edit', 'edit');
const bash = () => tool('Bash', 'shell');
const agent = () => tool('Agent', 'other');
const prose = (kind: 'assistant' | 'user' | 'thinking' = 'assistant'): FeedBlockDto =>
  ({ seq: next++, kind, sidechain: false, text: 'words' });

const list = (...blocks: FeedBlockDto[]): FeedBlockDto[] => blocks;
const heads = (blocks: FeedBlockDto[]): number[][] => [...foldRuns(blocks).values()].map((r) => r.seqs);

describe('isExploration (#1130)', () => {
  it('is the read-only family and nothing else', () => {
    expect(isExploration(read())).toBe(true);
    expect(isExploration(grep())).toBe(true);
    expect(isExploration(glob())).toBe(true);
    expect(isExploration(tool('LS', 'read'))).toBe(true);
    // mutating or output-bearing tools are events
    expect(isExploration(edit())).toBe(false);
    expect(isExploration(bash())).toBe(false);
    expect(isExploration(agent())).toBe(false);
    expect(isExploration(tool('WebSearch', 'other'))).toBe(false);
    expect(isExploration(prose())).toBe(false);
    // a tool block with no category (an old fixture) is not guessed at
    expect(isExploration({ seq: 1, kind: 'tool', sidechain: false, tool: { name: 'Read' } } as never)).toBe(false);
  });
});

describe('foldRuns (#1130)', () => {
  // the owner's screenshot, in miniature
  it('folds a burst of looking around into one run, and counts it', () => {
    const blocks = list(grep(), grep(), glob(), grep(), read(), grep(), read(), read());
    const runs = [...foldRuns(blocks).values()];
    expect(runs).toHaveLength(1);
    expect(runs[0].head).toBe(blocks[0].seq);
    expect(runs[0].seqs).toEqual(blocks.map((b) => b.seq));
    expect(runs[0].reads).toBe(3);
    expect(runs[0].searches).toBe(5);
    expect(runs[0].latest).toBe('Read read-target');
  });

  it(`leaves fewer than ${FOLD_MIN} alone`, () => {
    expect(heads(list(read()))).toEqual([]);
    expect(heads(list(read(), grep()))).toEqual([]);
    expect(heads(list(read(), grep(), read()))).toHaveLength(1);
  });

  // the boundary rule: prose in the middle is two folds around it, not one
  it('a sentence in the middle makes two folds, and is in neither', () => {
    const a = list(grep(), grep(), read());
    const said = prose();
    const b = list(read(), read(), glob(), grep());
    expect(heads([...a, said, ...b])).toEqual([a.map((x) => x.seq), b.map((x) => x.seq)]);
  });

  it('never folds across or into an event', () => {
    for (const event of [edit, bash, agent, () => prose('user')]) {
      const a = list(grep(), grep(), read());
      const e = event();
      const b = list(read(), read());
      const runs = heads([...a, e, ...b]);
      expect(runs).toEqual([a.map((x) => x.seq)]); // b is only two
      expect(runs.flat()).not.toContain(e.seq);
    }
  });

  // a fold must not put one speaker's work under another's caption
  it('ends where the speaker changes', () => {
    const mine = list(grep(), read(), read());
    const sub = (id: string) => ({ sidechain: true, agentId: id });
    const theirs = list(grep(sub('a1')), read(sub('a1')), read(sub('a1')));
    const others = list(grep(sub('b2')), read(sub('b2')), read(sub('b2')));
    expect(heads([...mine, ...theirs, ...others])).toEqual([
      mine.map((x) => x.seq),
      theirs.map((x) => x.seq),
      others.map((x) => x.seq),
    ]);
    // two of each is three runs of two: nothing folds
    expect(heads(list(grep(), read(), grep(sub('a1')), read(sub('a1'))))).toEqual([]);
  });

  // runs are found in what is RENDERED: on `normal` the thinking block between
  // two calls is not in the list at all, so the caller simply never passes it
  it('is about the list it is given', () => {
    const a = grep();
    const hidden = prose('thinking');
    const b = read();
    const c = read();
    expect(heads([a, hidden, b, c])).toEqual([]); // firehose: thinking is on screen
    expect(heads([a, b, c])).toEqual([[a.seq, b.seq, c.seq]]); // normal: it is not
  });
});

describe('applyFolds (#1130)', () => {
  const burst = (): FeedBlockDto[] => list(grep(), read(), glob(), read());

  it('a closed fold keeps only its head in the list', () => {
    const before = prose();
    const run = burst();
    const after = edit();
    const out = applyFolds([before, ...run, after], () => false);
    expect(out.rendered.map((b) => b.seq)).toEqual([before.seq, run[0].seq, after.seq]);
    expect(out.folds.get(run[0].seq)).toMatchObject({ open: false, seqs: run.map((b) => b.seq) });
  });

  it('an open fold keeps every member, in order', () => {
    const run = burst();
    const all = [prose(), ...run, edit()];
    const out = applyFolds(all, () => true);
    expect(out.rendered).toBe(all); // the same array: nothing was filtered
    expect(out.folds.get(run[0].seq)?.open).toBe(true);
  });

  it('opens and closes each run on its own', () => {
    const a = burst();
    const mid = prose();
    const b = burst();
    const out = applyFolds([...a, mid, ...b], (run) => run.head === b[0].seq);
    expect(out.rendered.map((x) => x.seq)).toEqual([a[0].seq, mid.seq, ...b.map((x) => x.seq)]);
  });

  it('hands back the list untouched when nothing folds', () => {
    const all = [prose(), read(), edit(), grep()];
    const out = applyFolds(all, () => false);
    expect(out.rendered).toBe(all);
    expect(out.folds.size).toBe(0);
  });
});
