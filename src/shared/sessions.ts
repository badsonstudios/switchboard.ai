// The LIVE session record's wire shape (#590).
//
// Same argument as `shared/transport.ts`: `main/sessions/session-manager.ts`
// owns the session — spawning it, killing it, walking its status machine — and
// that is main's business and nobody else's. What lives here is the part that
// leaves the main process: the fields `sessions:create`, `sessions:list` and
// `sessions:rename` put on the wire, and the vocabulary the renderer paints
// them with.
//
// WHY IT IS HERE AND NOT MIRRORED IN THE PRELOAD. It was mirrored, by hand,
// until #590. Nothing compiled the two copies against each other, so they
// drifted: #445 found `transport?` optional on the DTO while it was required on
// the record, which made every renderer that read it invent an answer for
// "missing" — and SessionGrid's answer was a second, contradictory default.
// #445 fixed that one field and pinned it with a type assertion; this file
// removes the class of bug by removing the second copy. `status` had drifted
// too, quietly: the DTO said `string` where the record says `SessionStatus`.
//
// So: one declaration, imported by both sides. `SessionRecord` in the manager
// extends it with the fields that stay in main (see there); the preload's
// `SessionRecordDto` IS it.
//
// NOT the persisted CARD, which is a different contract with a different name
// (`PersistedSession` in `main/workspace/store.ts`, surfaced by
// `sessions:cards`). A card describes what the user set up and survives a
// restart; this describes a process that is running right now. Their
// `transport` fields in particular are NOT the same field — see below — and
// merging the two shapes would be a bug, not a tidy-up.
import type { TransportKind } from './transport';

/**
 * Where a live session is in its lifecycle (P1-E2-03).
 *
 * Defined here rather than in `main/sessions/state-machine.ts` because the
 * renderer paints it; the state machine that PRODUCES the values re-exports
 * this so main-side imports are unchanged. 'idle' is currently only reachable
 * via future idle-detection (Notification "waiting" classifies to needs-input
 * today); it stays in the union because the spec names it and the UI ships a
 * badge for it.
 *
 * The rail's `RailStatusName` (`renderer/src/lib/rail-view.ts`) is this union
 * plus the card-level 'suspended', and is still hand-written — a card that has
 * been restored but not resumed has no live record and so no status from here.
 */
export type SessionStatus =
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'needs-permission'
  | 'idle'
  | 'done'
  | 'crashed';

/** Who a session is, as the rail and the title bar need to show it. */
export interface SessionIdentity {
  title: string;
  folder: string;
  accentColor?: string;
  /** project-type lang badge (§5.11), e.g. "TS", "Rs" */
  langBadge?: string;
  providerId: string;
}

/**
 * Exactly the fields of a live session record that cross IPC.
 *
 * Adding a field here publishes it to the renderer. A field main keeps to
 * itself goes on `SessionRecord` instead, and `transport-seam.test.ts` makes
 * that a deliberate choice rather than an accident: it pins the record's key
 * set against this shape plus a named main-only list, so a new field fails
 * `tsc` until someone says which side it belongs on.
 */
export interface SessionRecordWire {
  id: string;
  identity: SessionIdentity;
  status: SessionStatus;
  createdAt: string;
  nativeSessionId?: string;
  pid?: number;
  exitCode: number | null;
  /**
   * Which transport is hosting this session (P2-E18-02/#445).
   *
   * REQUIRED: recorded at spawn from the resolved recipe and never changed —
   * a live session cannot move between transports, and `kill()` must reach the
   * same service that spawned it. There is no live session without one, so no
   * reader should ever default it.
   *
   * NOT the same field as `PersistedSession.transport` / the `transport?` on
   * `sessions:cards`, which IS genuinely optional: absence there means "this
   * CARD has never chosen", and main resolves it through
   * `DEFAULT_SESSION_TRANSPORT` before a live record exists. One is a running
   * fact, the other is a stored preference for the next spawn; while a
   * transport change waits for a restart the two legitimately disagree.
   */
  transport: TransportKind;
}
