// Session view tabs as CONTRIBUTIONS (P2-E15-03, §5.10 + §5.23).
//
// The strip in SessionGrid used to name all four tabs and render each one in a
// hardcoded branch. It now renders whatever is registered here, in `order`.
//
// The ids are a CONTRACT, not display strings: they are persisted per card in
// the ui blob (`viewTab.<cardId>`) and named by the E9-01 commands and by
// `GridController.setView`. 'feed' is the Session view — the internal id
// predates the rename and changing it would be a migration for no gain.
import React from 'react';
import { useTranslation } from 'react-i18next';
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
        title={ctx.title}
        visible={ctx.visible}
        status={ctx.status}
        binding={ctx.binding}
        bindingDiag={ctx.bindingDiag}
        recentlyDecided={ctx.recentlyDecided}
        autonomy={ctx.autonomy}
        model={ctx.model}
        approval={ctx.approval}
        approvalQueued={ctx.approvalQueued}
        // P2-E9-11, and #261's lesson applied before it bites: the flag exists
        // to stop the handoff bar contradicting a grouped prompt, and it is
        // dead unless THIS render site threads it through
        approvalBatched={ctx.approvalBatched}
        // #261: the handoff bar routes the user to the Terminal in EVERY
        // branch, and a stream session has none — so without this the bar is
        // not merely unhelpful, it is false and its button is dead. The guard
        // has lived in `terminalHandoff` since #153's follow-up; it was dead
        // code the whole time because this render site never threaded the
        // context through. The sibling Terminal panel below reads the same
        // `ctx.transport` and got it right, which is how two surfaces in one
        // window came to contradict each other.
        transport={ctx.transport}
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
    // A stream session has NO PTY, so there is nothing for xterm to attach to.
    // Saying that in one sentence is the honest degrade (P2-E18-08b); rendering
    // an empty black rectangle would look like a broken terminal, which is the
    // failure mode #125 was about — a surface that is technically correct and
    // reads as breakage.
    render: (ctx) =>
      ctx.transport === 'stream' ? (
        <StreamTerminalNotice />
      ) : (
        <TerminalPane sessionId={ctx.sessionId} visible={ctx.visible} />
      ),
  },
];

/**
 * What the Terminal tab shows for a STREAM session (P2-E18-08b).
 *
 * There is no PTY to attach to, so xterm would render an empty black
 * rectangle — technically correct and indistinguishable from a broken
 * terminal, which is exactly the failure #125 was about. Say what is true
 * instead, and say what the user gains rather than only what is missing.
 */
function StreamTerminalNotice(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: '16px 18px',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
        maxInlineSize: 560,
      }}
    >
      <div style={{ fontWeight: 700, marginBlockEnd: 6 }}>{t('terminal.streamTitle')}</div>
      <div style={{ color: 'var(--muted)' }}>{t('terminal.streamBody')}</div>
    </div>
  );
}
