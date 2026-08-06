// §5.8's presentation ladder — the RULES (P2-E9-05).
//
// P2-E15-08 built the home: a per-card `ladder` rung that outlives the panel,
// persisted in the ui blob, plus the hidden↔expanded transitions. This module
// is the rest of the ladder — what each rung MEANS, how you step between them,
// and which events bring a session back up on their own.
//
// Pure by construction (no React, no dockview, no IPC): every rule below is a
// unit test rather than an e2e guess. SessionGrid owns the dockview verbs;
// nothing here knows dockview exists.
//
// ── WHAT THE FOUR RUNGS ARE ─────────────────────────────────────────────────
//
//   expanded   the full card, in its dock slot. Today's default.
//   collapsed  NO dockview panel; the session shows as a slim status row in the
//              collapsed strip. It gives its slot back to its neighbours.
//   tabbed     a dockview panel, but stacked with every other tabbed card in
//              ONE shared group — so all of them together cost one slot, and
//              only the selected one is on screen.
//   hidden     no panel and no row. The session lives on in the rail, its lamp
//              and the events list, and nowhere else (§5.8, verbatim).
//
// The ordering is decreasing screen cost, which is what makes it a ladder:
// a collapsed card always shows one status line; a tabbed card usually shows
// nothing at all but its tab label.
//
// ── WHY `collapsed` LEAVES THE GRID ─────────────────────────────────────────
//
// It is tempting to keep the panel and just render a short body inside it —
// far less code. That was rejected because it makes the rung cosmetic: a card
// collapsed inside a 2×2 dock leaves its whole quadrant empty, so nothing is
// actually given back. It also breaks the two items that compose on this one:
// E9-07's focus mode is specified as "one large + slim strips" AND as "a
// COMPOSITION of ladder states", which only works if collapsing the other seven
// sessions hands the screen to the eighth; and E9-08 aggregates "more than ~3
// idle" into a single row, which needs the collapsed sessions to be rows
// somewhere in the first place.
//
// Removing the panel is exactly what `hidden` already does, slot capture and
// all — so collapsed is the same mechanism with a row left behind, and the
// reveal contract ("restores it to EXACTLY its prior dock slot") is the one
// P2-E15-08 already proved.
import type { Ladder } from './presentation';
import type { RailSession } from '../model/types';
import { presentStatus, StatusToken } from './rail-view';
import type { AttentionEvent } from './queue';

/** Top (most screen) to bottom (none). The order IS the ladder. */
export const LADDER_ORDER: readonly Ladder[] = ['expanded', 'collapsed', 'tabbed', 'hidden'];

/** Step one rung down the ladder; the bottom rung stays put (never wraps —
 *  "collapse again" turning a hidden session back into a full card would be a
 *  gesture that silently undoes itself). */
export function stepDown(rung: Ladder): Ladder {
  const i = LADDER_ORDER.indexOf(rung);
  return LADDER_ORDER[Math.min(i + 1, LADDER_ORDER.length - 1)] ?? 'expanded';
}

/** Step one rung up. The top rung stays put, same reasoning as stepDown. */
export function stepUp(rung: Ladder): Ladder {
  const i = LADDER_ORDER.indexOf(rung);
  return LADDER_ORDER[Math.max(i - 1, 0)] ?? 'expanded';
}

/**
 * Does this rung have a dockview panel?
 *
 * The single source of truth for the hide-vs-show half of every transition:
 * SessionGrid adds a panel when it becomes true and removes one when it becomes
 * false, so a new rung cannot be added without answering this question.
 */
export function hasPanel(rung: Ladder): boolean {
  return rung === 'expanded' || rung === 'tabbed';
}

/** Does this rung show a row in the collapsed strip? Exactly one rung does —
 *  `hidden` deliberately shows nothing, which is the whole difference between
 *  the two panel-less rungs. */
export function showsRow(rung: Ladder): boolean {
  return rung === 'collapsed';
}

/**
 * Is this rung's dock slot its HOME, or where it currently sits?
 *
 * A tabbed card has a panel, but that panel has been moved into the shared tab
 * group — which is not where it came from and not where stepping back up should
 * put it. So the slot recorder must leave tabbed cards alone or the first layout
 * change after tabbing would overwrite home with the tab stack.
 */
export function slotIsLive(rung: Ladder): boolean {
  return rung === 'expanded';
}

// ── reveal triggers (§5.8) ──────────────────────────────────────────────────
//
// "Reveal triggers: needs-attention (permission / input / done) or user click
// anywhere (sidebar, event, lamp)."
//
// The click half has worked since P2-E15-08 — every click path funnels through
// GridController.focusSession, which reveals a card that has no panel. This is
// the other half: the session comes back on its own when it needs a human.

/**
 * The event kinds that bring a session back up, straight from §5.8's
 * parenthetical. `crashed` is NOT among them and that is deliberate rather than
 * an oversight: §5.8 enumerates three, a crashed session is not waiting on an
 * answer, and it still reaches you through the attention queue, its lamp and
 * the events list. Widening this is E9-10's call (focus-stealing policy), not
 * a quiet decision to make here.
 */
export const REVEAL_KINDS: readonly AttentionEvent['kind'][] = [
  'needs-permission',
  'needs-input',
  'done',
];

/** The subset of a feed event this module reads. Structural on purpose — the
 *  tests hand it plain objects, and it stays independent of EventDto's growth.
 *  `kind` is the QUEUE's union, not a bare string, so renaming a feed kind is a
 *  compile error here rather than a trigger that silently stops firing. */
export interface RevealEvent {
  /** minted fresh by EventFeed on EVERY ingest — see `seen` below */
  id: number;
  /** the LIVE session id; the caller maps it to a card */
  sessionId: string;
  kind: AttentionEvent['kind'];
}

export interface RevealPlan {
  /** cards to bring back to `expanded`, in event order */
  cardIds: string[];
  /** the event ids now accounted for — carry this forward */
  seen: ReadonlySet<number>;
}

/**
 * Which cards a fresh event list should reveal.
 *
 * SEEN IS KEYED BY EVENT ID, exactly as lib/queue's visited set is, and for the
 * same reason: EventFeed mints a new id on every ingest, so a session that is
 * answered, collapsed again and then blocks a second time arrives as an id
 * nobody has seen and reveals itself again. Keying by session would reveal it
 * once and never again for the life of the process.
 *
 * Ids that have left the list are dropped, so the set tracks the feed rather
 * than growing forever — and a replayed event (a feed refresh after a reconnect)
 * cannot arrive pre-seen and be silently skipped.
 *
 * The FIRST list is seeded, not acted on. At boot the feed hands over whatever
 * was already there, and §5.25 says the workspace comes back as the user left
 * it — a launch that instantly un-collapses every session that was waiting when
 * you quit yesterday is not that.
 */
export function revealTargets(
  events: readonly RevealEvent[],
  seen: ReadonlySet<number>,
  opts: {
    /** live session id -> durable card id */
    cardIdFor: (sessionId: string) => string;
    /** the card's current rung */
    rungOf: (cardId: string) => Ladder;
    /** false for the first list after boot: seed `seen`, reveal nothing */
    act: boolean;
  }
): RevealPlan {
  const live = new Set<number>();
  const cardIds: string[] = [];
  for (const e of events) {
    live.add(e.id);
    if (!opts.act) continue;
    if (seen.has(e.id)) continue;
    if (!REVEAL_KINDS.includes(e.kind)) continue;
    const cardId = opts.cardIdFor(e.sessionId);
    // already at the top of the ladder: nothing to reveal, and re-placing a
    // panel that is on screen would yank focus for no reason
    if (!cardId || opts.rungOf(cardId) === 'expanded') continue;
    if (!cardIds.includes(cardId)) cardIds.push(cardId);
  }
  // prune first, then admit: an id that is no longer in the feed must be
  // forgettable, or a session that blocks again after a quiet spell stays seen
  const next = new Set<number>();
  for (const id of seen) if (live.has(id)) next.add(id);
  for (const id of live) next.add(id);
  return { cardIds, seen: next };
}

// ── the collapsed strip ─────────────────────────────────────────────────────

export interface CollapsedRow {
  cardId: string;
  title: string;
  /** the six-way status ramp; var(--status-<token>) is the hue */
  token: StatusToken;
  /** a human is the only thing that can move this session on */
  needsYou: boolean;
  /** i18n key for the state text (the ASK when it needs you, else the state) */
  labelKey: string;
  /** the session's identity color, for the row's leading bar */
  accent?: string;
  /** §5.8's pinning contract (E9-09): this row never folds into the aggregate */
  pinned?: boolean;
}

/**
 * The rows of the collapsed strip, in RAIL ORDER.
 *
 * Rail order and not insertion order deliberately: it is the numbering
 * authority for Ctrl+1..9 and what the rail and the urgency strip both render,
 * so a session cannot be third in one list and first in another.
 *
 * The status vocabulary is lib/rail-view's, exactly as the lamps' is: a
 * collapsed row is the third surface describing the same session, and three
 * surfaces deriving "needs you" separately is how two of them end up wrong.
 */
export function collapsedRows(
  sessions: readonly RailSession[],
  rungOf: (cardId: string) => Ladder,
  /** §5.8's pinning contract (E9-09) — carried on the row so `foldableRow`
   *  stays a function of the row alone, exactly as the other three carve-outs
   *  are. Defaults to "nothing is pinned" so every existing caller is unmoved. */
  pinnedOf: (cardId: string) => boolean = () => false
): CollapsedRow[] {
  return sessions
    .filter((s) => showsRow(rungOf(s.id)))
    .map((s) => {
      const p = presentStatus(s.status);
      return {
        cardId: s.id,
        title: s.title,
        token: p.token,
        needsYou: p.needsYou,
        labelKey: p.labelKey,
        ...(s.accent ? { accent: s.accent } : {}),
        ...(pinnedOf(s.id) ? { pinned: true } : {}),
      };
    });
}

// ── idle aggregation (P2-E9-08) ─────────────────────────────────────────────
//
// §5.8, verbatim: "idle sessions collapse to compact rows; more than ~3 idle
// aggregate into a single 'N idle sessions' row. Working / errored /
// currently-focused sessions always keep their own row."
//
// WHERE THIS LIVES, and why it is not a second auto-collapse. The first half of
// that bullet — idle sessions BECOMING compact rows — is already shipped: the
// `collapsed` rung is the compact row (E9-05), and E9-07's focus and queue modes
// are what put the sessions you are not watching onto it. A standing sweep that
// collapsed idle cards on its own would contradict §5.8's own amended default
// (`always-visible`, 2026-08-04: nothing minimizes unasked), so this item adds
// no such sweep. It implements the SECOND half — what the strip does once it has
// more idle rows in it than are worth reading one by one.
//
// The aggregate is a DISCLOSURE, not a rung: nothing moves on the ladder, no
// session changes state, and each folded session is still in the rail, its lamp
// and the events list. All the fold does is stop eight identical "idle" chips
// from crowding out the two rows that are actually saying something.

/**
 * How many foldable rows it takes before they fold ("more than ~3").
 *
 * At three or fewer, listing them costs less than the click it takes to unfold
 * them — the fold only pays for itself once the strip is longer than a glance.
 */
export const IDLE_FOLD_MIN = 4;

/** One thing to draw in the strip: a session's row, or the aggregate standing
 *  in for several of them. */
export type StripItem =
  | { kind: 'row'; row: CollapsedRow }
  | { kind: 'fold'; rows: readonly CollapsedRow[] };

/**
 * May this row disappear into the aggregate?
 *
 * The four carve-outs are §5.8's, in its own order:
 *
 *   • WORKING is not idle. `token` is lib/rail-view's vocabulary, so 'starting'
 *     reads as working here exactly as it does in the rail and on the lamps —
 *     one rule, three surfaces, as it has been since E9-04.
 *   • ERRORED is not idle, and neither is anything that NEEDS YOU. `crashed`,
 *     `needs-permission`, `needs-input` and `done` all carry `needsYou`, and the
 *     one row you are looking for is never the one we hide. (The `needsYou` test
 *     is redundant against `token === 'idle'` today and deliberately kept: a
 *     future status that reads idle but wants a human must not slip in behind a
 *     token check.)
 *   • THE FOCUSED SESSION keeps its own row. `activeCardId` is the same
 *     authority lib/layout-mode exempts as "the card you are IN", so the strip
 *     and the layout engine cannot disagree about which session that is. It is
 *     belt-and-braces rather than the common case — a focused card normally has
 *     a dockview panel and so is not in the strip at all — and it stays because
 *     the strip must not silently depend on that invariant holding for every
 *     future thing that drives rungs from outside a card.
 *   • A PINNED SESSION never folds (E9-09). §5.8's pinning contract names idle
 *     aggregation among the bulk operations a pinned session is exempt from,
 *     and this is that operation — the fold is precisely the thing that takes a
 *     session's position in the list away, which is what pinning protects. Note
 *     it does NOT keep the session expanded: a pinned card a layout mode
 *     collapsed is still a strip row, it just stays a row OF ITS OWN. That is
 *     "protects existence and position, not size", in one line.
 */
export function foldableRow(row: CollapsedRow, activeCardId: string | null): boolean {
  return (
    row.token === 'idle' && !row.needsYou && !row.pinned && row.cardId !== activeCardId
  );
}

/**
 * The strip's contents: rows in rail order, with the idle ones folded once
 * there are enough of them.
 *
 * The aggregate takes the POSITION OF THE FIRST ROW IT SWALLOWS rather than
 * being appended, so the rows that keep their place keep it: the strip is
 * ordered by the rail (the numbering authority behind Ctrl+1..9), and a fold
 * that shunted itself to one end would reorder everything around it.
 *
 * Pure, and it returns the folded rows rather than only their count — the view
 * needs them to list on disclosure, and the alternative (handing back ids and
 * making the component look them up again) is a second derivation of the same
 * list.
 */
export function stripItems(
  rows: readonly CollapsedRow[],
  opts?: { activeCardId?: string | null }
): StripItem[] {
  const activeCardId = opts?.activeCardId ?? null;
  const folded = rows.filter((r) => foldableRow(r, activeCardId));
  if (folded.length < IDLE_FOLD_MIN) return rows.map((row) => ({ kind: 'row', row }));
  const items: StripItem[] = [];
  let placed = false;
  for (const row of rows) {
    if (foldableRow(row, activeCardId)) {
      if (!placed) {
        items.push({ kind: 'fold', rows: folded });
        placed = true;
      }
      continue;
    }
    items.push({ kind: 'row', row });
  }
  return items;
}
