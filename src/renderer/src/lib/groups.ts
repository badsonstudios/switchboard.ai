import { NO_PINS, PinSet, sortPinnedFirst } from './pinning';
import {
  applyManualOrder,
  autoBucket,
  groupBucket,
  LOOSE_BUCKET,
  ManualOrder,
  NO_ORDER,
} from './rail-order';

// Membership adoption rule for grid drags (P2-E12-04): when a session panel
// lands in a dockview group, it adopts the persistent group of the panels
// already there — first sibling with a membership wins; an all-ungrouped
// destination means ungrouped. Kept pure for unit testing.
export interface CardMembership {
  cardId: string;
  groupId?: string;
}

// Emergent repo/folder auto-groups (E12-05, §7): sessions sharing an autoKey
// (repo toplevel, else folder) cluster visually — computed, never persisted.
// User-made groups always win (S4): an explicitly-grouped session never
// auto-groups. Singletons don't group; empty means gone by construction.
export interface AutoGroupable {
  id: string;
  groupId?: string;
  autoKey?: string;
  folder?: string;
}

export interface AutoGroup {
  key: string;
  memberIds: string[];
}

export function computeAutoGroups(sessions: AutoGroupable[]): AutoGroup[] {
  const buckets = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.groupId) continue; // explicit membership overrides (S4)
    const key = s.autoKey ?? s.folder;
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(s.id);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, memberIds]) => ({ key, memberIds }));
}

// The rail's VISUAL order (P2-E9-01): persistent groups in their stored order,
// each followed by its members, then the emergent auto-groups and their
// members, then everything loose. "Jump to session N" (Ctrl+1..9) counts
// against exactly this list, so the rail renders FROM it — one function, no
// chance of the keyboard and the eye disagreeing.
export interface RailOrderResult<T> {
  /** persistent groups paired with their members, in render order */
  groups: Array<{ id: string; members: T[] }>;
  /** emergent auto-groups paired with their members, in render order */
  autoGroups: Array<{ key: string; members: T[] }>;
  /** ungrouped sessions that didn't land in an auto-group */
  loose: T[];
  /** every session, flattened in the order the rail paints it */
  flat: T[];
  /**
   * bucket key -> its members' card ids, in the order the rail paints them
   * (#559). The reorder handlers need "the list this row is being dragged
   * inside", and deriving it at the call site means re-implementing the
   * bucketing above — which is how the thing you drag and the thing you
   * persist end up being two different lists.
   */
  buckets: ReadonlyMap<string, string[]>;
  /** card id -> the bucket key its row renders in (#559) */
  bucketOf: ReadonlyMap<string, string>;
}

export function railOrder<T extends AutoGroupable>(
  sessions: readonly T[],
  groups: ReadonlyArray<{ id: string }>,
  /** §5.8's "a pinned session sorts first in the rail" (P2-E9-09) */
  pins: PinSet = NO_PINS,
  /** the order the user arranged by hand (#559) — see lib/rail-order for how
   *  it layers with the pin sort, which still wins */
  manual: ManualOrder = NO_ORDER
): RailOrderResult<T> {
  // §5.8's "a pinned session sorts first" is applied PER BUCKET, and applied
  // LAST — after membership and after bucket order are both settled.
  //
  // Per bucket, because a pinned session sorts to the front of the group it is
  // in rather than being torn out into a leading section of its own. That is VS
  // Code's semantics (pinning a tab moves it to the front of ITS editor group,
  // never across groups) and it is the only reading that does not empty the
  // count on the header the user deliberately filed the session under. On a
  // workspace with no persistent or emergent groups — the default, and by far
  // the common shape — the loose list IS the rail, so a pinned session is
  // literally first.
  //
  // Applied LAST is the subtler half, and it is what keeps lib/pinning's
  // promise honest: "pinning promotes, it never shuffles". Pre-sorting the
  // INPUT would have been one line shorter and would have quietly hoisted whole
  // auto-groups — `computeAutoGroups` buckets in the order it is handed, so
  // pinning one member would lift its emergent group above another one and move
  // strangers past each other. Nobody asked for that, and a rule with an
  // exception nobody wrote down is how "sorts first" ends up meaning three
  // different things. Membership and bucket order are computed from the
  // sessions exactly as they arrived; the pin only reorders WITHIN a bucket.
  const grouped = new Map<string, T[]>();
  for (const g of groups) grouped.set(g.id, []);
  const ungrouped: T[] = [];
  for (const s of sessions) {
    if (s.groupId && grouped.has(s.groupId)) grouped.get(s.groupId)!.push(s);
    else ungrouped.push(s);
  }
  const auto = computeAutoGroups(ungrouped);
  const autoMemberIds = new Set(auto.flatMap((g) => g.memberIds));
  const byId = new Map(ungrouped.map((s) => [s.id, s]));
  // #559's manual order goes on BETWEEN membership and the pin sort, per
  // bucket, and the pin sort still runs last — see lib/rail-order's header for
  // the decision and why it went that way rather than the other.
  const buckets = new Map<string, string[]>();
  const bucketOf = new Map<string, string>();
  const settle = (key: string, members: T[]): T[] => {
    const out = sortPinnedFirst(applyManualOrder(members, manual.get(key)), pins);
    buckets.set(
      key,
      out.map((s) => s.id)
    );
    for (const s of out) bucketOf.set(s.id, key);
    return out;
  };
  const orderedGroups = groups.map((g) => ({
    id: g.id,
    members: settle(groupBucket(g.id), grouped.get(g.id) ?? []),
  }));
  const orderedAuto = auto.map((ag) => ({
    key: ag.key,
    members: settle(
      autoBucket(ag.key),
      ag.memberIds.map((id) => byId.get(id)).filter((s): s is T => !!s)
    ),
  }));
  const loose = settle(
    LOOSE_BUCKET,
    ungrouped.filter((s) => !autoMemberIds.has(s.id))
  );
  return {
    groups: orderedGroups,
    autoGroups: orderedAuto,
    loose,
    flat: [
      ...orderedGroups.flatMap((g) => g.members),
      ...orderedAuto.flatMap((g) => g.members),
      ...loose,
    ],
    buckets,
    bucketOf,
  };
}

/**
 * Did a `groups:*` mutation land? (#326)
 *
 * `groups:create` and `groups:update` resolve `null` when main refused the
 * change — a blank name, a color that is not `#rrggbb`, an unknown group. They
 * no longer THROW for it, so an ordinary UI gesture can no longer become an
 * unhandled renderer rejection over one of App's uncaught `void
 * bridge.groups...then(...)` calls. See `main/workspace/group-ipc.ts` for why
 * that shape was chosen over catching at the call sites.
 *
 * The trade a result shape makes is that "refused" now looks exactly like
 * "done" unless somebody reads it, which is what this exists to prevent: the
 * refusal always leaves a line in the renderer console, next to main's own line
 * carrying the reason. There is deliberately NO new UI — the caller re-reads
 * the store either way, so a refused edit simply reverts to what is really
 * there, which is the idiom the rail's rename field already has for an edit
 * that goes nowhere (Escape, blur, #311's blank guard).
 */
export function groupChangeLanded(what: string, result: unknown): boolean {
  if (result === null || result === undefined) {
    console.warn(`[groups] ${what} was refused — nothing changed (reason is in the app log)`);
    return false;
  }
  return true;
}

export function pickAdoptedGroupId(
  myCardId: string,
  siblingCardIds: string[],
  cards: CardMembership[]
): string | null {
  const byId = new Map(cards.map((c) => [c.cardId, c.groupId]));
  for (const sib of siblingCardIds) {
    if (sib === myCardId) continue;
    const g = byId.get(sib);
    if (g) return g;
  }
  return null;
}
