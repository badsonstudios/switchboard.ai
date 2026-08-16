// The Events drawer's badge (P2-E14-01, Shape B — the 2026-08-13 design gate).
//
// The Events panel used to be a 220px column that every layout mode paid for.
// Shape B keeps its CONTENT exactly and changes its shape: an overlay drawer on
// the right edge, collapsed by default to a slim tab. Collapsed, that tab is
// the only thing left of the panel on screen, so it has to carry — in one
// glance — everything the column used to say by simply being there:
//
//   • HOW MANY sessions are waiting          → the attention-queue depth
//   • HOW BADLY the worst of them is waiting → the hottest queued kind, as a tint
//   • WHETHER a notice is up behind it       → the secondary marker
//
// This module derives all three, and it is pure so each rule is a unit test
// rather than an e2e guess.
//
// IT DEFERS TO lib/queue.ts FOR THE FIRST TWO rather than re-deciding them.
// The queue is the single ordering authority (E9-03, §5.12) — the drawer
// renders it, and the badge is the drawer's smallest possible rendering of it.
// So `attentionQueue` is called HERE, on the raw events, instead of this taking
// an already-ordered list as a parameter: "hottest" is the head of the queue by
// definition, and a caller handing over events in arrival order would otherwise
// make that quietly wrong. Sorting a list with one entry per session costs
// nothing next to being able to say the badge and Ctrl+Space cannot disagree.
import { AttentionEvent, attentionQueue } from './queue';

/**
 * The notice slot's THREE tenants (the #425 coordination note), as the badge
 * sees them — which is only whether each is up.
 *
 * Spelled out as three named fields rather than a count the caller adds up:
 * they rehomed into this drawer together and a fourth tenant has to be a
 * visible edit here, not an invisible one at a call site. Deliberately widened
 * to `unknown` where the badge does not care about the payload — this module
 * has no business knowing a version string or an incident's shape.
 */
export interface DrawerNotices {
  /** E19-04's update notice, in either flavour */
  updateNotice?: { kind: 'installed' | 'available'; version: string } | null;
  /** E8-06's "a saved display is back" offer */
  reconnectOffer?: boolean;
  /** P2-E14-07 / §5.14's open provider incidents */
  incidents?: readonly unknown[];
}

export interface DrawerBadge {
  /** how many sessions are waiting on a human — the queue's depth */
  count: number;
  /**
   * The kind at the HEAD of the queue, or null when nothing is waiting. The
   * queue is priority-ordered, so its head is by construction the worst thing
   * on the list — which is what the tab is tinted with.
   */
  hottest: AttentionEvent['kind'] | null;
  /** how many of the three notice tenants are up right now */
  notices: number;
}

/**
 * How many notices are live. A number rather than a boolean because the tab's
 * accessible name says it: a marker a sighted user reads as "there is something
 * behind this" has to become a word for someone who cannot see the dot (§5.32).
 */
export function liveNotices(n: DrawerNotices): number {
  return (
    (n.updateNotice ? 1 : 0) + (n.reconnectOffer ? 1 : 0) + (n.incidents?.length ? 1 : 0)
  );
}

/**
 * Everything the collapsed tab has to know, from the same list Ctrl+Space walks.
 *
 * `events` is the queue's OWN view of the feed — the subset E9-10's `none`
 * focus policy has not silenced — and not the full feed. A badge counted off
 * the full feed would advertise work the hotkey refuses to take you to, which
 * is the exact eye-and-keyboard disagreement E9-03 exists to prevent. It is
 * also why `ready` never counts: `attentionQueue` filters it out, because
 * reviewed work is a log entry and not a to-do.
 */
export function badgeState(
  events: readonly AttentionEvent[],
  notices: DrawerNotices
): DrawerBadge {
  const queue = attentionQueue(events);
  return {
    count: queue.length,
    hottest: queue[0]?.kind ?? null,
    notices: liveNotices(notices),
  };
}

/** one clause of the tab's accessible name, still untranslated */
export interface BadgeLine {
  key: string;
  params?: Record<string, unknown>;
}

/**
 * The tab's accessible name, as i18n keys — the same shape (and the same
 * joined-with-' · ' rendering) as `healthTooltip`, because it is the same job:
 * a control whose meaning is carried by a number and a colour needs that
 * meaning spelled out in WORDS for anyone who cannot see either (§5.32).
 *
 * The count clause is always present, including at zero. A tab that dropped it
 * when the queue emptied would be a control whose name changed shape rather
 * than value, and "Events, nothing waiting" is the sentence that tells you the
 * drawer is worth leaving shut.
 */
export function badgeLabel(badge: DrawerBadge): BadgeLine[] {
  const lines: BadgeLine[] = [
    { key: 'events.drawer.label' },
    { key: 'events.drawer.waiting', params: { count: badge.count } },
  ];
  // only when there IS one: a marker nobody can see must not become a clause
  // that says "0 notices" to everyone who can hear
  if (badge.notices > 0) {
    lines.push({ key: 'events.drawer.notices', params: { count: badge.notices } });
  }
  return lines;
}
