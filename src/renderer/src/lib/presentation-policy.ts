// §5.8's presentation POLICY — auto-minimize on submit (P2-E9-06).
//
// E9-05 built the ladder: what the four rungs mean and how a session moves
// between them. This module is the standing ANSWER to one question the user
// should not have to answer per prompt: when you submit a prompt, does the card
// stay where it is, fold into the collapsed strip, or leave the workspace
// altogether?
//
//   always-visible   nothing happens on submit; the card stays a card.
//                    THE DEFAULT.
//   auto-collapse    the card gives its dock slot back and becomes a row in the
//                    collapsed strip.
//   auto-hide        the card leaves the workspace entirely — rail, lamp and
//                    events only, exactly like `session.hide`.
//
// WHY always-visible IS THE DEFAULT (Dan, 2026-08-04, amending §5.8): the first
// draft shipped auto-collapse, as §5.8 originally specified, and dogfooding it
// settled the question — you cannot watch your own turn stream in the card you
// submitted from, which is the very first thing a new user does. The litmus
// parenthetical §5.8 wrote ("a new user watching their session vanish on first
// submit fails intuitive-first") was about auto-hide vs auto-collapse; applied
// one rung higher it rules out minimizing UNASKED at all. Both minimizing
// policies still hand the screen back to the sessions that need it, and both are
// one click of the titlebar chip away for the many-sessions workflow they suit.
//
// THE RESTORE HALF IS NOT HERE, and that is the point of doing this after
// E9-05: §5.8 says a minimized session "restores automatically on Stop (done)
// or Notification (needs human)", which is exactly lib/ladder's `revealTargets`
// — the same three kinds, the same slot-exact reveal, the same no-focus-steal
// rule. Auto-hide therefore honours the reveal contract by construction rather
// than by a second implementation of it.
//
// Pure by construction (no React, no dockview, no IPC): every rule below is a
// unit test rather than an e2e guess. The impure edges are the store (which
// holds the book) and lib/presentation-boot (which loads and saves it).
import type { Ladder } from './presentation';

export type PresentationPolicy = 'always-visible' | 'auto-collapse' | 'auto-hide';

/** Most screen kept to least. The order the chip and the menus cycle in. */
export const POLICY_ORDER: readonly PresentationPolicy[] = [
  'always-visible',
  'auto-collapse',
  'auto-hide',
];

/** The default, and the value an untouched workspace resolves to (§5.8 as
 *  amended 2026-08-04: nothing moves unless the user opted in). */
export const DEFAULT_POLICY: PresentationPolicy = 'always-visible';

/**
 * The whole setting: one global default plus two override tables.
 *
 * §5.8: "global default + per-group and per-session overrides". Groups and
 * cards are both keyed by their DURABLE ids (the persistent group id, the card
 * id) — never a live session id, which churns on every resume and would silently
 * drop the user's override the first time a session restarted.
 */
export interface PolicyBook {
  readonly global: PresentationPolicy;
  /** persistent-group id -> policy */
  readonly groups: Readonly<Record<string, PresentationPolicy>>;
  /** card id -> policy */
  readonly cards: Readonly<Record<string, PresentationPolicy>>;
}

/** Frozen and shared: the store's initial value must be one stable object, or
 *  every useSyncExternalStore snapshot over it re-renders forever. */
export const DEFAULT_BOOK: PolicyBook = Object.freeze({
  global: DEFAULT_POLICY,
  groups: Object.freeze({}),
  cards: Object.freeze({}),
});

export const POLICY_KEY = 'presentationPolicy';

function isPolicy(v: unknown): v is PresentationPolicy {
  return typeof v === 'string' && (POLICY_ORDER as readonly string[]).includes(v);
}

/**
 * Which policy governs this card.
 *
 * PRECEDENCE IS THE ITEM'S DONE-WHEN: session beats group beats global. Stated
 * as one function so the chip's label, the rail menu's tick and the thing that
 * actually happens on submit are all reading the same answer — three surfaces
 * deriving precedence separately is how two of them end up wrong.
 */
export function resolvePolicy(
  book: PolicyBook,
  cardId: string | undefined,
  groupId?: string | null
): PresentationPolicy {
  const own = cardId ? book.cards[cardId] : undefined;
  if (isPolicy(own)) return own;
  const group = groupId ? book.groups[groupId] : undefined;
  if (isPolicy(group)) return group;
  return isPolicy(book.global) ? book.global : DEFAULT_POLICY;
}

/** The card's OWN override, if it has one — what the menus tick, as opposed to
 *  what `resolvePolicy` computes. "Follow the default" is the absence of one. */
export function cardOverride(book: PolicyBook, cardId: string): PresentationPolicy | undefined {
  const v = book.cards[cardId];
  return isPolicy(v) ? v : undefined;
}

export function groupOverride(book: PolicyBook, groupId: string): PresentationPolicy | undefined {
  const v = book.groups[groupId];
  return isPolicy(v) ? v : undefined;
}

/**
 * Where a card should go when its prompt is submitted — or null for "stay".
 *
 * Every reason NOT to move is here rather than at the call site, because the
 * call site is a dockview mutation and the rules are the interesting part:
 *
 *  • `always-visible` is the whole point of that policy.
 *  • A card that is ALREADY off the top rung is left alone. Auto-minimize means
 *    "give the screen back", and a collapsed session has already given it back —
 *    pushing it on to `hidden` would be a second demotion the user never asked
 *    for, and it would take the strip row away from the one surface that says
 *    where the session went.
 *  • A POPPED-OUT card is left alone. Its rung change would close an OS window
 *    the user deliberately placed, quite possibly on another monitor; "I put
 *    this on the second screen" is a stronger statement of intent than a global
 *    default, and §5.8's own reveal contract treats a popout as a location worth
 *    restoring exactly. Manual collapse still works — this rule is about what we
 *    do UNASKED.
 *  • A session that is ALREADY WAITING ON A HUMAN is left alone, and this one
 *    is a hole in the reveal contract rather than a preference. The composer
 *    stays live while a permission is held, so you can type into a session that
 *    is blocked. Minimizing it there would take the approval bar off screen —
 *    and it would NOT come back: E9-05's reveal fires on a NEW event id, the
 *    hold already spent its id before the card had left, and a CLI parked on a
 *    hold mints no more. The one card that needs a human is the one card
 *    auto-minimize must never take away.
 *
 *  • A PINNED card is left alone (E9-09). §5.8's pinning contract names
 *    "auto-collapse sweeps" among the bulk operations a pinned session is
 *    exempt from, and THIS IS THAT SWEEP: it is the one thing in the app that
 *    moves a card down the ladder without the user asking for that card to
 *    move. It does not make pinning mean always-expanded — collapse, tab and
 *    hide all still work by hand, and a layout mode still arranges a pinned
 *    card like any other (see lib/pinning's header for why that is the same
 *    rule and not an exception to it).
 */
export function submitTarget(opts: {
  policy: PresentationPolicy;
  /** the card's current rung */
  ladder: Ladder;
  poppedOut: boolean;
  /** the session is blocked on a person right now (lib/rail-view's needsYou) */
  needsHuman: boolean;
  /** §5.8's pinning contract (E9-09) */
  pinned?: boolean;
}): Ladder | null {
  if (opts.policy === 'always-visible') return null;
  if (opts.ladder !== 'expanded') return null;
  if (opts.poppedOut) return null;
  if (opts.needsHuman) return null;
  if (opts.pinned) return null;
  return opts.policy === 'auto-hide' ? 'hidden' : 'collapsed';
}

/** Next value for the global chip — three states, wrapping. */
export function cycleGlobal(cur: PresentationPolicy): PresentationPolicy {
  const i = POLICY_ORDER.indexOf(cur);
  return POLICY_ORDER[(i + 1) % POLICY_ORDER.length];
}

/**
 * Next value for an OVERRIDE control — four states, because "follow the
 * default" is a real choice and has to be reachable by the same gesture that
 * left it. `undefined` is that state, and it is where the cycle starts and ends.
 */
export function cycleOverride(
  cur: PresentationPolicy | undefined
): PresentationPolicy | undefined {
  if (!isPolicy(cur)) return POLICY_ORDER[0];
  const i = POLICY_ORDER.indexOf(cur);
  return i === POLICY_ORDER.length - 1 ? undefined : POLICY_ORDER[i + 1];
}

// ── immutable edits ─────────────────────────────────────────────────────────
// The store publishes by identity, so every edit returns a NEW book. Passing
// `undefined` removes an override rather than storing a fourth value: "follow
// the default" must be the absence of a record, or a later change to the global
// default would not reach the sessions that never overrode it.

export function withGlobal(book: PolicyBook, policy: PresentationPolicy): PolicyBook {
  return Object.freeze({ ...book, global: policy });
}

export function withCard(
  book: PolicyBook,
  cardId: string,
  policy: PresentationPolicy | undefined
): PolicyBook {
  if (!cardId) return book;
  return Object.freeze({ ...book, cards: withEntry(book.cards, cardId, policy) });
}

export function withGroup(
  book: PolicyBook,
  groupId: string,
  policy: PresentationPolicy | undefined
): PolicyBook {
  if (!groupId) return book;
  return Object.freeze({ ...book, groups: withEntry(book.groups, groupId, policy) });
}

function withEntry(
  table: Readonly<Record<string, PresentationPolicy>>,
  key: string,
  policy: PresentationPolicy | undefined
): Readonly<Record<string, PresentationPolicy>> {
  const next = { ...table };
  if (isPolicy(policy)) next[key] = policy;
  else delete next[key];
  return Object.freeze(next);
}

/**
 * Drop overrides for cards and groups that no longer exist.
 *
 * Returns null when there is nothing to drop, so the caller can skip a pointless
 * write and re-render — the same contract `prunePresentation` uses, and for the
 * same reason: a workspace must not accrete a record per session it ever opened.
 */
export function prunePolicies(
  book: PolicyBook,
  knownCardIds: Iterable<string>,
  knownGroupIds: Iterable<string>
): PolicyBook | null {
  const cards = new Set(knownCardIds);
  const groups = new Set(knownGroupIds);
  const staleCards = Object.keys(book.cards).filter((id) => !cards.has(id));
  const staleGroups = Object.keys(book.groups).filter((id) => !groups.has(id));
  if (staleCards.length === 0 && staleGroups.length === 0) return null;
  const nextCards = { ...book.cards };
  for (const id of staleCards) delete nextCards[id];
  const nextGroups = { ...book.groups };
  for (const id of staleGroups) delete nextGroups[id];
  return Object.freeze({
    global: book.global,
    cards: Object.freeze(nextCards),
    groups: Object.freeze(nextGroups),
  });
}

// ── persistence ─────────────────────────────────────────────────────────────

/** One ui-blob record -> a full book. Anything unrecognised falls back to the
 *  default rather than throwing: a blob outlives the code that wrote it, and a
 *  stale value must never cost the user their workspace. */
export function loadPolicyBook(raw: unknown): PolicyBook {
  if (!raw || typeof raw !== 'object') return DEFAULT_BOOK;
  const r = raw as Record<string, unknown>;
  return Object.freeze({
    global: isPolicy(r.global) ? r.global : DEFAULT_POLICY,
    groups: readTable(r.groups),
    cards: readTable(r.cards),
  });
}

function readTable(v: unknown): Readonly<Record<string, PresentationPolicy>> {
  const out: Record<string, PresentationPolicy> = {};
  if (v && typeof v === 'object') {
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (key && isPolicy(value)) out[key] = value;
    }
  }
  return Object.freeze(out);
}

/** The book, reduced to what goes in the blob. A book that says nothing the
 *  default doesn't already say writes nothing at all. */
export function persistablePolicies(book: PolicyBook): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (book.global !== DEFAULT_POLICY) out.global = book.global;
  if (Object.keys(book.groups).length > 0) out.groups = { ...book.groups };
  if (Object.keys(book.cards).length > 0) out.cards = { ...book.cards };
  return Object.keys(out).length > 0 ? out : null;
}
