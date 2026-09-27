// The transport seam (P2-E18-02, epic E18).
//
// A session is a hosted CLI process; HOW we talk to that process is a choice,
// not a constant. DESIGN §6 (amended 2026-08-01) recorded two: the PTY
// (node-pty + xterm.js) and duplex stream-json over `child_process` pipes.
// #952 deleted the first. This file is the vocabulary the survivor satisfies —
// and it is KEPT rather than inlined, because §5.3's adapter contract promises a
// second provider that it can declare its own transport.
//
// Deliberately NARROW, and the narrowness paid off exactly as intended: it is
// exactly what SessionManager needs to own a session's lifetime — spawn it, learn
// when it died, kill it. Everything transport-SPECIFIC stayed on the concrete
// service. `resize`, the scrollback ring and the #117 attach epoch were PTY
// concepts with no stream-json meaning, so widening this interface to cover them
// would have forced the stream transport to implement stubs that lie — and it is
// why deleting the PTY deleted `shared/ipc/pty.ts` and the whole terminal IPC
// without this file changing shape at all. A seam that had leaked one PTY concept
// would have taken the stream transport down with it.

// `TransportKind` and `DEFAULT_SESSION_TRANSPORT` live in `shared/transport.ts`
// (#381): the renderer needs both and may not reach into main. Re-exported here
// because this file is where every main-side caller already imports the
// vocabulary from, and moving ~40 call sites would bury the one real change.
export type { TransportKind } from '../../shared/transport';
export { DEFAULT_SESSION_TRANSPORT } from '../../shared/transport';
import type { TransportKind } from '../../shared/transport';

/**
 * The default when an ADAPTER's recipe says nothing.
 *
 * ⚠️ THIS FLIPPED FROM `pty` TO `stream` IN #952, AND THE REASONING IS WORTH
 * KEEPING BECAUSE IT INVERTED. It was `pty` on the argument that an adapter
 * returning no transport field has told us it does not speak stream-json, so
 * reading that silence as "stream" would hand a terminal-only CLI a protocol it
 * cannot answer. True — and now moot, because there is no terminal to hand it
 * INSTEAD. A host with one transport cannot express "I can't do this one" by
 * choosing the other.
 *
 * What still expresses it is `UnknownTransportError`, and that is the reason this
 * is a safe flip rather than the silent-fallback failure the old comment warned
 * about: an adapter that genuinely needs a terminal declares `transport: 'pty'`
 * **explicitly**, that kind is no longer implemented, and the spawn throws by
 * name at the seam with a pointer to the migration doc. The narrowed
 * `TransportKind` does not weaken that — the error carries `kind: string` on
 * purpose, so a value arriving from an adapter at runtime is still caught even
 * though the type no longer admits it.
 *
 * So: silence means the only transport there is; a WRONG explicit answer still
 * fails loudly at the moment it is given.
 */
export const DEFAULT_TRANSPORT: TransportKind = 'stream';

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
   * Optional because the PTY genuinely did not have any: it carried bytes
   * destined for a terminal emulator, and the only way to get structure out of
   * them was to parse the CLI's own rendering — which amended P7 forbids outright
   * (PHILOSOPHY §5, screen-scraping as rejected precedent). That was never a gap
   * to be filled later; it was a real difference between the transports, and
   * making this optional said so instead of forcing PtyService to fake it.
   *
   * Still optional after #952, when the only transport implements it: a byte-only
   * CLI is a thing that can exist, and the day an adapter hosts one, this being
   * required would be the line that forced it to lie.
   */
  onMessage?(l: (m: Record<string, unknown>) => void): () => void;
  /**
   * Send one typed message to the CLI (P2-E18-06). Optional for the same reason
   * as `onMessage`: the PTY took BYTES for a terminal to interpret, and a prompt
   * had to be dressed as a bracketed paste plus a delayed carriage return before
   * it counted as submitted (S-03). Those are not the same operation wearing
   * different clothes, so they do not share a method.
   *
   * Must be a no-op on a dead child, never a throw — writes to a closed pipe
   * raise asynchronously (the S-01 lesson).
   */
  send?(msg: unknown): void;
}

/**
 * What a transport implementation must provide to host sessions.
 *
 * `StreamService` satisfies this structurally — it is not declared as
 * implementing it, so the interface stays a consumer's view rather than a
 * constraint pushed back onto the class. `PtyService` satisfied it the same way
 * until #952.
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
 * It THROWS rather than falling back on purpose, and that was E18-02's whole
 * point. A silent fallback would have handed a stream-json adapter a terminal,
 * and the failure would surface much later as garbled output or a session that
 * never answers a permission request — a diagnosis costing hours, from a
 * condition detectable in one line at spawn. This is a programming error (an
 * adapter declaring something the host does not have), not a runtime condition,
 * so fail-open does not apply: it sits beside the existing "no provider adapter"
 * throw and, like it, leaves no orphan session record.
 *
 * **It matters MORE after #952, not less.** With one transport implemented, this
 * is the only thing that distinguishes "the adapter said nothing, so it gets the
 * transport we have" from "the adapter explicitly asked for the PTY, which no
 * longer exists" — see `DEFAULT_TRANSPORT`. `kind` is a `string` rather than a
 * `TransportKind` precisely so a value the narrowed type no longer admits is
 * still catchable at runtime.
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
