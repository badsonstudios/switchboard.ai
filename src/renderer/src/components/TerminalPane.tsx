// Terminal pane (P1-E3-02): xterm wired to a session's PTY over the bridge.
// S-07 verdict enforced here: the xterm attaches (and receives data) ONLY
// while the pane is visible; hidden panes cost nothing in the renderer — the
// main process keeps the ring buffer, and re-attach replays it.
import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane(props: { sessionId: string; visible: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;

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
    };
  }, [props.sessionId]);

  // visibility drives attach/detach (hidden panes are ingest-only in main)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!props.visible) {
      window.switchboard.pty.detach(props.sessionId);
      return;
    }
    let off: (() => void) | null = null;
    let cancelled = false;
    const raf: number[] = [];
    void window.switchboard.pty.attach(props.sessionId).then((snapshot) => {
      if (cancelled) return;
      term.reset();
      if (snapshot) term.write(snapshot);
      off = window.switchboard.pty.onData(props.sessionId, (d) => term.write(d));
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
      tryFit(10);
    });
    return () => {
      cancelled = true;
      raf.forEach((h) => cancelAnimationFrame(h));
      off?.();
      window.switchboard.pty.detach(props.sessionId);
    };
  }, [props.sessionId, props.visible]);

  return <div ref={hostRef} style={{ blockSize: '100%', inlineSize: '100%' }} />;
}
