// DISPATCH LINEAGE (#951, §5.15 "Lifecycle & lineage") — which session sent
// which, and the rail nesting that draws it.
//
// §5.15's sentence is: *"Dispatched sessions nest under the parent in the sidebar
// ('↳ Review of X') … and lineage is recorded so the Feed can show the chain:
// authored → reviewed → fixed → merged."*
//
// ── WHY THIS IS NOT CALLED `lineage.ts` ─────────────────────────────────────
//
// `main/sessions/lineage.ts` already is, and it means something else entirely:
// the chain of NATIVE CONVERSATION IDS a card has been known by (#484), which
// exists so that learning a new id never destroys a transcript. Two modules
// called "lineage" holding two unrelated kinds of parentage is how a reader ends
// up in the wrong file with a plausible-looking answer. This one is about which
// session DISPATCHED which; that one is about which conversation a card is in.
//
// ── WHAT IS PERSISTED, AND WHERE, AND WHY IT IS NOT DERIVED ─────────────────
//
// The ui blob (§5.25), **keyed by CARD id**, exactly like pins, presentation,
// policies, layout and the manual rail order. The done-when says the nesting must
// survive a relaunch and must be "persisted, not derived from liveness", and both
// halves of that matter:
//
//   * a LIVE session id churns on every resume, so a lineage keyed by one would
//     forget the parentage the first time either end restarted — the same defect
//     `lib/pinning` states for pins;
//   * and liveness is not the fact. `main/sessions/dispatch-results.ts` holds the
//     round-trip in memory *on purpose* (a restart ends both ends, so there is no
//     outstanding round-trip left to lose). "Who dispatched whom" outlives that:
//     it is still true of two cards sitting in a relaunched workspace, neither of
//     which is running.
//
// ── THE NESTING IS A FOURTH LAYER OF ONE ORDER, NOT A SECOND ORDER ──────────
//
// `lib/groups`' `railOrder` is the single derivation of rail order, and Ctrl+1..9
// counts against the same call. A nesting pass beside it is how the rail and the
// keyboard end up disagreeing about what is third. So `nestWithin` operates on
// IDS and is called from inside `railOrder`'s per-bucket settle — and from
// `lib/rail-order`'s `planReorder`, so a drag is planned against the same rule
// that paints.
//
// Layering, four deep now, each applied in this order:
//
//   1. BUCKET ORDER    persistent groups, then auto-groups, then loose
//   2. MANUAL ORDER    #559, per bucket
//   3. PINNED FIRST    §5.8, per bucket
//   4. NESTING         this module, per bucket, per PIN BLOCK
//
// Last, and per pin block, is the whole interaction question, and the answer is
// the one `lib/rail-order`'s header already gave for a drag: **§5.8's pin wins.**
// A child follows its parent only where doing so does not cross the
// pinned/unpinned boundary. Pinning is a POSITION guarantee ("the place you look
// for it is the place it is"), and a nesting pass that could pull a pinned row
// down out of the sticky block — or shove an unpinned child up into it — would
// make that guarantee conditional on who dispatched whom. It would also break
// `SessionsRail`'s `bucketRows`, which takes the pinned PREFIX of a bucket as a
// contiguous run.
//
// ── AND THE DEPTH COMES OUT OF THE PLACEMENT, NEVER OUT OF A SECOND LOOKUP ──
//
// This is the load-bearing decision of the module. A row is reported at depth 1
// **only if this pass actually placed it under its parent's subtree.** Every case
// where it could not — the author's card closed first, a parent in a different
// bucket, a parent on the other side of a pin boundary, a cycle in a
// hand-edited blob — falls out as depth 0, and the rail draws no `↳` because
// there is no depth to draw it from.
//
// The done-when asks for that as a behaviour ("the author being closed first
// leaves the child as an ordinary top-level session rather than an orphan with a
// dangling ↳"). Deriving depth from `lineage.has(id)` instead would satisfy the
// sentence in the common case and produce a connector pointing at nothing in
// every other — an arrow to a row that is not above it. One pass, one answer.

/** child CARD id -> the CARD id of the session that dispatched it. */
export type LineageMap = ReadonlyMap<string, string>;

/**
 * The empty lineage — SHARED, for the reason `NO_PINS` and `NO_ORDER` are: the
 * store's initial value must be ONE stable object or every
 * `useSyncExternalStore` snapshot over it re-renders for ever.
 */
export const NO_LINEAGE: LineageMap = new Map<string, string>();

/** ui-blob key (§5.25: the nesting survives relaunch). */
export const LINEAGE_KEY = 'dispatchLineage';

/**
 * How deep a row may be indented.
 *
 * A reviewer can dispatch its own reviewer, so the chain has no natural bound —
 * but the rail is a 300 px column, and indentation that keeps going turns a
 * fourth-generation row into a sliver. Past this depth rows keep their `↳` and
 * stop moving right, which is what every file tree does with a deep path.
 *
 * It is a RENDERING cap and deliberately not a cap on the data: the depth this
 * module reports is the real one, and the clamp is `railDepthIndent`'s.
 */
export const MAX_RAIL_DEPTH = 3;

/**
 * Record that `child` was dispatched by `parent`.
 *
 * Returns the SAME map when nothing changed — identity is the store's change
 * signal, and a no-op write would re-derive rail order and re-render every row.
 *
 * Refuses a self-parent outright rather than relying on `nestWithin`'s cycle
 * guard to make it harmless later: a card is not its own author, and writing the
 * claim into the workspace file would leave a reader to wonder which of the two
 * is the bug.
 */
export function withParent(lineage: LineageMap, child: string, parent: string): LineageMap {
  if (!child || !parent || child === parent) return lineage;
  if (lineage.get(child) === parent) return lineage;
  const next = new Map(lineage);
  next.set(child, parent);
  return next;
}

/**
 * Forget everything this card is part of — BOTH DIRECTIONS.
 *
 * Called from `forgetClosedCard`, which is the one list both close paths run.
 * Both directions because a card is two different facts here: closing a
 * dispatched session retires its own row's parentage, and closing an AUTHOR has
 * to release the children it was the parent of. Dropping only the first would
 * leave a record pointing at a card that no longer exists — which `nestWithin`
 * renders correctly anyway (depth 0, no connector), but which would come back to
 * life and re-nest the child if the author's card id were ever reused. It also
 * keeps the blob from accreting a record per session the workspace ever held,
 * which is `prunePins`' own stated reason.
 *
 * `null` when there was nothing to forget, so the caller can skip a pointless
 * write and re-render — the contract every other per-card forget here uses.
 */
export function withoutCard(lineage: LineageMap, cardId: string): LineageMap | null {
  if (!cardId) return null;
  const doomed = [...lineage].filter(([child, parent]) => child === cardId || parent === cardId);
  if (doomed.length === 0) return null;
  const next = new Map(lineage);
  for (const [child] of doomed) next.delete(child);
  return next;
}

/**
 * Drop records naming cards that no longer exist.
 *
 * `null` when there is nothing to drop — the same contract `prunePins`,
 * `prunePresentation`, `pruneLayout` and `pruneManualOrder` use, called from the
 * same boot sweep.
 *
 * A record is dropped when EITHER end is unknown, which differs from
 * `pruneManualOrder`'s rule and deliberately: a manual order names one thing per
 * entry, while a lineage record is a RELATION, and half a relation is not a
 * weaker version of it — it is a parentage pointing at nothing.
 */
export function pruneLineage(lineage: LineageMap, knownCardIds: Iterable<string>): LineageMap | null {
  const known = new Set(knownCardIds);
  const kept = [...lineage].filter(([child, parent]) => known.has(child) && known.has(parent));
  if (kept.length === lineage.size) return null;
  return new Map(kept);
}

/** Who dispatched this card, if the workspace still knows. */
export function parentOf(lineage: LineageMap, cardId: string | undefined): string | undefined {
  return cardId ? lineage.get(cardId) : undefined;
}

/** What the nesting pass produced. */
export interface NestedIds {
  /** the ids in paint order — every child directly under its parent's subtree */
  readonly ids: readonly string[];
  /**
   * id -> how deep it was PLACED. Absent means 0.
   *
   * Only ids this pass really moved under a parent appear, which is what makes a
   * dangling `↳` unrepresentable — see the module header.
   */
  depth: ReadonlyMap<string, number>;
}

/** Nothing to nest: the same array back, and no depths. Shared empty map for the
 *  identity reason `NO_LINEAGE` exists. */
const NO_DEPTH: ReadonlyMap<string, number> = new Map<string, number>();

/**
 * One contiguous run of ids, with children pulled up under their parents.
 *
 * ⚠️ CALLED PER PIN BLOCK, not per bucket — `railOrder` and `planReorder` both
 * split the bucket at the pinned/unpinned boundary first and call this twice. The
 * function itself only knows about the ids it was handed, which is exactly what
 * makes that split enforceable: a parent outside this run is simply not found,
 * and its child stays where it was at depth 0.
 *
 * Order within the result:
 *
 *   * ROOTS keep the order they arrived in. A root is any id whose parent is not
 *     in this run — including a card with no parent at all, and including one
 *     whose parent was closed. That is the whole of the orphan rule;
 *   * a parent's children follow it immediately, in arrival order, each with its
 *     own children after it (depth-first), so a chain reads top to bottom;
 *   * every id in, every id out, exactly once. The rail is the numbering
 *     authority for `Ctrl+1..9`, so a pass that could drop or duplicate a row
 *     would make the keyboard count something nobody can see.
 *
 * CYCLE-PROOF BY THE WALK, not by a pre-check: the output is built by visiting
 * each id at most once (`placed`), so `A -> B -> A` out of a hand-edited blob
 * produces two roots in arrival order rather than a hang. §4's fail-open rule —
 * a stale or hand-edited blob must never cost the user their workspace — applied
 * to the one value here that can describe a loop.
 *
 * Returns the SAME array when there is nothing to do, so React and the store's
 * identity checks both see an untouched bucket as untouched.
 */
export function nestWithin(ids: readonly string[], lineage: LineageMap): NestedIds {
  if (lineage.size === 0 || ids.length < 2) return { ids, depth: NO_DEPTH };
  const present = new Set(ids);
  // A parent only counts if it is IN THIS RUN. That one condition is the pin
  // boundary, the bucket boundary and the closed-author case all at once.
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const parent = lineage.get(id);
    if (parent === undefined || parent === id || !present.has(parent)) {
      roots.push(id);
      continue;
    }
    const list = kids.get(parent);
    if (list) list.push(id);
    else kids.set(parent, [id]);
  }
  // Nothing in this run has a parent in it: hand the very same array back.
  if (kids.size === 0) return { ids, depth: NO_DEPTH };
  const out: string[] = [];
  const depth = new Map<string, number>();
  const placed = new Set<string>();
  const visit = (id: string, at: number): void => {
    if (placed.has(id)) return; // the cycle guard, and the whole of it
    placed.add(id);
    out.push(id);
    if (at > 0) depth.set(id, at);
    for (const child of kids.get(id) ?? []) visit(child, at + 1);
  };
  for (const root of roots) visit(root, 0);
  // A cycle leaves its members unreachable from any root. They are still rows the
  // user has on screen, so they go at the end, in arrival order, each treated as a
  // root — never dropped. `Ctrl+1..9` counting fewer rows than the rail paints
  // would be a worse bug than a loop rendering oddly.
  //
  // (What they get is NOT uniformly depth 0, which an earlier version of this
  // comment claimed: the first member is a root here, and the rest of the loop
  // hangs off it as ordinary children. That is fine and is the point of doing it
  // this way — the PLACEMENT is still sound, so every row reported at depth 1 is
  // genuinely sitting under its parent and no connector dangles. Only the
  // arbitrary choice of which member became the root is a consequence of the
  // corrupt data, and the alternative — flattening the whole loop — would need a
  // second pass to buy nothing.)
  for (const id of ids) if (!placed.has(id)) visit(id, 0);
  return { ids: out, depth: depth.size > 0 ? depth : NO_DEPTH };
}

/**
 * How far right a row at this depth is drawn, in pixels.
 *
 * THE ONE PLACE A DEPTH BECOMES A NUMBER, for `LABEL_LINES`' reason: the rail row
 * and anything that later wants to line up with it must not each pick their own
 * step. Clamped at `MAX_RAIL_DEPTH` — see that constant for why the clamp is here
 * and not in the data.
 */
export function railDepthIndent(depth: number | undefined): number {
  if (!depth || depth < 1) return 0;
  return Math.min(depth, MAX_RAIL_DEPTH) * 12;
}

// ── persistence ─────────────────────────────────────────────────────────────

/**
 * One ui-blob record -> a lineage map.
 *
 * Anything unrecognised is skipped rather than throwing: a blob outlives the code
 * that wrote it, and a stale value must never cost the user their workspace (§4,
 * fail-open). A self-parent is dropped here as well as refused by `withParent`,
 * because this reader is the one a hand-edited file goes through.
 */
export function loadLineage(raw: unknown): LineageMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_LINEAGE;
  const out = new Map<string, string>();
  for (const [child, parent] of Object.entries(raw as Record<string, unknown>)) {
    if (!child || typeof parent !== 'string' || !parent || parent === child) continue;
    out.set(child, parent);
  }
  return out.size > 0 ? out : NO_LINEAGE;
}

/**
 * The lineage, reduced to what goes in the blob. A workspace that has never
 * dispatched writes nothing at all — `null` means "delete the key". Keys sorted,
 * so an unchanged lineage does not rewrite the file in a different order each
 * launch.
 */
export function persistableLineage(lineage: LineageMap): Record<string, string> | null {
  if (lineage.size === 0) return null;
  const out: Record<string, string> = {};
  for (const child of [...lineage.keys()].sort()) out[child] = lineage.get(child)!;
  return out;
}
