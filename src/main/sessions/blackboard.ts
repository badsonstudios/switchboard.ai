// The blackboard (P2-E11-06, §5.4) — the shared scratchpad a pipeline gets.
//
// `publish(key, value)` leaves a durable note; `read(key)` picks it up; `read()`
// with no key lists what is there. Sessions in a deliberate pipeline can hand
// each other state without a send that needs a human keypress — because nothing
// here is ever sent. A note sits until somebody asks for it.
//
// ── WHY THIS IS NOT COVERED BY §5.4'S KEYPRESS RULE ─────────────────────────
//
// That rule is about `send_to_session` INJECTING into a sibling's composer, and
// it is kept by `delivery.ts`. This is the other shape: a write nobody receives.
// **Publishing never causes execution, delivery or notification in another
// session** — there is no composer on this path, no submit, no IPC and no
// renderer consumer, so nothing reaches a session that did not call the read
// tool itself. That is what puts the blackboard outside the rule rather than in
// an exception to it.
//
// ⚠️ NARROWED AFTER REVIEW, because the first version of this sentence claimed
// more than is true and would have been quoted back later. It said a publisher
// could not affect a non-reading session AT ALL. Two ways it can, both bounded
// and neither of them execution: the caps are workspace-global, so a session
// looping on generated keys can exhaust them and make a SIBLING's next publish
// fail; and the namespace is shared, so one session may overwrite another's
// key. Attribution is what keeps that honest — the reader is always told who
// wrote what it is holding — but "nothing happens anywhere" was false.
//
// ── IN MEMORY, FOR THE LIFE OF THE APP. NOT THE WORKSPACE STORE ─────────────
//
// Decided at pickup (#796 names persistence as an open decision) and recorded
// because the other choice is defensible and was rejected on purpose:
//
//   1. A RESTART HAS ALREADY DESTROYED THE PIPELINE. Restore-on-launch yields
//      SUSPENDED session records — nothing is running. Notes that survived would
//      be attributed to sessions that no longer exist, read by an agent with no
//      way to tell, which is the confident-wrong-answer shape this whole epic is
//      built against.
//   2. IT WOULD PUT DISK I/O INSIDE A TOOL CALL on Electron's main thread. #772
//      measured what a burst of bus calls does to the host's loop and bounded
//      it; a `publish` that writes `workspace.json` re-introduces that cost on
//      the write path.
//   3. `workspace.json` WOULD GAIN AGENT-WRITTEN CONTENT. `SIBLING_INBOX_CHAR_CAP`
//      already worries about exactly this — agent text bloating a file that is
//      re-serialized on every save, where every other preference pays for it.
//   4. IT IS THE REVERSIBLE DIRECTION. Adding persistence later is additive.
//      Removing it after agents have been writing to the workspace file is not.
//
// TRANSPORT-FREE like `queries.ts` and `delivery.ts`: no Electron, no IPC, no
// MCP. The session list arrives as a function, so every branch is unit-testable
// and `check:bus` can drive the real class through the real bus child.
import {
  BLACKBOARD_KEY_CHAR_CAP,
  BLACKBOARD_MAX_KEYS,
  BLACKBOARD_TOMBSTONE_CAP,
  BLACKBOARD_TOTAL_CHAR_CAP,
  BLACKBOARD_VALUE_CHAR_CAP,
} from '../../shared/blackboard';
import type { QueryResult, SessionSummary } from './queries';

/** One published note, as the reader is told about it. */
export interface BlackboardEntry {
  key: string;
  value: string;
  /**
   * Who published it — the live session id, taken from the TOKEN at publish
   * time and never from anything the child said about itself.
   */
  publisherId: string;
  /**
   * …and their name AS IT IS NOW, resolved at read time rather than stored.
   *
   * A card can be renamed between publish and read, and a name frozen at
   * publish would send the reader looking for a session that is listed under
   * something else.
   */
  publisherName: string;
  /**
   * The publishing session is no longer running.
   *
   * Carried because it changes what the reader should DO: a note from a live
   * sibling can be followed up with `send_to_session`, and a note from a session
   * that has exited cannot. Without this an agent reasonably tries to talk to a
   * session that is gone, and is told nothing until that fails too.
   */
  publisherGone: boolean;
  /**
   * We were able to CHECK whether the publisher is still running.
   *
   * A third state, and it exists because collapsing it into `publisherGone`
   * made a failed read of our OWN session list come out as the positive claim
   * that a sibling is alive and available to answer. That is #764's "an absent
   * payload is our fault, not a fact about the sibling", inverted — and the
   * reader acts on it, by deciding whether to go and ask.
   */
  publisherKnown: boolean;
  /** ISO 8601, from the clock at publish time. */
  at: string;
}

/** What a `read` with no key answers: the board, without the values. */
export interface BlackboardListing {
  key: string;
  publisherName: string;
  publisherGone: boolean;
  /** See `BlackboardEntry.publisherKnown`. */
  publisherKnown: boolean;
  at: string;
  /** How big the value is, so a reader can decide whether to ask for it. */
  chars: number;
}

/**
 * What `remove` gives back (#861) — and it is deliberately a RECEIPT FOR A
 * DESTRUCTION, not a bare acknowledgement.
 *
 * Every field except `key` and `keys` describes the note that no longer exists.
 * That is the point: removal is the one irreversible thing on this class, and
 * the mitigation that actually fits its failure mode is not a permission check
 * (see `remove`) but making an accidental removal VISIBLE in the transcript of
 * the session that did it. An agent that removed the wrong key can say which
 * note it destroyed, who wrote it, and how big it was — which is what someone
 * needs to go and ask for it again.
 */
/**
 * What a reader is told about a key that was REMOVED rather than never written
 * (#861). See `BLACKBOARD_TOMBSTONE_CAP` for why this exists at all.
 */
export interface Tombstone {
  /** Who took it off, as their name stands now — `entryFor`'s rule. */
  removerName: string;
  /** …and whether we could check. `BlackboardEntry.publisherKnown`'s third state. */
  removerKnown: boolean;
  at: string;
}

export interface RemoveReceipt {
  key: string;
  /**
   * A note was actually there, and is now gone.
   *
   * `false` is an ordinary `ok` answer, not a refusal — see `remove`. Carried
   * rather than inferred from the other fields so a caller never has to read
   * "0 characters removed" as either outcome.
   */
  removed: boolean;
  /** How big the removed note was, or 0 when nothing was there. */
  chars: number;
  /**
   * Who had published it, as their name stands NOW — `entryFor`'s rule, for
   * `entryFor`'s reason. Absent when nothing was removed.
   */
  publisherName?: string;
  /**
   * We were able to CHECK who published it.
   *
   * ⚠️ CARRIED FOR `BlackboardEntry.publisherKnown`'s REASON, and review caught
   * it missing here. `publisher` fails open, so an unavailable session list
   * makes `publisherName` fall back to the raw session id — and a receipt that
   * renders "published by sb-3f2a-…" as though that were a name defeats the one
   * field this whole tool leans on. The renderer says so in words instead.
   */
  publisherKnown?: boolean;
  /**
   * …and whether they have since exited, which decides whether anyone can be
   * asked to publish it again. Absent when nothing was removed.
   */
  publisherGone?: boolean;
  /** When it had been published. Absent when nothing was removed. */
  at?: string;
  /** What is left on the board, so a wall-hitting agent can see the room it made. */
  keys: number;
  maxKeys: number;
  /**
   * …and the CHARACTER total, for the same reason one cap along.
   *
   * Review's catch: the total-char refusal now advises removal, and that cap
   * needed it more than the key cap did — overwriting only reclaims room when
   * the new value is smaller. Reporting only `keys` left an agent removing notes
   * to get under the character ceiling with no way to tell whether it had
   * cleared enough, except to retry the publish and read the refusal again.
   */
  totalChars: number;
  maxChars: number;
}

/** What `publish` gives back — enough for the agent to know what it did. */
export interface PublishReceipt {
  key: string;
  /** This key already held a note, and it has been replaced. */
  replaced: boolean;
  chars: number;
  /** How many keys exist now, and the ceiling, so a pipeline can pace itself. */
  keys: number;
  maxKeys: number;
}

export interface BlackboardDeps {
  /**
   * Every session a sibling could name — the same list the bus answers
   * `list_sessions` from, so a publisher's name here and in that list cannot
   * disagree. `SessionQueries.listSessions` fits this exactly.
   */
  sessions(): QueryResult<SessionSummary[]>;
  /** Seam for tests; defaults to the real clock. */
  now?: () => Date;
}

/** What the store holds. `publisherName` is resolved on the way out, not in. */
interface StoredNote {
  value: string;
  publisherId: string;
  at: string;
}

export class Blackboard {
  /**
   * Insertion-ordered by first publish, which a `Map` preserves.
   *
   * That order is the one worth showing: it reads as the shape of the pipeline —
   * what was established first, what was added as it went. An overwrite
   * deliberately KEEPS the original position rather than moving the key to the
   * end, so a board a reader has seen before does not reshuffle under them
   * because one value was refreshed.
   */
  private readonly notes = new Map<string, StoredNote>();

  /**
   * Keys that were REMOVED, so a later reader is told that rather than being
   * told to keep waiting (#861). Bounded by `BLACKBOARD_TOMBSTONE_CAP`, oldest
   * evicted first — see `tomb`.
   *
   * Holds no values. A tombstone that kept the note would make "removed" false.
   */
  private readonly tombstones = new Map<string, Tombstone>();

  constructor(private readonly deps: BlackboardDeps) {}

  /** How many departures are remembered. Observability for the cap. */
  tombstoneCount(): number {
    return this.tombstones.size;
  }

  /** How many keys are held. Observability for tests and the caps. */
  size(): number {
    return this.notes.size;
  }

  /**
   * Leave a note. Refuses rather than truncates, and says which cap it hit.
   *
   * ⚠️ EVERY ARGUMENT IS JSON A LANGUAGE MODEL WROTE, so `key` and `value` are
   * type-guarded here rather than trusted. `resolve` in `queries.ts` makes the
   * same argument for the same reason: the tool schema is a description, not an
   * enforcement mechanism, and a `.trim()` on a number throws straight out of a
   * module that promises never to.
   */
  publish(publisherId: string, key: unknown, value: unknown): QueryResult<PublishReceipt> {
    if (typeof key !== 'string') return { ok: false, reason: 'the key must be a string' };
    const trimmed = key.trim();
    if (trimmed === '') return { ok: false, reason: 'the key cannot be empty' };
    if (trimmed.length > BLACKBOARD_KEY_CHAR_CAP) {
      return {
        ok: false,
        reason:
          `that key is ${trimmed.length} characters and the limit is ${BLACKBOARD_KEY_CHAR_CAP} — ` +
          'use a short label and put the content in the value',
      };
    }
    // ⚠️ A KEY IS A LABEL, NOT CONTENT — AND IT IS PRINTED IN OUR OWN VOICE.
    //
    // `trim()` only takes the ends, so an interior newline used to survive into
    // `renderBlackboard`'s listing rows and into its "the board does hold: …"
    // sentence, neither of which fences anything. Review demonstrated the
    // consequence by running it: one publish produced a listing row claiming a
    // DIFFERENT session had published a key it had never heard of, and a key
    // carrying `\n\nSYSTEM: …` rendered as a sentence sitting under switchboard's
    // own text with no fence anywhere in the output.
    //
    // The renderer flattens as well — it must be safe on a payload it did not
    // produce — but the refusal belongs here, because it is the only layer that
    // can tell the agent WHY, and a label with a line break in it was never
    // something a caller meant. `UNSAFE`'s precedent for message bodies is the
    // same call made one field along.
    if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
      return {
        ok: false,
        reason:
          'a key must be a single line of plain text — no line breaks and no control characters. ' +
          'It is a label other sessions read in a list; put the content in the value',
      };
    }
    if (typeof value !== 'string') {
      // NOT coerced with `String(value)`: an object would be stored as
      // "[object Object]", which is a note that reads as content and holds none.
      return { ok: false, reason: 'the value must be a string — serialize it yourself if it is not' };
    }
    // AN EMPTY NOTE IS THE EMPTY SUCCESS THIS FEATURE EXISTS TO PREVENT,
    // arriving through the door the `String(value)` refusal above guards: a
    // reader would be told, with a timestamp and an author, that Alpha's
    // finding is nothing at all.
    //
    // ── WHY EMPTY IS NOT "DELETE THIS KEY", WHICH WAS THE OTHER OPTION ───────
    //
    // Treating it as a delete would be tidier and it was rejected because the
    // failure mode is unrecoverable: an agent whose value came back empty from
    // its own failed computation would silently destroy ANOTHER session's note,
    // and nothing on this path could tell the two intentions apart. A refusal
    // costs a retry; a wrong delete costs the finding.
    //
    // ⚠️ **AND THAT ARGUMENT SURVIVED #861, WHICH BUILT THE DELETE.** This
    // comment used to end "if the cap turns out to bite, removal should arrive
    // as a deliberate gesture with its own name" — `remove` below IS that
    // gesture, and this refusal still stands, because the two decisions are
    // about different things. Removal is now permitted; inferring it from a
    // string that came back empty by accident is still the one path that cannot
    // tell an intention from a failure. A caller that means to delete has a
    // word for it.
    if (value.trim() === '') {
      return {
        ok: false,
        reason:
          'the value is empty, so there is nothing to publish — a note with no content would be ' +
          'shown to the next reader as a finding that says nothing, under your name. Nothing was ' +
          'stored and nothing that was already there has been changed',
      };
    }
    if (value.length > BLACKBOARD_VALUE_CHAR_CAP) {
      return {
        ok: false,
        reason:
          `that value is ${value.length} characters and the limit is ${BLACKBOARD_VALUE_CHAR_CAP}. ` +
          'It was NOT published — nothing was stored and nothing was cut. Publish a shorter summary, ' +
          'or split it across keys',
      };
    }

    const existing = this.notes.get(trimmed);
    if (!existing && this.notes.size >= BLACKBOARD_MAX_KEYS) {
      return {
        ok: false,
        reason:
          `the blackboard already holds ${this.notes.size} keys, which is the limit ` +
          `(${BLACKBOARD_MAX_KEYS}). Overwriting a key that is already there still works and does ` +
          'not count against this limit — publish under one of the existing keys instead. ' +
          'Or remove a key you no longer need with blackboard_remove, which frees a slot. ' +
          'blackboard_read with no key lists what is on the board',
        // ⚠️ THE HISTORY OF THIS SENTENCE IS THE HISTORY OF THE BUG.
        //
        // It first ended "or use fewer of them", and #796's review was right that
        // this was advice the reader could not take: there was no delete, so the
        // count never dropped for the life of the app, and telling a stuck model
        // to do an impossible thing is worse than telling it only the thing that
        // works. So it was cut, leaving overwrite as the only offer — which was
        // honest but left the cap a genuine one-way door (#861).
        //
        // #861 built the delete, so the advice is actionable for the first time.
        // It names the TOOL rather than the concept, and it names the listing
        // tool too, because an agent that has hit this wall needs to know which
        // keys exist before it can choose one to drop.
      };
    }

    // THE TOTAL IS MEASURED AGAINST WHAT THIS WRITE WOULD LEAVE BEHIND, not
    // against what is there now — an overwrite that SHRINKS a value must not be
    // refused because the board is currently full, and one that grows it must be
    // charged only the difference.
    const after = this.totalChars() - (existing ? existing.value.length + trimmed.length : 0) + trimmed.length + value.length;
    if (after > BLACKBOARD_TOTAL_CHAR_CAP) {
      return {
        ok: false,
        reason:
          `the blackboard holds ${this.totalChars()} characters and this would take it past its ` +
          `${BLACKBOARD_TOTAL_CHAR_CAP}-character limit. It was NOT published. Publish something ` +
          'shorter, overwrite a key that is no longer needed, or remove one with ' +
          // #861, and this cap needed it MORE than the key cap did: overwriting
          // only frees room if the new value is smaller, so before `remove`
          // existed a board full of large notes could not be shrunk at all.
          'blackboard_remove to free its characters',
      };
    }

    const at = (this.deps.now?.() ?? new Date()).toISOString();
    // `set` on an existing key keeps its insertion position — see `notes`.
    this.notes.set(trimmed, { value, publisherId, at });
    // ...AND THE KEY IS NO LONGER REMOVED (#861). Without this, a key that was
    // taken off and then published again would still carry its tombstone, and
    // the register would be ready to tell a future reader "Beta removed this"
    // about a note that is sitting right there. A tombstone outliving its key is
    // the one way this register can contradict the board.
    this.tombstones.delete(trimmed);
    return {
      ok: true,
      value: {
        key: trimmed,
        replaced: existing !== undefined,
        chars: value.length,
        keys: this.notes.size,
        maxKeys: BLACKBOARD_MAX_KEYS,
      },
    };
  }

  /**
   * Take a note off the board (#861).
   *
   * ── ANY SESSION MAY REMOVE ANY KEY, AND THAT IS THE DECISION ───────────────
   *
   * #861 held this open as "who may remove whose note, since the namespace is
   * shared and cross-session overwrite is already permitted". That clause is the
   * answer, and the three reasons are worth having here rather than in a PR:
   *
   *   1. **IT ADDS NO DESTRUCTIVE POWER THAT DOES NOT ALREADY EXIST.** Any
   *      session may already overwrite any key — §5.4 says so, the header of
   *      `shared/blackboard.ts` says so, and the manual states it as deliberate.
   *      An overwrite destroys another session's content today. This destroys
   *      the same content under a clearer name.
   *   2. **"ONLY THE PUBLISHER" WOULD NOT FIX THE BUG IT LOOKS LIKE IT FIXES.**
   *      The cap is reached by a pipeline generating a key per task, and those
   *      publishers are exactly the sessions that have since exited —
   *      `BlackboardEntry.publisherGone` exists because that is the ordinary
   *      case. Publisher-only removal leaves the cap a one-way door precisely
   *      when it is actually hit, which was the whole of #861.
   *   3. **IT IS, IN ONE WAY, SAFER THAN THE OVERWRITE WE ALREADY ALLOW.** After
   *      a removal `read` gives #764's ordinary answer — nothing under that key,
   *      here are the keys that do exist — which is true and actionable. After a
   *      hostile overwrite the reader gets content under an author, which reads
   *      as authoritative. Of the two destructive paths, the one already
   *      permitted is the one that can mislead.
   *
   * **So the mitigation is legibility — but it has to be legible to the RIGHT
   * SESSION, and the first cut of this got that wrong.** `RemoveReceipt` names
   * what was destroyed and who wrote it, which serves the session that did the
   * removing. Review found the asymmetry that argument had glossed over: an
   * OVERWRITE leaves its evidence where the victim will see it — the next
   * `read` returns content with a new author attached — while a removal left
   * nothing anywhere except the perpetrator's own transcript. Worse, `read`'s
   * miss advises an agent that the session it is waiting on "may not have got
   * there yet", so after a removal switchboard was telling a reader, in its own
   * voice, to keep waiting for something that would never arrive. That is the
   * confident-wrong-answer shape this whole epic is built against, introduced
   * by the fix for something else.
   *
   * **`tombstones` is the answer**: a removed key is remembered — who took it
   * off and when, never its value — so the miss becomes the most informative
   * answer on the class rather than the only misleading one.
   *
   * ⚠️ `removerId` IS RECORDED AND NEVER CHECKED. It exists so the tombstone can
   * name a session, not to gate anything; there is no branch below that compares
   * it to the note's publisher. That distinction is the whole design, so keep it
   * visible: the day someone adds `if (removerId !== existing.publisherId)`,
   * reason 2 above stops being true.
   *
   * ── A KEY THAT WAS NOT THERE IS `ok`, WITH `removed: false` ────────────────
   *
   * `read`'s ordering (#764) applied to a mutation. "Nothing was published under
   * that key" is an ordinary state, and an agent clearing space does not want a
   * refusal for a key a sibling already dropped. What it must not get is a
   * receipt that says something was removed when nothing was — hence the flag,
   * and hence the keys are returned either way so the answer is actionable.
   */
  remove(removerId: string, key: unknown): QueryResult<RemoveReceipt> {
    // TYPE-GUARDED HERE for `publish`'s reason: every argument is JSON a
    // language model wrote, and the tool schema is a description rather than an
    // enforcement mechanism.
    if (typeof key !== 'string') return { ok: false, reason: 'the key must be a string' };
    const trimmed = key.trim();
    if (trimmed === '') return { ok: false, reason: 'the key cannot be empty' };
    // CAPPED LIKE `publish`'S, and not only for symmetry: an over-cap key can
    // never match anything that was stored, so the only thing an uncapped one
    // could do is be echoed back whole in the refusal we print.
    if (trimmed.length > BLACKBOARD_KEY_CHAR_CAP) {
      return {
        ok: false,
        reason:
          `that key is ${trimmed.length} characters and the limit is ${BLACKBOARD_KEY_CHAR_CAP}, ` +
          'so nothing on the blackboard can be stored under it. Nothing was removed',
      };
    }

    const existing = this.notes.get(trimmed);
    if (!existing) {
      return {
        ok: true,
        value: {
          key: trimmed,
          removed: false,
          chars: 0,
          keys: this.notes.size,
          maxKeys: BLACKBOARD_MAX_KEYS,
          totalChars: this.totalChars(),
          maxChars: BLACKBOARD_TOTAL_CHAR_CAP,
        },
      };
    }

    // ONE session-list lookup, used for BOTH the publisher being reported and
    // the remover being recorded — `list`'s reason: this runs on Electron's main
    // thread inside a tool call, and `listSessions` copies its array per call.
    const list = this.sessionList();
    // The publisher is resolved BEFORE the delete: it comes from the note's own
    // `publisherId`, and the receipt is the only place it will ever be said.
    const who = this.publisher(existing.publisherId, list);
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    this.notes.delete(trimmed);
    this.tomb(trimmed, removerId, at, list);
    return {
      ok: true,
      value: {
        key: trimmed,
        removed: true,
        chars: existing.value.length,
        publisherName: who.name,
        publisherKnown: who.known,
        publisherGone: who.gone,
        at: existing.at,
        keys: this.notes.size,
        maxKeys: BLACKBOARD_MAX_KEYS,
        totalChars: this.totalChars(),
        maxChars: BLACKBOARD_TOTAL_CHAR_CAP,
      },
    };
  }

  /**
   * Record that a key was taken off, evicting the oldest if we are full.
   *
   * The remover's NAME is resolved here rather than at read time, unlike a
   * publisher's. A publisher is usually still around to be renamed; a remover is
   * being recorded precisely because the thing it touched is gone, and holding
   * its id to re-resolve later would mean a tombstone that says "sb-3f2a-…"
   * forever once that session exits — which is most of them.
   */
  private tomb(key: string, removerId: string, at: string, list: readonly SessionSummary[] | null): void {
    const who = this.publisher(removerId, list);
    // Delete-then-set so a key removed, republished and removed again moves to
    // the END rather than keeping a stale position and being evicted early.
    this.tombstones.delete(key);
    this.tombstones.set(key, { removerName: who.name, removerKnown: who.known, at });
    while (this.tombstones.size > BLACKBOARD_TOMBSTONE_CAP) {
      // `Map` iterates in insertion order, so the first key is the oldest.
      const oldest = this.tombstones.keys().next();
      if (oldest.done) break;
      this.tombstones.delete(oldest.value);
    }
  }

  /**
   * Read one note.
   *
   * ── AN UNKNOWN KEY IS `ok`, NOT A REFUSAL, AND THAT IS #764'S ORDERING ─────
   *
   * A bad session *reference* refuses; an empty *result* does not. "Nothing is
   * published under that key" is a true and ordinary state — the other half of
   * the pipeline has not got there yet — and an agent told it can wait or go and
   * look. What it must never get is an empty success it reads as "my sibling
   * published nothing at all".
   *
   * So the miss answers `ok` with `entry: null` AND the keys that do exist,
   * which is `resolve`'s trick: a refusal (or here, a miss) that names the real
   * options is one the agent can act on instead of retrying blind.
   */
  read(
    key: unknown
  ): QueryResult<{ entry: BlackboardEntry | null; keys: string[]; removed?: Tombstone }> {
    if (typeof key !== 'string') return { ok: false, reason: 'the key must be a string' };
    const trimmed = key.trim();
    if (trimmed === '') return { ok: false, reason: 'the key cannot be empty' };
    const note = this.notes.get(trimmed);
    const keys = [...this.notes.keys()];
    if (!note) {
      // ⚠️ THE MISS IS WHERE #861 COULD HAVE LIED. Without this, the renderer
      // tells an agent its sibling "may not have got there yet" — advice to
      // keep waiting for a note somebody deleted. A tombstone turns the same
      // branch into the answer that ends the wait.
      const removed = this.tombstones.get(trimmed);
      return { ok: true, value: { entry: null, keys, ...(removed ? { removed } : {}) } };
    }
    return { ok: true, value: { entry: this.entryFor(trimmed, note, this.sessionList()), keys } };
  }

  /**
   * The whole board, without the values (§5.4's discovery case).
   *
   * The ticket named the reason this exists rather than refusing a keyless
   * read: an agent that joined a pipeline late has no other way to find out
   * what is on the board. Values are left out deliberately — discovery should
   * cost a bounded answer, not the entire 100,000-character ceiling, and the
   * sizes here are what let an agent choose what to ask for.
   */
  list(): QueryResult<BlackboardListing[]> {
    // ONE SESSION-LIST LOOKUP FOR THE WHOLE LISTING, not one per row. It is an
    // in-memory map either way, but `listSessions` copies its array on every
    // call and this runs on Electron's main thread inside a tool call — which
    // is precisely the shape #772 measured and bounded.
    const list = this.sessionList();
    const rows = [...this.notes.entries()].map(([key, note]) => {
      const who = this.publisher(note.publisherId, list);
      return {
        key,
        publisherName: who.name,
        publisherGone: who.gone,
        publisherKnown: who.known,
        at: note.at,
        chars: note.value.length,
      };
    });
    return { ok: true, value: rows };
  }

  private totalChars(): number {
    let n = 0;
    for (const [key, note] of this.notes) n += key.length + note.value.length;
    return n;
  }

  private entryFor(
    key: string,
    note: StoredNote,
    list: readonly SessionSummary[] | null
  ): BlackboardEntry {
    const who = this.publisher(note.publisherId, list);
    return {
      key,
      value: note.value,
      publisherId: note.publisherId,
      publisherName: who.name,
      publisherGone: who.gone,
      publisherKnown: who.known,
      at: note.at,
    };
  }

  /** The session list, or `null` if we could not get one (P6 — never throws). */
  private sessionList(): readonly SessionSummary[] | null {
    try {
      const got = this.deps.sessions();
      return got.ok ? got.value : null;
    } catch {
      return null;
    }
  }

  /**
   * Who published, as things stand NOW.
   *
   * Fail-open (P6): a session list that is unavailable, or a publisher that has
   * gone, must not cost the reader the note. It costs them the name.
   *
   * ⚠️ THREE STATES, NOT TWO, and review caught this collapsed into two. When
   * the list is unavailable we do not know whether the publisher is running —
   * and the old code answered `gone: false`, which the renderer reads as "still
   * there, go ahead and ask it". A failed read of OUR OWN state became a
   * positive claim about a sibling's. `known: false` is the honest third answer,
   * and the renderer says it in words.
   */
  private publisher(
    publisherId: string,
    list: readonly SessionSummary[] | null
  ): { name: string; gone: boolean; known: boolean } {
    if (!list) return { name: publisherId, gone: false, known: false };
    const found = list.find((s) => s.id === publisherId);
    // `exited` rather than a status word, for the reason `renderSessions`
    // carries the same check: a clean exit is `status: 'done'`, which a finished
    // turn also gets, so the status alone cannot tell them apart.
    if (!found) return { name: publisherId, gone: true, known: true };
    return { name: found.name, gone: found.exited === true, known: true };
  }
}
