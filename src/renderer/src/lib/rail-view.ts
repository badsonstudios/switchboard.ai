// Sessions-rail presentation rules (design_handoff_sessions_rail, §5.8/§5.11).
//
// The rail's whole job is answering two questions instantly: which group is a
// session in, and which sessions need me right now. The second one is decided
// HERE — one pure function — so the row treatment, the per-group "N need you"
// summary and the footer count can never disagree about what "needs you" means.
//
// Kept free of React and of colors: the component turns `token` into
// var(--status-<token>) / var(--status-<token>-ink), which is the only place
// the theme is allowed to matter (§5.20).

/** The status vocabulary the rail can receive — SessionStatus plus the
 *  card-level 'suspended' (restored, not yet resumed). */
export type RailStatusName =
  | 'starting'
  | 'working'
  | 'needs-input'
  | 'needs-permission'
  | 'idle'
  | 'done'
  | 'crashed'
  | 'suspended';

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
}

// A session "needs you" when a human is the only thing that can move it on.
// 'done' is in the set deliberately (§5.8's completed-unreviewed state): the
// work finished and nobody has looked at it yet.
const PRESENTATION: Record<RailStatusName, StatusPresentation> = {
  starting: { token: 'working', needsYou: false, spinner: true, labelKey: 'railStatus.starting' },
  working: { token: 'working', needsYou: false, spinner: true, labelKey: 'railStatus.working' },
  'needs-input': {
    token: 'needs-input',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphInput',
    labelKey: 'railStatus.askInput',
  },
  'needs-permission': {
    token: 'needs-permission',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphPermission',
    labelKey: 'railStatus.askPermission',
  },
  done: {
    token: 'done',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphDone',
    labelKey: 'railStatus.askDone',
  },
  crashed: {
    token: 'crashed',
    needsYou: true,
    spinner: false,
    glyphKey: 'railStatus.glyphCrashed',
    labelKey: 'railStatus.askCrashed',
  },
  idle: {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.idle',
  },
  suspended: {
    token: 'idle',
    needsYou: false,
    spinner: false,
    glyphKey: 'railStatus.glyphIdle',
    labelKey: 'railStatus.suspended',
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

/** How many of these sessions need a human — drives the group header summary
 *  and the rail footer, from the same rule the rows paint themselves with. */
export function needCount(sessions: ReadonlyArray<{ status?: string }>): number {
  return sessions.filter((s) => presentStatus(s.status).needsYou).length;
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
