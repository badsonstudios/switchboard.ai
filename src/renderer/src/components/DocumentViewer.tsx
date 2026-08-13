// The document viewer panel (P2-E16-02, §5.30).
//
// A viewer is a DOCUMENT SURFACE: a panel whose content is a file on disk,
// rendered read-only. It is session-ATTRIBUTED, not session-owned — it outlives
// any session, needs none, and never appears in the rail, the attention queue
// or a bulk close (the attribution chip and the peek/pin machinery are
// P2-E16-03; this item builds the surface).
//
// WHAT IS DELIBERATELY NOT HERE:
//   * the peek slot and pinning behaviour (P2-E16-03) — the pin CONTROL is
//     rendered and reports its state through `onPinnedChange`, because a header
//     that grows a button later moves every other one; what the app does with
//     that state is the next item's;
//   * re-render on change (P2-E16-04) — the file is read once per open;
//   * images, JSON/CSV bodies and a file tree (Phase 3, DESIGN §8).
//
// THE SECURITY SHAPE, in one place, because it is spread across three modules:
// main decides what may be read at all (`ReadScope`), `lib/markdown` is the
// only thing in the app that runs a sanitizer, and `lib/document-render`
// decorates the result OFF-PAGE so nothing fetches. This component is the part
// that decides what a CLICK means, and its rule is that a link with an href
// never survives to be clicked — see `decorateLinks`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileReadResult, FileTextEncoding } from '../../../shared/ipc/fs';
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
  colorScheme: 'light' | 'dark';
  /** the panel's tab title follows relative-link navigation */
  onTitleChange?: (title: string) => void;
  /**
   * CONTROLLED (P2-E16-03). The peek slot is one pointer held outside this
   * component (`lib/document-panels`), and pinning MOVES it — so a viewer that
   * kept its own copy would show "pinned" for a panel the registry had since
   * handed the slot back to. The control reports; the registry decides.
   */
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
  /** is this viewer currently in its own OS window? */
  poppedOut?: boolean;
  /** pop out, or dock back — one control, because it is one toggle */
  onPopoutToggle?: () => void;
  /** the session this viewer was opened from, if any (§5.24) */
  session?: DocumentAttribution;
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

  // The panel can be re-pointed from outside (P2-E16-03's peek slot replaces
  // the params rather than the panel). Treat that as a fresh document.
  React.useEffect(() => {
    setHistory([props.path]);
    setAt(0);
    setPendingHash(undefined);
  }, [props.path]);

  const meta = React.useMemo(() => classifyDocument(current), [current]);
  const [result, setResult] = React.useState<FileReadResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState<DocumentMode>(meta.defaultMode);
  const pinned = props.pinned ?? false;

  React.useEffect(() => {
    setMode(meta.defaultMode);
  }, [meta.defaultMode, current]);
  React.useEffect(() => {
    props.onTitleChange?.(meta.name);
  }, [meta.name, props.onTitleChange]);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setResult(null);
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
      .then((r) => {
        if (!live) return;
        setResult(r);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setResult({ ok: false, reason: 'unreadable' });
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [current]);

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
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
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
    // highlights in it. Re-run against the new body instead of pretending.
    if (findOpenRef.current) runFindRef.current(queryRef.current);
  }, [showRendered, renderedHtml, labels, current]);

  // The `#fragment` a relative link carried, applied once the body exists.
  React.useEffect(() => {
    if (!pendingHash || !showRendered) return;
    const host = bodyRef.current;
    headingById(host ?? null, pendingHash)?.scrollIntoView?.({ block: 'start' });
    setPendingHash(undefined);
  }, [pendingHash, showRendered, renderedHtml]);

  // --- find ---------------------------------------------------------------
  const [findOpen, setFindOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [matches, setMatches] = React.useState(0);
  const [matchAt, setMatchAt] = React.useState(-1);
  const findInputRef = React.useRef<HTMLInputElement | null>(null);

  const runFind = React.useCallback((q: string) => {
    const host = bodyRef.current;
    if (!host) return;
    const count = applyMatches(host, q);
    setMatches(count);
    setMatchAt(count > 0 ? focusMatch(host, 0) : -1);
  }, []);

  // Read by the decorate effect, which must not re-run when a keystroke changes
  // the query — it would re-parse and re-decorate the whole document per letter.
  const findOpenRef = React.useRef(false);
  const queryRef = React.useRef('');
  const runFindRef = React.useRef(runFind);
  runFindRef.current = runFind;

  // The search walks and rewrites every text node in the document, and §5.30
  // budgets for 2 MiB of them. One pass per keystroke is how "never 'the app
  // froze'" stops being true; one pass per pause in typing is not felt.
  const findTimer = React.useRef<number | null>(null);
  const scheduleFind = React.useCallback(
    (q: string) => {
      if (findTimer.current !== null) window.clearTimeout(findTimer.current);
      findTimer.current = window.setTimeout(() => {
        findTimer.current = null;
        runFind(q);
      }, 120);
    },
    [runFind]
  );
  React.useEffect(() => {
    return () => {
      if (findTimer.current !== null) window.clearTimeout(findTimer.current);
    };
  }, []);

  const step = React.useCallback(
    (delta: number) => {
      const host = bodyRef.current;
      if (!host || matches === 0) return;
      setMatchAt(focusMatch(host, matchAt + delta));
    },
    [matches, matchAt]
  );

  // Clearing on close is not cosmetic: the marks are real nodes, and leaving
  // them behind would make the next search match inside its own highlights.
  const closeFind = React.useCallback(() => {
    if (findTimer.current !== null) window.clearTimeout(findTimer.current);
    findTimer.current = null;
    setFindOpen(false);
    setQuery('');
    setMatches(0);
    setMatchAt(-1);
    findOpenRef.current = false;
    queryRef.current = '';
    if (bodyRef.current) clearMatches(bodyRef.current);
  }, []);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent): void => {
      // Scoped to THIS panel's subtree, which is the whole argument against
      // `webContents.findInPage` in a docked viewer (§5.30 as corrected): the
      // main window holds other sessions' panes, and a find that reaches them
      // is a find that lies about where its matches are.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && mode === 'rendered') {
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
        findOpenRef.current = true;
        // after paint, so the input exists
        requestAnimationFrame(() => findInputRef.current?.focus());
      } else if (e.key === 'Escape' && findOpen) {
        e.preventDefault();
        closeFind();
      }
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [mode, findOpen, closeFind]);

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
    if (findOpen) closeFind();
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
      ref={rootRef}
      style={rootStyle}
      data-testid="document-viewer"
      data-doc-session={attribution ? '' : undefined}
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
        <button
          type="button"
          className="doc-btn doc-pin"
          data-testid="doc-pin"
          aria-pressed={pinned}
          title={pinned ? t('document.unpin') : t('document.pin')}
          aria-label={pinned ? t('document.unpin') : t('document.pin')}
          onClick={() => props.onPinnedChange?.(!pinned)}
        >
          {pinned ? t('document.icon.pinned') : t('document.icon.unpinned')}
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

      {truncated && ok ? (
        <div className="doc-notice" role="status" data-testid="doc-truncated">
          {t('document.truncated', {
            shown: formatBytes(ok.bytes ?? 0),
            size: formatBytes(ok.size),
          })}
        </div>
      ) : null}

      {findOpen && showRendered ? (
        <div className="doc-find" role="search">
          <input
            ref={findInputRef}
            className="doc-find-input"
            type="text"
            value={query}
            placeholder={t('document.findPlaceholder')}
            aria-label={t('document.find')}
            onChange={(e) => {
              setQuery(e.target.value);
              queryRef.current = e.target.value;
              scheduleFind(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="doc-find-count" data-testid="doc-find-count">
            {matches === 0
              ? t('document.findNone')
              : t('document.findCount', { n: matchAt + 1, total: matches })}
          </span>
          <button
            type="button"
            className="doc-btn"
            onClick={() => step(-1)}
            title={t('document.findPrev')}
            aria-label={t('document.findPrev')}
          >
            {t('document.icon.back')}
          </button>
          <button
            type="button"
            className="doc-btn"
            onClick={() => step(1)}
            title={t('document.findNext')}
            aria-label={t('document.findNext')}
          >
            {t('document.icon.forward')}
          </button>
          <button
            type="button"
            className="doc-btn"
            onClick={closeFind}
            title={t('document.close')}
            aria-label={t('document.close')}
          >
            {t('document.icon.close')}
          </button>
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
          <div className="doc-main">
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
            />
          </React.Suspense>
        </div>
      )}
    </div>
  );
}
