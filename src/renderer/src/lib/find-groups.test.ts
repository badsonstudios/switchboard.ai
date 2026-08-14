// The arithmetic behind §5.31's grouped results (P2-E17-03).
import { describe, expect, it } from 'vitest';
import {
  buildFindGroups,
  failedResults,
  initialStep,
  noticesOf,
  positionIn,
  type FindGroupInput,
} from './find-groups';
import type { FindHit, FindResults } from '../extensibility/contributions';

function hit(id: string, snippet = 'x', over: Partial<FindHit> = {}): FindHit {
  return { id, snippet, matchStart: 0, matchLength: 1, jumpable: true, earlierThanLoaded: false, ...over };
}

function results(hits: FindHit[], over: Partial<FindResults> = {}): FindResults {
  return { hits, total: hits.length, truncated: false, ...over };
}

const session = (hits: FindHit[], over?: Partial<FindResults>): FindGroupInput => ({
  id: 'find-session',
  panelId: 'feed',
  labelKey: 'grid.viewSession',
  results: results(hits, over),
});

const terminal = (hits: FindHit[], over?: Partial<FindResults>): FindGroupInput => ({
  id: 'find-terminal',
  panelId: 'terminal',
  labelKey: 'find.group.terminal',
  results: results(hits, over),
});

describe('grouping the providers’ answers', () => {
  it('keeps each group’s count to itself — no running total over two depths', () => {
    const view = buildFindGroups([session([hit('a'), hit('b')]), terminal([hit('c')])]);
    expect(view.groups.map((g) => [g.panelId, g.total])).toEqual([
      ['feed', 2],
      ['terminal', 1],
    ]);
    // there is deliberately NO `total` on the view: the transcript sees the
    // session and xterm sees 5,000 ring-buffered lines, so "3" would be a
    // number that is true of neither
    expect(view.any).toBe(true);
    expect(view.steps).toHaveLength(3);
  });

  it('keeps a ZERO group, because a group that vanishes reads as "not searched"', () => {
    const view = buildFindGroups([session([hit('a')]), terminal([])]);
    expect(view.groups).toHaveLength(2);
    expect(view.groups[1].total).toBe(0);
  });

  it('namespaces hit ids by provider — two providers may hand back the same id', () => {
    const view = buildFindGroups([session([hit('12:tool.out:0')]), terminal([hit('12:tool.out:0')])]);
    const ids = view.steps.map((s) => s.hit.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['find-session::12:tool.out:0', 'find-terminal::12:tool.out:0']);
  });

  it('walks the groups in order, and each step knows which group it is in', () => {
    const view = buildFindGroups([session([hit('a'), hit('b')]), terminal([hit('c')])]);
    expect(view.steps.map((s) => s.groupIndex)).toEqual([0, 0, 1]);
  });

  it('is empty, not broken, when nothing matched anywhere', () => {
    const view = buildFindGroups([session([]), terminal([])]);
    expect(view.any).toBe(false);
    expect(view.steps).toHaveLength(0);
    expect(initialStep(view, 'feed')).toBe(-1);
    expect(positionIn(view, 0)).toBeNull();
  });
});

describe('where stepping starts', () => {
  it('in the panel the user is LOOKING at, not the one that sorts first', () => {
    const view = buildFindGroups([session([hit('a'), hit('b')]), terminal([hit('c')])]);
    expect(initialStep(view, 'terminal')).toBe(2);
    expect(initialStep(view, 'feed')).toBe(0);
  });

  it('falls back to the first hit anywhere when the focused panel has none', () => {
    const view = buildFindGroups([session([hit('a')]), terminal([])]);
    expect(initialStep(view, 'terminal')).toBe(0);
  });
});

describe('the position the bar shows', () => {
  it('is a position INSIDE one group', () => {
    const view = buildFindGroups([session([hit('a'), hit('b')]), terminal([hit('c'), hit('d')])]);
    expect(positionIn(view, 1)).toEqual({ groupIndex: 0, position: 2, total: 2, shown: 2 });
    // …and stepping into the next group restarts at 1 of ITS total, rather
    // than reading "3 of 4" across two surfaces that saw different depths
    expect(positionIn(view, 2)).toEqual({ groupIndex: 1, position: 1, total: 2, shown: 2 });
  });

  it('reports the group’s honest total even when its list was capped', () => {
    const view = buildFindGroups([terminal([hit('a'), hit('b')], { total: 900, truncated: true })]);
    expect(positionIn(view, 0)).toEqual({ groupIndex: 0, position: 1, total: 900, shown: 2 });
  });
});

describe('notices', () => {
  it('are collected per group, so two of them do not fight over one line', () => {
    const view = buildFindGroups([
      session([], { notice: { key: 'find.notice.noTranscript', tone: 'info' } }),
      terminal([hit('a')], { notice: { key: 'find.notice.truncated', tone: 'info' } }),
    ]);
    expect(noticesOf(view).map((n) => [n.groupIndex, n.notice.key])).toEqual([
      [0, 'find.notice.noTranscript'],
      [1, 'find.notice.truncated'],
    ]);
  });

  it('a provider that could not run costs its own group and nothing else', () => {
    const view = buildFindGroups([
      { ...session([]), results: failedResults('find.notice.failed') },
      terminal([hit('a')]),
    ]);
    expect(view.groups[0].notice?.tone).toBe('error');
    expect(view.groups[1].hits).toHaveLength(1);
    expect(view.any).toBe(true);
  });
});
