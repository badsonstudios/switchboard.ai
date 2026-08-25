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
// extends it with its own bookkeeping (see there); the preload's
// `SessionRecordDto` IS it.
//
// WHAT THIS IS NOT: a runtime filter. `sessions:list` returns `manager.list()`
// verbatim (`main/sessions/ipc.ts`) and structured clone carries every own
// property, so a field on `SessionRecord` and not on this shape still ARRIVES
// in the renderer — it is simply not declared, so nothing can read it without
// saying so. `sessions:create` in fact re-publishes one (`autonomy`) in its own
// return type. Treat this as the DECLARED contract, not an exposure boundary:
// nothing secret should ride on a live record on the strength of being left
// out here.
//
// NOT the persisted CARD, which is a different contract: a card describes what
// the user set up and survives a restart; a record describes a process that is
// running right now. Their `transport` fields in particular are NOT the same
// field — see below — and merging the two shapes would be a bug, not a tidy-up.
//
// The card's own wire shape (`SessionCardWire`) IS in this file as of #618, and
// that is not a reversal of the paragraph above. It was inline in the
// `sessions:cards` handler and hand-copied in the preload, which is the same
// class of defect one shape over — its `status` said `string`. Giving it its
// own NAME next to the record's is what keeps them apart; it is being nameless
// that lets a reader assume they are the same thing. The rule the two shapes
// must obey is written once, between them, instead of twice in two files.
//
// (`PersistedSession` in `main/workspace/store.ts` is a third shape again: what
// goes in the workspace FILE. `sessions:cards` projects it — renaming
// `identity.langBadge` to `badge`, joining the live status on — so it is not
// this and does not want to be.)
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
 * A card that has been restored but not resumed has no live record and so no
 * status from here at all: that is `CardStatus` below, this union plus
 * 'suspended'. The rail's `RailStatusName` was a hand-written copy of those
 * eight names until #618; it is `RailCardStatus` — `CardStatus` plus the one
 * name the renderer mints for itself — as of #687.
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
 * The fields of a live session record the renderer is TYPED to see.
 *
 * Adding a field here declares it to the renderer. A field main keeps to
 * itself goes on `SessionRecord` instead, and `transport-seam.test.ts` makes
 * that a deliberate choice rather than an accident: it pins the record's key
 * set against this shape plus a named main-only list, so a new field fails
 * `tsc` until someone says which side it belongs on.
 *
 * "Keeps to itself" means undeclared, not withheld — see the header.
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

/**
 * A session's status CHANGED — the `sessions:status` push payload (#618).
 *
 * Declared here for the reason `SessionRecordWire` is: `main/sessions/ipc.ts`
 * sends `manager.onStatusChange`'s argument verbatim, so main's event type and
 * the renderer's picture of it are the same object and there is no room for two
 * declarations to be right. There WERE two — the preload took `change: unknown`
 * and both readers in `SessionGrid` cast it back by hand, one to
 * `{ sessionId: string; to: string }` and one to `{ …; to?: string }`. That is
 * the exact #590 defect one level out, twice: `to` is a REQUIRED
 * `SessionStatus`, so the `string` let a comparison against a status no state
 * machine can produce compile and silently never fire, and the optional
 * spelling bought a truthiness guard against a shape main cannot send.
 *
 * `main/sessions/session-manager.ts` re-exports this as `StatusChange` for its
 * own importers; `main/events/feed.ts` ingests it.
 */
export interface StatusChange {
  /** the LIVE session id (`SessionRecordWire.id`), not the card id */
  sessionId: string;
  from: SessionStatus;
  to: SessionStatus;
  /** free text for the log and the Feed — a reason, not a vocabulary */
  cause: string;
  /** ISO timestamp */
  at: string;
}

/**
 * What a CARD's status can be: every live status, plus 'suspended'.
 *
 * A card outlives its session. `sessions:cards` answers `rec?.status ??
 * 'suspended'` (`main/sessions/ipc.ts`), so 'suspended' is not a state the
 * state machine can reach — it is the absence of a live record, named. That is
 * why this union is here and not in `SessionStatus`: nothing in main may
 * TRANSITION to it.
 *
 * The rail's `RailStatusName` (`renderer/src/lib/rail-view.ts`) is `RailCardStatus`
 * below, which is this type plus the one status the renderer mints for itself.
 */
export type CardStatus = SessionStatus | 'suspended';

/**
 * What the RAIL's status can be: `CardStatus` plus 'not-started' (#687).
 *
 * THE SPLIT IS THE POINT, so read the direction before adding to either half.
 * `CardStatus` is what MAIN puts on the wire — `SessionCardWire.status` is
 * typed with it, and it stays that way. 'not-started' can never travel that
 * wire, because the whole defect #687 names is that main has never heard of the
 * card: `sessions:create` refused it, so `persist.upsert` never ran, so
 * `sessions:cards` (built from `persist.list()`) cannot list it. The renderer
 * is the only side that knows such a card exists — it is holding its dockview
 * panel — so the renderer is the side that names its status.
 *
 * Widening `CardStatus` itself would have been one word shorter and would have
 * declared a status main is structurally incapable of sending, which is exactly
 * the kind of contract-that-lies #618 spent an issue removing.
 */
export type RailCardStatus = CardStatus | 'not-started';

/**
 * How much a session may do unprompted (§5.9) — the four autonomy profiles.
 *
 * Hand-written NINE TIMES until #618, on both sides of the IPC boundary and in
 * the workspace file: the card's persisted choice (`PersistedSession`), the
 * spawn option (`SpawnOptions`, `SessionManager.create`), the live record
 * (`SessionRecord`), the `sessions:create` argument in main and again in the
 * preload, the result the preload re-publishes, the keys of
 * `AUTONOMY_PERMISSION_MODE`, and the renderer's own `Autonomy` — plus two
 * RUNTIME copies of the same list: the inline array in `sessions:setAutonomy`'s
 * validator and the renderer's `AUTONOMIES`. One name now, because a fifth
 * profile added to eight of those nine is a bug that compiles, and one added to
 * the types but not the runtime list is a mode the chips never offer.
 *
 * THE VALUES ARE THE DEFINITION and the type is derived from them, following
 * `STATUS_TOKENS` in `renderer/src/lib/rail-view.ts`: a fifth entry added to a
 * hand-written union would type-check while going unvalidated by
 * `isAutonomyMode` below.
 *
 * The ORDER is the renderer's cycle order — least to most autonomous, with
 * `plan` second because it is the one mode that grants LESS than the default,
 * so a user walking the chip meets "safe" and "safer" before anything starts
 * running on its own. It lives here rather than in the renderer only because a
 * list has to have one; `renderer/src/lib/autonomy.ts` is still where the
 * default, the walk and the tooltip copy are, and `main/providers/claude.ts`
 * still owns the mapping to the CLI's `--permission-mode`
 * (`AUTONOMY_PERMISSION_MODE`, whose keys are this type — so a new profile
 * fails `tsc` there until someone says what the CLI should be told).
 */
export const AUTONOMY_MODES = ['ask', 'plan', 'auto-edit', 'full-auto'] as const;

export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/**
 * Is this stored/IPC value a profile we still recognise?
 *
 * BOTH sides need this and for different jobs, which is why it is here and not
 * a predicate in either process. Main validates untrusted renderer input with
 * it (§5.29: `sessions:setAutonomy` drops anything else on the floor) — and
 * that check was a literal `['plan', 'ask', 'auto-edit', 'full-auto']` array
 * inline in the handler until #618 — a copy of the vocabulary in the one place
 * where being out of date means silently refusing a mode the rest of the app
 * offers. The renderer needs it because a workspace blob outlives the
 * code that wrote it, and an unrecognised value must fall back to the default
 * rather than render as a missing translation key.
 */
export function isAutonomyMode(v: unknown): v is AutonomyMode {
  return typeof v === 'string' && (AUTONOMY_MODES as readonly string[]).includes(v);
}

/**
 * A persisted CARD, as `sessions:cards` puts it on the wire.
 *
 * NOT `SessionRecordWire`, and the two must not be merged — see the header of
 * this file. A card is what the user set up and survives a restart; a record is
 * a process running right now. They are declared next to each other so that the
 * one thing everybody gets wrong about them is written down in one place rather
 * than inferred from two files.
 *
 * `transport` in particular is a DIFFERENT FIELD from the record's, and #445's
 * note stands: it is optional ON PURPOSE. Absence means "this card has never
 * chosen", which `lib/trust-reach.ts` resolves through
 * `DEFAULT_SESSION_TRANSPORT`; the record's is required because a live session
 * is always hosted on something. Same word, two contracts.
 *
 * What #618 changed is only that the card is now DECLARED ONCE instead of
 * inline in the handler and again in the preload: `main/sessions/ipc.ts`
 * annotates its `sessions:cards` handler with this type, so a field added on
 * one side and not the other fails `tsc` at the handler.
 */
export interface SessionCardWire {
  cardId: string;
  title: string;
  folder: string;
  accent?: string;
  /** project-type lang badge (§5.11) — `SessionIdentity.langBadge` renamed on
   *  the way out, which is why this shape is not the identity */
  badge?: string;
  /** the live session's status, or 'suspended' when the card has no session */
  status: CardStatus;
  /** the live session under this card, if any */
  liveId?: string;
  groupId?: string;
  /** repo/folder auto-group key (E12-05): same key -> same emergent group.
   *  A repo root beats the folder path, so sibling checkouts of one repo share
   *  a key. Always present in practice; optional because the renderer's
   *  grouping falls back to `folder`. */
  autoKey?: string;
  taskLabel?: string;
  /**
   * The transport this card's NEXT session will be asked for (#397): the card's
   * own choice, then the env override, then the default.
   *
   * Not `rec?.transport`, which is what a session is currently hosted on: the
   * renderer's consumer asks "can this card ever raise a trust question?", and
   * trust is consulted at SPAWN, so the honest answer is the transport the next
   * spawn will use. The two differ while a transport change waits for a restart.
   *
   * OPTIONAL ON PURPOSE (#445, and left that way by #590 and #618) — DO NOT
   * make this required to match `SessionRecordWire.transport`. That field is
   * required because a live session cannot exist without a transport; this one
   * describes a stored preference, and `PersistedSession.transport` is genuinely
   * absent for every card that has never chosen. `lib/trust-reach.ts` reads
   * absence as `DEFAULT_SESSION_TRANSPORT`, which is the same resolution
   * `sessions:create` applies, and that is the ONLY safe reading — the bug #445
   * fixed was a renderer answering `'pty'` instead.
   *
   * Worth knowing, and deliberately not changed here: the `sessions:cards`
   * handler resolves the chain before it sends, so on THIS channel a value
   * always arrives today. The question mark is what keeps a consumer from
   * assuming otherwise if that ever stops being true, and it costs one `??`
   * that already agrees with main.
   */
  transport?: TransportKind;
}
