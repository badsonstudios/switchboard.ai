// A card's native-conversation LINEAGE (#484) — the ids it has been known by,
// so that learning a new one never destroys the old.
//
// The bug this exists to make impossible, in two measured halves:
//
//  1. WE LEARN AN ID BEFORE ITS TRANSCRIPT EXISTS. The card's native id is
//     written the instant the CLI announces one — `system:init` on the stream,
//     or the `SessionStart` hook — and the CLI does not write that
//     conversation's `.jsonl` until a REAL TURN happens (S-07; `paths.ts` says
//     the same thing from the other side). Any session that announces an id and
//     then gets no prompt leaves the card pointing at a file that does not
//     exist. That alone is harmless.
//  2. IT WAS AN OVERWRITE. The id it replaced was the card's only pointer to a
//     conversation that IS on disk, and the next launch — finding the new id
//     unresumable, correctly — used to write `nativeSessionId: undefined` over
//     the card and start fresh. Two of the owner's real cards were found in
//     exactly that state, one of them with 67 KB of history sitting a directory
//     away under an id nothing referred to any more.
//
// (Measured 2026-08-15 against claude 2.1.226, correcting the theory this fix
// was filed under: plain `--resume <A>` does NOT fork. It re-adopts A's id and
// APPENDS to `A.jsonl` — 22 transcripts on disk carry a mid-file
// `SessionStart:resume` line and not one begins with a resume, and the CLI's own
// resume path re-adopts the id unless `--fork-session` is passed, which we never
// pass. A new id and a new file come from `/clear`, from a fresh spawn, and from
// a resume the app DECLINED — which is how both orphans were really made. The
// defect and the fix are unchanged; only the story about which CLI action mints
// the id is.)
//
// So: a card's identity is not one id, it is a CHAIN. The head is the
// conversation we believe we are in; the tail is every id it has been known by,
// newest-known-good first. Resume walks the chain and takes the first that is
// really on disk, which lands a card whose newest id never got a turn straight
// back in the conversation it actually has. Nothing is ever removed from the
// chain by a failed lookup — only pushed down it — because the whole class of
// defect here is a transient answer ("I could not see that file just now")
// being written down as a permanent one.
//
// Pure functions on plain records on purpose: every rule below is a decision
// about the user's history, and a decision you can call in a test is the only
// kind you can prove.

/**
 * How many ANCESTORS a card carries — so the resume walk asks about at most
 * this many plus the head.
 *
 * Bounded because the chain grows by one on every resume that gets a turn, and
 * this is persisted state in a file we re-serialize on every workspace save —
 * an unbounded list would grow forever for a card the user resumes daily. Ten
 * is far past useful: the fallback only ever reaches past the head when a
 * resume produced no turn, and a card with ten of those in a row has bigger
 * problems. The oldest are dropped, since the newest ancestor is the one with
 * the most history in it.
 */
export const MAX_LINEAGE = 10;

/** The persisted shape this module reasons about — the two fields of a card
 *  that carry its conversation identity. Deliberately structural rather than
 *  `PersistedSession`: nothing here needs the rest of a card, and the session
 *  IPC spreads the result over whatever record it holds. */
export interface NativeLineage {
  nativeSessionId?: string;
  nativeSessionLineage?: string[];
  /**
   * Conversations this card GAVE UP because another card holds them (#539).
   *
   * Deliberately not part of the chain: `resumeCandidates` never offers these,
   * because the whole point of ceding one is that two cards must not resume
   * into one transcript. And deliberately NOT a licence to go looking for a
   * substitute either — `start-plan.ts` says at length why a ceded card starts
   * fresh instead. Kept rather than deleted so the conversation stays findable
   * by hand (the manual documents the edit) and so the card that is owed it
   * still has it written down. Written by `sessions/untangle.ts`, which is
   * where the policy lives.
   */
  cededNativeIds?: string[];
}

/**
 * The ids to try resuming, in order: the head first, then its ancestors.
 *
 * De-duplicated and emptied of blanks, so a hand-edited or half-migrated
 * workspace file cannot make the caller ask the same question twice or ask it
 * about `''` (which `canResume` would refuse anyway, but a refusal that reads
 * like a real miss is how a card looks unresumable for no visible reason).
 */
export function resumeCandidates(card: NativeLineage | undefined): string[] {
  const out: string[] = [];
  for (const id of [card?.nativeSessionId, ...(card?.nativeSessionLineage ?? [])]) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Record that `next` is now this card's conversation, WITHOUT losing what it
 * was.
 *
 * The single writer of the chain, used by both of the moments an id changes:
 * the CLI announcing a new conversation mid-session, and a start that resolved
 * its resume from an ancestor (which promotes that ancestor back to the head and
 * demotes the id that had no transcript rather than deleting it — a conversation
 * we could not see today may materialize tomorrow, and an id we threw away
 * cannot).
 *
 * Returns the fields to persist, never mutating the input. `next` must be a
 * real id: there is deliberately no way to express "and now this card has no
 * conversation", because that assignment is the bug.
 */
export function recordNativeId(
  card: NativeLineage | undefined,
  next: string
): NativeLineage & { nativeSessionId: string } {
  // `next` itself is filtered out wherever it sat: a promotion from the tail
  // must not leave the id in both places, or the chain would offer it twice
  // and — worse — an ancestor would be indistinguishable from the head after
  // one more id change.
  const ancestors = resumeCandidates(card)
    .filter((id) => id !== next)
    .slice(0, MAX_LINEAGE);
  // A card can only be handed back an id it ceded when the card that kept it is
  // gone (#539) — rare, but then the id is live again, and leaving it on the
  // ceded list would make one conversation two contradictory facts about this
  // card.
  const ceded = (card?.cededNativeIds ?? []).filter((id) => id !== next);
  return {
    nativeSessionId: next,
    // Written even when EMPTY, like the lineage below: callers spread this over
    // the record they already hold, so an omitted field would leave the card's
    // stale ceded list in place — the id would be both the head and given away.
    cededNativeIds: ceded.length > 0 ? ceded : undefined,
    // `undefined` and not `[]` for a card with no ancestors, so that what is
    // held in memory and what comes back off disk are the same shape — the
    // store's load maps an empty array to absence, and a card whose first
    // session has just started would otherwise read differently before and
    // after a relaunch. It also keeps `[]` out of every record in a file people
    // open by hand.
    nativeSessionLineage: ancestors.length > 0 ? ancestors : undefined,
  };
}

/** Normalize whatever the workspace file had. Shared with the store's load so
 *  a hand-edited array of numbers cannot reach the resume walk. */
export function sanitizeLineage(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const id of value) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out.slice(0, MAX_LINEAGE) : undefined;
}
