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
import { diffNavKey, type DiffNavState } from '../lib/diff-nav';
import { WORKING_TREE_RIGHT, type DiffTarget } from '../lib/diff-panels';
import { foldedGroups } from '../lib/diff-toolbar-fit';
import {
  DIFF_VIEW_TOGGLES,
  getDiffViewToggle,
  subscribeDiffViewPrefs,
  toggleDiffViewToggle,
  type DiffViewToggle,
} from '../lib/diff-view-prefs';
import { canOpenDocuments, joinFolderPath, openDocument } from '../lib/document-open';
import { requestDocumentLine } from '../lib/document-reveal';
import { MonacoDiff, type DiffLayoutState, type MonacoDiffControl } from './MonacoDiff';
import { RailGroupMenu, type RailGroupMenuItem } from './RailGroupMenu';

/**
 * The least the path is squeezed to before a toolbar group folds into "…"
 * instead (#1384) — about eight characters of the tail, which is usually the
 * filename. Below that the path is no longer telling anyone anything.
 */
const PATH_MIN_PX = 60;
/** "…" before it has ever been on screen to measure (one glyph and padding). */
const MORE_FALLBACK_PX = 26;

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
   * FIND REACHES THIS PANEL SINCE #1054. The surface is published under its
   * own slot (see `MonacoDiff.findSlot`), `find-gitdiff` reads it, and
   * `GridController.activeDiffPanelId()` is how `Ctrl+F` learns the panel has
   * the user's attention. The slot separation is what stops two diffs of one
   * card overwriting each other, which that item would otherwise have shipped.
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

  // --- the view toggles (#1384) ---------------------------------------------
  // Workspace-wide, remembered, and read the way the layout pair is: one store,
  // every mounted panel (popped-out ones included) updates together.
  const ignoreWhitespace = React.useSyncExternalStore(subscribeDiffViewPrefs, () =>
    getDiffViewToggle('ignoreWhitespace')
  );
  const collapseUnchanged = React.useSyncExternalStore(subscribeDiffViewPrefs, () =>
    getDiffViewToggle('collapseUnchanged')
  );
  const wordWrap = React.useSyncExternalStore(subscribeDiffViewPrefs, () => getDiffViewToggle('wordWrap'));
  const toggles: Record<DiffViewToggle, boolean> = { ignoreWhitespace, collapseUnchanged, wordWrap };
  const toggleLabel: Record<DiffViewToggle, string> = {
    ignoreWhitespace: t('diff.ignoreWhitespace'),
    collapseUnchanged: t('diff.collapseUnchanged'),
    wordWrap: t('diff.wordWrap'),
  };
  const toggleHint: Record<DiffViewToggle, string> = {
    ignoreWhitespace: t('diff.ignoreWhitespaceHint'),
    collapseUnchanged: t('diff.collapseUnchangedHint'),
    wordWrap: t('diff.wordWrapHint'),
  };

  // --- ↑ / ↓ and the counter (#1384) ----------------------------------------
  const [nav, setNav] = React.useState<DiffNavState>({ kind: 'pending' });
  const control = React.useRef<MonacoDiffControl | null>(null);
  const canMove = nav.kind === 'changes';
  const counter =
    nav.kind === 'pending'
      ? t('diff.navPending')
      : nav.kind === 'none'
        ? t('diff.navNone')
        : nav.index === null
          ? t('diff.navTotal', { total: nav.total })
          : t('diff.navCount', { index: nav.index, total: nav.total });

  /**
   * Alt+F5 / Shift+Alt+F5, VS Code's chord.
   *
   * WHEN IT FIRES: focus is inside this panel (the editor, a toolbar button) —
   * or nothing has focus (`<body>`) and the last click in this window was on
   * this panel. The second case is not a nicety: a click on the path or on the
   * diff's background leaves focus on `<body>`, where a listener on the panel
   * itself never hears the key (found by the e2e). The "last click" is per
   * panel, so of two diff panels only the one clicked last answers.
   *
   * ⚠️ **ON THE PANEL'S OWN DOCUMENT, RE-RESOLVED, NOT THE MAIN ONE.** A
   * popped-out diff is a second DOCUMENT in the same renderer, and a listener on
   * the main one never hears a key pressed in it. Dockview MOVES this element
   * into the popout, so `ownerDocument` changes under a mounted component; the
   * listeners therefore follow the element — re-attached on the first pointer
   * or focus inside it in whatever document it now lives in. CAPTURE phase, so
   * the chord reaches us before Monaco's own key handling, and is then stopped:
   * it is ours, not a key for the editor.
   */
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let doc: Document | null = null;
    /** the last pointerdown in `doc` landed inside this panel */
    let armed = false;
    const onKey = (e: KeyboardEvent): void => {
      const direction = diffNavKey(e);
      if (!direction || !control.current || !root.isConnected) return;
      // A listener left on the document the panel USED to live in (found in
      // review): between a pop-out and the first touch inside the new window,
      // the main window's listener is still attached — and judging the popout's
      // focus from a key pressed in the main window would move the wrong diff
      // and swallow the key. Re-home instead, unarmed.
      if (e.currentTarget !== root.ownerDocument) {
        attach();
        armed = false;
        return;
      }
      const active = root.ownerDocument.activeElement;
      // Inside the panel — or on an ANCESTOR of it, which is where a click on
      // the path or the diff's margin actually leaves focus: dockview's
      // `.dv-content-container` is focusable (found by the e2e, after the first
      // cut listened on the panel and heard nothing).
      const nothingFocused =
        !active || active === root.ownerDocument.body || active === root.ownerDocument.documentElement;
      // (`<body>` contains every panel, so it is the "last click" case below,
      // never an ancestor that picks this one)
      const inside =
        root.contains(e.target as Node | null) || (!nothingFocused && !!active && active.contains(root));
      if (!inside && !(armed && nothingFocused)) return;
      e.preventDefault();
      // IMMEDIATE: two diff panels in one window both listen on its document,
      // and the first to claim the key is the only one that should act on it
      e.stopImmediatePropagation();
      control.current.go(direction);
    };
    const onDocPointer = (e: PointerEvent): void => {
      armed = root.contains(e.target as Node | null);
    };
    const detach = (): void => {
      doc?.removeEventListener('keydown', onKey, true);
      doc?.removeEventListener('pointerdown', onDocPointer, true);
      doc = null;
    };
    const attach = (): void => {
      if (doc === root.ownerDocument) return;
      detach();
      doc = root.ownerDocument;
      doc.addEventListener('keydown', onKey, true);
      doc.addEventListener('pointerdown', onDocPointer, true);
    };
    // The document's capture listener runs BEFORE this one, so on the first
    // press in a new document it was not yet there to arm — arm here too.
    const onRootPointer = (): void => {
      attach();
      armed = true;
    };
    root.addEventListener('pointerdown', onRootPointer, true);
    root.addEventListener('focusin', attach);
    attach();
    return () => {
      root.removeEventListener('pointerdown', onRootPointer, true);
      root.removeEventListener('focusin', attach);
      detach();
    };
  }, []);

  // --- Open file (#1384) -----------------------------------------------------
  // ABSENT, not disabled, where it can never work: a commit diff (the working
  // file's line numbers are not the ones on screen), the all-changes range (no
  // one file), or a build with nowhere to open a document.
  const path = props.target.path;
  const openable = props.target.right === WORKING_TREE_RIGHT && !!path && canOpenDocuments();
  const openFile = (): void => {
    if (!path) return;
    const file = joinFolderPath(props.target.folder, path);
    const line = control.current?.lineInView();
    if (line) requestDocumentLine(file, line);
    openDocument(file, props.target.attributionCardId);
  };

  // --- folding into "…" before anything wraps (#1384) -----------------------
  // See `lib/diff-toolbar-fit` for the rule. The component only MEASURES: each
  // group's width is remembered from the last time it was on screen, because a
  // folded group cannot be measured and the planner needs to know whether
  // unfolding it would fit.
  const barRef = React.useRef<HTMLDivElement | null>(null);
  const navRef = React.useRef<HTMLSpanElement | null>(null);
  const extrasRef = React.useRef<HTMLSpanElement | null>(null);
  const layoutRef = React.useRef<HTMLSpanElement | null>(null);
  const popRef = React.useRef<HTMLButtonElement | null>(null);
  const moreRef = React.useRef<HTMLButtonElement | null>(null);
  const widths = React.useRef({ extras: 0, layout: 0, more: 0 });
  const [folded, setFolded] = React.useState(0);
  const measure = React.useCallback((): void => {
    const bar = barRef.current;
    const view = bar?.ownerDocument.defaultView;
    if (!bar || !view) return;
    const cs = view.getComputedStyle(bar);
    const px = (v: string): number => Number.parseFloat(v) || 0;
    const w = (el: HTMLElement | null): number => (el ? el.getBoundingClientRect().width : 0);
    if (extrasRef.current) widths.current.extras = w(extrasRef.current);
    if (layoutRef.current) widths.current.layout = w(layoutRef.current);
    if (moreRef.current) widths.current.more = w(moreRef.current);
    const next = foldedGroups({
      room: bar.clientWidth - px(cs.paddingInlineStart) - px(cs.paddingInlineEnd),
      fixed: w(navRef.current) + w(popRef.current),
      fixedCount: 2,
      groups: [widths.current.extras, widths.current.layout],
      more: widths.current.more || MORE_FALLBACK_PX,
      gap: px(cs.columnGap),
      pathMin: PATH_MIN_PX,
    });
    if (next !== null) setFolded(next);
  }, []);
  // Every render: the counter's text, the narrow note and a toggle's state all
  // change widths without changing the toolbar's box, so a ResizeObserver alone
  // would miss them. Cheap — six rects — and `setFolded` bails on an equal value.
  React.useLayoutEffect(() => {
    measure();
  });
  React.useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    return () => ro.disconnect();
  }, [measure]);

  const [menuAt, setMenuAt] = React.useState<{ x: number; y: number } | null>(null);
  const closeMenu = React.useCallback((restoreFocus: boolean): void => {
    setMenuAt(null);
    if (restoreFocus) moreRef.current?.focus();
  }, []);
  // Folding while the menu is open would leave it listing the wrong things.
  React.useEffect(() => {
    if (folded === 0) setMenuAt(null);
  }, [folded]);

  const menuItems: RailGroupMenuItem[] = [];
  if (folded >= 1) {
    for (const which of DIFF_VIEW_TOGGLES) {
      menuItems.push({
        id: which,
        label: toggleLabel[which],
        can: true,
        checked: toggles[which],
        toggle: true,
        // the menu hands focus placement to its caller; back to "…", or a
        // keyboard user who pressed Enter here is left on <body> (review)
        run: () => {
          toggleDiffViewToggle(which);
          moreRef.current?.focus();
        },
      });
    }
    if (openable) {
      menuItems.push({ id: 'open-file', label: t('diff.openFile'), can: true, divider: true, run: openFile });
    }
  }
  if (folded >= 2) {
    (['side-by-side', 'inline'] as const).forEach((mode: DiffLayout, i) => {
      menuItems.push({
        id: `layout-${mode}`,
        label: t(mode === 'side-by-side' ? 'diff.sideBySide' : 'diff.inline'),
        can: true,
        checked: props.layoutPref === mode,
        // the too-narrow note travels with the pair it explains
        ...(i === 0 && body.narrowed ? { heading: t('diff.tooNarrowNote') } : {}),
        ...(i === 0 && !body.narrowed ? { divider: true } : {}),
        run: () => {
          setDiffLayout(mode);
          moreRef.current?.focus();
        },
      });
    });
  }

  return (
    <div
      ref={rootRef}
      className="git-diff-view"
      style={{
        blockSize: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card-bg)',
        minInlineSize: 0,
      }}
    >
      <div ref={barRef} className="diff-toolbar" role="group" aria-label={t('diff.layoutLabel')}>
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
        {/* ↑ / ↓ and the counter. Never folded — moving between changes is what
            this toolbar is for. The counter is a live region so a screen reader
            hears "3 of 7" after each move. */}
        <span ref={navRef} className="diff-group" role="group" aria-label={t('diff.navLabel')}>
          <button
            type="button"
            className="diff-btn"
            data-testid="git-diff-prev"
            aria-keyshortcuts="Shift+Alt+F5"
            title={t('diff.prevChange')}
            aria-label={t('diff.prevChange')}
            disabled={!canMove}
            onClick={() => control.current?.go('previous')}
          >
            {t('diff.prevChangeIcon')}
          </button>
          <button
            type="button"
            className="diff-btn"
            data-testid="git-diff-next"
            aria-keyshortcuts="Alt+F5"
            title={t('diff.nextChange')}
            aria-label={t('diff.nextChange')}
            disabled={!canMove}
            onClick={() => control.current?.go('next')}
          >
            {t('diff.nextChangeIcon')}
          </button>
          <span className="diff-counter" data-testid="git-diff-counter" aria-live="polite">
            {counter}
          </span>
        </span>
        {folded < 1 && (
          <span ref={extrasRef} className="diff-group" role="group" aria-label={t('diff.viewLabel')}>
            {DIFF_VIEW_TOGGLES.map((which) => (
              <button
                key={which}
                type="button"
                className="diff-btn"
                data-testid={`git-diff-toggle-${which}`}
                aria-pressed={toggles[which]}
                title={toggleHint[which]}
                onClick={() => toggleDiffViewToggle(which)}
              >
                {toggleLabel[which]}
              </button>
            ))}
            {openable && (
              <button
                type="button"
                className="diff-btn"
                data-testid="git-diff-open-file"
                title={t('diff.openFileHint')}
                aria-label={t('diff.openFileHint')}
                onClick={openFile}
              >
                {t('diff.openFileIcon')}
              </button>
            )}
          </span>
        )}
        {folded < 2 && (
          <span ref={layoutRef} className="diff-group">
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
          </span>
        )}
        {folded > 0 && (
          <button
            ref={moreRef}
            type="button"
            className="diff-btn"
            data-testid="git-diff-more"
            title={t('diff.more')}
            aria-label={t('diff.more')}
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            // the menu closes itself on any pointerdown in its window; without
            // this the press that opened it would be the press that shut it
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              if (menuAt) return closeMenu(false);
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: r.left, y: r.bottom });
            }}
          >
            {t('diff.moreIcon')}
          </button>
        )}
        {/* ⧉ / ⇤ — ONE CONTROL WITH TWO LABELS, which is what the document
            viewer's header does and for the same reason: "pop out" and "dock
            back" are the same gesture in two directions, and two buttons would
            mean one of them is always dead. Design §3 asks for both, plus a
            way from the tab's context menu: that is our own "Pop out to a new
            window" (#1281) — dockview's native tab menu is not registered. */}
        <button
          ref={popRef}
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
      {menuAt && menuItems.length > 0 && (
        <RailGroupMenu
          x={menuAt.x}
          y={menuAt.y}
          label={t('diff.more')}
          items={menuItems}
          onClose={closeMenu}
          testId="git-diff-menu"
        />
      )}
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
          viewOptions={toggles}
          onNav={setNav}
          controlRef={control}
        />
      </div>
    </div>
  );
}
