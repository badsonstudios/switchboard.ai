// Session view tabs as CONTRIBUTIONS (P2-E15-03, §5.10 + §5.23).
//
// The strip in SessionGrid used to name all four tabs and render each one in a
// hardcoded branch. It now renders whatever is registered here, in `order`.
//
// The ids are a CONTRACT, not display strings: they are persisted per card in
// the ui blob (`viewTab.<cardId>`) and named by the E9-01 commands and by
// `GridController.setView`. 'feed' is the Session view — the internal id
// predates the rename and changing it would be a migration for no gain.
import { manifestFor, PanelContext, PanelContribution } from './contributions';
import { RendererRegistry } from './registry-instance';
import { safely } from './boundary';
import { TerminalPane } from '../components/TerminalPane';
import { DiffPane } from '../components/DiffPane';
import { FeedView } from '../components/FeedView';

const manifest = (id: string, displayName: string) => manifestFor(id, displayName, 'panel.render');

/**
 * The panels a card shows, in order — the ONE definition of that rule.
 *
 * Consumers and tests both call this; when the strip re-implemented the sort
 * itself, the done-when test was asserting against its own copy of the logic
 * and would have passed while the real strip drifted.
 */
export function listPanels(registry: RendererRegistry): PanelContribution[] {
  return [...registry.list('panel')].sort((a, b) => a.order - b.order);
}

/** Is this panel selectable right now? A throw counts as "no". */
export function panelEnabled(p: PanelContribution, ctx: PanelContext): boolean {
  return safely(p.manifest.id, 'enabled()', () => p.enabled?.(ctx) ?? true, false);
}

/** The badge to show on a panel's tab, if any. A throw counts as none. */
export function panelBadge(p: PanelContribution, ctx: PanelContext): number | null {
  return safely(p.manifest.id, 'badge()', () => p.badge?.(ctx) ?? null, null);
}

// DEFAULT_PANEL_ID moved to contributions.ts (P2-E15-08): the store defaults a
// card's view to it, and the store must not import this file — these panels
// pull in React and every view component. Re-exported so existing importers,
// which think of it as "the panels module's business", keep working.
export { DEFAULT_PANEL_ID } from './contributions';

export const sessionPanels: PanelContribution[] = [
  {
    manifest: manifest('panel-session', 'Session view'),
    id: 'feed',
    titleKey: 'grid.viewSession',
    order: 10,
    render: (ctx: PanelContext) => (
      <FeedView
        sessionId={ctx.sessionId}
        cardId={ctx.cardId}
        visible={ctx.visible}
        status={ctx.status}
        autonomy={ctx.autonomy}
        model={ctx.model}
        approval={ctx.approval}
        approvalQueued={ctx.approvalQueued}
        onDecide={ctx.onDecide}
        onCycleAutonomy={ctx.onCycleAutonomy}
        onJumpToTerminal={() => ctx.setView('terminal')}
      />
    ),
  },
  {
    manifest: manifest('panel-changes', 'Changes (diff)'),
    id: 'diff',
    titleKey: 'grid.viewDiff',
    order: 20,
    // A session with no folder has nothing to diff — greyed, not hidden.
    // Hiding it would also strand `view.changes`, which switches to this tab
    // unconditionally, on a card with no such tab.
    enabled: (ctx) => !!ctx.folder,
    badge: (ctx) => (ctx.changed > 0 ? ctx.changed : null),
    render: (ctx) =>
      ctx.folder ? <DiffPane folder={ctx.folder} colorScheme={ctx.colorScheme} /> : null,
  },
  {
    // Shown but not clickable — §5.8's rule that you can always SEE what
    // exists. It was a hardcoded "soon" span before; as a contribution it is
    // at least honest about being a placeholder, and deleting it later is one
    // line here rather than surgery on the strip.
    manifest: manifest('panel-history', 'History (placeholder)'),
    id: 'history',
    titleKey: 'grid.viewHistory',
    order: 30,
    enabled: () => false,
    render: () => null,
  },
  {
    // LAST, deliberately (owner call 2026-07-22), and the only panel that must
    // survive being inactive: unmounting the terminal throws away the xterm
    // view and the user's scrollback with it.
    manifest: manifest('panel-terminal', 'Terminal'),
    id: 'terminal',
    titleKey: 'grid.viewTerminal',
    order: 100,
    keepMounted: true,
    render: (ctx) => <TerminalPane sessionId={ctx.sessionId} visible={ctx.visible} />,
  },
];
