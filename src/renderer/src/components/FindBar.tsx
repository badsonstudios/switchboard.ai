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
// WHAT THIS COMPONENT DOES NOT DO: search. It resolves `find-provider`
// contributions (§5.23) and asks them. That indirection is the correctness
// argument §5.31 makes against `webContents.findInPage` — a provider is
// reached by naming a card and a panel, so a search cannot leak into the three
// other cards on screen.
//
// ONE CTRL+F, RESULTS GROUPED BY VIEW (P2-E17-03, §5.31's first decision).
// Since the Terminal got a provider there are two `bar` registrants on a card,
// and the bar asks BOTH: "1 of 3" is a position inside one group, and the line
// under it reads "12 in Session · 3 in Terminal (scrollback only)". The two
// counts are never added together — the transcript is the whole session and
// xterm is 5,000 ring-buffered lines, so one number over both would be true of
// nothing. `lib/find-groups.ts` holds that arithmetic and the argument.
//
// The FOCUSED panel keeps two jobs: its provider's `unavailableKey` is what
// greys the bar (E17-02's guarantee — a panel that cannot be searched says so),
// and the first match is taken from ITS group when it has one, because find
// starting somewhere you cannot see is not find.
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
import type { FindContext, FindHit, FindResults, PanelId } from '../extensibility/contributions';
import {
  findMode,
  findProviderFor,
  findUnavailableKey,
  listFindProviders,
} from '../extensibility/find-providers';
import { rendererRegistry } from '../extensibility/registry-instance';
import { safely } from '../extensibility/boundary';
import {
  findSurfaceFor,
  findSurfaceKey,
  findSurfacesVersion,
  subscribeFindSurfaces,
} from '../lib/find-surfaces';
import {
  buildFindGroups,
  EMPTY_GROUPS,
  failedResults,
  initialStep,
  noticesOf,
  positionIn,
  type FindGroupsView,
} from '../lib/find-groups';
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
  /**
   * The LIVE session id of the card this bar belongs to — ABSENT over a
   * document (#533).
   *
   * A §5.30 viewer is session-ATTRIBUTED and not session-owned: it outlives any
   * session and needs none, so there is no live id to pass and inventing one
   * would be a lie the session provider would then act on. Absent reads through
   * as `''`, which `find-session`'s `unavailableKey` already refuses with
   * `find.unavailable.noSession` — so the Session group is simply not one of
   * this bar's groups, by the check that was already there.
   */
  sessionId?: string;
  /**
   * The card — half of the key that makes "this card only" structural.
   *
   * Over a document this is the `doc-` PANEL id, which plays the same role: it
   * is still true that a surface cannot be reached without naming the thing it
   * belongs to.
   */
  cardId: string;
  /** the panel that has the user's attention right now */
  panelId: PanelId;
  /** that panel's title key, so the greyed message can NAME the tab */
  panelTitleKey: string;
  /**
   * How far down the surface the bar hangs, in px (default 6).
   *
   * A card's chrome above the bar is a tab strip, which the bar may sit over —
   * it names the tab it is searching, so covering the strip costs nothing. A
   * §5.30 document's chrome is its only CONTROLS (the mode toggle, Open
   * externally, Reveal, pop out), and a bar parked on top of them takes them
   * away for as long as find is open.
   */
  insetBlockStart?: number;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const bar = React.useSyncExternalStore(subscribeFindBar, findBarState);
  // Surfaces come and go with their panels, and this component reads SEVERAL
  // of them (one per group), so the snapshot is a version token rather than a
  // surface: an array snapshot would be a new reference every render and
  // `useSyncExternalStore` would loop.
  const surfacesVersion = React.useSyncExternalStore(subscribeFindSurfaces, findSurfacesVersion);
  const locale = i18n.language;

  const provider = findProviderFor(rendererRegistry, props.panelId);
  const cardId = props.cardId;
  const sessionId = props.sessionId ?? '';
  const contextFor = React.useCallback(
    (panelId: string): FindContext => {
      // read through the version token deliberately: it is what makes this
      // callback's identity — and every memo built on it — change when a panel
      // publishes or withdraws its surface
      void surfacesVersion;
      return { sessionId, cardId, surface: findSurfaceFor(findSurfaceKey(cardId, panelId)), locale };
    },
    [sessionId, cardId, locale, surfacesVersion],
  );

  const ctx = React.useMemo(() => contextFor(props.panelId), [contextFor, props.panelId]);

  // The FOCUSED panel still decides whether find runs at all — §5.8's
  // greyed-not-hidden rule, and the guarantee E17-02 shipped: a panel that
  // cannot be searched says so instead of quietly searching something else.
  // What it no longer decides is which surfaces get searched (see `groups`).
  const unavailableKey = provider ? findUnavailableKey(provider, ctx) : 'find.unavailable.noProvider';
  // Per SURFACE, not per registrant (#533): the document provider is `bar` over
  // rendered markdown and `delegated` over its Monaco source body, and which
  // one is on screen is a question only the live surface can answer.
  const mode = provider ? findMode(provider, ctx) : null;

  // Every `bar` registrant that can be searched on THIS card, in `order`.
  // Delegated providers are absent by construction: they never render our bar,
  // so they can never be one of its groups — asked of each provider with ITS
  // OWN context, for the same reason `unavailableKey` is.
  const groupProviders = React.useMemo(() => {
    if (mode !== 'bar' || unavailableKey) return [];
    return listFindProviders(rendererRegistry)
      .map((p) => ({ p, groupCtx: contextFor(p.panelId) }))
      .filter(
        ({ p, groupCtx }) => findMode(p, groupCtx) === 'bar' && !findUnavailableKey(p, groupCtx)
      );
  }, [mode, unavailableKey, contextFor]);

  // TWO REFS, and the split is what stops a search restarting for no reason.
  //
  // `entries` is the CURRENT set, refreshed every render, and it is what
  // `reveal`/`clear` read — so a surface that re-published (a tab switch, a
  // popout re-parenting) is reached without the search knowing or caring.
  //
  // `searched` is the set the last query actually ran against, and it is what
  // `clearAll` undoes. Those are not the same list: switching to the Changes
  // tab empties the current one, and clearing "whatever is registered now"
  // would then strand the terminal's highlights and the feed's forced-open
  // blocks with nobody left holding a reference to them.
  //
  // Why refs rather than effect dependencies: `findSurfacesVersion` is
  // PROCESS-GLOBAL, so a DiffPane mounting in another card bumps it. If the
  // search effect depended on the derived array, that unrelated mount would
  // re-run the query 200 ms later, re-walk the terminal, and drop the user from
  // "7 of 12" back to the first hit. The effect keys on `groupKey` — which
  // panels are searchable — instead.
  const entriesRef = React.useRef<typeof groupProviders>([]);
  entriesRef.current = groupProviders;
  const searchedRef = React.useRef<typeof groupProviders>([]);

  const [view, setView] = React.useState<FindGroupsView>(EMPTY_GROUPS);
  const [searched, setSearched] = React.useState(false);
  const [index, setIndex] = React.useState(-1);
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<HTMLInputElement | null>(null);
  const closeBtn = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const steps = view.steps;

  // ── open / close ────────────────────────────────────────────────────────
  //
  // The nonce, not just the mount: a second Ctrl+F on an already-open bar
  // re-focuses and selects, which is what every browser does and the only way
  // to retype over a sticky term without reaching for the mouse.
  React.useEffect(() => {
    const root = input.current ?? closeBtn.current;
    const active = root?.ownerDocument.activeElement as HTMLElement | null;
    // don't overwrite the anchor with one of the bar's own controls on a re-press
    if (active && active !== input.current && active !== closeBtn.current) {
      returnFocusTo.current = active;
    }
    // A greyed bar's input is DISABLED, and focusing a disabled element is a
    // silent no-op — which would leave focus outside the bar, so Escape never
    // reached `onKeyDown` and the only way out was the mouse. Focus the close
    // button instead: still one keystroke, still the bar's own keys.
    if (input.current && !input.current.disabled) {
      input.current.focus();
      input.current.select();
    } else {
      closeBtn.current?.focus();
    }
  }, [bar.openNonce, unavailableKey]);

  // Clearing is per GROUP, not per focused panel: a search that highlighted a
  // terminal AND revealed a feed block has to undo both, and the terminal's
  // panel is `keepMounted` so it is still there holding decorations long after
  // the user switched tabs.
  const clearAll = React.useCallback(() => {
    // The UNION of what is registered now and what the last query actually ran
    // against. Neither list alone is enough: the current one is empty on the
    // Changes tab (where the terminal is still holding the highlights we
    // painted), and the searched one is empty before the first query (where
    // clearing is a harmless no-op that keeps "close always tidies up" true).
    // Live context wins where both have an entry — a panel may have
    // re-published, and it is the live surface that is holding the paint.
    const byId = new Map(searchedRef.current.map((e) => [e.p.manifest.id, e]));
    for (const e of entriesRef.current) byId.set(e.p.manifest.id, e);
    searchedRef.current = [];
    for (const { p, groupCtx } of byId.values()) {
      if (p.clear) safely(p.manifest.id, 'clear()', () => p.clear?.(groupCtx), undefined);
    }
  }, []);

  const close = React.useCallback(() => {
    clearAll();
    closeFindBar();
    const el = returnFocusTo.current;
    // rAF because the bar is still mounted synchronously (the palette's
    // lesson); `isConnected` because a tab switch may have unmounted the
    // element we were anchored to, and focusing a detached node is a silent
    // no-op that strands focus on <body>
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus?.();
    });
  }, [clearAll]);

  // Unmount is also a close: focusing another card, or closing this one, takes
  // the bar away without anyone calling `close()`, and the feed would be left
  // holding a highlight and a set of force-expanded blocks. Through a ref so
  // the cleanup runs ONLY on unmount — a deps-driven version would clear the
  // reveal every time the query changed.
  const clearRef = React.useRef<() => void>(() => {});
  clearRef.current = clearAll;
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
    if (!provider || mode !== 'delegated' || unavailableKey) return;
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
  }, [provider, mode, unavailableKey, ctx, bar.openNonce]);

  // A provider's `FindHit.ref` is ITS OWN private token — a Feed seq here, an
  // xterm buffer position there. Carrying a result set across a change in WHICH
  // providers are grouped would hand one of them another's tokens, so the
  // results go when the set does.
  const groupKey = groupProviders.map(({ p }) => p.manifest.id).join('|');
  React.useEffect(() => {
    // and UNDO what the previous set painted before forgetting it: switching to
    // Changes (or onto a panel with no provider) empties the set, and the
    // highlights it leaves behind have no other owner
    clearAll();
    setView(EMPTY_GROUPS);
    setSearched(false);
    setIndex(-1);
  }, [groupKey, clearAll]);

  // ── searching ───────────────────────────────────────────────────────────
  //
  // EVERY group, not just the focused one (§5.31's first decision). The
  // "never matches another card" guarantee is untouched: a group is reached by
  // naming a card AND a panel, and the only card named here is this one.
  /**
   * The current step could be counted but not scrolled to (#557).
   *
   * State rather than a derived read of `steps[index].hit.jumpable`, because
   * the second way to get here is only knowable at reveal time: a provider that
   * accepted the hit and then reported it did not move.
   */
  const [stuck, setStuck] = React.useState(false);
  const revealStep = React.useCallback((v: FindGroupsView, i: number): void => {
    const step = v.steps[i];
    if (!step?.hit.jumpable) {
      // NOT `setFindListOpen(true)` any more (#557). Opening the results list
      // because one hit could not be jumped to is the app taking the pane over
      // in response to a keystroke that asked for a step — the owner's words
      // for it were "this weird window that showed the different points in the
      // session". The bar says so instead, in one quiet line, and the list
      // stays behind its own `▸` for whoever wants it.
      setStuck(!!step);
      return;
    }
    setStuck(false);
    const group = v.groups[step.groupIndex];
    const entry = entriesRef.current.find(({ p }) => p.manifest.id === group?.id);
    if (!entry?.p.reveal) return;
    // a provider that says it did NOT move is not an error — the list is where
    // that match lives, the same policy the transcript's evicted hits get
    //
    // `findQuery()` rather than a closed-over term (#520): a surface that
    // decorates what it reveals needs the term, and reading the LIVE bar state
    // here keeps this callback dependency-free — closing over the three query
    // fields would rebuild it on every keystroke and re-run the search effect
    // that depends on it.
    //
    // For the AUTO-reveal the two cannot disagree: the effect checks
    // `cancelled` before it reveals, so a term that changed under the await has
    // already abandoned this step. For an Enter or a row click inside the
    // debounce window they can, briefly — `view` still holds the previous
    // term's hits — and the surface then jumps to the old hit and decorates the
    // new term. It is one keystroke's worth of wrong and the next search
    // corrects it; carrying the query on the step set is the fix if it ever
    // reads as a bug rather than as latency.
    const moved = safely(
      entry.p.manifest.id,
      'reveal()',
      () => entry.p.reveal?.(entry.groupCtx, step.hit, findQuery()) ?? false,
      false,
    );
    // Same rule for the other way a step can fail to land (#557): the provider
    // took the hit and reported it did not move. Say it; do not open anything.
    setStuck(!moved);
  }, []);

  const term = bar.term;
  const { caseSensitive, wholeWord } = bar;
  const focusedPanelId = props.panelId;
  React.useEffect(() => {
    if (groupKey === '') return;
    if (term === '') {
      clearAll();
      setView(EMPTY_GROUPS);
      setSearched(false);
      setIndex(-1);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const id = setTimeout(() => {
      void (async () => {
        // pinned at the moment of the query, so `clearAll` undoes exactly what
        // was painted even if the registered set changes underneath
        const groupProviders = entriesRef.current;
        searchedRef.current = groupProviders;
        // The provider contract says it never throws; belt and braces anyway,
        // because a find that takes the window down is worse than no find. One
        // provider failing costs its own group, never the others' — the same
        // fail-open rule the point states.
        const settled = await Promise.all(
          groupProviders.map(async ({ p, groupCtx }): Promise<FindResults> => {
            try {
              return (
                (await p.search?.(groupCtx, { term, caseSensitive, wholeWord })) ?? {
                  hits: [],
                  total: 0,
                  truncated: false,
                }
              );
            } catch (err) {
              console.error('[find] provider search failed', p.manifest.id, err);
              return failedResults('find.notice.failed');
            }
          }),
        );
        if (cancelled) return;
        const next = buildFindGroups(
          groupProviders.map(({ p }, i) => ({
            id: p.manifest.id,
            panelId: p.panelId,
            labelKey: p.labelKey,
            results: settled[i],
          })),
        );
        setView(next);
        setSearched(true);
        setBusy(false);
        // Land on the first match as you type — the browser rhythm, starting
        // in the view the user is actually looking at.
        const start = initialStep(next, focusedPanelId);
        setIndex(start);
        if (start >= 0) revealStep(next, start);
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setBusy(false);
    };
  }, [groupKey, term, caseSensitive, wholeWord, revealStep, focusedPanelId, clearAll]);

  /**
   * Move to a hit — and make sure SOMETHING happens.
   *
   * A hit that cannot be jumped to has nothing on screen to scroll to, so
   * stepping onto one would tick the count from "3 of 12" to "4 of 12" and
   * leave the conversation exactly where it was. That is the same dead
   * affordance this file refuses to render as a button, one keystroke later.
   * So landing on one OPENS THE RESULTS LIST, where the snippet and the reason
   * are: the only place the match exists.
   */
  const goTo = React.useCallback(
    (i: number): void => {
      setIndex(i);
      revealStep(view, i);
    },
    [view, revealStep],
  );

  const step = React.useCallback(
    (delta: number): void => {
      if (steps.length === 0) return;
      goTo((index + delta + steps.length) % steps.length);
    },
    [steps, index, goTo],
  );

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
  //
  // "1 of 3" is a position WITHIN ONE GROUP and never across two. The transcript
  // and the terminal see different depths of the same session, so a running
  // total over both would be a number that is true of nothing (§5.31, and
  // `lib/find-groups.ts`'s header). Which group it is, and what every other
  // group found, is the line underneath.
  const notices = noticesOf(view);
  const at = positionIn(view, index);
  // Every group failed is NOT "no results" — one says the session does not
  // contain it, the other says we could not look. The status region is what a
  // screen reader hears, so it must not be the confident one; the error notice
  // underneath carries the truth.
  const allFailed =
    view.groups.length > 0 && view.groups.every((g) => g.notice?.tone === 'error');
  const countText = ((): string => {
    if (unavailableKey) return '';
    if (term === '') return '';
    if (busy) return t('find.searching');
    if (!searched) return '';
    if (allFailed) return '';
    if (!view.any) return t('find.noResults');
    if (!at) return '';
    if (at.total > at.shown) {
      return t(at.totalIsFloor ? 'find.countTruncatedAtLeast' : 'find.countTruncated', {
        index: at.position,
        shown: at.shown,
        total: at.total,
      });
    }
    return t(at.totalIsFloor ? 'find.countAtLeast' : 'find.count', {
      index: at.position,
      total: at.total,
    });
  })();

  // Drawn once there are two of them, and then ALWAYS — including the zeros.
  // A group that vanished at 0 would make absence look like the search never
  // reached that surface, which is the exact thing the label is here to stop.
  const showGroups = searched && !unavailableKey && term !== '' && view.groups.length > 1;

  const listId = React.useId();
  const listOpen = bar.listOpen && steps.length > 0;

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
        insetBlockStart: props.insetBlockStart ?? 6,
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
          disabled={steps.length === 0}
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
          disabled={steps.length === 0}
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
          disabled={steps.length === 0}
          onClick={() => setFindListOpen(!bar.listOpen)}
          style={bar.listOpen ? chipOn : chip}
        >
          {t(listOpen ? 'find.iconListOpen' : 'find.iconListClosed')}
        </button>
        <button
          type="button"
          title={t('find.close')}
          aria-label={t('find.close')}
          ref={closeBtn}
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

      {/* §5.31's grouped count. Every group, every time — the zeros are the
          point: "0 in Terminal (scrollback only)" is a different statement from
          silence, and only one of them is true. */}
      {/* NOT a second live region, deliberately: the count above is
          `role="status"`, and two polite regions updating on the same keystroke
          talk over each other. The compromise is that a screen reader hears
          "1 of 3" without the group name and has to read this line for it —
          which is why the current group is marked `aria-current` rather than
          only bolded. Revisit if a second locale or a real screen-reader pass
          says the number alone is too thin. */}
      {showGroups && (
        <div data-testid="find-groups" style={{ fontSize: 10, color: 'var(--muted)', maxInlineSize: 420 }}>
          {view.groups.map((g, i) => (
            <span key={g.id}>
              {i > 0 && <span aria-hidden="true">{t('find.groupSeparator')}</span>}
              <span
                data-find-group={g.panelId}
                // the group the count above is counting inside
                aria-current={at?.groupIndex === i ? 'true' : undefined}
                style={{
                  color: at?.groupIndex === i ? 'var(--text)' : undefined,
                  fontWeight: at?.groupIndex === i ? 700 : undefined,
                }}
              >
                {t(g.totalIsFloor ? 'find.groupCountAtLeast' : 'find.groupCount', {
                  total: g.total,
                  group: t(g.labelKey),
                })}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* The one hit you are ON cannot be scrolled to (#557).
          A line in the BAR, where the count already is, because that is the
          honest half of what the results list used to be opened to say — and
          the list is still one `▸` away for the snippet itself. Rendered above
          the group notices deliberately: this one is about the keystroke just
          pressed, and it must not be read as a property of the whole search. */}
      {stuck && !unavailableKey && term !== '' && (
        <div data-testid="find-stuck" style={{ fontSize: 10, color: 'var(--muted)', maxInlineSize: 420 }}>
          {t('find.hitNotJumpable')}
        </div>
      )}

      {/* One container, N lines: a group can raise its own notice and two of
          them must not fight over one slot. Named by group once there is more
          than one, so "showing the first 200" says WHICH surface capped. */}
      {notices.length > 0 && !unavailableKey && (
        <div data-testid="find-notice" style={{ fontSize: 10, maxInlineSize: 420 }}>
          {notices.map(({ groupIndex, notice }) => (
            <div
              key={view.groups[groupIndex]?.id ?? groupIndex}
              style={{ color: notice.tone === 'error' ? 'var(--status-needs-input-ink)' : 'var(--muted)' }}
            >
              {view.groups.length > 1
                ? t('find.noticeInGroup', {
                    group: t(view.groups[groupIndex]!.labelKey),
                    message: t(notice.key, notice.params),
                  })
                : t(notice.key, notice.params)}
            </div>
          ))}
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
          {steps.map((s, i) => (
            <React.Fragment key={s.hit.id}>
              {/* a heading before each group's run, so a snippet is never
                  attributed to the wrong surface. Only when there IS more than
                  one — a lone heading over the only list is noise. */}
              {view.groups.length > 1 && (i === 0 || steps[i - 1]!.groupIndex !== s.groupIndex) && (
                <div
                  data-testid="find-group-header"
                  style={{
                    fontSize: 9,
                    color: 'var(--faint)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    padding: '4px 5px 2px',
                  }}
                >
                  {t(view.groups[s.groupIndex]!.labelKey)}
                </div>
              )}
              <HitRow hit={s.hit} current={i === index} onGo={() => goTo(i)} />
            </React.Fragment>
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
  const whyKey = hit.earlierThanLoaded ? 'find.earlierTitle' : 'find.cannotJumpTitle';
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
      // WHICH reason, not a blanket one: a hit can lack a seq because it was
      // evicted, because the watcher has not drained those lines yet, or
      // because the session could not be aligned at all — and on a Direct
      // session the last of those is the normal case. Asserting "further back
      // in the session" about all three is the small lie told confidently that
      // §5.31 exists to avoid.
      title={t(whyKey)}
      style={{ ...box, opacity: 0.85 }}
    >
      {body}
    </div>
  );
}
