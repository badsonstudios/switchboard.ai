// The Monaco diff body, as a component of its own (E24 Git v2 item 5, §5.7).
//
// ⚠️ **THIS IS A MOVE, NOT A REWRITE, AND THAT IS THE POINT.** Design record §3
// says a diff becomes a dock panel, and lists what must NOT change on the way:
// *"`DiffPane`'s Monaco wiring, the find-surface publication (§5.31),
// `diff-places` scroll memory, the theme handling or the narrow-pane verdict. All
// of it moves into the panel body intact."* Every effect below came out of
// `DiffPane` unchanged, comments and all, because each of those comments records
// a bug that was paid for once already — the editor rebuilt on a theme change and
// blanked the pane, the hidden tab measuring 0×0 and flipping the narrow verdict,
// the stamp that filed the old file's line under the new file's name. A
// re-implementation would have had to rediscover them.
//
// Two surfaces host this now: the Changes tab's in-place preview (`DiffPane`) and
// the `gitdiff-` dock panel (`GitDiffView`). Neither knows what Monaco is.
//
// #191 — the monaco entry point is `edcore.main`, the core editor with NO
// languages, and the tokenizers are put back one by one by `monaco-languages`.
// The bare `monaco-editor` entry would also register the rich TS/JSON/CSS/HTML
// language services, which demand their own web workers and throw uncaught
// against the single plain worker below. The full reasoning, and the numbers,
// are in `lib/monaco-languages.ts` — read that before changing this import.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import '../lib/monaco-languages';
// The single worker, assigned on import. See `lib/monaco-worker.ts` for why it is
// a side effect and not an `install()` anyone could forget to call.
import '../lib/monaco-worker';
import { answered } from '../../../shared/ipc/refusal';
import { languageForPath } from '../lib/diff-language';
import {
  effectiveDiffLayout,
  getDiffLayout,
  isTooNarrowForColumns,
  subscribeDiffLayout,
  type DiffLayout,
} from '../lib/diff-layout';
import { defineDiffThemes, DIFF_THEME } from '../lib/monaco-theme';
import { findSurfaceKey, publishFindSurface, type MonacoFindSurface } from '../lib/find-surfaces';
import { openMonacoFind } from '../lib/monaco-find';
import { rememberDiffPlace, readDiffPlace } from '../lib/diff-places';

/**
 * Where the two sides come from.
 *
 * ⚠️ **ONE SHAPE TODAY, AND IT IS THE ONLY ONE ANYTHING MAY ASK FOR.** Design §3
 * names three kinds of diff panel — working tree vs index/HEAD, all changes
 * stacked, one file at a commit — and only the first has a loader
 * (`git:fileVersions`). This type is the joint: a second variant becomes a second
 * branch in the load effect below rather than a second copy of this file. The
 * others arrive with items 4, 9 and 10.
 *
 * It is a DISCRIMINATED union, and that is what made adding the second member a
 * type error at every caller rather than a wrong answer on screen. The first
 * draft of item 5 hardcoded `kind: 'working-tree'` whatever its target said, so a
 * commit target would have shown the working-tree diff under a tab labelled
 * `file @ abc1234` (review). The `commit` member arrived with item 4, and the
 * all-changes range is item 9's.
 */
export type DiffSource =
  | {
      kind: 'working-tree';
      folder: string;
      /** git's forward-slash relative path; `null` means nothing is selected yet */
      path: string | null;
    }
  | {
      /** one file at two revisions (E24 Git v2 item 4) */
      kind: 'commit';
      folder: string;
      path: string | null;
      /** the "before" revision — already the empty tree for a root commit */
      left: string;
      /** the "after" revision */
      right: string;
    };

/** What the host needs to know to label its own toggle. */
export interface DiffLayoutState {
  /** what is actually drawn */
  layout: DiffLayout;
  /**
   * The preference is side-by-side and the pane cannot carry it.
   *
   * The toggle has to SAY so, or it reads as a button that does nothing (#532).
   */
  narrowed: boolean;
}

export function MonacoDiff(props: {
  source: DiffSource;
  /** Monaco has exactly two skins, so this takes the RESOLVED answer rather than
   *  a theme id it would have to guess a light/dark verdict from. */
  colorScheme: 'light' | 'dark';
  /**
   * The card this editor belongs to, for `Ctrl+F` (P2-E17-02, §5.31).
   *
   * Absent on a surface with no durable card id: no registration, and the find
   * bar greys with a reason rather than handing off into nothing.
   */
  cardId?: string;
  /**
   * Which find slot to publish under — `'diff'` for the Changes tab, something
   * else for a dock panel, so two diffs of one card do not overwrite each other.
   *
   * The panel's slot (`'gitdiff'`) is read by `find-gitdiff` since #1054; until
   * then it was published and inert, because `Ctrl+F`'s route only knew
   * `session-` and `doc-` panels. The slot separation is the part that mattered
   * all along: two diffs of one card sharing a key would mean the second to
   * mount silently overwrites the first, and `Ctrl+F` would reach whichever
   * editor registered last rather than the one on screen.
   */
  findSlot?: string;
  /**
   * The key the scroll position is remembered under (#562), or `undefined` not to
   * remember at all.
   *
   * Separate from `cardId` because the two answer different questions: a dock
   * panel has a place to remember and no card to find within.
   */
  placeKey?: string;
  /** told whenever the drawn layout or the narrow verdict changes */
  onLayout?: (state: DiffLayoutState) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  // Workspace-wide, not per-card (#532): "how I read a diff" is a habit, not a
  // property of one session, and the palette command has no card in hand.
  const layoutPref = useSyncExternalStore(subscribeDiffLayout, getDiffLayout);
  // The VERDICT, not the pixel count: a splitter drag then re-renders only when
  // the answer flips, rather than on every frame. See `isTooNarrowForColumns`.
  const [tooNarrow, setTooNarrow] = useState(false);
  const layout = effectiveDiffLayout(layoutPref, tooNarrow);
  const narrowed = layoutPref === 'side-by-side' && layout === 'inline';
  const selected = props.source.path;
  const folder = props.source.folder;
  const placeKey = props.placeKey;
  const source = props.source;
  // The two revisions, as primitives, so the load effect's deps are values rather
  // than an object identity that changes on every parent render.
  const left = source.kind === 'commit' ? source.left : null;
  const right = source.kind === 'commit' ? source.right : null;

  /**
   * The LINE to put back once the model is in (#562).
   *
   * A ref, and consumed once: the restore has to happen AFTER `setModel` — which
   * is inside an async `then` — and it must not fire again on every later
   * selection, or picking a fresh file would drop the reader somewhere in the
   * middle of it instead of at the top.
   */
  const pendingLine = useRef<number | null>(readDiffPlace(placeKey)?.line ?? null);
  /**
   * ⚠️ **AND THE RECORD IS RE-READ, BECAUSE A `useRef` INITIALISER RUNS ONCE AND
   * THE RECORD CAN GO AWAY AFTER IT (found in review).** `DiffPane` clears a
   * remembered file that is no longer a change — committed, discarded, deleted —
   * with `forgetDiffPlace`, and before the extraction it cleared
   * `pendingLine.current` in the same breath. The ref now lives in here, where
   * that call cannot reach it, and the race is live:
   *
   *  1. mount with a stale remembered file seeds `pendingLine = 120`;
   *  2. `git.status` lands, the file is gone, `setSelected(null)` — and the load
   *     effect's cleanup sets `cancelled`, so the `.then` returns WITHOUT
   *     consuming the ref;
   *  3. the user picks a different file, and line 120 of that one is restored.
   *
   * Which is precisely what the docblock above says must not happen. Child
   * effects run before parent effects, so the ordering also flipped in a way that
   * makes step 2 likelier than it was. So: the ref is forgotten the moment the
   * record it came from is.
   */
  useEffect(() => {
    if (placeKey && !readDiffPlace(placeKey)) pendingLine.current = null;
  }, [placeKey, selected]);
  /** pending restore frames, cancelled on unmount so nothing touches a disposed
   *  editor (the sibling effect in `DocumentViewer` does the same) */
  const rafs = useRef<number[]>([]);
  useEffect(() => {
    return () => {
      rafs.current.forEach((id) => cancelAnimationFrame(id));
      rafs.current = [];
    };
  }, []);

  // Tell the host, so its toggle can label itself. An effect rather than a call
  // during render: `onLayout` is a parent's setState, and calling it in render is
  // the "cannot update a component while rendering a different component" warning.
  const onLayout = props.onLayout;
  useEffect(() => {
    onLayout?.({ layout, narrowed });
  }, [layout, narrowed, onLayout]);

  // Built ONCE per pane. `colorScheme` used to be in these deps, which meant a
  // theme switch disposed the editor AND both models and built an empty one —
  // and nothing put the models back, because the effect below only re-runs
  // when the SELECTION changes. Switching theme with a file open therefore
  // blanked the diff until you clicked another file. Monaco's standalone theme
  // is global and swappable in place (`setTheme`, next effect), so there was
  // never a reason to rebuild the editor for it.
  useEffect(() => {
    if (!hostRef.current) return;
    // `vs` / `vs-dark` with the handful of below-AA token colours corrected —
    // see lib/monaco-theme.ts for the measurements. Here and not at module
    // load: `defineTheme` builds monaco's theme service, which reaches for
    // `CSS.escape`, and jsdom has no `CSS` — so a module-load call takes down
    // every unit test that merely IMPORTS the panel registry. Idempotent, and
    // a theme has to exist before `createDiffEditor` names it, so immediately
    // before is also the only place it has to be.
    defineDiffThemes(monaco.editor);
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: layout === 'side-by-side',
      // WE own the narrow-pane rule, not Monaco (#532). Left on — its default —
      // this quietly forces the inline view under 900px, which is where an
      // ordinary Changes tab in a 1280px window lives, so the pane had asked
      // for side-by-side since P1-E5-02 and never once got it. The full
      // reckoning is in lib/diff-layout's header; the short version is that a
      // rule the user cannot see is worse than one drawn a little narrow.
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      minimap: { enabled: false },
      theme: DIFF_THEME[props.colorScheme],
    });
    editorRef.current = editor;
    return () => {
      editor.getModel()?.original.dispose();
      editor.getModel()?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // deliberately empty: `colorScheme` and `layout` are READ here for the
    // initial paint but are not dependencies — the effects below own every
    // change to them, and rebuilding this editor would drop both models.
    // (No `eslint-disable` for `react-hooks/exhaustive-deps`: that plugin is not
    // installed in this repo, so the comment would itself be a lint error — see
    // `SessionGrid`'s "deps kept accurate by hand" notes.)
  }, []);

  // Live, in place — `updateOptions` is how a diff editor changes shape without
  // being rebuilt, and rebuilding would blank the pane (see the note above).
  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: layout === 'side-by-side' });
  }, [layout]);

  // How wide the DIFF is, which is not how wide the card is — a file list or a
  // toolbar takes its width off the front first. Measured rather than derived,
  // because the same body renders in a full-width card, a half-width one, a dock
  // panel and a popped-out window.
  useEffect(() => {
    const host = hostRef.current;
    // jsdom and older embedders have no ResizeObserver; without it the verdict
    // stays `false` and the preference is simply honoured — a degrade, not a
    // break (fail-open)
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (widthPx: number): void => {
      // A HIDDEN dockview tab observes 0×0 (`content.js` sets `display: none`
      // on the inactive panel). Treating that as a measurement would clear the
      // narrow verdict while the tab is away and paint one frame of two
      // columns on the way back — so a non-measurement leaves the last real
      // answer standing.
      if (widthPx > 0) setTooNarrow(isTooNarrowForColumns(Math.round(widthPx)));
    };
    const ro = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width ?? host.clientWidth);
    });
    ro.observe(host);
    measure(host.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // global by design: monaco's standalone theme is per-page, and every diff
    // pane in a window is showing the same app theme anyway
    monaco.editor.setTheme(DIFF_THEME[props.colorScheme]);
  }, [props.colorScheme]);

  // Session find, delegated (P2-E17-02, §5.31). Monaco HAS a find — a good one,
  // with regex, whole-word, replace and match marks down the scrollbar — and
  // §5.31 names it as a thing not to reimplement. So Ctrl+F opens Monaco's widget
  // and our bar stays out of the way entirely.
  const findSlot = props.findSlot ?? 'diff';
  useEffect(() => {
    if (!props.cardId) return;
    // The editor is built on mount but no file is selected until the user
    // picks one, and a find over a model-less editor opens a widget that can
    // never match anything. `ready()` is what lets the provider grey the bar
    // with a reason instead of handing off into nothing.
    const modified = (): monaco.editor.ICodeEditor | null =>
      editorRef.current?.getModifiedEditor() ?? null;
    const surface: MonacoFindSurface = {
      kind: 'monaco',
      ready: (): boolean => !!modified()?.getModel(),
      // `lib/monaco-find`, shared with the document viewer's source body since
      // #533: two surfaces in this app are Monaco editors and both delegate
      // find to it, so the hand-off is written once.
      openFind: (term: string): boolean => openMonacoFind(modified(), term),
    };
    return publishFindSurface(findSurfaceKey(props.cardId, findSlot), surface);
  }, [props.cardId, findSlot]);

  useEffect(() => {
    if (!selected || !editorRef.current) return;
    let cancelled = false; // stale selections / editor disposed mid-load
    // ⚠️ TWO LOADERS, ONE EFFECT. `fileVersions` answers HEAD-vs-disk and nothing
    // else, so a commit comparison needs `fileVersionsAt` — and a missing side
    // comes back as an empty string, which is exactly what Monaco needs to render
    // an addition or a deletion (see `fileVersionsAt`'s own note).
    const load =
      left !== null && right !== null
        ? window.switchboard.git.fileVersionsAt(folder, selected, left, right)
        : window.switchboard.git.fileVersions(folder, selected);
    void load.then((answer) => {
      // #650: `v.original` off a refusal is `undefined`, and
      // `monaco.editor.createModel(undefined, ...)` is a throw inside a `.then`
      // nobody catches. Leaving the editor on its previous model is the inert
      // choice, and it matches what `cancelled` does one line down.
      const v = answered(answer);
      const ed = editorRef.current;
      if (cancelled || !ed || !v) return;
      const old = ed.getModel();
      // Same language on both sides — they are two versions of one file, and a
      // mismatch would colour the "before" pane differently from the "after".
      // Unknown extensions come back `plaintext`, which is what the pane did
      // for EVERY file before #191.
      const language = languageForPath(selected);
      ed.setModel({
        original: monaco.editor.createModel(v.original, language),
        modified: monaco.editor.createModel(v.modified, language),
      });
      old?.original.dispose();
      old?.modified.dispose();
      // Put the reader back where they were (#562). AFTER the model, because an
      // editor with no content clamps any offset to 0, and ONCE — the ref is
      // consumed, so a later re-selection of the same file opens at the top like
      // the fresh choice it is.
      //
      // By LINE, not by pixels: side-by-side inserts alignment view zones for
      // deleted lines after the async diff computation, and the layout mode is
      // workspace-wide (#532), so the same pixel offset is a different place in
      // either case. `getTopForLineNumber` asks the editor where that line is
      // NOW.
      const line = pendingLine.current;
      pendingLine.current = null;
      // one frame later: the editor has the model but has not laid it out yet
      const id = requestAnimationFrame(() => {
        const me = ed.getModifiedEditor();
        if (line && line > 1) me.setScrollTop(me.getTopForLineNumber(line));
        // ...and NOW stamp, with a model in and a real viewport to read. A file
        // picked and never scrolled is still a place — the common one — and this
        // is the first moment the answer is trustworthy.
        const top = me.getVisibleRanges()[0]?.startLineNumber;
        if (top) rememberDiffPlace(placeKey, { selected, line: top });
      });
      rafs.current.push(id);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, folder, placeKey, left, right]);

  /**
   * Record where the reader is, for the next mount (#562).
   *
   * On the MODIFIED editor: it is the side a reader follows, and in side-by-side
   * the two are scroll-synchronised anyway. Re-subscribed per selection because
   * the handler CLOSES OVER `selected` — the emitter itself survives a
   * `setModel` (it lives on the widget, not the view model), so this is about
   * the closure and not about the editor's lifetime.
   *
   * NOTHING IS STAMPED HERE ON ARRIVAL, and that is the review's finding: this
   * effect runs the moment `selected` changes, which is BEFORE the async
   * `fileVersions` round trip swaps the model. At that instant the editor is
   * still showing the PREVIOUS file — so stamping would file the old file's line
   * under the new file's name, and on a fresh mount it would stamp Monaco's
   * "no model" answer over the very place the mount is about to restore. The
   * load effect above stamps instead, once the model is in.
   */
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !selected || !placeKey) return;
    const d = ed.getModifiedEditor().onDidScrollChange(() => {
      const top = ed.getModifiedEditor().getVisibleRanges()[0]?.startLineNumber;
      if (top) rememberDiffPlace(placeKey, { selected, line: top });
    });
    return () => d.dispose();
  }, [selected, placeKey]);

  return <div ref={hostRef} className="monaco-diff" style={{ flex: 1, minInlineSize: 0 }} />;
}
