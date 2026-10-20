// Sessions-rail presentation rules (design_handoff_sessions_rail, §5.8/§5.11).
//
// The rail's whole job is answering two questions instantly: which group is a
// session in, and which sessions need me right now. The second one is decided
// HERE — one pure function per half — so no two surfaces can disagree.
//
// THERE ARE TWO HALVES, and #621 is what taught us they are not the same
// question:
//
//   presentStatus()           what the session IS: its colour ramp, its glyph
//                             and the word beside its name. Purely a function
//                             of STATUS. Its `needsYou` is "is this a status
//                             that waits on a human", which the layout rules
//                             still read (a blocked card is not folded away).
//   attentionPaint()          whether the row and the lamp are LIT (tint, 4px
//                             bar, name at 700, filled lamp). Since #1137 that
//                             is the count's own answer, not the status's, so
//                             "N need you" is exactly N lit rows.
//   needCount()               how many demands are still ON YOUR PLATE. Drives
//                             the per-group summary, the rail footer and the
//                             strip's aggregate — and it counts the Events
//                             window's own list, so dismissing an event
//                             decrements it. See `lib/queue`'s `needingCards`.
//
// Kept free of React and of colors: the component turns `token` into
// var(--status-<token>) / var(--status-<token>-ink), which is the only place
// the theme is allowed to matter (§5.20).
import type { RailCardStatus } from '../../../shared/sessions';

import type { WritingDirection } from './writing-direction';

/**
 * The status vocabulary the rail can receive — `SessionStatus`, the card-level
 * 'suspended' (restored, not yet resumed) and 'ended' (its process exited
 * cleanly, #1362), and 'not-started' (#687).
 *
 * It was a second hand-written copy of those eight names until #618; it is
 * `RailCardStatus` from `shared/sessions.ts` now. That is `CardStatus` — what
 * `sessions:cards` puts on the wire — plus the one name the RENDERER mints,
 * because the card it describes is one main has never been told about. The
 * local NAME is kept because it says what this file uses the type FOR:
 * `PRESENTATION` below is keyed by it, so a TENTH status added to the union
 * stops compiling here until the rail decides how to paint it, which is the
 * whole point of that record — and is how this change found every consumer.
 */
export type RailStatusName = RailCardStatus;

/**
 * The six-way ramp the design paints. 'starting' and 'suspended' fold in.
 *
 * The VALUES are the definition and the type is derived from them, not the
 * other way round: the contrast tests iterate this list, and a seventh position
 * added to a hand-written union would type-check while silently going
 * unmeasured (#221).
 */
export const STATUS_TOKENS = [
  'working',
  'needs-input',
  'needs-permission',
  'idle',
  'done',
  'crashed',
  // the gold of a session whose turn ended and which is waiting for your next
  // prompt (#1351). Hue 72, outside the 20-70 band `shared/reserved-hue.ts`
  // keeps for "needs you", so it reads as calmer than an approval or a question
  'waiting',
] as const;
export type StatusToken = (typeof STATUS_TOKENS)[number];

export interface StatusPresentation {
  /** token stem: var(--status-<token>) is the hue, -ink the text color */
  token: StatusToken;
  /** the attention treatment: tinted row, 4px status-colored bar, name at 700,
   *  and the sub-label replaced by what the session is actually asking for */
  needsYou: boolean;
  /** a rotating ring instead of a glyph — the rail's only animation */
  spinner: boolean;
  /** i18n key for the 16x16 indicator glyph; absent while the ring spins */
  glyphKey?: string;
  /** i18n key for the sub-label: the ASK when it needs you, else the state */
  labelKey: string;
  /**
   * i18n key for the ONE SHORT WORD the row shows beside the name (#877).
   *
   * ⚠️ NOT DERIVABLE FROM `token`, and a CI failure proved it. `token` is the
   * COLOUR RAMP stem, and the ramp deliberately collapses states that share a
   * hue: `suspended` and `not-started` both paint `idle`, and `starting` paints
   * `working`. The row's first attempt at this read `status.${token}`, which
   * silently renamed a suspended session "idle" — the state the rail exists to
   * distinguish. So the short word is its own column, keyed by STATE.
   *
   * The `status.*` namespace, which is the card header's pill vocabulary
   * (`SessionGrid`'s `StatusPill`): §5.11 says a session's identity renders the
   * same on every surface, so two surfaces must not have two words for one
   * state.
   */
  shortKey: string;
  /**
   * The left list's longer word, where the row has room for it (#1351):
   * "waiting for you" where the tab and the pill say "waiting". Absent = the
   * short word.
   */
  listKey?: string;
}

// A session "needs you" when a human is the only thing that can move it on.
// 'done' is in the set deliberately (§5.8's completed-unreviewed state): the
// work finished and nobody has looked at it yet.
const PRESENTATION: Record<RailStatusName, StatusPresentation> = {
  starting: {
    token: 'working',
    needsYou: false,
    spinner: true,
    labelKey: 'railStatus.starting',
    shortKey: 'status.starting',
  },
  working: {
    token: 'working',
    needsYou: false,
    spinner: true,
    labelKey: 'railStatus.working',
    shortKey: 'status.working',
  },
  'needs-input': {
    token: 'needs-input',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphInput',
    labelKey: 'railStatus.askInput',
    shortKey: 'status.needs-input',
  },
  'needs-permission': {
    token: 'needs-permission',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphPermission',
    labelKey: 'railStatus.askPermission',
    shortKey: 'status.needs-permission',
  },
  // THE TURN ENDED AND IT IS WAITING FOR YOU (#1351). Dan: "If an AI session
  // stops and it's waiting on me for anything ... I want it to say it's
  // waiting for me. It should not say 'calm' or 'done'." Painted in the
  // `waiting` gold, not the `done` green: the green says "finished", and what
  // the user needs to know is that the next move is theirs.
  done: {
    token: 'waiting',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphDone',
    labelKey: 'railStatus.askDone',
    shortKey: 'status.done',
    listKey: 'status.doneList',
  },
  crashed: {
    token: 'crashed',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphCrashed',
    labelKey: 'railStatus.askCrashed',
    shortKey: 'status.crashed',
  },
  idle: {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.idle',
    shortKey: 'status.idle',
  },
  suspended: {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.suspended',
    shortKey: 'status.suspended',
  },
  // THE PROCESS HAS EXITED, AND NOT IN A CRASH (#1362). Main reports it off
  // `sessions:cards` (`cardStatusOf`) in place of the leftover `done`, which
  // read "waiting" here, on the tab and on the pill while the card's own
  // header said "ended". It is not waiting for a prompt — it has to be started
  // again — so it is neutral: the `idle` ramp, no wash, never in a group's
  // "waiting" (see `QUIET` below), and the same word the header's pill uses
  // (`endedPill`).
  ended: {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.ended',
    shortKey: 'status.ended',
  },
  // #687: the card is on screen and nothing ever ran in it — `sessions:create`
  // was refused, so main has no record of it and this row exists only because
  // the store minted it.
  //
  // THE IDLE RAMP, AND `needsYou: false`, ARE BOTH DELIBERATE. The card itself
  // is already shouting: it draws the "Session didn't start" overlay with Try
  // again and Close, and #606 gave it a header whose pill says the same word
  // (`endedPill` answers `{ token: 'idle', labelKey: 'status.notStarted' }` —
  // this entry is its rail-side twin, on purpose, so the two surfaces cannot
  // describe one card differently). Making the row shout too would put it in
  // the attention queue and the "N need you" count, and a session that never
  // started has made no demand — §4's rule that our own blind spots must not
  // invent an attention request cuts the same way for a card we know is dead
  // on arrival. The user closes it or retries it when they get to it.
  'not-started': {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.notStarted',
    shortKey: 'status.notStarted',
  },
};

/** Fail-open: a status we don't know reads as idle rather than as an alarm —
 *  our own blind spot must never invent an attention request (§4). */
export function presentStatus(status?: string): StatusPresentation {
  return PRESENTATION[status as RailStatusName] ?? PRESENTATION.idle;
}

/**
 * The two var() strings a status-colored surface paints with: the HUE (dots,
 * rings, tints, edges) and the INK (the word itself, tuned per theme so it
 * clears AA on the surface it lands on — #221).
 *
 * The pairing is a naming rule, not a table: `--status-<token>` and
 * `--status-<token>-ink`. It is a function rather than a fourth copy of the
 * same template literal so that the contrast tests can measure the pair a
 * component actually paints instead of a pair copied into the test. The urgency
 * lamp, the collapsed row and the rail row still spell it out inline and could
 * adopt this as they are next touched; the grid's pill uses it because it is
 * the one whose ratio is asserted.
 */
export function statusVars(token: StatusToken): { hue: string; ink: string } {
  return { hue: `var(--status-${token})`, ink: `var(--status-${token}-ink)` };
}

/** What a row or a lamp paints for one session, given who is being counted. */
export interface AttentionPaint {
  /** the attention treatment is on: the tint, the 4px bar, the bold name */
  lit: boolean;
  /** the colour ramp to paint it in */
  token: StatusToken;
  /**
   * The short state word keeps its status colour even when the row is calm.
   *
   * True for a session that is BLOCKED — asking, waiting on a permission,
   * crashed — whose event the user dismissed. Dismissing takes it off the
   * count and stops the row shouting; it does not answer the session, and §4's
   * fail-open rule does not let a dismissal make that unknowable. The coloured
   * word is where it stays knowable.
   */
  stateInk: boolean;
  /**
   * Lit for FINISHED work nobody has looked at, and nothing else (#1219). The
   * row is highlighted so it can be found, but it is not a demand: it is in
   * "N finished", not "N need you", and it clears by being looked at.
   */
  finished: boolean;
}

/** Statuses a session cannot leave on its own: someone has to act. */
const BLOCKED: ReadonlySet<string> = new Set(['needs-input', 'needs-permission', 'crashed']);

/**
 * Statuses never painted as WAITING, even while a count lights them (#1362).
 *
 * A session whose process has ended can still be in a count: the turn it
 * finished before it closed is "finished" until it is looked at, and a review
 * returned to it is a demand. The count keeps its lit row — "N finished" is
 * still N lit rows (#1137, #1219) — but in the neutral ramp, unwashed, and a
 * group's roll-up does not call it "waiting": nothing is waiting for its next
 * prompt, because there is no process to take one.
 */
const QUIET: ReadonlySet<string> = new Set(['ended']);

/**
 * THE ONE RULE for the needs-you treatment on a row or a lamp (#1137).
 *
 * `counted` is "is this session in `needingCards`" — the same set every
 * "N need you" readout counts. So a count of N is exactly N lit rows, by
 * construction: there is no second derivation to keep in step.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 *
 * The treatment used to be `presentStatus(status).needsYou`, while the counters
 * read the Events window (#621). The two parted whenever the user acted on an
 * event without the session's status moving — and the commonest way to do that
 * is to LOOK at a finished session, which relaxes its event from `done` to
 * `ready` and leaves its status at `done`. Every finished session the user had
 * already looked at stayed lit, identical to the one that had not been, under a
 * header that counted only the latter: "1 need you" over three rows reading
 * Done, with nothing to say which.
 *
 * #621's note argued the row should keep painting the real status so a
 * dismissal could not hide a blocked session. That half is kept — in the WORD
 * (`stateInk`), which still says and colours what the session is doing — and
 * given up in the TREATMENT, because two user-visible answers to "who needs
 * me" that can disagree is the defect.
 *
 * A session counted for something its status does not show (a returned review
 * is filed on its author, who is usually idle) is lit in the `waiting` ramp
 * (the `done` one until #1351): finished work to look at, which is what it is.
 */
export function attentionPaint(
  status: string | undefined,
  counted: boolean,
  /** in `finishedCards` (#1219): the other count, and never both */
  finished = false
): AttentionPaint {
  const p = presentStatus(status);
  // lit for the count, but never in the waiting gold for a session that has
  // ended (#1362): its own neutral ramp
  const litToken: StatusToken = QUIET.has(status ?? '') ? p.token : 'waiting';
  if (counted) {
    return { lit: true, token: p.needsYou ? p.token : litToken, stateInk: true, finished: false };
  }
  // FINISHED, UNSEEN: lit in the `waiting` ramp so the count leads to a row you
  // can see, exactly as "N need you" does. The same invariant, a second number.
  if (finished) return { lit: true, token: litToken, stateInk: true, finished: true };
  return {
    lit: false,
    token: p.token,
    // a session WAITING on you keeps its ink too (#1351): the word is in its
    // colour whether or not anything is still counting it
    stateInk: BLOCKED.has(status ?? '') || waitState(status) !== undefined,
    finished: false,
  };
}

// ── WAITING ON YOU (#1351) ───────────────────────────────────────────────────
//
// The owner, 2026-10-18: "If an AI session stops and it's waiting on me for
// anything — a gate, a question, an approval — I want it to say it's waiting
// for me. It should not say 'calm' or 'done'." Three states, and one word
// each:
//
//   needs-permission   approval   an approval is held, on a clock (#1202)
//   needs-input        question   it asked you something; no clock
//   done               waiting    its turn ended; the next prompt is yours
//
// WHY `idle` IS NOT ON THE LIST. In the state machine `done` is sticky: from it
// only a new prompt or new output moves a session (`main/sessions/state-
// machine.ts`, the `current === 'done'` arm), so the CLI's idle nudge and a
// `/clear` both leave a finished session at `done`. What reaches `idle` is a
// session that has not run a turn yet — started, resumed, or cleared before it
// did anything — which is the owner's "a session that has never had a turn",
// and it reads "calm".
//
// THIS IS THE STATE, NOT THE COUNT. `attentionPaint` still decides who is LIT
// (the 4px bar, the bold name, `data-needs-you`), from the count's own set, so
// "N need you" is still exactly N lit rows. What this decides is the WASH and
// the WORD every waiting session wears whether or not anything is counting it:
// a dismissed approval is still held, and a looked-at finished session is
// still waiting for its next prompt. Never colour-only: every surface that
// washes also writes the word.

export type WaitState = 'approval' | 'question' | 'waiting';

/** The three, most urgent first — the order a group's summary and wash use. */
export const WAIT_STATES: readonly WaitState[] = ['approval', 'question', 'waiting'];

const WAIT_OF: Readonly<Record<string, WaitState>> = {
  'needs-permission': 'approval',
  'needs-input': 'question',
  done: 'waiting',
};

/**
 * The status a surface should PAINT: the session's own, except that a Direct
 * session holding a QUESTION reads `needs-input` (#1351). Main gives a held
 * question the `needs-permission` status an approval has — it arrives as a
 * `can_use_tool` request for the CLI's question tool — and every surface would
 * then call a question an "approval". `heldQuestion` is the store's
 * `hasHeldQuestion(cardId)`.
 */
export function shownStatus<S extends string | undefined>(status: S, heldQuestion: boolean): S | 'needs-input' {
  return status === 'needs-permission' && heldQuestion ? 'needs-input' : status;
}

/** Which waiting state a session is in, or undefined when it is not waiting on you. */
export function waitState(status: string | undefined): WaitState | undefined {
  return status === undefined ? undefined : WAIT_OF[status];
}

/** The ramp position each waiting state is painted in. */
export const WAIT_TOKEN: Readonly<Record<WaitState, StatusToken>> = {
  approval: 'needs-permission',
  question: 'needs-input',
  waiting: 'waiting',
};

/**
 * How strong the wash is, in percent of the state's hue over the surface
 * behind it. ONE number for the tab, the row, the pill and a group's summary,
 * and `tokens.drift.test.ts` imports it: the words written on the wash are
 * measured at exactly this strength. 15 rather than the mockup's 16: at 16 the
 * "question" ink on nordic measured 4.46:1, under AA.
 */
export const WAIT_WASH = 15;

/** What a session's surface paints for its state (#1351). */
export interface WaitPaint {
  /** the waiting state, if it is in one */
  state: WaitState | undefined;
  /** wear the wash and the coloured edge */
  washed: boolean;
  /** the ramp to paint the wash, the edge, the ring and the word in */
  token: StatusToken;
}

/**
 * The wash for one session. Washed when it is waiting on you, and also when
 * the count lit it for something its status does not show (a returned review
 * on an idle author): a lit row that was not washed would be the one row
 * whose tint the count could not explain.
 */
export function waitPaint(status: string | undefined, paint: AttentionPaint): WaitPaint {
  const state = waitState(status);
  // an ended session is never washed, lit or not (#1362): see `QUIET`
  const washed = state !== undefined || (paint.lit && !QUIET.has(status ?? ''));
  return { state, washed, token: paint.token };
}

/**
 * The word a session's TAB writes after its name, if any (#1351, #1362).
 *
 * A tab is narrow, so it speaks only when there is something to say: the
 * waiting state's word in its colour; "working", quietly, while it works; and
 * "ended", quietly, once its process has gone (#1362) — the one calm state a
 * glance at the tab must not mistake for a live, calm session. Nothing for a
 * calm one, which keeps a calm tab the width it always was.
 *
 * `state` is the element's `data-tab-state`. `ink` absent = the tab's own text
 * colour.
 */
export function tabWordFor(
  status: string | undefined,
  wait: WaitPaint | undefined
): { key: string; state: string; ink?: string } | undefined {
  if (status === undefined) return undefined;
  const p = presentStatus(status);
  if (wait?.state) return { key: p.shortKey, state: wait.state, ink: statusVars(wait.token).ink };
  if (p.spinner) return { key: p.shortKey, state: 'working' };
  if (status === 'ended') return { key: p.shortKey, state: 'ended' };
  return undefined;
}

/** How many of a group's sessions are in each state (#1351, #1196). */
export interface WaitRollup {
  approval: number;
  question: number;
  /**
   * Crashed: not one of the three waiting states, but blocked on you all the
   * same (it is in "N need you"), so a group must not call it "waiting" or
   * "calm". Its own part, in the alarm's colour.
   */
  crashed: number;
  waiting: number;
  /** busy and not waiting on you: the strip's "N working" (#1179) */
  working: number;
}

/**
 * The roll-up a group shows instead of "calm" — the left list's header and the
 * strip's group box both read it, so the two cannot describe one group
 * differently (#1196's done-when).
 *
 * IT COUNTS THE WASHED ROWS, so the line and the rows under it agree (#1137's
 * invariant, kept): a session in one of the three states counts as that
 * state, and a session the count lit for something its status does not show —
 * a returned review on an idle author, which `waitPaint` washes in the
 * waiting gold — counts as waiting. `lit` is the union of the two counted
 * sets (`needing`, `finished`); omitted, only the states are counted. The "N
 * need you" totals (the rail's footer, the strip's own line, the status bar)
 * still count the Events window's list, which is the other question (#621).
 */
export function waitRollup(
  sessions: ReadonlyArray<{ id?: string; status?: string }>,
  lit?: (id: string) => boolean,
  /** the store's `hasHeldQuestion`, so a Direct session's question is counted as one */
  heldQuestion?: (id: string) => boolean
): WaitRollup {
  const r: WaitRollup = { approval: 0, question: 0, crashed: 0, waiting: 0, working: 0 };
  for (const s of sessions) {
    const status = shownStatus(s.status, s.id !== undefined && (heldQuestion?.(s.id) ?? false));
    if (status === 'crashed') {
      r.crashed += 1;
      continue;
    }
    // a lit session counts as waiting only if it could be: an ended one is
    // not washed (`waitPaint`), so it is not counted either (#1362)
    const w =
      waitState(status) ??
      (s.id !== undefined && !QUIET.has(status ?? '') && lit?.(s.id) ? 'waiting' : undefined);
    if (w) r[w] += 1;
    else if (presentStatus(status).spinner) r.working += 1;
  }
  return r;
}

/** A roll-up's parts, most urgent first: the three waiting states, with a crash after a question. */
export type RollupPart = 'approval' | 'question' | 'crashed' | 'waiting';
const ROLLUP_ORDER: readonly RollupPart[] = ['approval', 'question', 'crashed', 'waiting'];

/** The ramp position each part is painted in. */
export const ROLLUP_TOKEN: Readonly<Record<RollupPart, StatusToken>> = {
  ...WAIT_TOKEN,
  crashed: 'crashed',
};

/**
 * The most urgent thing in a roll-up: approval > question > crashed > waiting
 * > working. Undefined when the group is calm.
 */
export function rollupLead(r: WaitRollup): RollupPart | 'working' | undefined {
  for (const w of ROLLUP_ORDER) if (r[w] > 0) return w;
  return r.working > 0 ? 'working' : undefined;
}

/**
 * A roll-up as the i18n keys and counts its words are built from: one part per
 * state that is not zero, most urgent first; else "N working"; else "calm".
 * Pure so the three orders and the omitted zeros are unit-tested here rather
 * than read off a screen.
 */
export function rollupParts(r: WaitRollup): Array<{ key: string; count?: number }> {
  const parts = ROLLUP_ORDER.filter((w) => r[w] > 0).map((w) => ({
    key: `rail.rollup.${w}`,
    count: r[w],
  }));
  if (parts.length > 0) return parts;
  if (r.working > 0) return [{ key: 'rail.workingSummary', count: r.working }];
  return [{ key: 'rail.calm' }];
}

/**
 * How many of these sessions have an OUTSTANDING DEMAND on them — the one rule
 * behind every "N need you" readout: the group-header summary, the rail footer
 * and the urgency strip's aggregate.
 *
 * `needing` is `lib/queue`'s `needingCards` — the cards the Events window still
 * lists something for. It is NOT `presentStatus(status).needsYou`, which is
 * what this function used to count and what #621 was: dismissing an event took
 * it out of the Events window without moving the session's status, so the
 * counters went on reporting a demand nobody was still being shown. See
 * `needingCards` for why the feed is the authority here. The ROW treatment
 * reads the same set since #1137 — see `attentionPaint`.
 *
 * A set rather than a predicate so all three call sites are provably reading
 * the same derivation — the store computes it once, per push.
 */
/**
 * How many of these sessions are WORKING: busy, and not one of the ones
 * counted as needing you.
 *
 * For a group that is drawn as one box (#1179): the owner could not tell
 * whether anything was running inside a closed group on the strip without
 * opening it. A session that is working AND counted as needing you is a
 * demand, not a status, and is left to `needCount`: the two never count the
 * same session, so "1 needs you" and "2 working" add up.
 */
export function workingCount(
  sessions: ReadonlyArray<{ id: string; status?: string }>,
  needing: ReadonlySet<string>
): number {
  return sessions.reduce(
    (n, s) => (!needing.has(s.id) && presentStatus(s.status).spinner ? n + 1 : n),
    0
  );
}

export function needCount(
  sessions: ReadonlyArray<{ id: string }>,
  needing: ReadonlySet<string>
): number {
  return sessions.reduce((n, s) => (needing.has(s.id) ? n + 1 : n), 0);
}

/**
 * How many of these sessions have FINISHED work nobody has looked at (#1219):
 * the one rule behind every "N finished" readout, over `lib/queue`'s
 * `finishedCards`. `needCount`'s sibling, and the two never count one session
 * twice because the two sets never share a card.
 */
export function finishedCount(
  sessions: ReadonlyArray<{ id: string }>,
  finished: ReadonlySet<string>
): number {
  return sessions.reduce((n, s) => (finished.has(s.id) ? n + 1 : n), 0);
}

/** Rail width bounds. 286px is the design's figure; the clamp keeps a dragged
 *  edge from hiding the rail or eating the grid. */
export const RAIL_WIDTH_DEFAULT = 286;
export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 520;

export function clampRailWidth(px: number): number {
  if (!Number.isFinite(px)) return RAIL_WIDTH_DEFAULT;
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(px)));
}

/**
 * The width the rail should take while its edge is being dragged (#642).
 *
 * The rail's width is an INLINE size — a distance from the inline-start edge of
 * the window, which is the LEFT one in English and the RIGHT one under
 * `dir="rtl"`, where a flex row puts the rail on the other side. A pointer's
 * `clientX` is physical and always measures from the left. Passing one for the
 * other was the same confusion that put the context menu off screen, with a
 * nastier symptom: the first `pointermove` clamps to the maximum and the rail
 * then drags BACKWARDS for the rest of the gesture.
 *
 * Pure and unit-tested for the same reason `placeMenu` is: the mirror is one
 * subtraction, and the failure is invisible to anyone reading in English.
 *
 * @param clientX physical pointer x, i.e. `PointerEvent.clientX`
 * @param viewportWidth the window's client width, in the same CSS px
 */
export function railWidthAtPointer(
  clientX: number,
  viewportWidth: number,
  direction: WritingDirection
): number {
  return clampRailWidth(direction === 'rtl' ? viewportWidth - clientX : clientX);
}
