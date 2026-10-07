// Every change in one scroll (E24 Git v2 item 9, §5.7) — screen 5.
//
// ⚠️ **THE SURFACE WE HAD NO EQUIVALENT OF**, and the design record says why it
// matters: *"this is the surface for reviewing what an agent just did — you read
// top to bottom instead of clicking seventeen files."* VS Code calls it
// `git.viewChanges`; §2.3 of the design record lists it as the one multi-file
// reading surface the field has and we did not.
//
// ⚠️ **AND IT IS THE ONE PANEL IN THIS EPIC THAT CAN COST SOMETHING IF IT IS
// WRONG.** Every expanded file is a real Monaco diff editor — the same object the
// Changes tab mounts exactly one of. Seventeen of them is seventeen models and
// seventeen tokenizers built in one frame, which is seconds of held main thread on
// a change set the size of this repository's own. So `lib/multi-file-diff.ts`
// decides, before anything mounts, which files start open; this component only
// draws that decision. The policy is pure and tested as a rule, for the reason
// every `lib/` module in this epic is.
//
// WHAT IS DELIBERATELY NOT HERE: the **＋ Stage all** and per-file **＋** that
// screen 5 draws. Both need the `git.write` capability, which is item 12 — and
// the owner's rule is that a control which does nothing is worse than no control.
// The slot they will occupy is built; they are absent rather than drawn dead.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { setDiffLayout, type DiffLayout } from '../lib/diff-layout';
import { WORKING_TREE_LEFT, WORKING_TREE_RIGHT } from '../lib/diff-panels';
import { openDiff } from '../lib/diff-open';
import { buildGroups, letterKey, type ScmRow } from '../lib/scm-groups';
import {
  applyToggles,
  planStack,
  stackTotals,
  type StackedFile,
  type StackPlan,
} from '../lib/multi-file-diff';
import { getGitStatus, refreshGitStatus, subscribeGitStatus } from '../lib/git-status-store';
import { gitPaneState } from '../lib/git-status';
import { MonacoDiff, type DiffLayoutState } from './MonacoDiff';
import { LETTER_INKS } from './ScmSidebar';

/**
 * How tall one file's editor is.
 *
 * ⚠️ **A FIXED BOX PER FILE, BECAUSE A VERTICAL STACK CANNOT ASK MONACO TO SIZE
 * ITSELF.** Monaco's diff editor fills its container; in a scrolling column there
 * is no container height to fill, so without a number every editor collapses to
 * nothing. Auto-sizing to the content would mean measuring N editors after mount
 * and reflowing the whole column, which is the layout thrash this panel is budgeted
 * to avoid in the first place.
 *
 * So: a box scaled to the change, clamped at both ends. Small changes do not leave
 * a screen of blank; a large one gets its own inner scroll rather than a page of
 * column. The numbers are judgement, not measurement, and are named here so they
 * are one edit rather than a search.
 */
const ROW_PX = 19;
const MIN_EDITOR_PX = 140;
const MAX_EDITOR_PX = 460;
export function editorHeightPx(lines: number | null): number {
  // No count (untracked, binary) gets the minimum: there is nothing to scale by,
  // and guessing large would spend the most space on the least information.
  if (lines === null) return MIN_EDITOR_PX;
  // `+6` for the diff's own chrome and a little air, so a one-line change is not
  // a one-line box.
  return Math.min(MAX_EDITOR_PX, Math.max(MIN_EDITOR_PX, (lines + 6) * ROW_PX));
}

export function AllChangesView(props: {
  folder: string;
  colorScheme: 'light' | 'dark';
  poppedOut: boolean;
  onPopoutToggle: () => void;
  panelId: string;
  layoutPref: DiffLayout;
  /** the card this panel was opened from, for §5.24 attribution on a popped file */
  cardId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [body, setBody] = React.useState<DiffLayoutState>({
    layout: 'side-by-side',
    narrowed: false,
  });
  /**
   * The user's own folds, by file key.
   *
   * ⚠️ **A SET OF TOGGLES RATHER THAN A SET OF STATES, so the plan stays the
   * authority.** The plan is recomputed whenever the status refreshes; holding
   * absolute open/closed flags would mean a refresh either discarding the user's
   * folds or overriding its own budget. `applyToggles` flips the plan's answer,
   * which is the only arrangement where both keep meaning something.
   */
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set());

  // ⚠️ **THE SHARED STATUS, WHICH IS ITEM 11'S WHOLE POINT.** This is the FOURTH
  // reader of `git:status`, and a fourth independent fetch would make "do these
  // surfaces agree?" a question of timing. `stats: true` because every row here
  // draws `+/−` AND because the collapse budget is computed from those numbers —
  // without them every file would have an unknown size and the panel would open
  // ten editors on a guess.
  const status = React.useSyncExternalStore(subscribeGitStatus, () => getGitStatus(props.folder));
  React.useEffect(() => {
    refreshGitStatus(props.folder, { stats: true });
  }, [props.folder]);

  const paneState = gitPaneState(status);
  const rows = React.useMemo((): ScmRow[] => {
    // ⚠️ **GROUP ORDER, NOT STATUS ORDER**, so the stack reads in the same order
    // as the sidebar beside it: conflicts, then staged, then unstaged, then
    // untracked. A panel whose reading order disagreed with the list it was opened
    // from would be two answers about one change set.
    return buildGroups(status).flatMap((g) => g.rows);
  }, [status]);

  const plan: StackPlan = React.useMemo(
    () => applyToggles(planStack(rows), toggled),
    [rows, toggled]
  );
  const totals = React.useMemo(() => stackTotals(plan.files), [plan.files]);

  const toggle = (key: string): void =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /**
   * Fold or unfold everything.
   *
   * ⚠️ **COMPUTED FROM THE PLAN AS IT IS, NOT TOGGLED.** "Collapse all" has to end
   * with everything closed whatever each file's current state — flipping every
   * toggle would open exactly the files that were shut.
   */
  const setAll = (collapse: boolean): void => {
    const next = new Set<string>();
    for (const f of plan.files) {
      // a toggle is needed only where the PLAN's answer differs from the target
      const planned = planStack(rows).files.find((p) => p.key === f.key);
      if (planned && planned.collapsed !== collapse) next.add(f.key);
    }
    setToggled(next);
  };

  return (
    <div
      className="all-changes-view"
      style={{
        blockSize: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card-bg)',
        minInlineSize: 0,
      }}
    >
      <div className="diff-toolbar" role="group" aria-label={t('diff.layoutLabel')}>
        <span
          className="all-changes-title"
          style={{ flexShrink: 0, color: 'var(--text)', fontSize: 11, fontWeight: 600 }}
        >
          {t('allChanges.title')}
        </span>
        {/* What is being compared, said in words. A panel called "All changes"
            that did not say WHICH changes would be the same ambiguity the History
            tab's empty states were corrected for. */}
        <span
          className="all-changes-scope"
          style={{
            flex: '1 1 auto',
            minInlineSize: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--muted)',
            fontSize: 10,
          }}
        >
          {status?.branch
            ? t('allChanges.scopeBranch', { branch: status.branch })
            : t('allChanges.scope')}
        </span>
        {paneState?.kind === 'files' && (
          <span
            className="all-changes-totals"
            style={{ flexShrink: 0, color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}
          >
            {/* ⚠️ ABSENT IS NOT ZERO, the standing rule: with nothing countable the
                bar draws the FILE count and no line numbers, rather than `+0 −0`
                over a stack full of binaries. */}
            {totals.insertions > 0 || totals.deletions > 0
              ? t('allChanges.totals', {
                  plus: totals.insertions,
                  minus: totals.deletions,
                  count: totals.files,
                })
              : // `scm.filesAtLeast` already exists and already hedges — the
                // sidebar's totals bar says exactly this when nothing could be
                // counted, and a second wording for one fact would be a second
                // thing to keep true.
                t(totals.partial ? 'scm.filesAtLeast' : 'scm.files', { count: totals.files })}
          </span>
        )}
        {body.narrowed && <span className="diff-narrow-note">{t('diff.tooNarrowNote')}</span>}
        {(['side-by-side', 'inline'] as const).map((mode: DiffLayout) => {
          const reason = mode === 'side-by-side' && body.narrowed ? t('diff.tooNarrow') : undefined;
          return (
            <button
              key={mode}
              type="button"
              className="diff-btn"
              data-testid={`all-changes-layout-${mode}`}
              aria-pressed={props.layoutPref === mode}
              aria-label={reason}
              title={reason}
              onClick={() => setDiffLayout(mode)}
            >
              {t(mode === 'side-by-side' ? 'diff.sideBySide' : 'diff.inline')}
            </button>
          );
        })}
        {/* ⊟ / ⊞ — one control, two directions, like the pop-out below it. Absent
            with nothing to fold, because a control that does nothing is the thing
            this epic keeps refusing to draw. */}
        {plan.files.length > 0 && (
          <button
            type="button"
            className="diff-btn"
            data-testid="all-changes-fold"
            title={plan.allCollapsed ? t('allChanges.expandAll') : t('allChanges.collapseAll')}
            aria-label={plan.allCollapsed ? t('allChanges.expandAll') : t('allChanges.collapseAll')}
            onClick={() => setAll(!plan.allCollapsed)}
          >
            {plan.allCollapsed ? t('allChanges.expandAllIcon') : t('allChanges.collapseAllIcon')}
          </button>
        )}
        <button
          type="button"
          className="diff-btn"
          data-testid="all-changes-popout"
          title={props.poppedOut ? t('diff.dockBack') : t('diff.popOut')}
          aria-label={props.poppedOut ? t('diff.dockBack') : t('diff.popOut')}
          onClick={props.onPopoutToggle}
        >
          {props.poppedOut ? t('document.icon.dockBack') : t('document.icon.popOut')}
        </button>
      </div>

      <div
        className="all-changes-body"
        style={{ flex: 1, minBlockSize: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {/* The same four states the sidebar and the History tab draw, in the same
            order and from the same one decision in `lib/git-status` — an unreadable
            repository must never read as a clean one. */}
        {paneState === null && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('diff.loading')}</div>
        )}
        {paneState?.kind === 'unreadable' && (
          <div style={{ padding: 10, color: 'var(--status-needs-input-ink)', fontSize: 11 }}>
            {t('diff.unreadable', { reason: paneState.reason })}
          </div>
        )}
        {paneState?.kind === 'not-repo' && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('diff.notRepo')}</div>
        )}
        {paneState?.kind === 'clean' && (
          <div style={{ padding: 10, color: 'var(--muted)', fontSize: 11 }}>{t('diff.clean')}</div>
        )}
        {/* ⚠️ A STACK OF NOTHING BUT CLOSED HEADERS LOOKS BROKEN, so it says why
            once, at the top. Reachable with a single file bigger than the whole
            budget, which is an ordinary generated-file commit. */}
        {paneState?.kind === 'files' && plan.allCollapsed && (
          <div
            className="all-changes-all-folded"
            style={{ padding: '6px 8px', color: 'var(--muted)', fontSize: 10.5 }}
          >
            {t('allChanges.allFolded', { count: plan.files.length })}
          </div>
        )}
        {paneState?.kind === 'files' &&
          plan.files.map((f) => (
            <FileBlock
              key={f.key}
              file={f}
              folder={props.folder}
              cardId={props.cardId}
              colorScheme={props.colorScheme}
              onToggle={() => toggle(f.key)}
              onLayout={setBody}
            />
          ))}
      </div>
    </div>
  );
}

/** One file in the stack: a sticky header, and its diff if it is open. */
function FileBlock(props: {
  file: StackedFile;
  folder: string;
  cardId?: string;
  colorScheme: 'light' | 'dark';
  onToggle: () => void;
  onLayout: (s: DiffLayoutState) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const f = props.file;
  const row = f.row;
  const statusWord = t(`scm.letter.${letterKey(row.letter)}`);
  return (
    <div className="all-changes-file" data-path={row.path} data-group={row.group}>
      {/* STICKY, which is screen 5's own word for it: scrolling through a long
          diff must never leave you unable to see which file you are in. */}
      <div
        className="all-changes-head"
        style={{
          position: 'sticky',
          insetBlockStart: 0,
          zIndex: 1,
          display: 'flex',
          gap: 5,
          alignItems: 'center',
          background: 'var(--card-bg)',
          borderBlockEnd: '1px solid var(--border)',
          padding: '3px 6px',
          minInlineSize: 0,
        }}
      >
        <button
          type="button"
          className="all-changes-toggle"
          aria-expanded={!f.collapsed}
          aria-label={t('allChanges.fileLabel', { name: row.name, status: statusWord })}
          onClick={props.onToggle}
          style={{
            flex: 1,
            minInlineSize: 0,
            display: 'flex',
            gap: 5,
            alignItems: 'baseline',
            background: 'transparent',
            border: 'none',
            color: 'var(--text)',
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
            textAlign: 'left',
          }}
        >
          <span aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
            {f.collapsed ? t('scm.caretClosed') : t('scm.caretOpen')}
          </span>
          <span
            className={`scm-letter scm-letter-${letterKey(row.letter)}`}
            aria-hidden="true"
            style={{
              flexShrink: 0,
              inlineSize: 10,
              textAlign: 'center',
              color: LETTER_INKS[row.letter] ?? LETTER_INKS.M,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: 10,
            }}
          >
            {row.letter}
          </span>
          {/* Name first, directory after and dimmed — design §1.2 cause 2, the
              same rule the sidebar row follows and for the same reason. */}
          <span className="all-changes-name" style={{ flexShrink: 0, fontWeight: 600 }}>
            {row.name}
          </span>
          {row.dir !== '' && (
            <span
              className="all-changes-dir"
              style={{
                flex: 1,
                minInlineSize: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                direction: 'rtl',
                textAlign: 'left',
                color: 'var(--muted)',
                fontSize: 10,
              }}
            >
              {t('diff.pathIsolated', { path: row.dir })}
            </span>
          )}
        </button>
        <span
          className="all-changes-stat"
          style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5 }}
        >
          {/* Absent is not zero, once more: an untracked or binary file draws its
              word, never a pair of noughts. */}
          {row.stat?.binary ? (
            <span style={{ color: 'var(--muted)' }}>{t('scm.binary')}</span>
          ) : row.stat ? (
            <>
              {/* `n`, not `count` — `scm.plus` is a plain `+{n}` and not a
                  plural, so a `count` placeholder leaves the template on screen
                  verbatim. Exactly how a test caught this. */}
              <span style={{ color: 'var(--diff-added)' }}>
                {t('scm.plus', { n: row.stat.insertions })}
              </span>{' '}
              <span style={{ color: 'var(--diff-removed)' }}>
                {t('scm.minus', { n: row.stat.deletions })}
              </span>
            </>
          ) : null}
        </span>
        {/* ⧉ — this one file in its own panel. The `gitdiff-` family from item 5,
            reached through the same seam the sidebar uses, so there is one route
            to a single-file diff rather than two. */}
        <button
          type="button"
          className="diff-btn"
          data-testid="all-changes-file-popout"
          title={t('diff.openInPanel', { file: row.path })}
          aria-label={t('diff.openInPanel', { file: row.path })}
          onClick={() =>
            openDiff({
              folder: props.folder,
              path: row.path,
              left: WORKING_TREE_LEFT,
              right: WORKING_TREE_RIGHT,
              attributionCardId: props.cardId,
            })
          }
        >
          {t('diff.openInPanelIcon')}
        </button>
      </div>
      {f.collapsed ? (
        <button
          type="button"
          className="all-changes-folded"
          onClick={props.onToggle}
          style={{
            inlineSize: '100%',
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: '5px 8px 7px 24px',
            fontSize: 10,
            textAlign: 'left',
          }}
        >
          {/* ⚠️ **IT SAYS WHY IT IS CLOSED, and the three reasons are three
              different sentences.** "This file is enormous" and "the panel ran out
              above you" are not the same fact about the user's project, and a
              single "collapsed" would make the budget look arbitrary. A file the
              USER folded gets no explanation, because none is owed. */}
          {f.reason === 'huge'
            ? t('allChanges.foldedHuge', { count: f.lines ?? 0 })
            : f.reason === 'budget'
              ? t('allChanges.foldedBudget')
              : f.reason === 'count'
                ? t('allChanges.foldedCount')
                : t('allChanges.foldedByYou')}
        </button>
      ) : (
        <div style={{ blockSize: editorHeightPx(f.lines), display: 'flex', minInlineSize: 0 }}>
          {/* ⚠️ **NO `cardId` AND NO `findSlot`, DELIBERATELY, AND IT IS NOT AN
              OVERSIGHT.** `MonacoDiff` publishes itself as a card's find surface
              under one slot key; N editors in one panel sharing a key means the
              last to mount silently wins and `Ctrl+F` reaches a file the user is
              not looking at. Item 5 already records that find is inert in these
              panels at all (the provider only knows `session-` and `doc-` ids), so
              publishing nothing here costs nothing today and avoids shipping a
              collision that would surface the day the provider lands.
              `placeKey` is per file, so each editor remembers its own place. */}
          <MonacoDiff
            source={{ kind: 'working-tree', folder: props.folder, path: row.path }}
            colorScheme={props.colorScheme}
            placeKey={`allchanges:${props.folder}:${f.key}`}
            onLayout={props.onLayout}
          />
        </div>
      )}
    </div>
  );
}
