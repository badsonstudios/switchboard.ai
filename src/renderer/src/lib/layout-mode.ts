// §5.8's layout modes — grid · focus · queue, plus maximize (P2-E9-07).
//
// E9-05 built the ladder (what the four rungs mean, how one session moves
// between them). This module is the WORKSPACE-level answer: one setting that
// puts EVERY session on a rung at once.
//
//   grid    every session gets its own card. Today's behaviour, and the
//           default — the absence of a layout rule rather than a rule.
//   focus   one large card + slim strips: the session you are in keeps its
//           card, everything else folds into the collapsed strip.
//   queue   only the sessions that need a human are expanded. With 7–8
//           sessions this, not the grid, is the primary workflow (§5.8).
//
// A MODE IS A MAP OF card -> RUNG, NOT A FOURTH WAY TO ARRANGE THE WORKSPACE.
// §5.8 is explicit that "focus mode is a COMPOSITION of ladder states, not a
// bespoke mode", and E9-05 built `setCardLadder` as the one verb that can put a
// named session on a named rung from outside its card. So this module computes
// moves and SessionGrid applies them through that verb; there is no second
// layout engine, and a rung reached by a mode is the same rung reached by hand.
//
// Pure by construction (no React, no dockview, no IPC): every rule below is a
// unit test rather than an e2e guess.
//
// ── WHAT A MODE MAY NOT DO ──────────────────────────────────────────────────
//
// The four exemptions in `wants` below are the whole difference between a
// layout mode and a layout mode that fights you. Each has a precedent in an
// already-shipped rule rather than being invented here:
//
//   • a session that NEEDS A HUMAN is never folded away. E9-06 wrote this rule
//     for auto-minimize ("the one card that needs a human is the one card
//     auto-minimize must never take away") and it is stronger here: E9-05's
//     reveal-on-attention would bring that card straight back, and the next
//     sweep would fold it again — a mode and the attention system taking turns
//     on the same card, forever.
//   • the card you are IN is never folded away. §5.8's idle-collapse bullet
//     already carves out "working / errored / currently-focused sessions" from
//     a bulk collapse, and E9-06's always-visible ruling is the same instinct:
//     nothing minimizes the thing you are looking at, unasked.
//   • a POPPED-OUT card is never touched. Its rung change would close an OS
//     window the user deliberately placed, quite possibly on another monitor
//     (E9-06, verbatim) — and it is not competing for the main window's space
//     anyway, which is all a layout mode is about.
//   • a card that is ALREADY off the top rung is left where the user put it.
//     A mode wants sessions OUT OF THE WAY; collapsed, tabbed and hidden are
//     all out of the way, and promoting a hidden card to `collapsed` to satisfy
//     the letter of the plan would be a demotion the user has to undo.
import type { Ladder } from './presentation';

export type LayoutMode = 'grid' | 'focus' | 'queue';

/** The cycle order for the chip and the binding. Grid first: it is the default
 *  and the one people come back to. */
export const LAYOUT_MODES: readonly LayoutMode[] = ['grid', 'focus', 'queue'];

/** §5.8's "grid (all visible)" — and the value an untouched workspace has. */
export const DEFAULT_MODE: LayoutMode = 'grid';

/** ui-blob key (§5.25: the mode survives relaunch). NOT `layout`: the workspace
 *  store already has a top-level `layout` — dockview's own JSON — and two
 *  different things called the same name one object apart is a foot-gun. */
export const LAYOUT_KEY = 'layoutMode';

export interface LayoutState {
  readonly mode: LayoutMode;
  /**
   * The card §5.8's maximize gesture is holding, or null.
   *
   * A separate axis from `mode` rather than a fourth mode: maximize is
   * something you do to ONE session for a minute and then undo, and it has to
   * put back the arrangement it interrupted — which a mode, by definition,
   * does not.
   */
  readonly maximized: string | null;
  /**
   * Every card's rung at the moment maximize was taken — what "restores the
   * prior layout on repeat" (§5.8, verbatim) actually restores.
   *
   * Persisted with the rest of it, so a relaunch in the middle of a maximize
   * can still undo it. Empty whenever `maximized` is null.
   */
  readonly restore: Readonly<Record<string, Ladder>>;
}

/** Frozen and shared: the store's initial value must be ONE stable object, or
 *  every useSyncExternalStore snapshot over it re-renders forever. */
export const DEFAULT_LAYOUT: LayoutState = Object.freeze({
  mode: DEFAULT_MODE,
  maximized: null,
  restore: Object.freeze({}),
});

/** What a plan needs to know about one card. Structural on purpose: the caller
 *  assembles it from the rail order + the presentation map, and the tests hand
 *  it plain objects. */
export interface LayoutCard {
  cardId: string;
  /** where it is on the ladder right now */
  ladder: Ladder;
  /** a human is the only thing that can move this session on (rail-view's
   *  `needsYou` — the same rule the lamps, the rail rows and the strip use) */
  needsAttention: boolean;
  /** in its own OS window */
  poppedOut: boolean;
}

/** One card, one rung. The plan is a list of MOVES, not a full map: a card that
 *  is already where the mode wants it must produce no dockview work at all. */
export interface LayoutMove {
  cardId: string;
  rung: Ladder;
}

/**
 * Why the plan is being computed, which decides how assertive it may be.
 *
 *   switch   the user just picked this mode (or maximized). The mode gets to
 *            rearrange the workspace — that is what they asked for.
 *   react    something moved underneath a mode that is already on: a session
 *            started needing a human, focus changed, a card was added.
 *
 * GRID IS NOT ENFORCED ON `react`, and that is the single most important line
 * in this file. Grid means "every session gets a card", so a standing grid
 * sweep would re-expand every card the user collapsed by hand the moment any
 * status changed — turning the default mode into a machine that undoes the
 * ladder. Grid is applied when you switch INTO it and never again.
 */
export type LayoutTrigger = 'switch' | 'react';

/**
 * Is a mode actively holding the workspace in shape right now?
 *
 * `held` is the maximize AS RESOLVED AGAINST THE CARDS ON SCREEN, not the
 * stored id — a maximize whose card has been closed must not count. If it did,
 * `grid` would start enforcing (its plan is "every session gets a card") and
 * every card the user collapsed by hand would pop back open on the next status
 * push, which is the one thing this file's header says must never happen.
 */
export function isEnforced(state: LayoutState, held: string | null = state.maximized): boolean {
  return held !== null || state.mode !== 'grid';
}

/** The maximize, if the card it names is still on screen. */
function heldMaximize(state: LayoutState, cards: readonly LayoutCard[]): string | null {
  return state.maximized && cards.some((c) => c.cardId === state.maximized)
    ? state.maximized
    : null;
}

/**
 * The rung each card should be on — before the exemptions, which `plan` applies.
 *
 * A card absent from the map is one this mode has no opinion about.
 */
function wants(opts: {
  state: LayoutState;
  cards: readonly LayoutCard[];
  activeCardId: string | null;
  trigger: LayoutTrigger;
}): Map<string, Ladder> {
  const { state, cards, activeCardId, trigger } = opts;
  const want = new Map<string, Ladder>();
  if (cards.length === 0) return want;

  // ── which card is the big one ─────────────────────────────────────────────
  //
  // Maximize names it outright. Otherwise focus mode follows the card you are
  // IN, which is what makes it a mode and not a one-off — click another session
  // and the big card moves with you.
  //
  // THE FALLBACKS ARE THE INTERESTING PART, because "nothing is focused" is not
  // rare: focus moves to null whenever the active panel is not a session card
  // (a Changes tab), and again whenever the last session card leaves the
  // workspace. Naively falling back to rail position 1 there would make the
  // layout twitch — open a diff on the session you are reading and the big card
  // would jump to somebody else — and it would undo E9-06's auto-collapse, by
  // re-expanding a card the presentation policy had just minimized.
  //
  //   1. the card you are in (never a POPPED-OUT one: it is in another window,
  //      so folding this window around it would empty the screen);
  //   2. else, ONLY when the user just asked for this mode, a card already on
  //      screen — or rail position 1 if none is.
  //
  // ON A REACTIVE PASS THERE IS DELIBERATELY NO ANSWER AT ALL, and that is the
  // careful part. "First expanded card" looks like the stable choice, but in
  // focus mode a second expanded card is NORMAL — E9-05 reveals a session that
  // needs a human without focusing it — so it is not a synonym for "the big
  // one". Open the Changes tab on the card you are reading (focus goes to a
  // panel that is not a session card, so `activeCard` is null) and that guess
  // would hand the screen to the blocked session and fold the card you were
  // reading. A mode may rearrange what is on screen; it may not decide, on its
  // own initiative, which card you meant.
  const maximized = heldMaximize(state, cards);
  const active = cards.find((c) => c.cardId === activeCardId && !c.poppedOut)?.cardId ?? null;
  const onScreen = cards.find((c) => c.ladder === 'expanded' && !c.poppedOut)?.cardId ?? null;
  const large =
    maximized ?? active ?? (trigger === 'switch' ? (onScreen ?? cards[0].cardId) : null);

  if (maximized) {
    for (const c of cards) want.set(c.cardId, c.cardId === large ? 'expanded' : 'collapsed');
    return want;
  }
  switch (state.mode) {
    case 'grid':
      for (const c of cards) want.set(c.cardId, 'expanded');
      return want;
    case 'focus':
      // no big card and nobody asked for one: see the fallback note above
      if (!large) return want;
      for (const c of cards) want.set(c.cardId, c.cardId === large ? 'expanded' : 'collapsed');
      return want;
    case 'queue': {
      // §5.8: "only attention-needing sessions expanded". The card you are IN
      // is expanded too — see the exemptions in the header; the alternative is
      // the workspace emptying itself out from under you the moment you answer
      // the session you were reading.
      //
      // It uses the ACTIVE card and not `large`: queue is the one mode with a
      // complete plan without a big card, so the fallbacks that invent one for
      // focus mode would only weaken "only the sessions that need you". (A
      // maximize cannot reach here — it returned above — which is exactly why
      // `active` alone is the whole rule.)
      const kept = active;
      for (const c of cards) {
        want.set(c.cardId, c.needsAttention || c.cardId === kept ? 'expanded' : 'collapsed');
      }
      return want;
    }
  }
}

/**
 * The dockview work a layout change actually needs, in the order to do it.
 *
 * EXPANDS COME FIRST, and that is not cosmetic: a card comes back to the dock
 * slot it remembers (E9-05's reveal contract), and removing the neighbours
 * first can destroy the group that slot names — dockview drops a group when its
 * last panel goes. Placing the arrivals while the workspace is still standing
 * lets every one of them land at home, and the departures then reflow around
 * what is left.
 */
export function plan(opts: {
  state: LayoutState;
  /** in RAIL ORDER — the numbering authority every other surface uses */
  cards: readonly LayoutCard[];
  activeCardId: string | null;
  trigger: LayoutTrigger;
  /**
   * Un-maximize: the rungs to put back. Beats the mode's own plan card by card
   * and is applied EXACTLY (a card that was hidden goes back to hidden), which
   * is the difference between "restores the prior layout" and "re-applies the
   * current mode".
   */
  restore?: Readonly<Record<string, Ladder>>;
}): LayoutMove[] {
  const { state, cards, activeCardId, trigger, restore } = opts;
  const maximized = heldMaximize(state, cards);
  // Nothing is holding the workspace in shape, and nobody asked for a change.
  if (trigger === 'react' && !isEnforced(state, maximized) && !restore) return [];

  const want = wants({ state, cards, activeCardId, trigger });
  const active = activeCardId;

  const up: LayoutMove[] = [];
  const down: LayoutMove[] = [];
  for (const card of cards) {
    // A restore entry is the user's own prior arrangement coming back, so it
    // beats every rule below — including the exemptions, which exist to stop a
    // MODE overriding the user, not to stop the user being put back.
    const exact = restore?.[card.cardId];
    if (exact) {
      // ...with ONE exemption still standing: a card popped out since the
      // snapshot was taken. Putting it back to `collapsed` would close an OS
      // window the user placed after the fact, and no restore is worth that.
      if (card.poppedOut && exact !== 'expanded') continue;
      if (exact !== card.ladder) (exact === 'expanded' ? up : down).push({ cardId: card.cardId, rung: exact });
      continue;
    }
    const target = want.get(card.cardId);
    if (!target || target === card.ladder) continue;
    if (target === 'expanded') {
      up.push({ cardId: card.cardId, rung: 'expanded' });
      continue;
    }
    // ── the four exemptions (see the file header) ──────────────────────────
    if (card.poppedOut) continue;
    if (card.needsAttention) continue;
    // ...except on the maximize ITSELF, which is an explicit "blow this one up
    // and put the rest away" — the card you were in is exactly what it is
    // putting away, and it comes back the moment you double-click again.
    //
    // On a REACTIVE pass the exemption stands even under a maximize, and that
    // is the difference between a held maximize and a trap: §5.8 says clicking
    // a session anywhere reveals it, so a click that expanded a card and then
    // watched the next sweep fold it again — handing focus back to the
    // maximized card — would leave the user no way out but a shortcut nobody
    // told them about. The maximize keeps holding everything else down; the
    // card you deliberately went to stays.
    if (card.cardId === active && !(maximized && trigger === 'switch')) continue;
    if (card.ladder !== 'expanded') continue;
    down.push({ cardId: card.cardId, rung: target });
  }
  return [...up, ...down];
}

/** Every card's rung right now — the snapshot a maximize has to be able to
 *  put back. Cards at the default rung are included: "it was expanded" is a
 *  fact the restore needs as much as "it was hidden". */
export function snapshotRungs(cards: readonly LayoutCard[]): Record<string, Ladder> {
  const out: Record<string, Ladder> = {};
  for (const c of cards) out[c.cardId] = c.ladder;
  return out;
}

// ── immutable edits ─────────────────────────────────────────────────────────
// The store publishes by identity, so every edit returns a NEW state.

/**
 * Switch to a mode.
 *
 * It takes no prior state, and that IS the rule: picking a mode ends a
 * maximize. The user just asked for a whole arrangement, so holding on to the
 * one card that was blown up — and to the snapshot of a layout they have now
 * replaced — would mean the next double-click restored a workspace nobody
 * remembers asking for.
 */
export function withMode(mode: LayoutMode): LayoutState {
  return Object.freeze({ mode, maximized: null, restore: Object.freeze({}) });
}

/** Next mode for the chip and the binding — three states, wrapping. */
export function cycleMode(cur: LayoutMode): LayoutMode {
  const i = LAYOUT_MODES.indexOf(cur);
  return LAYOUT_MODES[(i + 1) % LAYOUT_MODES.length];
}

/**
 * Maximize this card.
 *
 * A maximize taken while one is ALREADY held keeps the original snapshot: the
 * arrangement worth restoring is the one before the first blow-up, not the
 * all-collapsed workspace the first one produced.
 */
export function withMaximized(
  state: LayoutState,
  cardId: string,
  rungs: Readonly<Record<string, Ladder>>
): LayoutState {
  if (!cardId) return state;
  return Object.freeze({
    mode: state.mode,
    maximized: cardId,
    restore: state.maximized ? state.restore : Object.freeze({ ...rungs }),
  });
}

/** Let go of the maximize. The caller applies `state.restore` — read it BEFORE
 *  calling this, because this is what forgets it. */
export function withoutMaximized(state: LayoutState): LayoutState {
  if (!state.maximized && Object.keys(state.restore).length === 0) return state;
  return Object.freeze({ mode: state.mode, maximized: null, restore: Object.freeze({}) });
}

/**
 * Drop a maximize and restore entries for cards that no longer exist.
 *
 * Returns null when there is nothing to drop, so the caller can skip a pointless
 * write and re-render — the same contract `prunePresentation` and
 * `prunePolicies` use, and for the same reason: a workspace must not accrete a
 * record per session it ever opened. A maximize whose card is gone is dropped
 * outright; otherwise the workspace would stay in a shape held for a session
 * that no longer exists.
 */
export function pruneLayout(state: LayoutState, knownCardIds: Iterable<string>): LayoutState | null {
  const known = new Set(knownCardIds);
  return dropCards(state, (id) => known.has(id));
}

/** One card has just been closed. The same rule as `pruneLayout`, at the moment
 *  it happens rather than at the next boot — a maximize held for a card that no
 *  longer exists would leave the workspace blown up around nothing, AND would
 *  make the default mode start enforcing (see `isEnforced`). */
export function forgetLayoutCard(state: LayoutState, cardId: string): LayoutState | null {
  return dropCards(state, (id) => id !== cardId);
}

function dropCards(state: LayoutState, keep: (cardId: string) => boolean): LayoutState | null {
  const staleMax = !!state.maximized && !keep(state.maximized);
  const stale = Object.keys(state.restore).filter((id) => !keep(id));
  if (!staleMax && stale.length === 0) return null;
  const restore = { ...state.restore };
  for (const id of stale) delete restore[id];
  return Object.freeze({
    mode: state.mode,
    maximized: staleMax ? null : state.maximized,
    // the snapshot belongs to the maximize: losing one loses the other
    restore: Object.freeze(staleMax ? {} : restore),
  });
}

// ── persistence ─────────────────────────────────────────────────────────────

const LADDERS: readonly string[] = ['expanded', 'collapsed', 'tabbed', 'hidden'];

function isMode(v: unknown): v is LayoutMode {
  return typeof v === 'string' && (LAYOUT_MODES as readonly string[]).includes(v);
}

function isLadder(v: unknown): v is Ladder {
  return typeof v === 'string' && LADDERS.includes(v);
}

/** One ui-blob record -> a full state. Anything unrecognised falls back to the
 *  default rather than throwing: a blob outlives the code that wrote it, and a
 *  stale value must never cost the user their workspace. */
export function loadLayout(raw: unknown): LayoutState {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT;
  const r = raw as Record<string, unknown>;
  const maximized = typeof r.maximized === 'string' && r.maximized ? r.maximized : null;
  const restore: Record<string, Ladder> = {};
  if (maximized && r.restore && typeof r.restore === 'object') {
    for (const [cardId, rung] of Object.entries(r.restore as Record<string, unknown>)) {
      if (cardId && isLadder(rung)) restore[cardId] = rung;
    }
  }
  return Object.freeze({
    mode: isMode(r.mode) ? r.mode : DEFAULT_MODE,
    maximized,
    restore: Object.freeze(restore),
  });
}

/** The state, reduced to what goes in the blob. A workspace that says nothing
 *  the default doesn't already say writes nothing at all. */
export function persistableLayout(state: LayoutState): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (state.mode !== DEFAULT_MODE) out.mode = state.mode;
  if (state.maximized) {
    out.maximized = state.maximized;
    if (Object.keys(state.restore).length > 0) out.restore = { ...state.restore };
  }
  return Object.keys(out).length > 0 ? out : null;
}
