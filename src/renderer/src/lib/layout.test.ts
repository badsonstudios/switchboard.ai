import { describe, it, expect } from 'vitest';
import {
  sanitizePopoutLayout,
  boxOnAnyDisplay,
  dropDerivedPopoutGroups,
  isDerivedPanelId,
} from './layout';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

describe('boxOnAnyDisplay', () => {
  it('true when a corner is visible, false when fully off-screen', () => {
    expect(boxOnAnyDisplay({ left: 100, top: 100, width: 800, height: 600 }, [primary])).toBe(true);
    expect(boxOnAnyDisplay({ left: 2200, top: 100, width: 800, height: 600 }, [primary])).toBe(false);
    expect(boxOnAnyDisplay({ left: 2200, top: 100, width: 800, height: 600 }, [primary, second])).toBe(true);
  });
});

describe('sanitizePopoutLayout', () => {
  const origin = 'http://127.0.0.1:55555';

  it('rewrites popout urls to the current origin (port changes each launch)', () => {
    const layout = {
      popoutGroups: [{ url: 'http://127.0.0.1:40000/popout.html', position: { left: 100, top: 100, width: 800, height: 600 } }],
    };
    const out = sanitizePopoutLayout(layout, origin, [primary]) as typeof layout;
    expect(out.popoutGroups[0].url).toBe('http://127.0.0.1:55555/popout.html');
  });

  it('rescues an off-display popout position to null and reports it (E8-06)', () => {
    const layout = {
      popoutGroups: [
        {
          url: 'x',
          position: { left: 3000, top: 100, width: 800, height: 600 },
          data: { views: ['session-abc'], activeView: 'session-abc' },
        },
      ],
    };
    // second monitor gone -> position rescued + stash entry captured
    const rescued: import('./layout').RescuedPopout[] = [];
    const out = sanitizePopoutLayout(layout, origin, [primary], rescued) as typeof layout;
    expect(out.popoutGroups[0].position).toBeNull();
    expect(rescued).toEqual([
      { panelIds: ['session-abc'], box: { left: 3000, top: 100, width: 800, height: 600 } },
    ]);
  });

  it('keeps an on-display popout position', () => {
    const layout = {
      popoutGroups: [{ url: 'x', position: { left: 2100, top: 100, width: 800, height: 600 } }],
    };
    const out = sanitizePopoutLayout(layout, origin, [primary, second]) as typeof layout;
    expect(out.popoutGroups[0].position).toEqual({ left: 2100, top: 100, width: 800, height: 600 });
  });

  it('no-ops on layouts without popouts / on garbage', () => {
    expect(sanitizePopoutLayout({ panels: {} }, origin, [primary])).toEqual({ panels: {} });
    expect(sanitizePopoutLayout(null, origin, [primary])).toBeNull();
  });
});

describe('dropDerivedPopoutGroups (#494)', () => {
  /** The real shape, captured from a workspace.json written by quitting with a
   *  viewer popped out — the case the flake was filed for. */
  const docOnlyPopout = () => ({
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { views: ['session-a', 'diff-a'], activeView: 'diff-a', id: '1' } },
          { type: 'leaf', data: { views: [], id: '2' }, visible: false },
        ],
      },
    },
    panels: { 'session-a': {}, 'diff-a': {}, 'doc-1': {} },
    activeGroup: '3',
    popoutGroups: [
      {
        gridReferenceGroup: '2',
        position: { left: 1416, top: 423, width: 478, height: 568 },
        url: 'http://127.0.0.1:55606/popout.html',
        data: { views: ['doc-1'], activeView: 'doc-1', id: '3' },
      },
    ],
  });

  it('names the derived ids, and only those', () => {
    expect(isDerivedPanelId('doc-1')).toBe(true);
    expect(isDerivedPanelId('diff-abc')).toBe(true);
    expect(isDerivedPanelId('session-abc')).toBe(false);
    expect(isDerivedPanelId('seed-1')).toBe(false);
    // not a prefix match on a session that merely starts with the letters
    expect(isDerivedPanelId('document-1')).toBe(false);
  });

  it('drops a popout window that would restore nothing but a viewer', () => {
    const out = dropDerivedPopoutGroups(docOnlyPopout()) as ReturnType<typeof docOnlyPopout>;
    expect(out.popoutGroups).toEqual([]);
    // the grid is untouched — the invisible dock-back shell included, because
    // dockview restores it as a hidden zero-size leaf and `documentHomeGroup`
    // already refuses to open into one
    expect(out.grid).toEqual(docOnlyPopout().grid);
    // ...and the window that is no longer being opened is not left as `active`
    expect('activeGroup' in out).toBe(false);
  });

  it('leaves the layout object the caller passed in alone', () => {
    const layout = docOnlyPopout();
    dropDerivedPopoutGroups(layout);
    expect(layout.popoutGroups).toHaveLength(1);
    expect(layout.popoutGroups[0].data.views).toEqual(['doc-1']);
  });

  it('keeps a popout that holds a session card, minus its derived tabs', () => {
    const layout = {
      activeGroup: '3',
      popoutGroups: [
        {
          url: 'x',
          data: { views: ['session-a', 'doc-1'], activeView: 'doc-1', id: '3' },
        },
      ],
    };
    const out = dropDerivedPopoutGroups(layout) as typeof layout;
    expect(out.popoutGroups).toHaveLength(1);
    expect(out.popoutGroups[0].data.views).toEqual(['session-a']);
    // the active tab was one of the ones removed, so the key goes and dockview
    // falls back to the last surviving panel
    expect('activeView' in out.popoutGroups[0].data).toBe(false);
    // the window still opens, so it is still allowed to be the active group
    expect(out.activeGroup).toBe('3');
  });

  it('handles a MULTI-GROUP popout window: all-derived goes, mixed stays', () => {
    const win = (views: string[][]) => ({
      url: 'x',
      grid: {
        root: {
          type: 'branch',
          data: views.map((v, i) => ({
            type: 'leaf',
            data: { views: v, id: `g${i}` },
          })),
        },
      },
      data: { views: views[0], id: 'g0' },
    });
    const allDerived = { popoutGroups: [win([['doc-1'], ['diff-a']])] };
    expect((dropDerivedPopoutGroups(allDerived) as typeof allDerived).popoutGroups).toEqual([]);

    const mixed = { popoutGroups: [win([['doc-1'], ['session-a']])] };
    const out = (dropDerivedPopoutGroups(mixed) as typeof mixed).popoutGroups;
    expect(out).toHaveLength(1);
    expect(out[0].grid.root.data.map((n) => n.data.views)).toEqual([[], ['session-a']]);
  });

  it('runs before the sanitizer, so a dropped window is never RESCUED (E8-06)', () => {
    const layout = {
      popoutGroups: [
        {
          url: 'x',
          // off every display: the sanitizer would stash this for the reconnect
          // offer if it ever saw it
          position: { left: 3000, top: 100, width: 800, height: 600 },
          data: { views: ['doc-1'], id: '3' },
        },
      ],
    };
    const rescued: import('./layout').RescuedPopout[] = [];
    const out = sanitizePopoutLayout(
      dropDerivedPopoutGroups(layout),
      'http://127.0.0.1:1',
      [primary],
      rescued
    ) as typeof layout;
    expect(out.popoutGroups).toEqual([]);
    expect(rescued).toEqual([]);
  });

  it('no-ops on garbage and on layouts with no popouts', () => {
    expect(dropDerivedPopoutGroups(null)).toBeNull();
    expect(dropDerivedPopoutGroups('nope')).toBe('nope');
    expect(dropDerivedPopoutGroups({ panels: {} })).toEqual({ panels: {} });
    // a popout entry with no group data at all is dropped rather than opened:
    // there is nothing in it to restore
    expect((dropDerivedPopoutGroups({ popoutGroups: [{ url: 'x' }] }) as { popoutGroups: unknown[] }).popoutGroups).toEqual([]);
  });
});
