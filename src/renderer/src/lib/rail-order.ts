// MANUAL RAIL ORDER (#559, §5.8) — the order the user arranged by hand.
//
// Dan, dogfooding v0.6.0: dragging a session that is already in a group should
// move it UP or DOWN inside that group, not only between groups. So the rail
// gains a second, weaker authority over order — one the user writes, one that
// survives relaunch, and one that has to say out loud how it sits beside the
// two rules §5.8 already gave the rail.
//
// ── WHERE IT SITS, AND WHY (the decision #559 delegated) ────────────────────
//
// Three layers, applied in this order, and only the middle one is new:
//
//   1. BUCKET ORDER — persistent groups in their stored order, then the
//      emergent auto-groups, then the loose sessions (lib/groups' railOrder).
//      A manual order NEVER crosses a bucket: it is a list per group, exactly
//      as the request was worded.
//   2. MANUAL ORDER — this module. Within one bucket, the ids the user
//      arranged come first in the order they arranged them; a session that
//      arrived after the arrangement follows, in arrival order. That is what
//      "plus the new one at the bottom" means in every list a human has ever
//      dragged.
//   3. PINNED FIRST — unchanged, and still applied LAST (lib/pinning's
//      `sortPinnedFirst`, called by railOrder).
//
// Layer 3 last is the whole of the interaction question, so: **§5.8's "a
// pinned session sorts first in the rail" wins over a manual order.** A pinned
// session forms a leading block inside its group; you reorder freely among the
// pinned block and freely among the unpinned block, and no drag moves a session
// across the boundary between them. Those are VS Code's pinned-tab
// semantics, they are what §5.8's PROTECTION framing already promises ("pinning
// protects existence and position"), and they are the only reading under which
// the shipped pinning e2e stays true. The alternative — a drag beating a pin —
// would have made "sorts first" mean "sorts first until someone drags", which
// is a rule with an exception nobody wrote down.
//
// What that costs at the boundary is spelled out rather than left to the
// arithmetic, because it is the one thing a user will do by accident: dragging
// an unpinned row ABOVE a pinned one lands it at the top of the UNPINNED block
// instead. The gesture still does the most it legally can — "drag it to the
// top" keeps meaning something in a group that happens to hold a pin — and the
// pin is not displaced. Only when that is already where the row was does
// `planReorder` answer `null`, and the rail then draws no insertion line at
// all: a drop that would visibly snap back is never offered.
//
// ── AND ATTENTION? ──────────────────────────────────────────────────────────
//
// It does not compete, and that is a fact about the app rather than a decision
// taken here: **the rail has never sorted by attention.** §5.8's attention
// ordering is two OTHER lists — the Ctrl+Space queue (lib/queue) and the
// urgency strip — plus the loud row treatment (lib/rail-view's `needsYou`),
// which changes how a row LOOKS and never where it is. A manual order therefore
// takes nothing away from attention routing: a session that needs you is still
// tinted, still barred, still next in the queue, wherever you filed it. If a
// future item ever does sort the rail by attention, this module is the baseline
// it should sort — not the other way round.
//
// ── WHAT IS PERSISTED, AND WHERE ────────────────────────────────────────────
//
// The ui blob (P2-E15-06 / §5.25), which is the WORKSPACE STORE over IPC and
// deliberately not localStorage: the packaged renderer's loopback origin
// changes port every launch, so a localStorage order would reset every run —
// the exact bug E15-06 was filed for. Keyed by CARD id, like pins,
// presentation, policies and layout, because a live session id churns on every
// resume and an order keyed by one would shuffle itself on restart.
import { NO_PINS, PinSet, sortPinnedFirst } from './pinning';

/** bucket key -> the card ids in that bucket, in the order the user left them */
export type ManualOrder = ReadonlyMap<string, readonly string[]>;

/**
 * The empty order — SHARED, for the reason `NO_PINS` is: the store's initial
 * value must be ONE stable object or every `useSyncExternalStore` snapshot over
 * it re-renders for ever.
 */
export const NO_ORDER: ManualOrder = new Map<string, readonly string[]>();

/** ui-blob key (§5.25: an arrangement survives relaunch). */
export const ORDER_KEY = 'railOrder';

/**
 * The bucket key for the trailing "everything else" list.
 *
 * These three functions are the ONE definition of a bucket key, and they must
 * keep matching the `key` the rail hands `groupCard` — the order is stored
 * under it, the drop handler looks it up by it, and two spellings of the same
 * bucket would persist an arrangement the rail never reads back. `railOrder`
 * builds the keyed map from here for exactly that reason.
 */
export const LOOSE_BUCKET = 'ungrouped';

/** A persistent group's bucket key is its id — a function so the call sites
 *  read the same as the other two rather than reaching for `g.id` raw. */
export const groupBucket = (groupId: string): string => groupId;

/** An emergent repo/folder group's bucket key (E12-05). */
export const autoBucket = (autoKey: string): string => `auto:${autoKey}`;

/**
 * One bucket's members, in the order the user arranged.
 *
 * Known ids first, in the stored order; anything the stored order has never
 * heard of — a session opened since — after them, in the order it arrived.
 * A stored id with no member is skipped rather than leaving a hole: an order
 * outlives the sessions it names, and a prune that has not run yet must not
 * cost the user their arrangement.
 *
 * Returns the SAME array when there is nothing to do, so React and the store's
 * identity checks both see an untouched bucket as untouched.
 */
export function applyManualOrder<T extends { id: string }>(
  members: T[],
  order: readonly string[] | undefined
): T[] {
  if (!order || order.length === 0 || members.length < 2) return members;
  const rank = new Map<string, number>();
  order.forEach((id, i) => rank.set(id, i));
  // nothing in this bucket was ever arranged: hand the very same array back
  if (!members.some((m) => rank.has(m.id))) return members;
  const known: T[] = [];
  const fresh: T[] = [];
  for (const m of members) (rank.has(m.id) ? known : fresh).push(m);
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...fresh];
}

/** ids through lib/pinning's one sort rule. Ids and not rows because that is
 *  what an order IS here; the mapping is cheaper than a second copy of the
 *  rule, and a second copy is how "sorts first" ends up meaning two things. */
function pinnedFirstIds(ids: readonly string[], pins: PinSet): string[] {
  return sortPinnedFirst(
    ids.map((id) => ({ id })),
    pins
  ).map((o) => o.id);
}

/** Do these two id lists say the same thing? */
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * What the bucket's order becomes when `cardId` is dropped at `toIndex`, or
 * `null` when the answer is "nothing changes".
 *
 * `displayIds` is the bucket EXACTLY AS PAINTED — pins already promoted —
 * because that is the list the user is dragging in, and an operation computed
 * against a list nobody can see is an operation that lands somewhere else.
 *
 * `toIndex` is an insertion point in that painted list with the dragged row
 * REMOVED (0 = first, `length - 1` = last), which is the index a drop-above /
 * drop-below hit test naturally produces.
 *
 * The pin sort is re-applied to the result, which is what makes §5.8 win: a
 * move that would cross the pinned/unpinned boundary is settled back to the
 * near side of it, and a move that pinning would undo entirely comes back as
 * `null` — no write, no announcement, and (in the rail) no insertion line
 * offering it. Because the input was already pin-sorted, re-sorting is
 * idempotent for every move that does not touch the boundary, so this costs
 * nothing except the cases it exists to catch.
 */
export function planReorder(
  displayIds: readonly string[],
  cardId: string,
  toIndex: number,
  pins: PinSet = NO_PINS
): string[] | null {
  const from = displayIds.indexOf(cardId);
  if (from < 0) return null;
  const rest = displayIds.filter((id) => id !== cardId);
  const at = Math.max(0, Math.min(rest.length, Math.trunc(toIndex)));
  const moved = [...rest.slice(0, at), cardId, ...rest.slice(at)];
  const settled = pinnedFirstIds(moved, pins);
  return same(settled, displayIds) ? null : settled;
}

/**
 * One step up (`-1`) or down (`+1`) — the keyboard's whole vocabulary here.
 *
 * `null` at the ends, and `null` at the pinned/unpinned boundary, which is the
 * same answer for the same reason: the menu item reads this to decide whether
 * it is `aria-disabled`, so "can't" is computed by the rule rather than by a
 * second guess at the rule's edges.
 */
export function stepReorder(
  displayIds: readonly string[],
  cardId: string,
  delta: -1 | 1,
  pins: PinSet = NO_PINS
): string[] | null {
  const from = displayIds.indexOf(cardId);
  if (from < 0) return null;
  return planReorder(displayIds, cardId, from + delta, pins);
}

/** Can this session move that way at all? What the menu item's disabled state
 *  and the palette command's `enabled` both ask, so they cannot disagree. */
export function canStep(
  displayIds: readonly string[],
  cardId: string,
  delta: -1 | 1,
  pins: PinSet = NO_PINS
): boolean {
  return stepReorder(displayIds, cardId, delta, pins) !== null;
}

/**
 * Record one bucket's order.
 *
 * Returns the SAME map when nothing changed — identity is the store's change
 * signal, and a no-op write would re-derive rail order and re-render every row.
 * A bucket of fewer than two sessions stores nothing and DROPS what it had:
 * there is no arrangement to remember about a list of one, and a workspace must
 * not accrete a record per bucket it ever painted.
 */
export function withBucketOrder(
  order: ManualOrder,
  bucket: string,
  ids: readonly string[]
): ManualOrder {
  const prior = order.get(bucket);
  if (ids.length < 2) {
    if (!prior) return order;
    const next = new Map(order);
    next.delete(bucket);
    return next;
  }
  if (prior && same(prior, ids)) return order;
  const next = new Map(order);
  next.set(bucket, [...ids]);
  return next;
}

/**
 * Drop ids for cards that no longer exist, and buckets left with nothing worth
 * remembering.
 *
 * `null` when there is nothing to drop, so the caller can skip a pointless
 * write and re-render — the same contract `prunePins`, `prunePresentation` and
 * `pruneLayout` use, called from the same boot sweep.
 *
 * It prunes CARDS and not BUCKETS: a group can be empty and still be a group
 * (E12's "empty ≠ gone"), and an auto-group whose folder has no sessions open
 * right now is one folder away from having them again. Only the cards are
 * knowable here, so only the cards are retired.
 */
export function pruneManualOrder(
  order: ManualOrder,
  knownCardIds: Iterable<string>
): ManualOrder | null {
  const known = new Set(knownCardIds);
  let changed = false;
  const next = new Map<string, readonly string[]>();
  for (const [bucket, ids] of order) {
    const kept = ids.filter((id) => known.has(id));
    if (kept.length !== ids.length) changed = true;
    // a bucket down to one remembered session has no order left to remember
    if (kept.length < 2) changed = changed || kept.length !== ids.length;
    else next.set(bucket, kept);
  }
  return changed ? next : null;
}

/**
 * One ui-blob record -> a manual order.
 *
 * Anything unrecognised is skipped rather than throwing: a blob outlives the
 * code that wrote it, and a stale value must never cost the user their
 * workspace (§4, fail-open). Buckets that survive the filter with fewer than
 * two ids are dropped for the reason `withBucketOrder` never writes them.
 */
export function loadManualOrder(raw: unknown): ManualOrder {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_ORDER;
  const out = new Map<string, readonly string[]>();
  for (const [bucket, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!bucket || !Array.isArray(value)) continue;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of value) {
      // duplicates would give one card two ranks; the first one wins
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (ids.length >= 2) out.set(bucket, ids);
  }
  return out.size > 0 ? out : NO_ORDER;
}

/**
 * The order, reduced to what goes in the blob. A workspace nobody has arranged
 * writes nothing at all — `null` means "delete the key". Bucket keys are
 * sorted, so an unchanged order does not rewrite the file in a different order
 * each launch (the ids inside are the DATA and keep their order, obviously).
 */
export function persistableManualOrder(order: ManualOrder): Record<string, string[]> | null {
  if (order.size === 0) return null;
  const out: Record<string, string[]> = {};
  for (const bucket of [...order.keys()].sort()) out[bucket] = [...order.get(bucket)!];
  return out;
}
