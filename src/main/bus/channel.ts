// The CHILD↔HOST wire contract (P2-E11-02) — the one definition both ends read.
//
// Split out of `pipe-client.ts` after review: the op name was being derived at
// the child end from the MCP tool name and compared at the host end against a
// duplicated string literal. That is two independent declarations of one
// contract, which is the drift `sessions/queries.ts` exists to prevent one
// level up — and #764 adds three more ops, so it is the moment to fix it.
//
// Node builtins only: this module is imported by the child bundle, which runs
// under ELECTRON_RUN_AS_NODE and may not touch Electron, IPC or the query core.

/**
 * Payload version, checked at the host.
 *
 * It was decorative until review pointed out that nothing read it — a stamp no
 * receiver inspects is a compatibility story, not a compatibility mechanism.
 * The host now refuses an unknown version, so widening the payload is a change
 * both ends must agree on rather than one that half-works.
 *
 * ⚠️ **STILL 1 AFTER #764, DELIBERATELY, AND THAT IS THE INTERESTING PART.**
 * That item added two ops and the note above had been read as "so bump it".
 * Bumping would have been the wrong move: a v1 child meeting a v2 host fails
 * EVERY call, including the `list_sessions` that works perfectly — whereas
 * leaving it alone costs a v1 child nothing and a v2 child one readable
 * "unknown request" from `isBusOp` if it ever met a v1 host. Adding a word to
 * the vocabulary is backwards-compatible by construction; this gate is for a
 * change to the ENVELOPE — renaming `token`, moving `op`, changing the framing
 * — where there is no graceful degradation to fall back on.
 */
export const CHANNEL_VERSION = 1;

/**
 * The operations the host answers.
 *
 * Deliberately the SAME strings as the MCP tool names — an agent-visible tool
 * and its host-side op are one concept, and giving them separate vocabularies
 * would mean a mapping table that can be wrong.
 *
 * `send_to_session` (#765) is the first op that WRITES, and it went in without
 * touching `CHANNEL_VERSION` for the reason that constant's comment gives.
 */
export const BUS_OPS = [
  'list_sessions',
  'get_session_output',
  'get_session_diff',
  'send_to_session',
] as const;

export type BusOp = (typeof BUS_OPS)[number];

export function isBusOp(op: unknown): op is BusOp {
  return typeof op === 'string' && (BUS_OPS as readonly string[]).includes(op);
}

/** What a child sends. The token comes from a 0600 file, never from argv (S-03). */
export interface BusRequest {
  v: number;
  token: string;
  op: string;
  /** The MCP tool's own arguments, passed through. Empty for `list_sessions`. */
  args?: Record<string, unknown>;
}

/**
 * The argument name every session-addressing tool uses.
 *
 * One constant rather than the string typed into a schema, a renderer and a
 * host handler: those are three independent declarations of one contract, and
 * a rename in two of the three is a tool that silently resolves `undefined` —
 * which `SessionQueries.resolve` refuses with "session reference must be a
 * string", pointing the reader at the model rather than at us.
 */
export const SESSION_ARG = 'session';

/** `send_to_session`'s text argument — one constant for the same reason. */
export const MESSAGE_ARG = 'message';
