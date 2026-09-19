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
// and any session may overwrite any key, which is why every answer carries the
// publisher — see `main/sessions/blackboard.ts` for why that wording was
// narrowed from the broader claim it started as.

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

/** The argument names. One constant per word, read by schema, host and tests. */
export const KEY_ARG = 'key';
export const VALUE_ARG = 'value';
