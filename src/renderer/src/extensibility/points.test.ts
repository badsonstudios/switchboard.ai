// @vitest-environment jsdom
// The DONE-WHEN of P2-E15-03, as an executable claim rather than a promise:
// "adding a new view tab or a new block renderer requires editing ONLY its own
// module plus the renderer bootstrap — no edit to SessionGrid.tsx or
// FeedView.tsx."
//
// These tests add a fourth panel and an eighth block renderer to a registry
// and assert they take effect. Neither consumer file is imported here, which
// is the point: if either still needed editing, there would be no way to write
// this file.
import { describe, it, expect } from 'vitest';

import { PanelContext, StatusBarContext } from './contributions';
import { createRendererRegistry } from '../bootstrap';
import { listPanels, panelBadge, panelEnabled } from './panels';
import { listStatusBarItems } from './status-bar-items';
import { renderFeedBlock } from './feed-render';
import { FeedBlockDto } from '../lib/feed';

function ctx(over: Partial<PanelContext> = {}): PanelContext {
  return {
    sessionId: 's1',
    cardId: 'c1',
    visible: true,
    folder: 'C:/proj',
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    setView: () => {},
    ...over,
  };
}

// NOTE: these call the same `listPanels` / `listStatusBarItems` the real
// consumers call. An earlier draft re-implemented the sort here, which meant
// the "done-when" test was asserting against its own copy of the rule and
// would have stayed green while the strip drifted.

describe('the built-in renderer points', () => {
  it('ships four panels in a fixed order, Terminal last', () => {
    const ids = listPanels(createRendererRegistry()).map((p) => p.id);
    expect(ids).toEqual(['feed', 'diff', 'history', 'terminal']);
  });

  it('a tab is never HIDDEN, only greyed — §5.8: you can see what exists', () => {
    // Changes has nothing to diff without a folder, but vanishing tabs teach
    // the user the app is unpredictable; a greyed one teaches them why. It
    // also keeps `view.changes` from selecting a tab that isn't there.
    const r = createRendererRegistry();
    const folderless = ctx({ folder: undefined });
    expect(listPanels(r).map((p) => p.id)).toEqual(['feed', 'diff', 'history', 'terminal']);
    const diff = listPanels(r).find((p) => p.id === 'diff')!;
    expect(panelEnabled(diff, folderless)).toBe(false);
    expect(panelEnabled(diff, ctx())).toBe(true);
  });

  it('History is shown but not clickable', () => {
    const history = listPanels(createRendererRegistry()).find((p) => p.id === 'history')!;
    expect(panelEnabled(history, ctx())).toBe(false);
  });

  it('a panel whose enabled() THROWS is greyed, not fatal', () => {
    const r = createRendererRegistry();
    r.register('panel', {
      manifest: { id: 'panel-bad', displayName: 'Bad', version: '1.0.0', capabilities: ['panel.render'] },
      id: 'bad',
      titleKey: 'x',
      order: 5,
      enabled: () => {
        throw new Error('boom');
      },
      render: () => null,
    });
    const bad = listPanels(r).find((p) => p.id === 'bad')!;
    expect(panelEnabled(bad, ctx())).toBe(false);
    expect(panelBadge(bad, ctx())).toBeNull();
  });

  it('only the Terminal survives being inactive (its xterm view would be lost)', () => {
    const kept = listPanels(createRendererRegistry())
      .filter((p) => p.keepMounted)
      .map((p) => p.id);
    expect(kept).toEqual(['terminal']);
  });

  it('Changes badges the changed-file count, and nothing when clean', () => {
    const diff = listPanels(createRendererRegistry()).find((p) => p.id === 'diff')!;
    expect(panelBadge(diff, ctx({ changed: 3 }))).toBe(3);
    expect(panelBadge(diff, ctx({ changed: 0 }))).toBeNull();
  });

  it('the shipped block renderers keep the old chain precedence', () => {
    const r = createRendererRegistry();
    const pick = (b: Partial<FeedBlockDto>): string | undefined =>
      [...r.list('feed-block-renderer')]
        .sort((x, y) => x.order - y.order)
        .find((x) => x.matches({ seq: 1, kind: 'assistant', ...b } as FeedBlockDto))?.manifest.id;
    // all three of these are kind 'tool'; the specific ones must win
    expect(pick({ kind: 'tool', tool: { name: 'Bash', category: 'shell', summary: 'ls' } })).toBe('feed-block-bash');
    expect(pick({ kind: 'tool', tool: { name: 'Edit', summary: 'y.ts', newString: 'x' } })).toBe('feed-block-edit');
    expect(pick({ kind: 'tool', tool: { name: 'Read', summary: 'x.ts' } })).toBe('feed-block-tool');
    expect(pick({ kind: 'todos' })).toBe('feed-block-todos');
    expect(pick({ kind: 'thinking' })).toBe('feed-block-thinking');
    expect(pick({ kind: 'user' })).toBe('feed-block-user');
    expect(pick({ kind: 'assistant' })).toBe('feed-block-markdown');
  });

  it('status bar items split across the spacer, each side in order', () => {
    const r = createRendererRegistry();
    expect(listStatusBarItems(r, 'start').map((i) => i.manifest.id)).toEqual([
      'status-session-count',
      // §5.14's attention-queue count, built with P2-E14-01 — between the two
      // it was always spec'd between
      'status-attention-count',
      'status-usage',
    ]);
    expect(listStatusBarItems(r, 'end').map((i) => i.manifest.id)).toEqual([
      'status-service-health',
      'status-cli-version',
      'status-theme',
    ]);
  });

  it('the usage item renders nothing when there is nothing to report', () => {
    const usage = createRendererRegistry()
      .list('status-bar-item')
      .find((i) => i.manifest.id === 'status-usage')!;
    const base: StatusBarContext = { count: 1, theme: 'nordic', themeNameKey: 'theme.nordic' };
    expect(usage.render(base)).toBeNull();
    expect(usage.render({ ...base, totalOutputTokens: 100 })).not.toBeNull();
  });

  it('every contribution carries an honest manifest', () => {
    for (const { point, manifest } of createRendererRegistry().manifests()) {
      expect(manifest.id, `${point} has an id`).toMatch(/^[a-z0-9-]+$/);
      expect(manifest.displayName.length, `${manifest.id} has a display name`).toBeGreaterThan(0);
      expect(manifest.version, `${manifest.id} has a version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.capabilities.length, `${manifest.id} declares a capability`).toBeGreaterThan(0);
    }
  });
});

describe('choosing the active panel', () => {
  // the rule SessionGrid applies to the persisted view id
  const active = (ids: string[], view: string, c: PanelContext) => {
    const panels = listPanels(createRendererRegistry()).filter((p) => ids.includes(p.id));
    return (panels.find((p) => p.id === view && panelEnabled(p, c)) ?? panels[0])?.id;
  };
  const all = ['feed', 'diff', 'history', 'terminal'];

  it('uses the persisted panel when it exists and is selectable', () => {
    expect(active(all, 'terminal', ctx())).toBe('terminal');
  });

  it('falls back when the persisted id names no panel at all', () => {
    // an id left behind by a contribution that has since been removed
    expect(active(all, 'notes-from-a-plugin-we-uninstalled', ctx())).toBe('feed');
  });

  it('falls back when the persisted panel is DISABLED rather than blanking', () => {
    // Changes remembered, then the folder went away: rendering it would give a
    // blank card body with no tab lit and nothing explaining why
    expect(active(all, 'diff', ctx({ folder: undefined }))).toBe('feed');
    expect(active(all, 'history', ctx())).toBe('feed');
  });
});

describe('the done-when: extending needs no edit to the consumers', () => {
  it('a NEW panel appears in the strip without touching SessionGrid', () => {
    const r = createRendererRegistry();
    r.register('panel', {
      manifest: { id: 'panel-notes', displayName: 'Notes', version: '1.0.0', capabilities: ['panel.render'] },
      id: 'notes',
      titleKey: 'x.notes',
      order: 25, // between Changes and History
      render: () => null,
    });
    expect(listPanels(r).map((p) => p.id)).toEqual([
      'feed',
      'diff',
      'notes',
      'history',
      'terminal',
    ]);
  });

  it('a NEW block renderer claims its blocks without touching FeedView', () => {
    const r = createRendererRegistry();
    r.register('feed-block-renderer', {
      manifest: { id: 'feed-block-web', displayName: 'Web fetch', version: '1.0.0', capabilities: ['feed.render'] },
      order: 35, // ahead of the generic tool row
      matches: (b) => b.kind === 'tool' && b.tool?.name === 'WebFetch',
      render: () => 'WEB',
    });
    const web = { seq: 1, kind: 'tool', tool: { name: 'WebFetch', summary: 'https://x' } } as FeedBlockDto;
    expect(renderFeedBlock(r, web)).toBe('WEB');
    // and it does NOT steal blocks it never claimed
    const read = { seq: 2, kind: 'tool', tool: { name: 'Read', summary: 'x.ts' } } as FeedBlockDto;
    expect(renderFeedBlock(r, read)).not.toBe('WEB');
  });

  it('a NEW status bar item appears without touching chrome', () => {
    const r = createRendererRegistry();
    r.register('status-bar-item', {
      manifest: { id: 'status-clock', displayName: 'Clock', version: '1.0.0', capabilities: ['statusbar.item'] },
      align: 'end',
      order: 5,
      render: () => 'CLOCK',
    });
    expect(listStatusBarItems(r, 'end').map((i) => i.manifest.id)).toEqual([
      'status-clock',
      'status-service-health',
      'status-cli-version',
      'status-theme',
    ]);
  });
});
