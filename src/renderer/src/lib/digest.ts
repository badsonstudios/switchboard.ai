// The missed-events digest, as data (P2-E14-05c, §5.9).
//
// What happened while nobody was told. The store hands over #482's held records
// oldest first — its own write order — and this turns them into the thing a
// person reads over coffee: newest first, capped, with a summary line that says
// how much of it there is before any of it is read.
//
// PURE, and in `lib/` rather than in the panel, for the reason every other
// `lib/events-*.ts` is: ordering and overflow are the parts worth pinning, and
// pinning them through a rendered component means a jsdom test for arithmetic.
import { SuppressedEvent } from '../../../shared/suppressed';

/**
 * How many rows the digest draws before it stops naming them individually.
 *
 * The record's own cap is 200 (`SUPPRESSED_CAP`) — a long weekend of a busy
 * workspace — and 200 rows in a 300px drawer is not a digest, it is the wall of
 * stale toasts this feature exists to replace. Six is what fits the notice slot
 * without pushing the live events out of view; the rest become a count, and the
 * count is what tells you whether to care.
 */
export const DIGEST_ROWS = 6;

/** One line of the digest: an event that happened while you were not told. */
export interface DigestRow {
  id: string;
  at: number;
  kind: string;
  cardId: string | null;
  /** captured at hold time by #482, never re-derived — see `shared/suppressed.ts` */
  title: string;
  body: string;
  /**
   * Is this from an earlier DAY than the digest was built on?
   *
   * The cap is 200 records and the manual advertises covering a long weekend, so
   * a row rendered as a bare clock time is ambiguous the moment the list spans
   * midnight — "03:14" naming no night at all, in a feature whose entire subject
   * is which night. The row decides it rather than the renderer, because it is a
   * comparison against a clock and not a formatting choice.
   *
   * The RECORD also carries `actions` and `ruleIds` (which channels were held,
   * which rules asked). They are deliberately NOT lifted onto the row: there is
   * nowhere in a 300px drawer to put them without crowding out the one thing the
   * row is for, and a reader who wants them is asking a different question. Read
   * them off the record when something is built to answer it.
   */
  earlierDay: boolean;
}

export interface Digest {
  /** what to draw, newest first */
  rows: DigestRow[];
  /** how many were held in total, including the ones past `DIGEST_ROWS` */
  total: number;
  /** total - rows.length; 0 when everything is on screen */
  overflow: number;
  /** how many distinct sessions are represented, counting unresolved as one */
  sessions: number;
  /** every id the digest is accounting for — what a clear sends back */
  ids: readonly string[];
}

/**
 * The empty digest. A named value because "nothing was held" renders nothing,
 * and a shared one because a stable reference keeps `useMemo` consumers from
 * re-rendering on every quiet night.
 *
 * FROZEN, arrays included: one value handed to every caller means a single
 * `push` on it would corrupt the empty digest app-wide.
 */
export const EMPTY_DIGEST: Digest = Object.freeze({
  rows: Object.freeze([]) as readonly DigestRow[] as DigestRow[],
  total: 0,
  overflow: 0,
  sessions: 0,
  ids: Object.freeze([]),
});

/**
 * Build the digest from the held list.
 *
 * NEWEST FIRST, which is the opposite of the store's order and deliberately so:
 * the store appends, because it is a log, and a person returning in the morning
 * wants last night's last event at the top. Ties keep their relative order —
 * several events can share a millisecond, and a stable sort means the drawn
 * order matches the order they were held in.
 *
 * `ids` covers EVERYTHING held, not just the drawn rows. "Clear" on a digest
 * that says "and 14 more" has to mean all 20, or the fifteenth would surface
 * alone tomorrow as though it had just happened.
 *
 * `now` is injected rather than read, for `rules.ts`' reason: deciding whether a
 * row is from an earlier day is a comparison against a clock, and a clock a
 * caller cannot set is a test that has to mock the global one.
 */
export function buildDigest(
  held: readonly SuppressedEvent[],
  limit = DIGEST_ROWS,
  now: Date = new Date()
): Digest {
  if (held.length === 0) return EMPTY_DIGEST;
  // copy before sorting: the caller's array is the renderer's state
  const newestFirst = [...held].sort((a, b) => b.at - a.at);
  const today = now.toDateString();
  const rows = newestFirst.slice(0, Math.max(0, limit)).map(
    (e): DigestRow => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      cardId: e.cardId,
      title: e.title,
      body: e.body,
      // `toDateString` rather than an elapsed-hours threshold: "an earlier day"
      // is what a person reading their own calendar means, which is the same
      // local wall-clock reading quiet hours uses for its own windows.
      earlierDay: new Date(e.at).toDateString() !== today,
    })
  );
  // A record whose card could not be resolved counts as ONE session between them
  // all rather than one each: the digest's summary answers "how many of your
  // sessions needed you", and an unresolvable card is one unknown place, not N.
  //
  // A separate flag rather than folding them in under a sentinel string — a
  // sentinel is a card id a workspace file is free to collide with, and the one
  // that reads as obviously-impossible is a control character this repo lints
  // against writing at all (`scripts/check-nul.js`).
  const cards = new Set(held.filter((e) => e.cardId !== null).map((e) => e.cardId));
  const anyUnresolved = held.some((e) => e.cardId === null);
  return {
    rows,
    total: held.length,
    // off `rows.length`, never off `limit`: they diverge whenever the list is
    // shorter than the cap, and "and -3 more" is the bug that hides there.
    overflow: Math.max(0, held.length - rows.length),
    sessions: cards.size + (anyUnresolved ? 1 : 0),
    ids: held.map((e) => e.id),
  };
}
