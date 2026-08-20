// The suppression record (P2-E14-05b, §5.9) — what quiet hours held back.
//
// **This is the input to the missed-events digest (#483), and it is data, not a
// side effect.** When quiet hours hold a notification, the event did still
// happen: a session needed a human at 03:14 and nobody was told. Throwing that
// away and calling it "quiet" would be the app deciding on the user's behalf
// that the night never happened. So each held event is written down — what,
// when, which card, which channels were held, and why — and the digest reads
// the list on return.
//
// In `shared/` rather than beside the rules engine because two processes need
// the shape: MAIN writes it (the engine has no renderer involved) and the
// RENDERER reads it over IPC to draw the digest. `main/events/rules.ts` cannot
// be that home — a renderer importing a main module is the wrong direction, and
// `Rule` living there is already noted as the smell it is.
//
// **Bounded, and the bound is stated:** `SUPPRESSED_CAP` records, oldest
// dropped first. A digest is a list a person reads over coffee, not an archive:
// 200 covers a long weekend of a busy workspace, keeps the workspace file's
// share of it under ~50 KB, and — the reason a cap exists at all — means a user
// who leaves quiet hours on for a month comes back to a file that still loads.
// Overflow is not an error and is not reported: dropping the oldest line of a
// digest nobody read is the correct outcome.

/**
 * One attention event that quiet hours held back.
 *
 * One record per EVENT, not per action: "this session needed you at 3am" is one
 * line in a digest, even though it held the toast, the cue and the voice. Which
 * channels were held is `actions`, for the person who wants to know why their
 * phone stayed dark.
 */
export interface SuppressedEvent {
  /**
   * Unique, and unique across a restart: `"<epoch-ms>-<counter>"`. The digest
   * clears by id, and an id that could repeat would clear the wrong line.
   */
  id: string;
  /** epoch ms — when it was held. Rendered in local time by whoever draws it. */
  at: number;
  /** the attention event (a `FeedKind`: done / needs-input / …) */
  kind: string;
  /** the durable CARD it belongs to, or null when it could not be resolved */
  cardId: string | null;
  /**
   * What the notification WOULD have said, captured at the moment it was held.
   *
   * Deliberately a copy rather than a lookup: the digest is read hours later,
   * by which time the card may have been renamed, closed, or re-labelled by a
   * new task. A digest that re-derives its own text is a digest that reports
   * last night's 3am event under this morning's title.
   */
  title: string;
  body: string;
  /** the action types held, deduped and in plan order: `["os-toast","sound"]` */
  actions: string[];
  /** the rules that asked, for the "why did this happen" breadcrumb */
  ruleIds: string[];
  /** why it was held. One value today; a field so the digest never has to guess. */
  reason: SuppressionReason;
}

/**
 * Today there is exactly one reason, and it is still a named field rather than
 * an assumption: #483's digest also wants "you were away" events, and a list
 * whose rows cannot say which kind they are is a list that has to be rebuilt.
 */
export type SuppressionReason = 'quiet-hours';

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = ['quiet-hours'];

/** How many held events are kept. Oldest dropped first — see the file header. */
export const SUPPRESSED_CAP = 200;

/** Longest string any field is stored at; a title arrives from a session name. */
const MAX_TEXT = 200;

/** Trim one to what the store is willing to write. */
export function clampSuppressed(e: SuppressedEvent): SuppressedEvent {
  return {
    ...e,
    id: e.id.slice(0, 64),
    kind: e.kind.slice(0, 32),
    cardId: e.cardId === null ? null : e.cardId.slice(0, 128),
    title: e.title.slice(0, MAX_TEXT),
    body: e.body.slice(0, MAX_TEXT),
    actions: e.actions.slice(0, 16).map((a) => a.slice(0, 32)),
    ruleIds: e.ruleIds.slice(0, 16).map((r) => r.slice(0, 128)),
  };
}

/**
 * Can this build read the record back? The same bar `isSaneRule` sets: a record
 * that is half-understood is dropped on load rather than repaired, because a
 * digest row with a missing card or a `NaN` timestamp is worse than one fewer
 * row.
 */
export function isSaneSuppressedEvent(v: unknown): v is SuppressedEvent {
  const x = v as Partial<SuppressedEvent> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  if (typeof x.id !== 'string' || !x.id) return false;
  if (typeof x.at !== 'number' || !Number.isFinite(x.at)) return false;
  if (typeof x.kind !== 'string' || !x.kind) return false;
  if (x.cardId !== null && typeof x.cardId !== 'string') return false;
  if (typeof x.title !== 'string' || typeof x.body !== 'string') return false;
  if (!Array.isArray(x.actions) || !x.actions.every((a) => typeof a === 'string')) return false;
  if (!Array.isArray(x.ruleIds) || !x.ruleIds.every((r) => typeof r === 'string')) return false;
  return (
    typeof x.reason === 'string' &&
    SUPPRESSION_REASONS.includes(x.reason)
  );
}
