// Where a card SITS (P2-E15-08, §5.8).
//
// §5.8's reveal contract is "restores the session to exactly where it was
// (dock slot or its monitor)". Dockview knows that only while the panel
// exists: hiding a card removes the panel, and with it every trace of where it
// was. So we record the slot BEFORE removing it, and place it back from that
// record.
//
// The dockview-touching part is deliberately tiny and structurally typed —
// everything that makes a DECISION is a pure function below, because "which
// group does a revealed card go back to when its old group is gone" is exactly
// the kind of rule that is easy to get wrong and impossible to test through a
// real DockviewApi.
import { Box } from './layout';

/** A remembered position in the workspace. Persisted in the ui blob. */
export interface SlotRef {
  /** dockview group id — round-trips through toJSON/fromJSON, so it survives
   *  a relaunch as well as a hide */
  groupId: string;
  /** tab index within that group; -1 when unknown */
  index: number;
  location: 'grid' | 'popout';
  /** screen rect of the popout window, when the card was in one */
  box?: Box;
}

/** The shape of a dockview panel this module needs — structural on purpose, so
 *  the tests can hand it a plain object. */
export interface SlotSource {
  id: string;
  group: {
    id: string;
    panels: readonly { id: string }[];
    api: { location: { type: string } };
  };
}

/** Record where this panel is. `box` is the popout window's screen rect, which
 *  only the caller can read (it needs the live Window). */
export function captureSlot(panel: SlotSource, box?: Box | null): SlotRef | null {
  const groupId = panel.group?.id;
  if (!groupId) return null;
  const index = panel.group.panels.findIndex((p) => p.id === panel.id);
  const location = panel.group.api.location.type === 'popout' ? 'popout' : 'grid';
  return {
    groupId,
    index,
    location,
    ...(location === 'popout' && box ? { box } : {}),
  };
}

/** Where a revealed panel should go. */
export interface Placement {
  /** an existing dockview group to join, or null for "caller's fallback" */
  groupId: string | null;
  /** tab index within that group; -1 means append */
  index: number;
  /** tear it out into a popout window at this rect after adding it */
  popout: Box | null;
}

const NOWHERE: Placement = { groupId: null, index: -1, popout: null };

/**
 * Decide where a card goes when it comes back.
 *
 * Best-effort by construction, and worth being honest about: removing the last
 * panel of a group DESTROYS the group, so a card that was alone in its slot has
 * nothing left to rejoin and lands in the caller's fallback group. "Exactly
 * where it was" holds while the neighbourhood still exists.
 *
 * A surviving group is joined wherever it lives — including a popout window,
 * which IS the prior slot. Only when the group is gone do we ask for a new
 * popout window at the remembered rect.
 */
export function placeAt(
  slot: SlotRef | null | undefined,
  existingGroupIds: readonly string[]
): Placement {
  if (!slot) return NOWHERE;
  if (existingGroupIds.includes(slot.groupId)) {
    return { groupId: slot.groupId, index: slot.index >= 0 ? slot.index : -1, popout: null };
  }
  return { groupId: null, index: -1, popout: slot.location === 'popout' ? (slot.box ?? null) : null };
}

/**
 * dockview opens a popout at `opener.screenX + position.left`, so a remembered
 * ABSOLUTE screen rect has to be made opener-relative on the way back in or the
 * main window's origin gets added to it a second time (#86).
 */
export function openerRelative(box: Box, opener: { screenX: number; screenY: number }): Box {
  return {
    left: box.left - opener.screenX,
    top: box.top - opener.screenY,
    width: box.width,
    height: box.height,
  };
}

/** The shape of a dockview group `homeGroupId` needs to judge — structural, so
 *  the tests can hand it plain objects. */
export interface HomeCandidate {
  id: string;
  /** dockview's `group.api.location.type` */
  location: string;
  /** does it hold a document viewer? #462's document area, by its only tell */
  hasDocument: boolean;
}

/**
 * The group a card DOCKING BACK should return to — its own slot, or nothing.
 *
 * `placeAt` above answers the reveal's question ("where was this panel"), and
 * deliberately treats a popout slot as a place to go back to. A dock-back is
 * the opposite motion: the popout is what the card is LEAVING, so the record it
 * must be placed from is `home` — the last grid slot it occupied (#558).
 *
 * `null` is a real answer and the reason this exists: a card born inside a
 * popped-out window (#531) has no grid slot, and the group dockview would hand
 * it — the one the WINDOW was created from, i.e. its opener's — is a slot it
 * never earned. The caller falls back to `sessionCardHome`'s ordinary placement
 * rules, which is where a brand new session would land.
 *
 * Three ways a remembered home stops being one, all of them ordinary:
 *
 *  * it was a POPOUT slot — never written here, but a persisted blob outlives
 *    the code that wrote it, and a `home` naming another OS window would send a
 *    docking card straight back out of the main window;
 *  * the group is GONE, or is itself in a popout now (someone dragged the whole
 *    group out while this card was away);
 *  * the group became the DOCUMENT AREA. A viewer never displaces a session and
 *    a session never displaces what you are reading (#462/#501) — the rule
 *    holds even when the group used to be this card's, because what the user
 *    can see now beats what the card remembers.
 *
 * NOTE the group may be INVISIBLE and that is not a disqualifier: an empty
 * hidden grid group is exactly the dock-back husk dockview leaves behind when a
 * card is torn out, and it IS the card's slot. The caller un-hides it.
 */
export function homeGroupId(
  home: SlotRef | null | undefined,
  groups: readonly HomeCandidate[]
): string | null {
  if (!home || home.location !== 'grid') return null;
  const g = groups.find((c) => c.id === home.groupId);
  if (!g || g.location !== 'grid' || g.hasDocument) return null;
  return g.id;
}

/**
 * A card dockview has just handed back to the grid: does it keep where it landed?
 *
 * A popout window carries ONE dock-back reference — the group the window was
 * torn from — and dockview returns EVERY member of a closing window through it
 * (`disposePopoutWindow` -> `moveGroupWithoutDestroying({ from, to:
 * referenceGroup })`). #558 fixed the one route we drive ourselves, the ⤡ with
 * company; this is the question for the routes dockview drives: the window
 * closed from the OS, the ⤡ that empties it, a card left holding a window its
 * opener made.
 *
 * Two ways the landing is honest, and they are the whole rule:
 *
 *  * IT IS THE CARD'S OWN SLOT. The card that tore the window off comes back to
 *    exactly the group it left, which is what the reference means for it. Say
 *    so rather than moving it, so the ordinary round trip costs nothing.
 *  * IT ARRIVED BESIDE SOMEBODY. A group that still holds other panels is not a
 *    slot being claimed — the card is a tab in somebody else's group, which is
 *    precisely where #558 says a card with no claim belongs ("a tab beside the
 *    card that owns that half rather than instead of it").
 *
 * What is left is a card sitting ALONE in a group that is not its own: it has
 * been handed a whole slot on the strength of a reference it never earned, and
 * that is #657. The caller places it again — its own home, or the ordinary
 * placement rules for a card that has none.
 *
 * `landingGroupSize` COUNTS THIS CARD. One means alone.
 */
export function keepsInheritedGroup(args: {
  landingGroupId: string;
  landingGroupSize: number;
  /** `homeGroupId(home, groups)` — the card's own slot, when it still has one */
  homeId: string | null;
}): boolean {
  return args.homeId === args.landingGroupId || args.landingGroupSize > 1;
}
