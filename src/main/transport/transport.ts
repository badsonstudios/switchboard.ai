// The transport seam (P2-E18-02, epic E18).
//
// A session is a hosted CLI process; HOW we talk to that process is a choice,
// not a constant. DESIGN §6 (amended 2026-08-01) records two: the PTY
// (node-pty + xterm.js) and duplex stream-json over `child_process` pipes.
// This file is the vocabulary both satisfy.
//
// Deliberately NARROW. It is exactly what SessionManager needs to own a
// session's lifetime — spawn it, learn when it died, kill it. Everything
// transport-SPECIFIC stays on the concrete service and is reached through it:
// `resize`, the scrollback ring and the #117 attach epoch are PTY concepts and
// have no stream-json meaning, so widening this interface to cover them would
// force the stream transport to implement stubs that lie. `sessions/ipc.ts`
// keeps a concrete `PtyService` reference for those, which is why the terminal
// IPC is unchanged by this item.

// `TransportKind` and `DEFAULT_SESSION_TRANSPORT` live in `shared/transport.ts`
// (#381): the renderer needs both and may not reach into main. Re-exported here
// because this file is where every main-side caller already imports the
// vocabulary from, and moving ~40 call sites would bury the one real change.
export type { TransportKind } from '../../shared/transport';
export { DEFAULT_SESSION_TRANSPORT } from '../../shared/transport';
import type { TransportKind } from '../../shared/transport';

/**
 * The default when an ADAPTER's recipe says nothing — every pre-E18 adapter.
 *
 * Stays `pty`, and must: an adapter that returns a recipe without a transport
 * field has told us it does not speak stream-json, and reading that silence as
 * "stream" would hand a terminal-only CLI a protocol it cannot answer. That is
 * a different claim from `DEFAULT_SESSION_TRANSPORT`, which is what a USER's
 * silence means and is only ever a *request* — the adapter still answers, and
 * this constant is how the answer "I can't" is read.
 */
export const DEFAULT_TRANSPORT: TransportKind = 'pty';

export interface TransportSpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  /** env DELTAS over the (scrubbed) base env; undefined value = delete key */
  env?: Record<string, string | undefined>;
}

/** The handle on one hosted process, common to every transport. */
export interface TransportSession {
  pid: number;
  onExit(l: (code: number) => void): () => void;
  kill(): void;
  /**
   * Typed protocol messages, if this transport HAS any (P2-E18-05).
   *
   * Optional because the PTY genuinely does not: it carries bytes destined for
   * a terminal emulator, and the only way to get structure out of them is to
   * parse the CLI's own rendering — which amended P7 forbids outright
   * (PHILOSOPHY §5, screen-scraping as rejected precedent). So this is not a
   * gap to be filled later; it is a real difference between the transports, and
   * making it optional says so instead of forcing PtyService to fake it.
   */
  onMessage?(l: (m: Record<string, unknown>) => void): () => void;
  /**
   * Send one typed message to the CLI (P2-E18-06). Optional for the same reason
   * as `onMessage`: the PTY takes BYTES for a terminal to interpret, and a
   * prompt has to be dressed as a bracketed paste plus a delayed carriage
   * return before it counts as submitted (S-03). Those are not the same
   * operation wearing different clothes, so they do not share a method.
   *
   * Must be a no-op on a dead child, never a throw — writes to a closed pipe
   * raise asynchronously (the S-01 lesson).
   */
  send?(msg: unknown): void;
}

/**
 * What a transport implementation must provide to host sessions.
 *
 * `PtyService` satisfies this today (structurally — it is not declared as
 * implementing it, so the interface stays a consumer's view rather than a
 * constraint pushed back onto a P1 class). `StreamService` satisfies it in
 * P2-E18-03.
 */
export interface SessionTransport {
  spawn(opts: TransportSpawnOptions): TransportSession;
  remove(id: string): void;
}

/** Transports available to a SessionManager, keyed by what a recipe may ask for. */
export type TransportMap = Partial<Record<TransportKind, SessionTransport>>;

/**
 * Thrown when an adapter's recipe asks for a transport this host has no
 * implementation for.
 *
 * It THROWS rather than falling back to the PTY on purpose, and this is the
 * item's whole point. A silent fallback would hand a stream-json adapter a
 * terminal, and the failure would surface much later as garbled output or a
 * session that never answers a permission request — a diagnosis costing hours,
 * from a condition detectable in one line at spawn. This is a programming
 * error (an adapter declaring something the host does not have), not a runtime
 * condition, so fail-open does not apply: it sits beside the existing
 * "no provider adapter" throw and, like it, leaves no orphan session record.
 */
export class UnknownTransportError extends Error {
  constructor(
    readonly kind: string,
    readonly providerId: string,
    readonly available: readonly string[]
  ) {
    super(
      `transport "${kind}" is not implemented (provider "${providerId}" asked for it). ` +
        `Available: ${available.length ? available.join(', ') : '(none)'}. ` +
        `See docs/plans/05-transport-migration.md.`
    );
    this.name = 'UnknownTransportError';
  }
}
