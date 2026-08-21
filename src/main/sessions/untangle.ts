// Two cards, one conversation — and the one-time decision that separates them
// (#539).
//
// THE STATE THIS EXISTS FOR. #484 gave a card a CHAIN of conversation ids and a
// repair sweep for cards whose chain had gone missing, and the sweep is fenced
// so it can never hand a card a conversation another card is already in. That
// fence is right, and it made one state permanent: two of the owner's real
// cards (`Switchboard.ai` and `Switchboard.ai-2`) already held the SAME id.
// Neither is orphaned — the conversation is on disk — so the sweep is never
// asked about them, and both cards resume into one transcript for ever. Frozen,
// not repaired.
//
// THE POLICY, decided here because the issue delegated it. Exactly one card
// keeps a conversation — where "the same conversation" means the same id IN THE
// SAME FOLDER, because that pair is what names the file (see `conversationKey`).
// Which card, first rule that gives a UNIQUE answer:
//
//  1. A HEAD BEATS AN ANCESTOR. `nativeSessionId` is "the conversation I am in
//     now"; a lineage entry is "one I was in once". If exactly one card holds
//     the id as its head, that card is the one still using it and it keeps it.
//     This resolves every mixed case without a tie-break, and it does it on
//     evidence rather than on order.
//  2. OTHERWISE THE ELDER CARD KEEPS IT. Cards sit in the workspace file in
//     creation order (`WorkspaceStore.upsertSession` appends), and the app
//     itself names the LATER card in a folder `-2` (`sessions/ipc.ts` suffixes
//     a new card whose title is taken). So when two cards hold one id the same
//     way, the later one is by construction the copy.
//
// WHY THE LOSER LOSES NOTHING. A ceded id is not deleted — it moves to
// `cededNativeIds`, out of the resume walk but still written down. That matters
// two ways: the conversation stays findable by hand (the manual documents the
// edit that puts it back), and the card that is owed it still has it written
// down if the keeper is ever closed. Nothing here destroys a card, and the only
// pointer it can drop is the ELEVENTH ceded id on one card (`MAX_LINEAGE`),
// which the keeper is holding anyway.
//
// WHAT CEDING DOES NOT BUY: the ceding card is NOT then offered the repair
// sweep. The sweep's inference is "my conversation is missing from disk, so the
// newest unclaimed one in this folder is probably mine"; for a ceded card the
// conversation is present and demonstrably someone else's, so that inference is
// inverted — and `ownIds` would be empty, making the adapter's own absence check
// vacuous at the same moment. A fully-ceded card starts fresh, keeps its
// pointer, and the notice plus the manual are the way back. The long version is
// at the adoption branch in `start-plan.ts`.
//
// AND THE PAIR CANNOT BE HANDED BACK TOGETHER: a ceded id is `claimed` by the
// card that gave it up as well as by the keeper (`sessions/ipc.ts`), so no
// third card can adopt it either.
//
// Pure, on plain records, for the same reason `lineage.ts` is: this is a
// decision about the user's history, and the only kind you can prove is one you
// can call in a test.
import { slugForCwd } from '../transcripts/paths';
import { MAX_LINEAGE, NativeLineage, resumeCandidates } from './lineage';

/** The shape this reasons about: identity fields, the folder that scopes them,
 *  and a title to say it with. */
export interface UntangleCard extends NativeLineage {
  id: string;
  identity: { title: string; folder: string };
}

/**
 * WHAT COUNTS AS "the same conversation": the same id **in the same folder**.
 *
 * A conversation is a file, and the file is `<projectsRoot>/<slug of the
 * folder>/<id>.jsonl` — every lookup on this path is folder-scoped
 * (`locateConversation`, `listConversations`, `canResume`). So two cards in
 * DIFFERENT folders holding one id are not sharing anything; they name two files
 * in two directories, and untangling them would take a conversation off a card
 * that was never in anyone's way. The harm being repaired is two cards resuming
 * into ONE transcript, and this is what that means precisely.
 *
 * Via `slugForCwd` rather than the raw path so this cannot disagree with the
 * resolver about which folders are the same one, and lower-cased for the reason
 * `conversationExists` documents: real paths lowercase the drive letter. `:` is
 * a safe joiner precisely because `slugForCwd` replaces it.
 */
function conversationKey(folder: string, nativeSessionId: string): string {
  return `${slugForCwd(folder).toLowerCase()}:${nativeSessionId}`;
}

/** One conversation, taken off one card and left with another. */
export interface UntangleChange {
  /** the card that gave it up */
  cardId: string;
  cardTitle: string;
  /** the conversation, now in that card's `cededNativeIds` */
  nativeSessionId: string;
  /** the card that kept it */
  keptByCardId: string;
  keptByTitle: string;
}

export interface UntangleResult<T> {
  /**
   * The cards to persist. The SAME array object when there was nothing to fix —
   * the ordinary launch allocates nothing and changes nothing, which is what
   * makes this safe to run every time instead of behind a one-shot migration
   * flag. (`changes` is what the caller branches on; this is the cheap half.)
   */
  cards: readonly T[];
  /** what moved, in the order the cards appear. Empty when nothing did. */
  changes: UntangleChange[];
}

/**
 * Give every duplicated conversation exactly one owner.
 *
 * Idempotent by construction: after one pass no id appears in two cards' resume
 * chains, so a second pass finds nothing and returns the input array.
 */
export function untangleDuplicateConversations<T extends UntangleCard>(
  cards: readonly T[]
): UntangleResult<T> {
  // who holds what, in workspace order — which is creation order, and therefore
  // rule 2's evidence
  const holders = new Map<string, { nativeSessionId: string; index: number; isHead: boolean }[]>();
  cards.forEach((card, index) => {
    for (const id of resumeCandidates(card)) {
      const key = conversationKey(card.identity.folder, id);
      const list = holders.get(key) ?? [];
      list.push({ nativeSessionId: id, index, isHead: id === card.nativeSessionId });
      holders.set(key, list);
    }
  });

  // cardIndex -> the ids it must give up, in the order the ids were met
  const ceding = new Map<number, string[]>();
  // cardIndex -> id -> the keeper's index, so the notices can name it
  const keeperOf = new Map<number, Map<string, number>>();
  for (const list of holders.values()) {
    if (list.length < 2) continue;
    const { nativeSessionId } = list[0];
    const heads = list.filter((h) => h.isHead);
    // rule 1, then rule 2 — and `list` is already in workspace order, so rule 2
    // is just the first entry
    const keeper = heads.length === 1 ? heads[0] : list[0];
    for (const holder of list) {
      if (holder.index === keeper.index) continue;
      const given = ceding.get(holder.index) ?? [];
      given.push(nativeSessionId);
      ceding.set(holder.index, given);
      const named = keeperOf.get(holder.index) ?? new Map<string, number>();
      named.set(nativeSessionId, keeper.index);
      keeperOf.set(holder.index, named);
    }
  }
  // A card can also need a rewrite without ceding anything: a hand-edited file
  // can list one id as both held and given away, and "one conversation, two
  // contradictory facts about this card" is a state nothing downstream is
  // written to survive. Collected here so the early return below stays honest —
  // an ordinary launch touches neither set and gets its own array back.
  const stale = new Set<number>();
  cards.forEach((card, index) => {
    const given = ceding.get(index) ?? [];
    const kept = resumeCandidates(card).filter((id) => !given.includes(id));
    if ((card.cededNativeIds ?? []).some((id) => kept.includes(id))) stale.add(index);
  });
  if (ceding.size === 0 && stale.size === 0) return { cards, changes: [] };

  // Built by walking the CARDS rather than the id map, so a card that gave up
  // two conversations reads as two lines about one card instead of an
  // interleaving — and so the order is the workspace's, not a Map's.
  const changes: UntangleChange[] = [];
  cards.forEach((card, index) => {
    for (const nativeSessionId of ceding.get(index) ?? []) {
      const keeper = cards[keeperOf.get(index)!.get(nativeSessionId)!];
      changes.push({
        cardId: card.id,
        // `isSaneSession` does not require a title to be a string, and a notice
        // with `undefined` in the middle of its sentence is worse than a clumsy
        // one — the id at least identifies the card in the workspace file
        cardTitle: card.identity.title || card.id,
        nativeSessionId,
        keptByCardId: keeper.id,
        keptByTitle: keeper.identity.title || keeper.id,
      });
    }
  });

  const next = cards.map((card, index) => {
    const given = ceding.get(index) ?? [];
    if (given.length === 0 && !stale.has(index)) return card;
    const chain = resumeCandidates(card);
    const kept = chain.filter((id) => !given.includes(id));
    // What it just gave up, in the order it HELD them — so a former head comes
    // before a former ancestor and the manual's hand-edit recipe reads the way
    // the card does — then whatever it had already ceded. Never an id it is
    // still actively holding.
    const ceded = [...chain.filter((id) => given.includes(id)), ...(card.cededNativeIds ?? [])]
      .filter((id, i, all) => all.indexOf(id) === i && !kept.includes(id))
      .slice(0, MAX_LINEAGE);
    return {
      ...card,
      // The head is whatever it still holds — an ancestor is PROMOTED rather
      // than left stranded under an empty head, the same move a resume-from-
      // lineage makes. `undefined` when it holds nothing: that is a card whose
      // only conversation is now someone else's, and the repair sweep is what
      // gives it another (see `cededNativeIds` in `start-plan.ts`).
      nativeSessionId: kept[0],
      // `undefined` and not `[]`, matching `recordNativeId` — one shape in
      // memory and on disk, and no empty arrays in a file people open by hand.
      nativeSessionLineage: kept.length > 1 ? kept.slice(1) : undefined,
      cededNativeIds: ceded.length > 0 ? ceded : undefined,
    };
  });
  return { cards: next, changes };
}
