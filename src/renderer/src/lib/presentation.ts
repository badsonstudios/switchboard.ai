// Per-card presentation state (P2-E15-08, AR-P1-5, §5.8).
//
// Which view tab a card is showing, where it sits on §5.8's presentation
// ladder, and which dock slot it came from. This used to be `useState` inside
// SessionCardPanel, which meant it died with the panel — and E9-05's contract
// is "reveal restores it to EXACTLY its prior dock slot or monitor", i.e. state
// that must OUTLIVE the panel, while E9-07 drives every card at once from the
// palette including cards that are not mounted at all.
//
// WHAT IS PERSISTED AND WHAT IS NOT is the load-bearing distinction here:
//
//   • view, ladder, slot,
//     home                 — persisted. They are the user's arrangement and
//                            §5.25 says the workspace comes back as it was.
//                            `home` outlives a relaunch for the same reason it
//                            exists at all (#558): a card can be popped out
//                            when the app quits, and the slot it must come back
//                            to is the one it left BEFORE the window.
//   • poppedOut, suspended — reflected only. dockview's own layout JSON already
//                            round-trips popout location and geometry, and a
//                            second copy of that in our blob is just two
//                            authorities waiting to disagree. `suspended` is a
//                            lifecycle fact about a live session, and a fresh
//                            launch has none.
import type { PanelId } from '../extensibility/contributions';
import { DEFAULT_PANEL_ID } from '../extensibility/contributions';
import type { SlotRef } from './dock-slot';

/**
 * §5.8's presentation ladder: `expanded → collapsed strip → tabbed → hidden`.
 *
 * This file is the ladder's HOME — the value, its persistence and its
 * round-trip. What each rung MEANS, how you step between them and which events
 * bring a session back up are lib/ladder's (P2-E15-08 built the home, P2-E9-05
 * moved in); the dockview verbs that carry a card between rungs are
 * SessionGrid's `setCardLadder`.
 */
export type Ladder = 'expanded' | 'collapsed' | 'tabbed' | 'hidden';

const LADDER: readonly string[] = ['expanded', 'collapsed', 'tabbed', 'hidden'];

export interface CardPresentation {
  /** the active view tab */
  readonly view: PanelId;
  readonly ladder: Ladder;
  /** where it was when it was last placed — how a reveal finds its way back */
  readonly slot: SlotRef | null;
  /**
   * The last grid slot this card occupied WHILE EXPANDED — its home, the place
   * ⤡ brings it back to (#558).
   *
   * "While expanded" is `captureSlots`' gate, not a separate rule, and it does
   * leave a gap worth knowing about: a card stacked into the tab group and then
   * popped out of it docks back to the slot it held before the stack, not to
   * the stack it visibly left. That is the same reasoning `slot` uses — a
   * tabbed card is not AT its home — and it is not a regression, since before
   * this the card went to the first visible group either way.
   *
   * Note lib/ladder calls `slot` the card's "home" in prose, meaning the rung
   * question "is this card at its own slot". This field is the narrower thing:
   * the slot itself, for one gesture.
   *
   * Not the same question as `slot`, which is "where is it now" and becomes a
   * POPOUT slot the moment the card is torn off. That is right for a reveal
   * (§5.8 restores a card to its monitor) and useless for a dock-back, which
   * needs the thing the popout replaced. So this is only ever written from a
   * grid slot, and a card BORN in a popout window (#531) has none — which is
   * the whole point: it never earned a slot in the grid, so it docks back
   * through the ordinary placement rules instead of inheriting its opener's.
   */
  readonly home: SlotRef | null;
  /** in its own OS window (a reflection of dockview's truth, never persisted) */
  readonly poppedOut: boolean;
  /** restored-but-not-resumed, or its popout window was closed (not persisted) */
  readonly suspended: boolean;
}

/** Frozen and shared: an unknown card must return the SAME object every call,
 *  because useSyncExternalStore compares snapshots by identity. */
export const DEFAULT_PRESENTATION: CardPresentation = Object.freeze({
  view: DEFAULT_PANEL_ID,
  ladder: 'expanded',
  slot: null,
  home: null,
  poppedOut: false,
  suspended: false,
});

/** The persisted subset — see the header for why it is a subset. */
export interface PersistedPresentation {
  view?: PanelId;
  ladder?: Ladder;
  slot?: SlotRef | null;
  home?: SlotRef | null;
}

export const PRESENTATION_KEY = 'presentation';
/** P2-E12-08 stored one ui-blob key per card. Migrated on load, then deleted. */
export const LEGACY_VIEW_PREFIX = 'viewTab.';

function isLadder(v: unknown): v is Ladder {
  return typeof v === 'string' && LADDER.includes(v);
}

/** A window rect is four real numbers or it is nothing: a half-written `box`
 *  would reach the popout opener as NaN and put the window who-knows-where. */
function readBox(v: unknown): SlotRef['box'] {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  const nums = ['left', 'top', 'width', 'height'].map((k) => b[k]);
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const [left, top, width, height] = nums as number[];
  return { left, top, width, height };
}

function readSlot(v: unknown): SlotRef | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.groupId !== 'string' || !s.groupId) return null;
  const location = s.location === 'popout' ? 'popout' : 'grid';
  const box = readBox(s.box);
  return {
    groupId: s.groupId,
    index: typeof s.index === 'number' && Number.isFinite(s.index) ? s.index : -1,
    location,
    ...(box ? { box } : {}),
  };
}

/** One card's persisted record -> a full presentation. Anything unrecognised
 *  falls back to the default rather than throwing: a ui blob outlives the code
 *  that wrote it, and a stale value must never cost the user their workspace. */
export function fromPersisted(raw: unknown): CardPresentation {
  if (!raw || typeof raw !== 'object') return DEFAULT_PRESENTATION;
  const r = raw as Record<string, unknown>;
  return Object.freeze({
    view: typeof r.view === 'string' && r.view ? r.view : DEFAULT_PRESENTATION.view,
    ladder: isLadder(r.ladder) ? r.ladder : DEFAULT_PRESENTATION.ladder,
    slot: readSlot(r.slot),
    home: readSlot(r.home),
    poppedOut: false,
    suspended: false,
  });
}

/**
 * Build the presentation map from a ui blob, migrating the legacy per-card
 * `viewTab.<cardId>` keys.
 *
 * Returns the keys that were migrated so the caller can delete them: leaving
 * both homes writable is how the two quietly disagree six months from now.
 */
export function loadPresentation(blob: Readonly<Record<string, unknown>>): {
  map: Map<string, CardPresentation>;
  legacyKeys: string[];
} {
  const map = new Map<string, CardPresentation>();
  const stored = blob[PRESENTATION_KEY];
  if (stored && typeof stored === 'object') {
    for (const [cardId, raw] of Object.entries(stored as Record<string, unknown>)) {
      if (cardId) map.set(cardId, fromPersisted(raw));
    }
  }
  const legacyKeys: string[] = [];
  for (const [key, value] of Object.entries(blob)) {
    if (!key.startsWith(LEGACY_VIEW_PREFIX)) continue;
    legacyKeys.push(key);
    const cardId = key.slice(LEGACY_VIEW_PREFIX.length);
    // the new home wins: a card present in both was written since the upgrade
    if (!cardId || map.has(cardId) || typeof value !== 'string' || !value) continue;
    map.set(cardId, Object.freeze({ ...DEFAULT_PRESENTATION, view: value }));
  }
  return { map, legacyKeys };
}

/** The map, reduced to what goes in the blob. Cards sitting at the default are
 *  omitted entirely — an untouched workspace should not accrete a record per
 *  card it ever opened. */
export function persistablePresentation(
  map: ReadonlyMap<string, CardPresentation>
): Record<string, PersistedPresentation> {
  const out: Record<string, PersistedPresentation> = {};
  for (const [cardId, p] of map) {
    const entry: PersistedPresentation = {};
    if (p.view !== DEFAULT_PRESENTATION.view) entry.view = p.view;
    if (p.ladder !== DEFAULT_PRESENTATION.ladder) entry.ladder = p.ladder;
    if (p.slot) entry.slot = p.slot;
    if (p.home) entry.home = p.home;
    if (Object.keys(entry).length > 0) out[cardId] = entry;
  }
  return out;
}

function sameSlot(a: SlotRef | null, b: SlotRef | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.groupId === b.groupId &&
    a.index === b.index &&
    a.location === b.location &&
    a.box?.left === b.box?.left &&
    a.box?.top === b.box?.top &&
    a.box?.width === b.box?.width &&
    a.box?.height === b.box?.height
  );
}

/** Nothing actually changed? Then the store must not publish a new object:
 *  identity IS the change signal, so a no-op write would re-render every card
 *  (recapturing a slot on each layout change makes this a hot path). */
export function samePresentation(a: CardPresentation, b: CardPresentation): boolean {
  return (
    a.view === b.view &&
    a.ladder === b.ladder &&
    a.poppedOut === b.poppedOut &&
    a.suspended === b.suspended &&
    sameSlot(a.slot, b.slot) &&
    sameSlot(a.home, b.home)
  );
}

/** Does this change need writing to the blob? Reflected-only fields don't. */
export function persistedChanged(a: CardPresentation, b: CardPresentation): boolean {
  return (
    a.view !== b.view ||
    a.ladder !== b.ladder ||
    !sameSlot(a.slot, b.slot) ||
    !sameSlot(a.home, b.home)
  );
}

/** Drop records for cards that no longer exist. Returns null when there is
 *  nothing to drop, so the caller can skip a pointless write + re-render. */
export function prunePresentation(
  map: ReadonlyMap<string, CardPresentation>,
  knownCardIds: Iterable<string>
): Map<string, CardPresentation> | null {
  const known = new Set(knownCardIds);
  const stale = [...map.keys()].filter((id) => !known.has(id));
  if (stale.length === 0) return null;
  const next = new Map(map);
  for (const id of stale) next.delete(id);
  return next;
}
