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

/** Which wire a session's CLI is hosted on. */
export type TransportKind = 'pty' | 'stream';

/** The default when an adapter's recipe says nothing — every pre-E18 adapter. */
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
