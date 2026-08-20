import { describe, it, expect } from 'vitest';
import {
  sanitizePopoutLayout,
  boxOnAnyDisplay,
  isDerivedPanelId,
  prunePopoutGroups,
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

describe('prunePopoutGroups (#494)', () => {
  /** The restore's real verdict: derived panels always, plus session cards with
   *  no record behind them. `session-a` is the one card that is coming back. */
  const willBePruned = (id: string): boolean =>
    isDerivedPanelId(id) || (/^session-/.test(id) && id !== 'session-a');

  const leaf = (views: string[], id: string, extra: object = {}) => ({
    type: 'leaf',
    data: { views, activeView: views[0], id },
    size: 478,
    ...extra,
  });

  /** The real shape, captured from a `workspace.json` written by quitting with
   *  a viewer popped out — the case #494 was filed for. Group `2` is the hidden
   *  dock-back husk dockview leaves in the grid for the popout to return into. */
  const docOnlyPopout = () => ({
    grid: {
      root: {
        type: 'branch',
        data: [leaf(['session-a', 'diff-a'], '1'), leaf([], '2', { visible: false })],
        size: 564,
      },
      width: 956,
      height: 564,
      orientation: 'HORIZONTAL',
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

  const gridIds = (out: { grid: { root: { data: { data: { id: string } }[] } } }): string[] =>
    out.grid.root.data.map((n) => n.data.id);

  it('names the derived ids, and only those', () => {
    expect(isDerivedPanelId('doc-1')).toBe(true);
    expect(isDerivedPanelId('diff-abc')).toBe(true);
    expect(isDerivedPanelId('session-abc')).toBe(false);
    expect(isDerivedPanelId('seed-1')).toBe(false);
    // a prefix, not a substring: an id that merely starts with the letters
    expect(isDerivedPanelId('document-1')).toBe(false);
  });

  it('drops a popout window that would restore nothing but a viewer', () => {
    const out = prunePopoutGroups(docOnlyPopout(), willBePruned) as ReturnType<
      typeof docOnlyPopout
    >;
    expect(out.popoutGroups).toEqual([]);
    // ...and the window that is no longer being opened is not left as `active`
    expect('activeGroup' in out).toBe(false);
    // the session's own group is untouched, husk aside
    expect(out.grid.root.data[0]).toEqual(docOnlyPopout().grid.root.data[0]);
  });

  it('takes the dropped window\u2019s dock-back husk with it', () => {
    // dockview removes the husk itself when a popout window CLOSES; a window
    // that is never opened never closes, so one would be left behind — and a
    // fresh one added on every pop-out-then-quit after that.
    const out = prunePopoutGroups(docOnlyPopout(), willBePruned) as ReturnType<
      typeof docOnlyPopout
    >;
    expect(gridIds(out)).toEqual(['1']);
  });

  it('keeps a husk that a SURVIVING window still needs as its way home', () => {
    const layout = docOnlyPopout();
    // a second window, on the same husk, holding the session that IS coming back
    layout.popoutGroups.push({
      gridReferenceGroup: '2',
      position: { left: 0, top: 0, width: 478, height: 568 },
      url: 'u',
      data: { views: ['session-a'], activeView: 'session-a', id: '4' },
    });
    const out = prunePopoutGroups(layout, willBePruned) as typeof layout;
    expect(out.popoutGroups).toHaveLength(1);
    expect(gridIds(out)).toEqual(['1', '2']);
  });

  it('never empties the grid: a husk that is the whole layout stays', () => {
    // `session.spec.ts`'s #462 case — a viewer popped out of an app with no
    // sessions open. A grid with no views at all is worse than a stale husk.
    const layout = {
      grid: { root: { type: 'branch', data: [leaf([], '2', { visible: false })] } },
      popoutGroups: [{ gridReferenceGroup: '2', url: 'u', data: { views: ['doc-1'], id: '3' } }],
    };
    const out = prunePopoutGroups(layout, willBePruned) as typeof layout;
    expect(out.popoutGroups).toEqual([]);
    expect(gridIds(out as never)).toEqual(['2']);
  });

  it('leaves the layout object the caller passed in alone', () => {
    const layout = docOnlyPopout();
    prunePopoutGroups(layout, willBePruned);
    expect(layout.popoutGroups).toHaveLength(1);
    expect(layout.popoutGroups[0].data.views).toEqual(['doc-1']);
    expect(gridIds(layout as never)).toEqual(['1', '2']);
  });

  it('keeps a popout that holds a live session card, minus the condemned tabs', () => {
    const layout = {
      activeGroup: '3',
      popoutGroups: [
        {
          url: 'x',
          gridReferenceGroup: '2',
          data: { views: ['session-a', 'doc-1'], activeView: 'doc-1', id: '3' },
        },
      ],
    };
    const out = prunePopoutGroups(layout, willBePruned) as typeof layout;
    expect(out.popoutGroups).toHaveLength(1);
    expect(out.popoutGroups[0].data.views).toEqual(['session-a']);
    // the active tab was one of the ones removed, so the key goes and dockview
    // falls back to the last surviving panel
    expect('activeView' in out.popoutGroups[0].data).toBe(false);
    // the window still opens, so it is still allowed to be the active group
    expect(out.activeGroup).toBe('3');
  });

  it('applies the SESSION half of the verdict too, not just the derived one', () => {
    // The half that made the predicate an argument: a popout holding one card
    // whose record is gone strands its window exactly as a viewer's did.
    const layout = {
      popoutGroups: [{ url: 'x', data: { views: ['session-gone'], id: '3' } }],
    };
    expect((prunePopoutGroups(layout, willBePruned) as typeof layout).popoutGroups).toEqual([]);
  });

  it('handles a MULTI-GROUP popout window: all-condemned goes, mixed is thinned', () => {
    const win = (views: string[][]) => ({
      url: 'x',
      grid: { root: { type: 'branch', data: views.map((v, i) => leaf(v, `g${i}`)) } },
      data: { views: views[0], activeView: views[0][0], id: 'g0' },
    });
    const allDerived = { popoutGroups: [win([['doc-1'], ['diff-a']])] };
    expect((prunePopoutGroups(allDerived, willBePruned) as typeof allDerived).popoutGroups).toEqual(
      []
    );

    const mixed = { popoutGroups: [win([['doc-1'], ['session-a']])] };
    const out = (prunePopoutGroups(mixed, willBePruned) as typeof mixed).popoutGroups;
    expect(out).toHaveLength(1);
    // the emptied group is REMOVED, not left as a blank pane in the window
    expect(out[0].grid.root.data.map((n) => n.data.id)).toEqual(['g1']);
    // ...and the anchor copy the rescue stash reads is filtered as well
    expect(out[0].data.views).toEqual([]);
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
      prunePopoutGroups(layout, willBePruned),
      'http://127.0.0.1:1',
      [primary],
      rescued
    ) as typeof layout;
    expect(out.popoutGroups).toEqual([]);
    expect(rescued).toEqual([]);
  });

  it('a SURVIVING off-display window is still rescued, minus the condemned ids', () => {
    const layout = {
      popoutGroups: [
        {
          url: 'x',
          position: { left: 3000, top: 100, width: 800, height: 600 },
          data: { views: ['session-a', 'doc-1'], id: '3' },
        },
      ],
    };
    const rescued: import('./layout').RescuedPopout[] = [];
    sanitizePopoutLayout(
      prunePopoutGroups(layout, willBePruned),
      'http://127.0.0.1:1',
      [primary],
      rescued
    );
    expect(rescued).toEqual([
      { panelIds: ['session-a'], box: { left: 3000, top: 100, width: 800, height: 600 } },
    ]);
  });

  it('no-ops on garbage and on layouts with no popouts', () => {
    expect(prunePopoutGroups(null, willBePruned)).toBeNull();
    expect(prunePopoutGroups('nope', willBePruned)).toBe('nope');
    expect(prunePopoutGroups({ panels: {} }, willBePruned)).toEqual({ panels: {} });
    // a popout entry with no group data at all is dropped rather than opened:
    // there is nothing in it to restore (dockview discards it too)
    expect(
      (prunePopoutGroups({ popoutGroups: [{ url: 'x' }] }, willBePruned) as { popoutGroups: [] })
        .popoutGroups
    ).toEqual([]);
  });
});
