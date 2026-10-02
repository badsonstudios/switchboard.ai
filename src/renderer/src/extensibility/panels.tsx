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
import { DiffPane } from '../components/DiffPane';
import { FeedView } from '../components/FeedView';
import { FileTree } from '../components/FileTree';
import { HistoryPane } from '../components/HistoryPane';
import { openDocument } from '../lib/document-open';

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
    // Messages from other sessions waiting in the composer (P2-E11-05, #765
    // review). The composer only exists while this tab is selected, so on the
    // Terminal or Changes tab a waiting message would otherwise be invisible —
    // and the sender is told "not on screen", which this is the answer to.
    badge: (ctx) => (ctx.waiting !== undefined && ctx.waiting > 0 ? ctx.waiting : null),
    render: (ctx: PanelContext) => (
      <FeedView
        sessionId={ctx.sessionId}
        cardId={ctx.cardId}
        title={ctx.title}
        visible={ctx.visible}
        // the feed keeps a scroll position, so it is the panel that most needs
        // to hear that dockview moved its DOM out from under it (#555)
        dockEpoch={ctx.dockEpoch}
        status={ctx.status}
        // #903's buttons are dead without this — and #261 is the standing
        // lesson about a guard that only exists if THIS render site threads it
        // through. Without it the composer would offer a live Clear on a
        // session that has already exited.
        controlsLock={ctx.controlsLock}
        binding={ctx.binding}
        bindingDiag={ctx.bindingDiag}
        autonomy={ctx.autonomy}
        model={ctx.model}
        approval={ctx.approval}
        approvalQueued={ctx.approvalQueued}
        // #972's Monaco diff in the approval body, and #261's lesson one more
        // time: without this the prop is absent, `ApprovalPreview` falls back to
        // the plain panes, the card still works and the feature is simply not
        // there. A silent nothing is the failure mode this file keeps having.
        colorScheme={ctx.colorScheme}
        // P2-E9-11, and #261's lesson applied before it bites: the flag exists
        // to stop the handoff bar contradicting a grouped prompt, and it is
        // dead unless THIS render site threads it through
        approvalBatched={ctx.approvalBatched}
        // #261: the handoff bar routes the user to the Terminal in EVERY
        // branch, and a stream session has none — so without this the bar is
        // not merely unhelpful, it is false and its button is dead. The guard
        // has lived in `terminalHandoff` since #153's follow-up; it was dead
        // code the whole time because this render site never threaded the
        // context through. The Terminal panel that used to sit below read the
        // same `ctx.transport` and got it right, which is how two surfaces in
        // one window came to contradict each other. That panel went in #873, so
        // this is now the only render site consuming the guard.
        transport={ctx.transport}
        onDecide={ctx.onDecide}
        // #261's lesson again: the button is absent, not broken, without this
        onAllowFile={ctx.onAllowFile}
        onCycleAutonomy={ctx.onCycleAutonomy}
        // No `onJumpToTerminal`, and no bar to give it to since #952 — see
        // `setView('terminal')` would now resolve to the Session tab — a button
        // labelled "Open Terminal" that quietly does something else. The bar
        // still states what the CLI is waiting on; it just no longer offers a
        // door. It is PTY-only anyway (`terminalHandoff` returns null on
        // Direct), so no migrated session reaches it at all.
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
      ctx.folder ? (
        // `cardId` so the pane can publish its editor as THIS card's find
        // surface (P2-E17-02) — Ctrl+F on the Changes tab must reach one
        // editor, not whichever one the page happens to hold.
        //
        // ⚠️ **`sessionId` WAS MISSING, AND THAT IS #261's LESSON LANDING IN THE
        // FILE THAT KEEPS RECORDING IT** (found while wiring E24 Git v2 item 10).
        // `DiffPane` has taken a `sessionId` since P2-E16-03 and uses it for §5.24
        // attribution — a file opened from this tab should wear the session's
        // accent and a `↳ session` chip. This render site never threaded it, so
        // the prop was absent, the viewer fell back to no attribution, the tab
        // still worked, and the feature was simply not there. A silent nothing,
        // exactly as the Session panel's own comments above predict. Item 5's ⧉
        // and item 10's ⏱ both carry it now too.
        <DiffPane
          folder={ctx.folder}
          colorScheme={ctx.colorScheme}
          cardId={ctx.cardId}
          // ⚠️⚠️ **`ctx.cardId`, NOT `ctx.sessionId`, AND THE PROP NAME LIES.**
          // §5.24 attribution resolves through `sessionStore.getCardTitle`, which
          // matches on the CARD id — while `PanelContext.sessionId` is documented
          // three lines from here as *"the LIVE session id — churns on resume"*.
          // The first version of this fix passed the live id: the prop went from
          // ABSENT to WRONG, which is worse, and it looks identical on screen
          // because an unresolved id draws no chip. `lib/document-open.ts` carries
          // the full warning; issue 1055 is the rename that ends it.
          sessionId={ctx.cardId}
        />
      ) : null,
  },
  {
    // The Files tab (#521 layer 2, §5.35), and it is THREE LINES because it is
    // meant to be: everything real is in `FileTree` and
    // `lib/file-tree-model.ts`, neither of which knows what a tab is. The owner
    // chose this placement over a document-area panel knowing tabs are
    // exclusive, on the condition that moving it later is a new host rather than
    // a rewrite — so this host is the whole of what would be replaced.
    manifest: manifest('panel-files', 'Files'),
    id: 'files',
    titleKey: 'grid.viewFiles',
    // Was "ahead of History, which is a permanently disabled placeholder: a
    // working tab behind a dead one reads as the strip trailing off." History
    // works now (E24 Git v2 item 2), so the order is just the order — Changes,
    // Files, History, from the working tree outwards to the repository.
    order: 25,
    // Nothing to browse without a folder — greyed, not hidden, for the reason
    // the Changes tab directly above is greyed rather than hidden.
    enabled: (ctx) => !!ctx.folder,
    // NO BADGE, deliberately. `ctx.changed` is right there and a count of
    // changed files on a Files tab would be the Changes tab's badge in a second
    // place, saying the same number about a tab that is not about git.
    render: (ctx) =>
      ctx.folder ? (
        <FileTree
          root={ctx.folder}
          active={ctx.visible}
          // §5.30's placement policy, not a second opinion about it — and the
          // second argument is §5.24 attribution: the viewer wears this card's
          // accent and a `↳ session` chip.
          //
          // ⚠️ **`ctx.cardId`, AND IT WAS `ctx.sessionId` UNTIL AN E2E EXPOSED
          // THE WHOLE FAMILY OF THIS MISTAKE.** Attribution resolves on the CARD
          // id; the live id this used to pass resolves to nothing, so a file
          // opened from the Files tab has silently worn no attribution since
          // #521. `lib/document-open.ts` carries the warning.
          onOpenFile={(p) => openDocument(p, ctx.cardId)}
        />
      ) : null,
  },
  {
    // ⚠️ **THIS WAS `enabled: () => false, render: () => null` WHILE TWO DOCUMENTS
    // SAID ITS READ-ONLY LOG HAD SHIPPED** — `docs/DESIGN.md` §5.7's as-built note
    // and `docs/plans/06-phase-3-ide.md`'s E24, the second having inherited the
    // claim from the first. The owner found out by clicking the tab, six days
    // after the audit built to catch exactly that. E24 Git v2 item 2 is this line
    // stopping being a lie; `docs/plans/e24-git-v2-design.md` is the record.
    //
    // Three lines, like the Files tab above and for the same reason: everything
    // real is in `HistoryPane` and `lib/git-log-dto.ts`, neither of which knows
    // what a tab is. If the graph ever wants its own dock panel (design §6, still
    // open), that is a new host rather than a rewrite.
    manifest: manifest('panel-history', 'History'),
    id: 'history',
    titleKey: 'grid.viewHistory',
    order: 30,
    // Greyed, not hidden, for a session with no folder — the same rule the two
    // tabs above follow, and §5.8's: a tab is never hidden, only disabled.
    enabled: (ctx) => !!ctx.folder,
    // NO BADGE, deliberately, and the temptation is real: `ctx.changed` is right
    // there and an ahead-count would look at home on this tab. It would be a
    // second number about git on a strip that already has one, and the Changes
    // tab's badge is about the working tree while anything here would be about
    // the remote — two meanings, one shape.
    render: (ctx) =>
      ctx.folder ? (
        <HistoryPane
          folder={ctx.folder}
          active={ctx.visible}
          // `cardId` is how ⏱ in the Changes tab reaches THIS tab (item 10), and
          // `sessionId` is §5.24 attribution on a diff opened from a commit.
          cardId={ctx.cardId}
          sessionId={ctx.sessionId}
        />
      ) : null,
  },
  // THE TERMINAL TAB IS GONE (#873, owner call 2026-09-19): *"we don't need the
  // Terminal tab anymore, and we don't need the option to switch to Terminal in
  // the menu. Remove the tab and the menu item — leave the code behind."*
  //
  // `TerminalPane`, `terminal-attach`, `PtyService` and the whole PTY transport
  // stay in the tree: E18-16 still requires PTY to keep WORKING as the fallback
  // while Direct mode is under test, and this is a UI-level removal, not the
  // cutover. What is gone is the only user-facing route to it.
  //
  // WHY THE CONTRIBUTION IS REMOVED RATHER THAN HIDDEN FOR NON-PTY CARDS.
  // `PanelContribution.enabled` says there is deliberately no "hide it
  // entirely" option, and `points.test.ts` pins that as §5.8 — a tab is never
  // hidden, only greyed, because a vanishing tab teaches the user the app is
  // unpredictable. Registering this panel only for PTY cards would break that
  // rule from inside. Deleting it does not: §5.8 governs what EXISTS, and a tab
  // that does not exist is not a tab the user is being kept from seeing.
];

// `StreamTerminalNotice` lived here (P2-E18-08b): the Terminal tab's honest
// answer for a session with no PTY. It went with the tab (#873) — there is no
// longer a surface for it to be the body of. Its strings stay in `en.json`
// unreferenced rather than being deleted, alongside the rest of the transport
// vocabulary the code still speaks.
