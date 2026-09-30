// The blackboard's vocabulary and its caps (P2-E11-06, §5.4) — shared because
// both ends speak them.
//
// SHARED FOR A HARD REASON, not for tidiness: `bus/bus-tools.ts` builds the tool
// descriptions and runs inside the CHILD bundle under `ELECTRON_RUN_AS_NODE`,
// which may import Node builtins and `shared/*` only — never the query core.
// The number an agent is TOLD in a description has to be the number the host
// enforces, and the only way for both ends to read one constant is for it to
// live here. Same shape, same reason, as `sibling-message.ts`'s caps.
//
// ── NOTHING HERE MEANS "SEND IT" ────────────────────────────────────────────
//
// A blackboard entry is left, not delivered. It reaches another session only
// when that session deliberately calls the read tool, so there is no composer,
// no keypress and no submit anywhere on this path — which is precisely what
// keeps it outside §5.4's human-keypress rule rather than an exception to it.
// The litmus statement, stated at the width that is actually true:
// **publishing never causes execution, delivery or notification in another
// session.** It can consume shared capacity (the caps below are workspace-wide)
// and any session may overwrite — or, since #861, REMOVE — any key, which is
// why every answer carries the publisher. See `main/sessions/blackboard.ts` for
// why that wording was narrowed from the broader claim it started as, and for
// why removal is open to every session rather than to the note's author: the
// power to destroy a sibling's note is one overwrite already had, and restricting
// removal to the publisher would have left the key cap a one-way door in the one
// case that reaches it, since the publisher has usually exited by then.

/**
 * The longest key, in characters.
 *
 * A key is an identifier an agent invents and another agent has to guess or
 * discover ("build-status", "schema-decision"). 128 is far above anything
 * usable as a label and far below anything that could be a payload smuggled
 * through the key to dodge the value cap.
 */
export const BLACKBOARD_KEY_CHAR_CAP = 128;

/**
 * The longest value, in characters.
 *
 * Deliberately the same order as `SIBLING_MESSAGE_CHAR_CAP` and
 * `OUTPUT_CHAR_CAP`, and for the identical reason pointed the same way:
 * whatever is stored here eventually lands in a READING agent's context window,
 * so a blackboard that accepted a megabyte would be a tool for destroying the
 * ability of its reader to act on the answer.
 *
 * **Over the cap the publish is REFUSED, never truncated.** A truncated note
 * still reads as a complete one — the sibling-message cap's own argument — and
 * the publishing agent can shorten its own text far better than we can.
 */
export const BLACKBOARD_VALUE_CHAR_CAP = 20_000;

/**
 * How many keys may exist at once, across the whole workspace.
 *
 * The bound on an agent that publishes in a loop with a generated key each
 * time. Overwriting an existing key is always allowed — that is what a
 * scratchpad IS — so a well-behaved pipeline never meets this.
 */
export const BLACKBOARD_MAX_KEYS = 100;

/**
 * …and the ceiling across every entry, keys and values together.
 *
 * `BLACKBOARD_MAX_KEYS` alone would admit 100 × 20,000 = 2 MB of agent-written
 * text held for the life of the app. The same two-bound shape, for the same
 * reason, as `SIBLING_INBOX_CAP` beside `SIBLING_INBOX_CHAR_CAP`.
 */
export const BLACKBOARD_TOTAL_CHAR_CAP = 100_000;

/**
 * How many REMOVED keys are remembered, so a reader can be told a note was
 * taken off rather than never written (#861).
 *
 * ⚠️ THIS EXISTS BECAUSE REMOVAL CREATED A LIE THAT OVERWRITE NEVER COULD.
 * `blackboard_read`'s miss tells an agent the session it is waiting on "may not
 * have got there yet" — true, and the ordinary case. After a removal it is
 * switchboard, in its own voice, advising an agent to keep waiting for
 * something that will never arrive. An overwrite cannot produce that: the
 * reader still gets content, stamped with an author. So the asymmetry is not
 * reach — removal and overwrite reach equally far — it is that removal is the
 * only one whose evidence would otherwise exist ONLY in the transcript of the
 * session that did it.
 *
 * A tombstone is the key, who removed it and when. Never the value: the note is
 * gone, and keeping a shadow copy of it would make "removed" a lie in the other
 * direction.
 *
 * Bounded for `BLACKBOARD_MAX_KEYS`' reason, one shape along — an agent looping
 * on generated keys and removing each one would otherwise grow this for ever.
 * Oldest-first eviction: the board's own insertion order, applied to departures.
 */
export const BLACKBOARD_TOMBSTONE_CAP = 100;

/** The argument names. One constant per word, read by schema, host and tests. */
export const KEY_ARG = 'key';
export const VALUE_ARG = 'value';
