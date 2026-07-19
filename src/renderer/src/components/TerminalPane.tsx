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
      if (!termRef.current) return;
      fit.fit();
      window.switchboard.pty.resize(props.sessionId, term.cols, term.rows);
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
    void window.switchboard.pty.attach(props.sessionId).then((snapshot) => {
      if (cancelled) return;
      term.reset();
      if (snapshot) term.write(snapshot);
      off = window.switchboard.pty.onData(props.sessionId, (d) => term.write(d));
      fitRef.current?.fit();
      window.switchboard.pty.resize(props.sessionId, term.cols, term.rows);
    });
    return () => {
      cancelled = true;
      off?.();
      window.switchboard.pty.detach(props.sessionId);
    };
  }, [props.sessionId, props.visible]);

  return <div ref={hostRef} style={{ blockSize: '100%', inlineSize: '100%' }} />;
}
