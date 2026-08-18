// The document viewer panel (P2-E16-02, §5.30).
//
// A viewer is a DOCUMENT SURFACE: a panel whose content is a file on disk,
// rendered read-only. It is session-ATTRIBUTED, not session-owned — it outlives
// any session, needs none, and never appears in the rail, the attention queue
// or a bulk close (the attribution chip is P2-E16-03; this item built the
// surface).
//
// ONE PANEL, ONE DOCUMENT (#530). Every file opens its own tab, so `path` is
// fixed for the life of this component and nothing re-points it from outside.
// P2-E16-03's peek slot and its 📌 are gone — the header no longer has a pin,
// `lib/document-panels` no longer has a pointer to move, and the only thing
// that changes what is on screen is this component's own back/forward.
//
// WHAT IS DELIBERATELY NOT HERE:
//   * images, JSON/CSV bodies and a file tree (Phase 3, DESIGN §8).
//
// P2-E16-04 ADDED THE LIVE HALF, and it is deliberately thin here: main owns the
// watch and the debounce (`main/fs/file-watch.ts`), and all that arrives is
// "read it again" or "it is gone". The viewer's own share of that contract is
// the two things a reader would notice if they were missing — the scroll
// position survives a re-render, and a deleted file becomes a strip over what
// you were reading rather than an error or an empty pane.
//
// THE SECURITY SHAPE, in one place, because it is spread across three modules:
// main decides what may be read at all (`ReadScope`), `lib/markdown` is the
// only thing in the app that runs a sanitizer, and `lib/document-render`
// decorates the result OFF-PAGE so nothing fetches. This component is the part
// that decides what a CLICK means, and its rule is that a link with an href
// never survives to be clicked — see `decorateLinks`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileReadResult, FileTextEncoding, FileWatchNotice } from '../../../shared/ipc/fs';
import { renderMarkdown } from '../lib/markdown';
import {
  classifyDocument,
  DocumentMode,
  baseName,
  directoryName,
} from '../lib/document-kind';
import { classifyHref } from '../lib/document-link';
import {
  decorateDocument,
  splitFrontMatter,
  DecorationLabels,
  OutlineEntry,
} from '../lib/document-render';
import { applyMatches, clearMatches, focusMatch } from '../lib/document-find';
import { findBarState, findQuery } from '../lib/find-bar-state';
import { findSurfaceKey, publishFindSurface, type DocumentFindSurface } from '../lib/find-surfaces';
import { openMonacoFind, type FindableEditor } from '../lib/monaco-find';

const DocumentSource = React.lazy(() => import('./DocumentSource'));

/**
 * Find a heading by id.
 *
 * VALIDATED, NOT ESCAPED, and the difference is a white screen. The id we build
 * is `slugify`'s output, which can only be letters, numbers, `-` and `_` — but
 * the NEEDLE comes from a link inside a file we did not write, percent-decoded
 * on the way (`classifyHref`). A document containing `[go](./x.md#a%0Ab)` hands
 * this a raw newline, a newline inside a CSS string is a parse error, and
 * `querySelector` THROWS — from inside an effect, where React's answer is to
 * unmount the tree. There is no error boundary above a dockview panel's
 * content, so one hostile link would take every session pane in the window with
 * it, which is the fail-open constraint broken by a file on disk.
 *
 * Escaping was the first version and it is not enough: escaping `"` and `\`
 * leaves the newline, and a complete CSS-string escaper is a thing to own
 * forever. An id that cannot match anything we generated is simply not looked
 * up. (`CSS.escape` is also absent from the jsdom the unit tests run on, and
 * jsdom's selector engine is more forgiving than Chromium's — which is why this
 * only shows up in the real app.)
 */
function headingById(root: ParentNode | null, id: string): Element | null {
  if (!root || !/^[\p{L}\p{N}\-_]+$/u.test(id)) return null;
  return root.querySelector(`[id="${id}"]`);
}

/** The session a viewer was opened FROM, for §5.24's lineage convention. */
export interface DocumentAttribution {
  /** what that session calls itself, right now */
  name: string;
  /** its identity accent, or undefined while the store has not answered */
  accent?: string;
}

export interface DocumentViewerProps {
  /** the absolute path this viewer opened on */
  path: string;
  /**
   * The dockview panel this viewer is the content of (`doc-3`), which is how
   * the §5.31 find bar names it (#533).
   *
   * Optional because a unit test mounts the component with no panel around it.
   * Absent means the find surface is not published, and Ctrl+F over this viewer
   * finds nothing to search — which is the correct answer for a viewer nobody
   * can name.
   */
  panelId?: string;
  colorScheme: 'light' | 'dark';
  /** the panel's tab title follows relative-link navigation */
  onTitleChange?: (title: string) => void;
  /** is this viewer currently in its own OS window? */
  poppedOut?: boolean;
  /** pop out, or dock back — one control, because it is one toggle */
  onPopoutToggle?: () => void;
  /** the session this viewer was opened from, if any (§5.24) */
  session?: DocumentAttribution;
  /**
   * Bumped whenever dockview moved this panel's DOM (#562) — the same signal
   * `PanelContext.dockEpoch` carries for a session card's panels (#555).
   *
   * MEASURED, two documents sharing a dockview group: read halfway down one,
   * click the other tab, click back — **722 -> 0**. And the component is NEVER
   * UNMOUNTED while that happens, which is the part that misleads: only one
   * `[data-testid="doc-scroll"]` is findable at a time, so the obvious reading
   * is that the inactive panel was destroyed. It was not. Dockview DETACHES the
   * panel's element from the document and keeps the React tree alive, so
   * `querySelector` cannot see it while every ref in here still holds its value
   * — `scrollMemo` included. Nothing was lost; there was simply nothing to
   * re-apply it, because the effect that does so only runs when the rendered
   * HTML changes and the document had not changed at all.
   */
  dockEpoch?: number;
}

/** Bytes as a human says them. Two significant places is enough for a header. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The bridge slice this panel uses, so a test can stub exactly it. */
interface FilesBridge {
  read(path: string): Promise<FileReadResult>;
  openPath?(path: string): Promise<boolean>;
  reveal?(path: string): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  /** follow the file; returns the unsubscribe (P2-E16-04) */
  watch?(path: string, onChange: (notice: FileWatchNotice) => void): () => void;
}

function files(): FilesBridge | undefined {
  return (window as unknown as { switchboard?: { files?: FilesBridge } }).switchboard?.files;
}

export function DocumentViewer(props: DocumentViewerProps): React.JSX.Element {
  const { t } = useTranslation();

  // --- navigation ---------------------------------------------------------
  // A stack plus a cursor, which is what back/forward IS. Following a relative
  // link truncates everything after the cursor, exactly like a browser: the
  // path you came from is behind you, the one you abandoned is gone.
  const [history, setHistory] = React.useState<string[]>([props.path]);
  const [at, setAt] = React.useState(0);
  const current = history[at] ?? props.path;
  const [pendingHash, setPendingHash] = React.useState<string | undefined>(undefined);

  // DEFENSIVE, and unreachable by design since #530: `path` is fixed for the
  // life of a panel, and a remount re-runs the `useState` initialiser above
  // anyway. Kept because the cost is one render on mount and the failure it
  // guards is silent — a history stack seeded from a stale prop is a back
  // button that lies about where you have been. Delete it the day something
  // proves no prop can ever change under this component.
  React.useEffect(() => {
    setHistory([props.path]);
    setAt(0);
    setPendingHash(undefined);
  }, [props.path]);

  const meta = React.useMemo(() => classifyDocument(current), [current]);
  const [result, setResult] = React.useState<FileReadResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState<DocumentMode>(meta.defaultMode);

  React.useEffect(() => {
    setMode(meta.defaultMode);
  }, [meta.defaultMode, current]);
  React.useEffect(() => {
    props.onTitleChange?.(meta.name);
  }, [meta.name, props.onTitleChange]);

  /**
   * The file was there when we opened it and is not there now (P2-E16-04).
   *
   * SEPARATE from `result`, because the done-when is that a deleted file shows
   * "a strip instead of an error or a blank pane": the last good read stays on
   * screen underneath it. Overwriting `result` with the refusal would be the
   * blank pane, and it would also throw away the only copy of a document the
   * reader may still be halfway through — the file is gone, their place in it
   * need not be.
   */
  const [missing, setMissing] = React.useState(false);

  /**
   * Which read is the CURRENT one.
   *
   * A watch notice can land while the open read is still in flight, and the two
   * resolve in whatever order the bridge feels like — so the answers are stamped
   * and a stale one is dropped. Without it a slow first read can overwrite the
   * fresher content that a rewrite already delivered, and the viewer shows the
   * old document with no event left to correct it.
   */
  const readSeq = React.useRef(0);

  /**
   * Apply one read's answer — ONE function, because there are two readers and
   * `loading` must be cleared by whichever of them lands last.
   *
   * The bug this shape exists to prevent: the open read and a change notice can
   * be in flight at the same time (they are issued in the same commit, and the
   * flagship scenario is opening a file an agent is *already* rewriting). The
   * notice's read retires the open read's stamp, so if only the open read
   * cleared `loading`, the viewer would sit on "Opening…" for the rest of the
   * panel's life with a perfectly good document rendered behind it — the blank
   * pane the done-when forbids, arrived at from the other direction.
   *
   * `keep` is what separates the two readers: a RELOAD keeps the document that
   * is on screen when the new read fails, because it is still the last true
   * thing anyone wrote. An OPEN has nothing to keep.
   */
  const applyRead = React.useCallback((mine: number, r: FileReadResult, keep: boolean): void => {
    if (mine !== readSeq.current) return;
    setLoading(false);
    if (r.ok) {
      setResult(r);
      setMissing(false);
      return;
    }
    if (!keep) {
      setResult(r);
      return;
    }
    // A read that fails on a RELOAD keeps what is on screen. `not-found` is the
    // deletion racing us to the file and earns the strip; anything else (the
    // scope narrowed because the session card closed, a lock, an unplugged
    // drive) is a document that has stopped updating, not one that has stopped
    // existing — and replacing a page of prose with a refusal message would be
    // this item breaking what E16-02 shipped.
    if (r.reason === 'not-found') setMissing(true);
  }, []);

  /**
   * Follow the open file (P2-E16-04, §5.30).
   *
   * Main does the watching, the coalescing and the deciding; this asks, re-reads
   * and — crucially — UNSUBSCRIBES. The effect is keyed on the path, so a
   * relative-link navigation moves the watch with it, and unmounting a panel
   * takes the last reference off the file in main.
   *
   * DECLARED BEFORE THE READ, and the order is load-bearing: effects run in
   * declaration order, so `fs:watch` reaches main first and main seeds the
   * file's signature BEFORE the bytes are read. The other way round leaves a
   * window — the file being rewritten between the read and the seed — in which
   * the change is baked into the seed and no event is ever emitted for it, so
   * the viewer shows content it already knows is stale until something else
   * happens to the file.
   *
   * A re-read deliberately does NOT set `loading`. Flashing "Opening…" over a
   * document every time an agent saves is worse than the staleness it replaces,
   * and there is nothing to wait for: the previous content is still correct
   * until the new one arrives.
   */
  React.useEffect(() => {
    const bridge = files();
    // A bridge without `watch` is an older preload or a test that stubbed the
    // three methods it cared about. The viewer is simply not live; nothing else
    // about it changes.
    if (!bridge?.watch) return;
    return bridge.watch(current, (notice) => {
      if (notice.state === 'gone') {
        setMissing(true);
        return;
      }
      const mine = ++readSeq.current;
      void bridge
        .read(current)
        .then((r) => applyRead(mine, r, true))
        .catch(() => {
          /* keep showing what we have */
        });
    });
  }, [current, applyRead]);

  React.useEffect(() => {
    const mine = ++readSeq.current;
    setLoading(true);
    setResult(null);
    setMissing(false);
    const bridge = files();
    if (!bridge) {
      // Fail-open (litmus #3): no bridge is a viewer that says so, not a throw
      // that takes the window's React tree with it.
      setResult({ ok: false, reason: 'unreadable' });
      setLoading(false);
      return;
    }
    void bridge
      .read(current)
      .then((r) => applyRead(mine, r, false))
      .catch(() => applyRead(mine, { ok: false, reason: 'unreadable' }, false));
    // Retiring the stamp is what the old `live` flag did, said once for both
    // readers: a read still in flight when the path changes — or when the panel
    // closes — has nothing left to apply to.
    return () => {
      readSeq.current += 1;
    };
  }, [current, applyRead]);

  const navigate = React.useCallback(
    (to: string, hash?: string) => {
      setHistory((h) => [...h.slice(0, at + 1), to]);
      setAt((i) => i + 1);
      setPendingHash(hash);
    },
    [at]
  );

  // --- bodies -------------------------------------------------------------
  const ok = result?.ok === true ? result : null;
  const binary = ok?.binary === true;
  const isCard = meta.kind === 'external' || binary;
  const text = ok?.text ?? '';

  const front = React.useMemo(
    () => (meta.kind === 'markdown' ? splitFrontMatter(text) : { body: text }),
    [meta.kind, text]
  );

  const labels: DecorationLabels = React.useMemo(
    () => ({
      copy: t('document.copy'),
      image: t('document.image'),
      openInBrowser: t('document.openInBrowser'),
      mediaOmitted: t('document.mediaOmitted'),
    }),
    [t]
  );

  // TWO elements, and the split is not cosmetic: `scrollRef` is the pane that
  // scrolls and `bodyRef` is the column of prose inside it, capped at a
  // readable measure (§5.30). One element doing both puts the scrollbar 78
  // characters in, with dead pane to the right of it.
  //
  // `mainRef` is a third and belongs to FIND (#533): it wraps the prose AND the
  // front-matter block, which is what the reader can see and therefore what a
  // search has to cover. The decoration effect still writes into `bodyRef` —
  // the rendered document is the only thing React does not own here.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  const [outline, setOutline] = React.useState<readonly OutlineEntry[]>([]);
  const [frontOpen, setFrontOpen] = React.useState(false);

  // Scroll position per MODE, so the toggle round-trips. Two numbers rather
  // than one shared offset: a rendered line and a source line are not the same
  // distance down the pane, and pretending they are lands you in the wrong
  // place in both directions.
  const scrollMemo = React.useRef<{ rendered: number; source: number }>({
    rendered: 0,
    source: 0,
  });
  React.useEffect(() => {
    scrollMemo.current = { rendered: 0, source: 0 };
  }, [current]);

  const renderedHtml = React.useMemo(
    () => (meta.kind === 'markdown' && ok && !binary ? renderMarkdown(front.body) : ''),
    [meta.kind, ok, binary, front.body]
  );

  const showRendered = meta.kind === 'markdown' && mode === 'rendered' && !!ok && !binary && !isCard;

  React.useEffect(() => {
    const host = bodyRef.current;
    if (!host || !showRendered) return;
    const { fragment, outline: found } = decorateDocument(renderedHtml, labels, (href) =>
      classifyHref(href, current)
    );
    host.replaceChildren(fragment);
    setOutline(found);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollMemo.current.rendered;
    // The marks belonged to the OLD document — `replaceChildren` just deleted
    // them, so the bar would sit there reading "1 of 5" over a document with no
    // highlights in it. Re-mark against the new body instead of pretending.
    //
    // The bar's own state is READ, not driven: there is no way to ask it to
    // re-run its query, so a rewrite that changes how many matches there are
    // leaves its COUNT one keystroke stale. The highlights are the thing the
    // reader is looking at (#520 — a jump with no visible mark reads as broken),
    // and they are right; the number catches up on the next keystroke.
    const q = findQuery();
    if (findBarState().openOn === props.panelId && q.term && mainRef.current) {
      applyMatches(mainRef.current, q.term, q);
    }
  }, [showRendered, renderedHtml, labels, current, props.panelId]);

  /**
   * Put the reader back after dockview moved this panel's DOM (#562).
   *
   * `scrollMemo` already holds the right number — the component was never
   * unmounted (see the `dockEpoch` prop) — so this is purely "apply it again".
   * The browser dropped the element's `scrollTop` during the detach and fired
   * nothing: no scroll event, no resize (the panel comes back at exactly the
   * size it left), no visibility change. The card's own panels learned this in
   * #555; a document panel is not a card panel and had no such signal at all.
   *
   * Twice, a frame apart, for `FeedView`'s reason: the dockview event can land
   * on either side of the DOM move, and re-applying a scrollTop the element is
   * already sitting at costs nothing.
   *
   * The SOURCE body is INFERRED to need no equivalent, and the word is chosen:
   * Monaco scrolls a virtual viewport rather than a native `scrollTop`, and the
   * Changes tab — a Monaco editor under the identical move — came back on the
   * same line, measured. But that is a diff editor and this is a plain one, and
   * nothing has moved a viewer while it was in Source mode. Inference, not
   * measurement; `e2e/panel-restore-position.spec.ts`'s header lists it as such
   * beside the Terminal.
   *
   * SKIPS THE FIRST RUN. `dockEpoch` starts at 0, so this effect fires on mount,
   * where there is nothing to restore and the write races the `#fragment` jump
   * declared just below — a relative link's anchor would be undone a frame after
   * it landed.
   */
  const restoredEpoch = React.useRef<number | undefined>(props.dockEpoch);
  React.useEffect(() => {
    if (props.dockEpoch === undefined || props.dockEpoch === restoredEpoch.current) return;
    restoredEpoch.current = props.dockEpoch;
    const apply = (): void => {
      const el = scrollRef.current;
      if (el) el.scrollTop = scrollMemo.current.rendered;
    };
    apply();
    const id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [props.dockEpoch]);

  /**
   * The backstop `FeedView` has and this did not (#562 review).
   *
   * The two shots above are timed to the dockview event, and both are silent
   * no-ops if the element has no layout box at that instant — `scrollTop =` on a
   * zero-height element does nothing. The measured gesture is fine; a document
   * tab DRAGGED into another group, where the event can land on the far side of
   * the move, has no third chance. `FeedView` solves this by calling the same
   * reconcile from a ResizeObserver on the scroller, so the dockview signal is
   * one route among several rather than the only one.
   *
   * Re-applying costs nothing when nothing is wrong: `scrollMemo` is updated by
   * the scroll handler, so the remembered position IS the current one, and the
   * guard makes the ordinary case a comparison rather than a write. It must not
   * fight a user who resizes the pane — and it cannot, for the same reason.
   */
  React.useEffect(() => {
    const el = scrollRef.current;
    // `ResizeObserver` is a browser affordance and jsdom has none. Guarded rather
    // than stubbed in every test that merely mounts this component: a backstop
    // that cannot run in a unit test is still a backstop in the app, and making
    // twenty tests declare a global to get past it would be the tail wagging.
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const want = scrollMemo.current.rendered;
      if (want > 0 && el.scrollTop === 0 && el.scrollHeight > el.clientHeight) {
        el.scrollTop = want;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRendered]);

  // The `#fragment` a relative link carried, applied once the body exists.
  React.useEffect(() => {
    if (!pendingHash || !showRendered) return;
    const host = bodyRef.current;
    headingById(host ?? null, pendingHash)?.scrollIntoView?.({ block: 'start' });
    setPendingHash(undefined);
  }, [pendingHash, showRendered, renderedHtml]);

  // --- find (#533) ---------------------------------------------------------
  //
  // THE VIEWER NO LONGER OWNS A FIND BAR. It publishes a `FindSurface` and the
  // shared §5.31 bar drives it — same Ctrl+F, same chrome and same sticky term
  // as every other panel in the app, with a results list the private bar never
  // had. What used to live here (a bar, four pieces of state, a debounce and a
  // keydown listener) is `extensibility/find-providers.ts`'s `find-document`
  // and `components/FindBar.tsx` now.
  //
  // THE KEYDOWN LISTENER IS GONE ON PURPOSE, and it is worth knowing why rather
  // than re-adding it: it was attached to this component's ROOT DIV and nothing
  // in that subtree is focusable, so unless the user had first clicked a button
  // in the header the keydown's target was `document.body` and the event never
  // bubbled through here at all. It was dead code, and the reason Ctrl+F looked
  // broken over a document. The keystroke arrives through the app's dispatcher
  // now (`find.open` + `GridController.activeDocumentId`), which works wherever
  // focus happens to be — including in a popped-out viewer's own window.
  const sourceEditor = React.useRef<FindableEditor | null>(null);
  // Read by the surface's methods, which are called from OUTSIDE React's render
  // (a keydown, then the bar's effects) and must see what is true now.
  const showRenderedRef = React.useRef(false);
  // The editor's ARRIVAL, as state rather than only as a ref — see the effect's
  // deps below for why a ref alone would leave the bar greyed.
  const [sourceReady, setSourceReady] = React.useState(false);

  const panelId = props.panelId;
  React.useEffect(() => {
    // No panel id means nobody can name this viewer — a unit test mounting the
    // component directly, and the one case where publishing would be wrong: the
    // key is what makes "a search cannot reach another panel" structural.
    // In the EFFECT rather than during render: a ref written while rendering
    // can hold a value from a render React went on to throw away, and the deps
    // below already re-run this whenever the answer changes.
    showRenderedRef.current = showRendered;
    if (!panelId) return;
    const surface: DocumentFindSurface = {
      kind: 'document',
      view: () => {
        if (showRenderedRef.current && mainRef.current) return 'rendered';
        if (!showRenderedRef.current && sourceEditor.current?.getModel()) return 'source';
        // loading, refused, binary (the card), or the editor has not built yet
        return 'none';
      },
      search: (query) => {
        const host = mainRef.current;
        if (!host) return { matches: [], truncated: false };
        return applyMatches(host, query.term, query);
      },
      reveal: (index) => {
        const host = mainRef.current;
        return host ? focusMatch(host, index) >= 0 : false;
      },
      clear: () => {
        if (mainRef.current) clearMatches(mainRef.current);
      },
      openFind: (term) => openMonacoFind(sourceEditor.current, term),
    };
    return publishFindSurface(findSurfaceKey(panelId, 'document'), surface);
    // RE-PUBLISHED whenever `view()` would answer differently, and that is the
    // point of the deps rather than an accident of them: the bar is a SIBLING
    // subtree, so nothing here re-renders it, and a publish is the only signal
    // it gets (`findSurfacesVersion`). Without this, toggling to Source would
    // leave the bar still driving a rendered body that has been unmounted, and
    // the editor arriving a moment later would leave it greyed with "hasn't
    // finished opening" over an editor that had. Re-publishing is cheap and
    // explicitly supported — last publisher wins, and the cleanup only deletes
    // the entry if it is still the one it published.
  }, [panelId, showRendered, sourceReady]);


  // --- clicks inside the rendered body ------------------------------------
  const activate = React.useCallback(
    (target: HTMLElement | null): void => {
      if (!target) return;
      const copy = target.closest<HTMLElement>('[data-doc-copy]');
      if (copy) {
        const code = copy.closest('.doc-code')?.querySelector('pre')?.textContent ?? '';
        void navigator.clipboard?.writeText(code).catch(() => {});
        const before = copy.textContent;
        copy.textContent = t('document.copied');
        window.setTimeout(() => {
          if (copy.isConnected) copy.textContent = before;
        }, 1200);
        return;
      }
      const image = target.closest<HTMLElement>('[data-doc-external]');
      if (image) {
        void files()?.openExternal?.(image.getAttribute('data-doc-external') ?? '');
        return;
      }
      const link = target.closest<HTMLElement>('[data-doc-link]');
      if (!link) return;
      const kind = link.getAttribute('data-doc-link');
      const to = link.getAttribute('data-doc-target') ?? '';
      // 'blocked' falls through every branch and does nothing at all — the
      // done-when for this item names `javascript:` specifically.
      if (kind === 'external') void files()?.openExternal?.(to);
      else if (kind === 'relative') navigate(to, link.getAttribute('data-doc-hash') ?? undefined);
      else if (kind === 'anchor') {
        headingById(bodyRef.current, to)?.scrollIntoView?.({ block: 'start' });
      }
    },
    [navigate, t]
  );

  // --- header -------------------------------------------------------------
  const canRender = meta.kind === 'markdown';
  const truncated = ok?.truncated === true;
  const encoding = ok?.encoding;

  const switchMode = (next: DocumentMode): void => {
    if (next === mode) return;
    if (mode === 'rendered' && scrollRef.current) {
      scrollMemo.current.rendered = scrollRef.current.scrollTop;
    }
    // Leaving the rendered body takes its marks with it — they are real nodes
    // in a tree that is about to be unmounted, and the next search would
    // otherwise match inside its own highlights. The BAR stays open across the
    // toggle, and switches from driving us to delegating to Monaco, because
    // `modeFor` is asked of the live surface on every render.
    if (mainRef.current) clearMatches(mainRef.current);
    setMode(next);
  };

  // §5.24's lineage convention: the accent is a TINT on the surface (a rule
  // down its leading edge, exactly as a card header wears it), never the ink —
  // the eight accents span 1.8:1 to 3.1:1 on daylight and text on them cannot
  // be read (the #5.11 finding IdentityChip records).
  const attribution = props.session;
  const rootStyle = attribution?.accent
    ? ({ ['--doc-accent' as string]: attribution.accent } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={`doc-viewer${attribution ? ' doc-attributed' : ''}`}
      style={rootStyle}
      data-testid="document-viewer"
    >
      <div className="doc-header">
        <div className="doc-nav">
          <button
            type="button"
            className="doc-btn"
            disabled={at === 0}
            title={t('document.back')}
            aria-label={t('document.back')}
            onClick={() => setAt((i) => Math.max(0, i - 1))}
          >
            {t('document.icon.back')}
          </button>
          <button
            type="button"
            className="doc-btn"
            disabled={at >= history.length - 1}
            title={t('document.forward')}
            aria-label={t('document.forward')}
            onClick={() => setAt((i) => Math.min(history.length - 1, i + 1))}
          >
            {t('document.icon.forward')}
          </button>
        </div>
        {/* the full path on hover, per §5.30's header list */}
        <span className="doc-name" title={current} data-testid="doc-name">
          {baseName(current)}
        </span>
        <span className="doc-dir" title={current}>
          {directoryName(current)}
        </span>
        {attribution ? (
          // A CHIP, not a title bar: a viewer is session-ATTRIBUTED and not
          // session-owned (§5.30), so this says where it came from and claims
          // nothing else. `role="note"` because the chip has to carry its own
          // accessible name — "↳ api-work" read aloud is a rune and a word.
          <span
            className="doc-attribution"
            data-testid="doc-attribution"
            role="note"
            aria-label={t('document.openedFromLabel', { name: attribution.name })}
            title={t('document.openedFromLabel', { name: attribution.name })}
          >
            <span aria-hidden="true">{t('document.icon.lineage')}</span> {attribution.name}
          </span>
        ) : null}
        {encoding && encoding !== 'utf-8' ? (
          <span className="doc-chip" data-testid="doc-encoding">
            {t('document.encodingNote', { encoding: encoding as FileTextEncoding })}
          </span>
        ) : null}
        <span className="doc-header-gap" />
        <div className="doc-modes" role="group" aria-label={t('document.toggleLabel')}>
          <button
            type="button"
            className="doc-btn"
            aria-pressed={mode === 'rendered'}
            // Greyed, never hidden (§5.8): a `.ts` has no rendered view, and
            // saying so is more use than a toggle that silently isn't there.
            disabled={!canRender || isCard}
            title={canRender ? undefined : t('document.renderedOnlyForMarkdown')}
            onClick={() => switchMode('rendered')}
          >
            {t('document.rendered')}
          </button>
          <button
            type="button"
            className="doc-btn"
            aria-pressed={mode === 'source'}
            disabled={isCard}
            onClick={() => switchMode('source')}
          >
            {t('document.source')}
          </button>
        </div>
        <button
          type="button"
          className="doc-btn"
          title={t('document.openExternally')}
          onClick={() => void files()?.openPath?.(current)}
        >
          {t('document.openExternally')}
        </button>
        <button
          type="button"
          className="doc-btn"
          title={t('document.revealInFolder')}
          onClick={() => void files()?.reveal?.(current)}
        >
          {t('document.revealInFolder')}
        </button>
        {props.onPopoutToggle ? (
          // ONE control for both directions, like the card's (E8-04): pop out
          // and dock back are the same toggle, and two buttons that are never
          // both meaningful is two chances to show the wrong one. Its title is
          // deliberately NOT the card's "Pop out into its own window" — several
          // specs reach for that string by title, and a second match would make
          // them ambiguous rather than wrong, which is the harder failure.
          <button
            type="button"
            className="doc-btn doc-popout"
            data-testid="doc-popout"
            aria-pressed={props.poppedOut === true}
            title={props.poppedOut ? t('document.dockBack') : t('document.popOut')}
            aria-label={props.poppedOut ? t('document.dockBack') : t('document.popOut')}
            onClick={() => props.onPopoutToggle?.()}
          >
            {props.poppedOut ? t('document.icon.dockBack') : t('document.icon.popOut')}
          </button>
        ) : null}
      </div>

      {/* The file went away while it was open (P2-E16-04). A STRIP over the
          document, not in place of it: what you were reading is still the last
          true thing anyone wrote, and losing your place as well as the file
          would be this feature costing more than it gives. */}
      {missing ? (
        <div className="doc-notice doc-gone" role="status" data-testid="doc-gone">
          {t('document.gone')}
        </div>
      ) : null}

      {truncated && ok ? (
        <div className="doc-notice" role="status" data-testid="doc-truncated">
          {t('document.truncated', {
            shown: formatBytes(ok.bytes ?? 0),
            size: formatBytes(ok.size),
          })}
        </div>
      ) : null}

      {loading ? (
        <div className="doc-body-message" role="status">
          {t('document.loading')}
        </div>
      ) : result && !result.ok ? (
        <div className="doc-body-message doc-refusal" role="status" data-testid="doc-refusal">
          {t(`document.refusal.${result.reason}`)}
        </div>
      ) : isCard ? (
        <div className="doc-card" data-testid="doc-card">
          <div className="doc-card-title">{t('document.card.title')}</div>
          <div className="doc-card-body">
            {meta.extension
              ? t('document.card.body', {
                  name: meta.name,
                  type: meta.extension.toUpperCase(),
                  size: formatBytes(ok?.size ?? 0),
                })
              : t('document.card.bodyUnknown', {
                  name: meta.name,
                  size: formatBytes(ok?.size ?? 0),
                })}
          </div>
          <div className="doc-card-actions">
            <button type="button" className="doc-btn" onClick={() => void files()?.openPath?.(current)}>
              {t('document.openExternally')}
            </button>
            <button type="button" className="doc-btn" onClick={() => void files()?.reveal?.(current)}>
              {t('document.revealInFolder')}
            </button>
          </div>
        </div>
      ) : showRendered ? (
        <div className="doc-rendered-wrap">
          {outline.length >= 3 ? (
            <nav className="doc-outline" aria-label={t('document.outline')}>
              <div className="doc-outline-title">{t('document.outline')}</div>
              <ul>
                {outline.map((h) => (
                  <li key={h.id} className={`doc-outline-l${h.level}`}>
                    <button
                      type="button"
                      className="doc-outline-link"
                      onClick={() =>
                        headingById(bodyRef.current, h.id)?.scrollIntoView?.({ block: 'start' })
                      }
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {/* THE SEARCH ROOT, not just a layout box (#533). The find surface
              marks inside THIS element rather than inside `.doc-md`, so that
              expanded front matter — text the reader can see — is searchable
              too. A zero over something on screen is the same lie §5.31 refuses
              one level up, and the chrome inside it (the "Front matter" chip)
              is excluded by `document-find`'s own walker. Collapsed front
              matter is not in the DOM at all, so it is honestly not searched. */}
          <div className="doc-main" ref={mainRef}>
            {front.frontMatter !== undefined ? (
              <div className="doc-front">
                <button
                  type="button"
                  className="doc-front-chip"
                  aria-expanded={frontOpen}
                  onClick={() => setFrontOpen((v) => !v)}
                >
                  {t('document.frontMatter')}
                </button>
                {frontOpen ? <pre className="doc-front-body">{front.frontMatter}</pre> : null}
              </div>
            ) : null}
            <div
              ref={scrollRef}
              className="doc-body"
              data-testid="doc-scroll"
              // WHERE THE READER IS, recorded as they read (P2-E16-04). The
              // decoration effect hands this back after every re-render, which
              // is the whole of "preserving scroll position": without it a
              // rewrite of the file would drop the reader at the top of the
              // document, and an agent that saves every few seconds would make
              // the pane unreadable. `switchMode` still records it explicitly —
              // a mode toggle is not a scroll, so no event fires for it.
              onScroll={(e) => {
                scrollMemo.current.rendered = e.currentTarget.scrollTop;
              }}
              onClick={(e) => activate(e.target as HTMLElement)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  const el = e.target as HTMLElement;
                  if (el.getAttribute?.('role') === 'link') {
                    e.preventDefault();
                    activate(el);
                  }
                }
              }}
            >
              {/* The rendered HTML is written by the effect above, never by
                  React: it is decorated DOM, not JSX, and letting React own the
                  children would have it discard the decoration on every
                  render. */}
              <div ref={bodyRef} className="doc-md" data-testid="doc-rendered" />
            </div>
          </div>
        </div>
      ) : (
        <div className="doc-body doc-source-wrap" data-testid="doc-source">
          <React.Suspense fallback={<div className="doc-body-message">{t('document.loading')}</div>}>
            <DocumentSource
              text={text}
              language={meta.language}
              colorScheme={props.colorScheme}
              initialScrollTop={scrollMemo.current.source}
              onScrollTop={(top) => {
                scrollMemo.current.source = top;
              }}
              // §5.31 delegates the source body's find to Monaco's own widget
              // rather than reimplementing it (#533). Held structurally, so the
              // viewer still never imports monaco.
              onEditor={(editor) => {
                sourceEditor.current = editor;
                setSourceReady(!!editor);
              }}
            />
          </React.Suspense>
        </div>
      )}
    </div>
  );
}
