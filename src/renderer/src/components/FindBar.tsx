// The find bar (P2-E17-02, §5.31): Ctrl+F, the way a browser means it.
//
// A bar, a term, Enter and Shift+Enter to step, a count, Esc to close — plus
// §5.31's one addition to that rhythm, an expandable RESULTS LIST. The list is
// not a nicety: roughly a third of a long session is already out of the
// renderer's view buffer (E17-01 measured 1,579 blocks against a `BLOCK_CAP`
// of 1,000 on a real 4,697-line transcript), and you cannot scroll to a block
// that no longer exists. For those hits the list is the only surface there is,
// so they show a generous snippet and say plainly that they are earlier than
// the loaded view.
//
// WHAT THIS COMPONENT DOES NOT DO: search. It resolves the FOCUSED panel's
// `find-provider` (§5.23) and asks it. That indirection is the correctness
// argument §5.31 makes against `webContents.findInPage` — a provider is
// reached by naming a card and a panel, so a search cannot leak into the three
// other cards on screen.
//
// A11y (§5.32), and one deliberate departure from the modal precedents:
//
//  • The bar is NOT a focus trap and must not become one. `UpdateDialog` and
//    `CommandPalette` are modals; this is a non-modal widget over a live
//    conversation, and trapping Tab inside it would be an actual 2.1.2
//    keyboard trap. Escape closes and returns focus; Tab leaves, as it should.
//  • Every control is a real `<button>` (rule 1) and the bar itself stays a
//    role-less container of them (rule 2) apart from the `search` landmark,
//    which is true — and there is only ever ONE bar open, so it cannot become
//    the N-identical-landmarks problem §5.30 warns about.
//  • The count lives in a `role="status"` region that is MOUNTED EMPTY on the
//    first frame (#222): a live region inserted already holding text is
//    announced by almost nothing.
//  • A hit that cannot be jumped to is NOT a button. An affordance that does
//    nothing is the same lie as searching the DOM, one interaction later.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FindHit, FindResults, PanelId } from '../extensibility/contributions';
import { findProviderFor, findUnavailableKey } from '../extensibility/find-providers';
import { rendererRegistry } from '../extensibility/registry-instance';
import { safely } from '../extensibility/boundary';
import { findSurfaceFor, findSurfaceKey, subscribeFindSurfaces } from '../lib/find-surfaces';
import {
  closeFindBar,
  findBarState,
  findQuery,
  setFindListOpen,
  setFindOptions,
  setFindTerm,
  subscribeFindBar,
} from '../lib/find-bar-state';

/** How long after the last keystroke we ask. Long enough that typing a word
 *  is one scan of a multi-megabyte file, short enough to feel live. */
const DEBOUNCE_MS = 200;

const chip: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  background: 'transparent',
  color: 'var(--faint)',
  fontFamily: 'var(--font-ui)',
  fontSize: 10,
  lineHeight: '16px',
  padding: '0 6px',
  cursor: 'pointer',
};

const chipOn: React.CSSProperties = {
  ...chip,
  background: 'var(--chip)',
  color: 'var(--text)',
};

export function FindBar(props: {
  /** the LIVE session id of the card this bar belongs to */
  sessionId: string;
  /** the card — half of the key that makes "this card only" structural */
  cardId: string;
  /** the panel that has the user's attention right now */
  panelId: PanelId;
  /** that panel's title key, so the greyed message can NAME the tab */
  panelTitleKey: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bar = React.useSyncExternalStore(subscribeFindBar, findBarState);
  // a surface appears when its panel mounts — switching to Changes has to
  // re-resolve, or the bar would still be holding the feed's
  const surfaceKey = findSurfaceKey(props.cardId, props.panelId);
  const surface = React.useSyncExternalStore(subscribeFindSurfaces, () => findSurfaceFor(surfaceKey));

  const provider = findProviderFor(rendererRegistry, props.panelId);
  const ctx = React.useMemo(
    () => ({ sessionId: props.sessionId, cardId: props.cardId, surface }),
    [props.sessionId, props.cardId, surface],
  );
  const unavailableKey = provider ? findUnavailableKey(provider, ctx) : 'find.unavailable.noProvider';

  const [results, setResults] = React.useState<FindResults | null>(null);
  const [index, setIndex] = React.useState(-1);
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<HTMLInputElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const hits = results?.hits ?? [];

  // ── open / close ────────────────────────────────────────────────────────
  //
  // The nonce, not just the mount: a second Ctrl+F on an already-open bar
  // re-focuses and selects, which is what every browser does and the only way
  // to retype over a sticky term without reaching for the mouse.
  React.useEffect(() => {
    const active = input.current?.ownerDocument.activeElement as HTMLElement | null;
    // don't overwrite the anchor with the bar's own input on a re-press
    if (active && active !== input.current) returnFocusTo.current = active;
    input.current?.focus();
    input.current?.select();
  }, [bar.openNonce]);

  const close = React.useCallback(() => {
    if (provider?.clear) safely(provider.manifest.id, 'clear()', () => provider.clear?.(ctx), undefined);
    closeFindBar();
    const el = returnFocusTo.current;
    // rAF because the bar is still mounted synchronously (the palette's
    // lesson); `isConnected` because a tab switch may have unmounted the
    // element we were anchored to, and focusing a detached node is a silent
    // no-op that strands focus on <body>
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus?.();
    });
  }, [provider, ctx]);

  // Unmount is also a close: focusing another card, or closing this one, takes
  // the bar away without anyone calling `close()`, and the feed would be left
  // holding a highlight and a set of force-expanded blocks. Through a ref so
  // the cleanup runs ONLY on unmount — a deps-driven version would clear the
  // reveal every time the query changed.
  const clearRef = React.useRef<() => void>(() => {});
  clearRef.current = () => {
    if (provider?.clear) safely(provider.manifest.id, 'clear()', () => provider.clear?.(ctx), undefined);
  };
  React.useEffect(() => {
    return () => clearRef.current();
  }, []);

  // ── delegated providers (Changes → Monaco) ──────────────────────────────
  //
  // Hand the whole interaction over and get out of the way. Our bar never
  // renders for these; §5.31 says Monaco's find should not be reimplemented,
  // and wrapping our chrome around it would give one editor two bars' worth of
  // Escape targets and two match counts.
  React.useEffect(() => {
    if (!provider || provider.mode !== 'delegated' || unavailableKey) return;
    const ok = safely(
      provider.manifest.id,
      'delegate()',
      () => provider.delegate?.(ctx, findQuery()) ?? false,
      false,
    );
    // A refusal leaves the greyed bar up saying why; a success means the
    // surface owns the keyboard now, so we close without restoring focus —
    // the editor's find widget is where the user wants to be.
    if (ok) closeFindBar();
  }, [provider, unavailableKey, ctx, bar.openNonce]);

  // ── searching ───────────────────────────────────────────────────────────
  const reveal = React.useCallback(
    (hit: FindHit | undefined): void => {
      if (!hit?.jumpable || !provider?.reveal) return;
      safely(provider.manifest.id, 'reveal()', () => provider.reveal?.(ctx, hit) ?? false, false);
    },
    [provider, ctx],
  );

  const term = bar.term;
  const { caseSensitive, wholeWord } = bar;
  React.useEffect(() => {
    if (!provider || provider.mode !== 'bar' || unavailableKey) return;
    if (term === '') {
      setResults(null);
      setIndex(-1);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const id = setTimeout(() => {
      void (async () => {
        // The provider contract says it never throws; belt and braces anyway,
        // because a find that takes the window down is worse than no find.
        let res: FindResults;
        try {
          res = (await provider.search?.(ctx, { term, caseSensitive, wholeWord })) ?? {
            hits: [],
            total: 0,
            truncated: false,
          };
        } catch (err) {
          console.error('[find] provider search failed', err);
          res = { hits: [], total: 0, truncated: false, notice: { key: 'find.notice.failed', tone: 'error' } };
        }
        if (cancelled) return;
        setResults(res);
        setBusy(false);
        // Land on the first match as you type — the browser rhythm. Stepping
        // from there is Enter / Shift+Enter.
        setIndex(res.hits.length > 0 ? 0 : -1);
        reveal(res.hits[0]);
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setBusy(false);
    };
  }, [provider, unavailableKey, ctx, term, caseSensitive, wholeWord, reveal]);

  const step = React.useCallback(
    (delta: number): void => {
      if (hits.length === 0) return;
      const next = (index + delta + hits.length) % hits.length;
      setIndex(next);
      reveal(hits[next]);
    },
    [hits, index, reveal],
  );

  const goTo = (i: number): void => {
    setIndex(i);
    reveal(hits[i]);
  };

  // ── keys ────────────────────────────────────────────────────────────────
  const onKeyDown = (e: React.KeyboardEvent): void => {
    // the bar owns its keys while it is open — the same rule the modals use,
    // so a stray Enter never also submits the composer behind it
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    // a second Ctrl+F inside the bar selects the term instead of doing
    // nothing: the app-scope dispatcher cannot see this one (we are a text
    // input, and `classifyTarget` gives typing surfaces their keys back)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      input.current?.select();
    }
  };

  // ── the count, which is where the honesty lives ──────────────────────────
  const notice = results?.notice;
  const countText = ((): string => {
    if (unavailableKey) return '';
    if (term === '') return '';
    if (busy) return t('find.searching');
    if (!results) return '';
    if (results.total === 0) return t('find.noResults');
    if (results.truncated) {
      return t('find.countTruncated', { index: index + 1, shown: hits.length, total: results.total });
    }
    return t('find.count', { index: index + 1, total: results.total });
  })();

  const listId = React.useId();
  const listOpen = bar.listOpen && hits.length > 0;

  return (
    <div
      role="search"
      aria-label={t('find.label')}
      data-testid="find-bar"
      onKeyDown={onKeyDown}
      // absolutely positioned so opening it MOVES NOTHING (§5.31 litmus 5) —
      // the conversation underneath keeps its scroll position and its layout
      style={{
        position: 'absolute',
        insetBlockStart: 6,
        insetInlineEnd: 12,
        zIndex: 5,
        maxInlineSize: 'min(560px, calc(100% - 24px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        background: 'var(--panel2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: 'var(--tab-lift)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          ref={input}
          type="text"
          data-testid="find-input"
          value={term}
          disabled={!!unavailableKey}
          aria-label={t('find.label')}
          placeholder={t('find.placeholder')}
          onChange={(e) => setFindTerm(e.target.value)}
          style={{
            flex: 1,
            minInlineSize: 120,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            color: 'var(--text)',
            font: 'inherit',
            fontSize: 11,
            padding: '2px 6px',
            opacity: unavailableKey ? 0.55 : 1,
          }}
        />
        {/* MOUNTED EMPTY on the first frame (#222) — a live region that
            arrives already holding text is announced by almost nothing */}
        <div
          role="status"
          aria-live="polite"
          data-testid="find-count"
          style={{ fontSize: 10, color: 'var(--muted)', minInlineSize: 58, textAlign: 'end' }}
        >
          {countText}
        </div>
        <button
          type="button"
          title={t('find.previous')}
          aria-label={t('find.previous')}
          disabled={hits.length === 0}
          onClick={() => step(-1)}
          style={chip}
        >
          {t('find.iconPrevious')}
        </button>
        <button
          type="button"
          title={t('find.next')}
          aria-label={t('find.next')}
          data-testid="find-next"
          disabled={hits.length === 0}
          onClick={() => step(1)}
          style={chip}
        >
          {t('find.iconNext')}
        </button>
        <button
          type="button"
          title={t('find.caseSensitive')}
          aria-label={t('find.caseSensitive')}
          aria-pressed={caseSensitive}
          disabled={!!unavailableKey}
          onClick={() => setFindOptions({ caseSensitive: !caseSensitive })}
          style={caseSensitive ? chipOn : chip}
        >
          {t('find.iconCase')}
        </button>
        <button
          type="button"
          title={t('find.wholeWord')}
          aria-label={t('find.wholeWord')}
          aria-pressed={wholeWord}
          disabled={!!unavailableKey}
          onClick={() => setFindOptions({ wholeWord: !wholeWord })}
          style={wholeWord ? chipOn : chip}
        >
          {t('find.iconWholeWord')}
        </button>
        <button
          type="button"
          title={t('find.toggleResults')}
          aria-label={t('find.toggleResults')}
          aria-expanded={listOpen}
          aria-controls={listOpen ? listId : undefined}
          data-testid="find-results-toggle"
          disabled={hits.length === 0}
          onClick={() => setFindListOpen(!bar.listOpen)}
          style={bar.listOpen ? chipOn : chip}
        >
          {t(listOpen ? 'find.iconListOpen' : 'find.iconListClosed')}
        </button>
        <button
          type="button"
          title={t('find.close')}
          aria-label={t('find.close')}
          data-testid="find-close"
          onClick={close}
          style={chip}
        >
          {t('find.iconClose')}
        </button>
      </div>

      {unavailableKey && (
        <div data-testid="find-unavailable" style={{ fontSize: 10, color: 'var(--muted)', maxInlineSize: 420 }}>
          {t(unavailableKey, { view: t(props.panelTitleKey) })}
        </div>
      )}

      {notice && !unavailableKey && (
        <div
          data-testid="find-notice"
          style={{
            fontSize: 10,
            color: notice.tone === 'error' ? 'var(--status-needs-input-ink)' : 'var(--muted)',
            maxInlineSize: 420,
          }}
        >
          {t(notice.key, notice.params)}
        </div>
      )}

      {listOpen && (
        <div
          id={listId}
          data-testid="find-results"
          // focusable so the list can be scrolled from the keyboard; no role,
          // because it is a container of controls (§5.32 rule 2)
          tabIndex={0}
          aria-label={t('find.results')}
          style={{
            maxBlockSize: 220,
            overflowY: 'auto',
            borderBlockStart: '1px solid var(--border)',
            paddingBlockStart: 4,
          }}
        >
          {hits.map((h, i) => (
            <HitRow key={h.id} hit={h} current={i === index} onGo={() => goTo(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One result.
 *
 * A jumpable hit is a real `<button>`; one that is not is a plain `<div>` with
 * the marker that says why. That asymmetry is the §5.31 v1 boundary rendered
 * honestly: the block is out of the renderer's view buffer, there is nothing
 * to scroll to, and offering a control that does nothing would teach the user
 * the feature is broken rather than bounded.
 */
function HitRow({
  hit,
  current,
  onGo,
}: {
  hit: FindHit;
  current: boolean;
  onGo: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const before = hit.snippet.slice(0, hit.matchStart);
  const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
  const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
  const body = (
    <>
      <div style={{ fontSize: 10.5, color: 'var(--text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {before}
        <mark style={{ background: 'var(--chip)', color: 'var(--text)', fontWeight: 700 }}>{match}</mark>
        {after}
      </div>
      <div style={{ fontSize: 9, color: 'var(--faint)', marginBlockStart: 1 }}>
        {hit.metaKey ? t(hit.metaKey, hit.metaParams) : ''}
        {hit.earlierThanLoaded && (
          <span data-testid="find-earlier" style={{ marginInlineStart: 6, fontStyle: 'italic' }}>
            {t('find.earlier')}
          </span>
        )}
      </div>
    </>
  );
  const box: React.CSSProperties = {
    display: 'block',
    inlineSize: '100%',
    textAlign: 'start',
    background: current ? 'var(--chip)' : 'transparent',
    border: 'none',
    borderRadius: 4,
    padding: '3px 5px',
    font: 'inherit',
  };
  return hit.jumpable ? (
    <button
      type="button"
      data-find-hit=""
      aria-current={current ? true : undefined}
      onClick={onGo}
      style={{ ...box, cursor: 'pointer' }}
    >
      {body}
    </button>
  ) : (
    <div
      data-find-hit=""
      data-find-hit-readonly=""
      title={t('find.earlierTitle')}
      style={{ ...box, opacity: 0.85 }}
    >
      {body}
    </div>
  );
}
