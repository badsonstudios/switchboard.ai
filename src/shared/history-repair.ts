// What switchboard.ai did to a card's conversation history WITHOUT being asked
// (#539), on its way to the one surface that says so.
//
// Two repairs can move a card's pointer at someone else's initiative, and until
// this type existed both of them happened in silence:
//
//  • ADOPTED — the repair sweep (#484) found the card's stored conversation
//    missing and reattached it to the newest unclaimed one in its folder. The
//    code that does it already calls this "the one resume outcome the user
//    might disagree with", and it reported that disagreement only to the log.
//  • CEDED — two cards pointed at the SAME conversation, so one of them gave it
//    up (`sessions/untangle.ts`). Nothing is deleted by that: the id moves to
//    the card's `cededNativeIds`, and this notice is what tells the user which
//    card kept what, so the hand-edit back is a decision rather than a discovery.
//
// PERSISTED UNTIL ACKNOWLEDGED, and that is the whole point rather than a
// nicety. Both repairs are one-time by construction — after an adoption the
// card's head IS the adopted id, and after a cede the collision is gone — so
// nothing would ever re-announce them. A notice held only in memory, behind a
// drawer that is collapsed by default, is therefore lost for good the first time
// the user works a session and quits without opening it, and the app has
// silently rewritten which conversation a card is in. That is exactly the state
// this feature exists to make impossible, so the notice outlives the run and
// leaves only when it is dismissed.

/** One thing the app moved, in the words the notice row needs. */
export interface HistoryRepairNotice {
  /**
   * DERIVED, not minted: `<kind>:<cardId>:<nativeSessionId>`.
   *
   * A counter would be a different id for the same fact on every launch, and
   * this list survives launches — the same notice would pile up until it hit the
   * cap, and a dismissal would be undone by a restart. Derived, re-recording a
   * repair already on the list is a no-op and a dismissal is final.
   */
  id: string;
  kind: 'adopted' | 'ceded';
  /** the card this happened TO — the one whose pointer moved */
  cardId: string;
  /** its title at the time, because the notice has to name it in a sentence */
  cardTitle: string;
  /** the conversation involved: adopted INTO, or ceded AWAY */
  nativeSessionId: string;
  /** `ceded` only — the card that kept the conversation */
  keptByTitle?: string;
}

/** The one place the id is spelled, so the writer and the dismisser agree. */
export function historyRepairId(
  r: Pick<HistoryRepairNotice, 'kind' | 'cardId' | 'nativeSessionId'>
): string {
  return `${r.kind}:${r.cardId}:${r.nativeSessionId}`;
}

/**
 * How many of these the app will hold. A hand-edited or badly duplicated
 * workspace can collide a dozen cards on one id, and a notice slot that grew
 * without bound would push the events list off the bottom of the drawer — and
 * this list is written to the workspace file, so unbounded means unbounded on
 * disk. The rest are still in the log, which is where a case that extreme
 * belongs.
 */
export const MAX_HISTORY_REPAIR_NOTICES = 10;

/** Is this a record this build can render? Shared by the store's load and the
 *  log, so a hand-edited file cannot put `undefined` into a sentence. */
export function isSaneHistoryRepair(n: unknown): n is HistoryRepairNotice {
  const x = n as Partial<HistoryRepairNotice>;
  return (
    typeof x?.id === 'string' &&
    !!x.id &&
    (x.kind === 'adopted' || x.kind === 'ceded') &&
    typeof x.cardId === 'string' &&
    typeof x.cardTitle === 'string' &&
    typeof x.nativeSessionId === 'string' &&
    !!x.nativeSessionId &&
    (x.keptByTitle === undefined || typeof x.keptByTitle === 'string')
  );
}
