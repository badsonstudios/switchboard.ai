import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRESENTATION,
  fromPersisted,
  loadPresentation,
  persistablePresentation,
  persistedChanged,
  prunePresentation,
  samePresentation,
  type CardPresentation,
} from './presentation';

const withView = (view: string): CardPresentation => ({ ...DEFAULT_PRESENTATION, view });

describe('presentation — reading a ui blob (P2-E15-08)', () => {
  it('reads view, ladder and slot back out', () => {
    const { map } = loadPresentation({
      presentation: {
        'card-A': {
          view: 'terminal',
          ladder: 'hidden',
          slot: { groupId: 'g1', index: 3, location: 'grid' },
        },
      },
    });
    expect(map.get('card-A')).toEqual({
      view: 'terminal',
      ladder: 'hidden',
      slot: { groupId: 'g1', index: 3, location: 'grid' },
      poppedOut: false,
      suspended: false,
    });
  });

  it('a blob written by other code never costs the user their workspace', () => {
    // a ui blob outlives the code that wrote it: a removed ladder rung, a
    // half-written slot or an outright wrong type all fall back, never throw
    expect(fromPersisted({ ladder: 'minimised' }).ladder).toBe('expanded');
    expect(fromPersisted({ view: 42 }).view).toBe(DEFAULT_PRESENTATION.view);
    expect(fromPersisted({ slot: { index: 2 } }).slot).toBeNull(); // no groupId
    expect(fromPersisted({ slot: { groupId: 'g1' } })?.slot?.index).toBe(-1);
    expect(fromPersisted('nonsense')).toBe(DEFAULT_PRESENTATION);
    expect(fromPersisted(null)).toBe(DEFAULT_PRESENTATION);
  });

  it('migrates the legacy per-card viewTab keys and reports them for deletion', () => {
    const { map, legacyKeys } = loadPresentation({
      'viewTab.card-A': 'terminal',
      'viewTab.card-B': 'diff',
      railHidden: true,
    });
    expect(map.get('card-A')?.view).toBe('terminal');
    expect(map.get('card-B')?.view).toBe('diff');
    // the caller deletes them: leaving both homes writable gives one fact two
    // authorities, which is the bug this migration exists to prevent
    expect(legacyKeys.sort()).toEqual(['viewTab.card-A', 'viewTab.card-B']);
  });

  it('the new home wins when a card appears in both', () => {
    const { map } = loadPresentation({
      presentation: { 'card-A': { view: 'diff' } },
      'viewTab.card-A': 'terminal',
    });
    expect(map.get('card-A')?.view).toBe('diff');
  });
});

describe('presentation — writing a ui blob', () => {
  it('omits cards sitting at the default', () => {
    const map = new Map<string, CardPresentation>([
      ['card-A', DEFAULT_PRESENTATION],
      ['card-B', withView('terminal')],
      // reflected-only state is not a reason to write a record
      ['card-C', { ...DEFAULT_PRESENTATION, poppedOut: true, suspended: true }],
    ]);
    expect(persistablePresentation(map)).toEqual({ 'card-B': { view: 'terminal' } });
  });

  it('round-trips through the blob', () => {
    const map = new Map<string, CardPresentation>([
      [
        'card-A',
        {
          ...DEFAULT_PRESENTATION,
          ladder: 'hidden',
          slot: { groupId: 'g9', index: 1, location: 'popout', box: { left: 10, top: 20, width: 800, height: 600 } },
        },
      ],
    ]);
    const back = loadPresentation({ presentation: persistablePresentation(map) }).map;
    expect(back.get('card-A')).toEqual(map.get('card-A'));
  });
});

describe('presentation — change detection', () => {
  it('compares slots structurally, since one is captured fresh each time', () => {
    const a = { ...DEFAULT_PRESENTATION, slot: { groupId: 'g1', index: 0, location: 'grid' as const } };
    const b = { ...DEFAULT_PRESENTATION, slot: { groupId: 'g1', index: 0, location: 'grid' as const } };
    expect(samePresentation(a, b)).toBe(true);
    expect(samePresentation(a, { ...b, slot: { ...b.slot, index: 1 } })).toBe(false);
    expect(samePresentation(a, DEFAULT_PRESENTATION)).toBe(false);
  });

  it('reflected-only changes are changes, but not writes', () => {
    const a = DEFAULT_PRESENTATION;
    const b = { ...a, poppedOut: true };
    expect(samePresentation(a, b)).toBe(false); // the card must re-render
    expect(persistedChanged(a, b)).toBe(false); // ...but nothing goes in the blob
    expect(persistedChanged(a, { ...a, ladder: 'hidden' })).toBe(true);
  });
});

describe('presentation — pruning', () => {
  it('drops records for cards that no longer exist, and says when it did nothing', () => {
    const map = new Map<string, CardPresentation>([
      ['card-A', withView('terminal')],
      ['card-B', withView('diff')],
    ]);
    expect(prunePresentation(map, ['card-A', 'card-B'])).toBeNull(); // no write, no render
    const pruned = prunePresentation(map, ['card-A']);
    expect([...(pruned?.keys() ?? [])]).toEqual(['card-A']);
  });
});
