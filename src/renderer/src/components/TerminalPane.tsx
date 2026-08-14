// Terminal pane (P1-E3-02): xterm wired to a session's PTY over the bridge.
// S-07 verdict enforced here: the xterm attaches (and receives data) ONLY
// while the pane is visible; hidden panes cost nothing in the renderer — the
// main process keeps the ring buffer, and re-attach replays it.
import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { attachTerminalFeed } from '../lib/terminal-attach';
import { findSurfaceKey, publishFindSurface, type TerminalFindSurface } from '../lib/find-surfaces';
import { clearTerminalSearch, revealTerminalMatch, searchTerminal } from '../lib/terminal-find';

export function TerminalPane(props: {
  sessionId: string;
  visible: boolean;
  /** the card, so find can reach THIS terminal and no other (P2-E17-03) */
  cardId?: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Is this xterm holding a CURRENT view of the PTY right now? See the find
  // effect below — this is the difference between "0 matches in the terminal"
  // and "a confident 0 about a buffer we never filled".
  const liveRef = useRef(false);
  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;

  // Fit ONLY when the host has real, finite dimensions. During a dockview
  // layout change (popout dock-back, tab switch, window move) the container is
  // transiently 0-size; FitAddon then proposes NaN cols/rows and xterm paints
  // garbage ("NaNMaN…") that never self-heals. Guard on proposeDimensions and
  // repaint afterwards. Returns true if a real resize was applied. (E8-04)
  const safeFit = (): boolean => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return false;
    if (host.clientWidth < 1 || host.clientHeight < 1) return false;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
    if (dims.cols < 2 || dims.rows < 1) return false;
    fit.fit();
    term.refresh(0, term.rows - 1); // force a repaint after the reflow
    return true;
  };

  // terminal lifecycle: created once per mounted pane
  useEffect(() => {
    const term = new Terminal({
      scrollback: 5000, // S-07 verdict
      // concrete stack: xterm can't resolve CSS custom properties
      fontFamily: "'IBM Plex Mono', Consolas, 'Cascadia Mono', monospace",
      fontSize: 13,
      // P2-E17-03: `@xterm/addon-search`'s match highlighting goes through
      // `registerDecoration`, which is PROPOSED API in xterm 6 — and without
      // this flag `findNext` THROWS rather than degrading (probed 2026-08-13,
      // see `lib/terminal-find.ts`). It gates API checks only; nothing about
      // what the CLI prints changes.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.onData((d) => window.switchboard.pty.input(props.sessionId, d));

    const ro = new ResizeObserver(() => {
      // hidden panes collapse to a 2x1 min; resizing the PTY there makes the
      // real CLI reflow its TUI into the ring buffer as garbage (S-07). Only
      // resize while visible and above the fit-addon minimum.
      if (!visibleRef.current) return;
      if (safeFit()) {
        window.switchboard.pty.resize(props.sessionId, term.cols, term.rows);
      }
    });
    ro.observe(hostRef.current!);

    return () => {
      ro.disconnect();
      window.switchboard.pty.detach(props.sessionId);
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [props.sessionId]);

  // ── find (P2-E17-03, §5.31) ────────────────────────────────────────────────
  //
  // A SEPARATE effect from the terminal's lifecycle, keyed on the card: the
  // registry key is (cardId, panelId) and the surface has to come and go with
  // the pane, but re-creating the xterm because a card was renamed would throw
  // the scrollback away. Nothing is published without a cardId — a terminal
  // nobody can name is a terminal find must not reach.
  //
  // THE SURFACE PUBLISHES ALWAYS; `ready()` IS WHAT GATES THE GROUP, and the
  // distinction is the difference between an honest answer and the exact lie
  // §5.31 wrote this item's done-when about.
  //
  // S-07's verdict is that a hidden pane is ingest-only: main keeps the ring
  // buffer, the renderer's xterm is attached (and fed) ONLY while the tab is
  // showing, and re-attach replays the snapshot. The Session view is the
  // DEFAULT tab, so on a card whose Terminal tab has never been opened this
  // xterm holds nothing at all — and a grouped count that read
  // "12 in Session · 0 in Terminal (scrollback only)" there would be stating
  // "not in the last 5,000 lines" about a buffer that has no lines, for output
  // that may have been printed thirty seconds ago. The same goes, more weakly,
  // for a terminal that was shown an hour ago and has been frozen since.
  //
  // So the group participates only while this pane is LIVE. Everywhere else it
  // is absent with a reason ("open the Terminal tab") rather than present with
  // a number. An absent group asks a question; a false zero answers one.
  useEffect(() => {
    const cardId = props.cardId;
    if (!cardId) return;
    const surface: TerminalFindSurface = {
      kind: 'terminal',
      ready: () => !!termRef.current && !!searchRef.current && liveRef.current,
      search: (query) => {
        const term = termRef.current;
        const addon = searchRef.current;
        if (!term || !addon) return { matches: [], total: 0, truncated: false, totalIsFloor: false };
        return searchTerminal(term, addon, query);
      },
      reveal: (match) => {
        const term = termRef.current;
        return term ? revealTerminalMatch(term, match) : false;
      },
      clear: () => {
        const term = termRef.current;
        const addon = searchRef.current;
        if (term && addon) clearTerminalSearch(term, addon);
      },
    };
    return publishFindSurface(findSurfaceKey(cardId, 'terminal'), surface);
  }, [props.cardId]);

  // visibility drives attach/detach (hidden panes are ingest-only in main)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!props.visible) {
      liveRef.current = false;
      // The feed owns the subscribe/detach pair (#117) — but there is no feed on
      // this path: either the previous run's cleanup already detached, or the
      // pane rendered hidden and never attached, where main treats this as a
      // no-op. Keep it, and don't split the pair for the attached path.
      window.switchboard.pty.detach(props.sessionId);
      return;
    }
    let cancelled = false;
    const raf: number[] = [];
    // Re-fit on show, but the container size often settles a frame or two
    // after a dockview dock-back/move — retry across a few frames until a
    // real fit lands so we never leave the terminal at NaN/stale geometry.
    const tryFit = (attemptsLeft: number): void => {
      if (cancelled) return;
      if (safeFit()) {
        window.switchboard.pty.resize(props.sessionId, term.cols, term.rows);
      } else if (attemptsLeft > 0) {
        raf.push(requestAnimationFrame(() => tryFit(attemptsLeft - 1)));
      }
    };
    // Subscribe-then-attach, so main never streams to a channel nobody is
    // listening on (#117). The sequencing lives in lib/terminal-attach.ts.
    const feed = attachTerminalFeed({
      subscribe: (cb) => window.switchboard.pty.onData(props.sessionId, cb),
      attach: () => window.switchboard.pty.attach(props.sessionId),
      detach: () => window.switchboard.pty.detach(props.sessionId),
      reset: () => term.reset(),
      write: (d) => term.write(d),
      onReady: () => {
        // the snapshot and the gap chunks are on screen: from here the xterm
        // is a current view of the PTY, which is what find is allowed to count
        liveRef.current = true;
        tryFit(10);
      },
      onError: (err) => console.warn('[terminal] feed problem', props.sessionId, err),
    });
    return () => {
      cancelled = true;
      liveRef.current = false;
      raf.forEach((h) => cancelAnimationFrame(h));
      feed.off(); // unsubscribes AND detaches, in that order
    };
  }, [props.sessionId, props.visible]);

  return <div ref={hostRef} style={{ blockSize: '100%', inlineSize: '100%' }} />;
}
