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
import {
  findSurfaceKey,
  publishFindSurface,
  type TerminalFindOutcome,
  type TerminalFindSurface,
} from '../lib/find-surfaces';
import { clearTerminalSearch, revealTerminalMatch, searchTerminal } from '../lib/terminal-find';
import { TerminalShadow } from '../lib/terminal-shadow';

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
  // The off-screen replay of MAIN's ring buffer, built on demand when find asks
  // a pane that is not on screen (#517). Null until that happens, and disposed
  // the moment find is done with it — see the find effect.
  const shadowRef = useRef<TerminalShadow | null>(null);
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

  // ── find (P2-E17-03, §5.31; widened to main's ring buffer by #517) ─────────
  //
  // A SEPARATE effect from the terminal's lifecycle, keyed on the card: the
  // registry key is (cardId, panelId) and the surface has to come and go with
  // the pane, but re-creating the xterm because a card was renamed would throw
  // the scrollback away. Nothing is published without a cardId — a terminal
  // nobody can name is a terminal find must not reach.
  //
  // TWO BUFFERS, ONE SURFACE, AND THE ANSWER SAYS WHICH IT CAME FROM.
  //
  // S-07's verdict is that a hidden pane is ingest-only: main keeps the ring
  // buffer, and the renderer's xterm is attached (and fed) ONLY while the tab
  // is showing. The Session view is the DEFAULT tab, so on a card whose
  // Terminal has never been opened THIS xterm holds nothing at all.
  //
  // #516 answered that by withholding the group with a reason ("open the
  // Terminal tab") rather than printing "0 in Terminal (scrollback only)" about
  // a buffer with no lines. Honest, and narrower than it needed to be — the
  // complete scrollback was in main the whole time. So:
  //
  //   • pane LIVE   → the xterm on screen. Exact, highlighted, jumpable.
  //   • otherwise   → an off-screen replay of main's ring buffer
  //                   (`lib/terminal-shadow.ts`). Real counts for a tab that
  //                   was never opened; nothing rendered to scroll, so the hits
  //                   come back `live: false` and the bar does not offer a jump.
  //   • no PTY      → `null`. "We could not look" is not "we looked and found
  //                   none", and the provider renders the two differently.
  //
  // The group is therefore always AVAILABLE for a session that has a terminal,
  // and there is no `ready()` left to gate it: what used to be an availability
  // question is now a fact about where the answer came from.
  useEffect(() => {
    const cardId = props.cardId;
    if (!cardId) return;
    /** the off-screen replay, built the first time a hidden pane is searched */
    const shadow = (): TerminalShadow => {
      shadowRef.current ??= new TerminalShadow({
        read: () => window.switchboard.pty.snapshot(props.sessionId),
      });
      return shadowRef.current;
    };
    const dropShadow = (): void => {
      shadowRef.current?.dispose();
      shadowRef.current = null;
    };
    const surface: TerminalFindSurface = {
      kind: 'terminal',
      search: async (query): Promise<TerminalFindOutcome | null> => {
        const term = termRef.current;
        const addon = searchRef.current;
        if (term && addon && liveRef.current) {
          return { ...searchTerminal(term, addon, query), live: true };
        }
        const out = await shadow().search(query);
        return out && { ...out, live: false };
      },
      reveal: (match) => {
        // only a LIVE pane can be scrolled: the off-screen replay has no
        // viewport, and its hits are published `live: false` so the bar never
        // offers this for one
        const term = termRef.current;
        return term && liveRef.current ? revealTerminalMatch(term, match) : false;
      },
      clear: () => {
        const term = termRef.current;
        const addon = searchRef.current;
        if (term && addon) clearTerminalSearch(term, addon);
        // find is done with us: let a whole second xterm go rather than keep
        // one per card alive for the rest of the session
        dropShadow();
      },
    };
    const unpublish = publishFindSurface(findSurfaceKey(cardId, 'terminal'), surface);
    return () => {
      unpublish();
      dropShadow();
    };
  }, [props.cardId, props.sessionId]);

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
