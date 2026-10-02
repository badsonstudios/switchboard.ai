// A diff, in a dock panel of its own (E24 Git v2 item 5, §5.7) — screens 3 & 4.
//
// ⚠️ **NOT CALLED `DiffPanel`, AND THE NAME IT DOES NOT HAVE IS THE INTERESTING
// PART.** `SessionGrid` already has a local `DiffPanel`: the dockview wrapper for
// #504's "the whole Changes tab, relocated into the document area" panel
// (`diff-<cardId>`). Two things called DiffPanel, one being a session's tab moved
// and the other being one comparison, is how a future reader edits the wrong
// file — so this is `GitDiffView`, matching the `gitdiff-` prefix its panels wear.
// See `DIFF_PANEL_PREFIX` for the same collision in the id space, which cost more.
//
// ⚠️ **THIS IS THE STRUCTURAL ITEM, AND THE WHOLE OF IT IS THAT THE DIFF LEFT THE
// TAB.** Design record §1.2, cause 3 of the owner's *"everything's kind of just
// smashed together"*: card tabs are mutually exclusive, so reading a diff costs
// you sight of the conversation that produced it — and the pane then self-reports
// `tooNarrow` and silently drops to inline, which is #532's whole story. A diff in
// the document area can sit beside the Session view; a diff in its own OS window
// can sit on another monitor.
//
// It costs almost nothing because the pattern was already proved. This component
// is `DocumentViewer`'s shape with one body instead of four, and the pop-out it
// offers is dockview's own popout group — `popout-bounds.ts`,
// `popout-geometry.ts`, `app:popoutGeometryChanged` and the window-state
// persistence are all built and shipped.
//
// What is NOT here: the file list. A `gitdiff-` panel is of ONE comparison, named at
// `addPanel` and fixed for the panel's life, for the reason `document-panels`
// records about `doc-` — a surface that silently re-points what you were reading
// costs more than the tab it saves.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { setDiffLayout, type DiffLayout } from '../lib/diff-layout';
import { WORKING_TREE_RIGHT, type DiffTarget } from '../lib/diff-panels';
import { MonacoDiff, type DiffLayoutState } from './MonacoDiff';

/** The basename, which is what a tab is wide enough to show. */
export function diffPanelTitle(target: DiffTarget): string {
  if (!target.path) return target.left === target.right ? target.left : `${target.left}..${target.right}`;
  const base = target.path.split('/').pop() ?? target.path;
  // A working-tree diff is "the file"; a commit diff needs to say WHICH commit,
  // or two tabs on one file are indistinguishable in the strip.
  return target.right === WORKING_TREE_RIGHT ? base : `${base} @ ${target.right.slice(0, 8)}`;
}

export function GitDiffView(props: {
  target: DiffTarget;
  colorScheme: 'light' | 'dark';
  /** is this panel in its own OS window right now? */
  poppedOut: boolean;
  /** pop out, or dock back — dockview's own popout group, via the grid */
  onPopoutToggle: () => void;
  /**
   * This panel's own dockview id — the `cardId` role for the find registry and
   * the key the scroll position is remembered under.
   *
   * ⚠️ **FIND IS NOT REACHABLE IN THIS PANEL YET, and saying so is the point.**
   * The surface is published under its own slot (see `MonacoDiff.findSlot`) and
   * no provider reads it, because `Ctrl+F`'s route goes through `activeCardId` /
   * `activeDocumentId`, which know only `session-` and `doc-` panels. The slot
   * separation is still right — it is what stops two diffs of one card
   * overwriting each other the day the provider lands — but the earlier version
   * of this comment described a collision that cannot currently happen, which is
   * the kind of sentence this whole epic exists to stop writing.
   */
  panelId: string;
  /** the layout preference, read by the host so the toggle is a controlled pair */
  layoutPref: DiffLayout;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [body, setBody] = React.useState<DiffLayoutState>({
    layout: 'side-by-side',
    narrowed: false,
  });

  return (
    <div
      className="git-diff-view"
      style={{
        blockSize: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card-bg)',
        minInlineSize: 0,
      }}
    >
      <div className="diff-toolbar" role="group" aria-label={t('diff.layoutLabel')}>
        {/* The path, because a tab shows only the basename and two files called
            `index.ts` are the commonest thing in a project. Truncated at the
            FRONT — design §1.2 cause 2 is the Changes tab cutting off the
            identifying end of a path, and the identifying end is the tail. */}
        <span
          className="git-diff-path"
          title={props.target.path ?? undefined}
          style={{
            // ⚠️ `flex: 1 1 auto`, NOT `flex: 1` (found in review). `flex: 1` is
            // basis ZERO, so the path takes none of the negative free space: in a
            // narrow panel it collapsed to nothing and the BUTTONS wrapped their
            // labels instead — so the identifying path, which is the only thing
            // this panel adds over the tab title, was the first casualty, and the
            // ellipsis machinery below never fired at all. `.diff-btn` gained a
            // matching `flex-shrink: 0` in `tokens.css` — both halves, because
            // either one alone leaves the other free to take the squeeze.
            flex: '1 1 auto',
            minInlineSize: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
          }}
        >
          {/* `direction: rtl` is what moves the ellipsis to the FRONT. The path
              goes through the catalog — `react/jsx-no-literals` is on, and the
              **bidi isolate** the template adds is not decoration: without it an
              RTL container reorders the path's own `/` and `.`, so a reader would
              be shown a path that is not the one on disk. */}
          {t('diff.pathIsolated', { path: props.target.path ?? t('diff.allChanges') })}
        </span>
        {/* VISIBLE, not just a tooltip: Chromium never shows `title` on keyboard
            focus, so a sighted keyboard user would have had no way at all to
            learn why the pressed button is not what is on screen. */}
        {body.narrowed && <span className="diff-narrow-note">{t('diff.tooNarrowNote')}</span>}
        {(['side-by-side', 'inline'] as const).map((mode: DiffLayout) => {
          const reason = mode === 'side-by-side' && body.narrowed ? t('diff.tooNarrow') : undefined;
          return (
            <button
              key={mode}
              type="button"
              className="diff-btn"
              data-testid={`git-diff-layout-${mode}`}
              aria-pressed={props.layoutPref === mode}
              aria-label={reason}
              title={reason}
              onClick={() => setDiffLayout(mode)}
            >
              {t(mode === 'side-by-side' ? 'diff.sideBySide' : 'diff.inline')}
            </button>
          );
        })}
        {/* ⧉ / ⇤ — ONE CONTROL WITH TWO LABELS, which is what the document
            viewer's header does and for the same reason: "pop out" and "dock
            back" are the same gesture in two directions, and two buttons would
            mean one of them is always dead. Design §3 asks for both, plus
            dockview's native "Move to New Window" from the tab's context menu,
            which keeps working without us. */}
        <button
          type="button"
          className="diff-btn"
          data-testid="git-diff-popout"
          title={props.poppedOut ? t('diff.dockBack') : t('diff.popOut')}
          aria-label={props.poppedOut ? t('diff.dockBack') : t('diff.popOut')}
          onClick={props.onPopoutToggle}
        >
          {props.poppedOut ? t('document.icon.dockBack') : t('document.icon.popOut')}
        </button>
      </div>
      <div style={{ flex: 1, minBlockSize: 0, display: 'flex' }}>
        {/* ⚠️ **THE COMMIT CASE USED TO SAY "coming" HERE, AND ITEM 4 IS WHAT
            ANSWERED IT.** Until `fileVersionsAt` existed the only loader was
            `git:fileVersions` — HEAD versus disk — so a commit target handed over
            as `working-tree` would have drawn the working-tree diff under a tab
            reading `file @ abc1234`. The union's `kind` is what made adding the
            second loader a type error at every caller rather than a wrong picture
            on screen. Item 9's all-changes range is the third. */}
        <MonacoDiff
          source={
            props.target.right === WORKING_TREE_RIGHT
              ? { kind: 'working-tree', folder: props.target.folder, path: props.target.path ?? null }
              : {
                  kind: 'commit',
                  folder: props.target.folder,
                  path: props.target.path ?? null,
                  left: props.target.left,
                  right: props.target.right,
                }
          }
          colorScheme={props.colorScheme}
          // ⚠️ THE PANEL'S OWN ID in the card-id role, which is exactly what a
          // `doc-` panel does for the find bar (#533). A `gitdiff-` panel has no
          // card, and `Ctrl+F` has to reach the editor the user is looking at.
          cardId={props.panelId}
          findSlot="gitdiff"
          // The scroll position is remembered per PANEL, not per card: two
          // panels on two comparisons are two places, and the Changes tab's
          // place is a third that must not be overwritten by either.
          placeKey={props.panelId}
          onLayout={setBody}
        />
      </div>
    </div>
  );
}
