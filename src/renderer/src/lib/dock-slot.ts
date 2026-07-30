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
