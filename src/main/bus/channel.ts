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
 * The host now refuses an unknown version, so #764 widening the payload is a
 * change both ends must agree on rather than one that half-works.
 */
export const CHANNEL_VERSION = 1;

/**
 * The operations the host answers.
 *
 * Deliberately the SAME strings as the MCP tool names — an agent-visible tool
 * and its host-side op are one concept, and giving them separate vocabularies
 * would mean a mapping table that can be wrong. #764 and #765 add
 * `get_session_output`, `get_session_diff` and `send_to_session` here.
 */
export const BUS_OPS = ['list_sessions'] as const;

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
