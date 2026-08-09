// How the IPC BROKER says no (#346, §5.23, following #326 and #347).
//
// `main/ipc/broker.ts` refuses a call whose caller does not hold the channel's
// capability. It used to refuse by THROWING `refused: <channel>`, which arrives
// in the caller as a rejected promise. Unreachable today — our one renderer is
// granted every capability — but the whole reason the broker exists is Phase 4,
// and the day a plugin holds a partial grant, a refused call becomes an
// unhandled rejection inside third-party code. That is the exact class #326
// removed from `groups:*` and #347 from `sessions:*`; the broker was the last
// place in the app that still refused by throwing.
//
// So: a refused `invoke` RESOLVES with the object below, and never rejects.
//
// WHY THIS SHAPE, and not the two obvious alternatives.
//
//   * NOT bare `null`, which is what #326 and #347 answer. That works for a
//     HANDLER, because a handler knows what null means for its own channel and
//     so does its caller. The broker is GENERIC: it does not know whether
//     `null` is a real answer for `groups:list`, and for `groups:update`,
//     `pty:attach` and `sessions:create` — all of which answer `null` for
//     ordinary reasons — a bare null refusal is literally indistinguishable
//     from a successful call. A caller told `null` cannot tell "you may not do
//     that" from "there was nothing to do", which is the one thing the refusal
//     has to communicate. #355 made the same observation about #347's null: it
//     carries nothing, so nobody downstream can say WHY.
//
//   * NOT `{ ok: false, reason }`, the shape that looks natural. It is already
//     TAKEN: `sessions:setTransport` legitimately answers
//     `{ ok: false, reason: 'unknown-card' }` from its own handler. A refusal
//     wearing that shape would be indistinguishable from that handler's answer
//     on the one channel that uses it — the same collision as bare null, with
//     more ceremony. Hence a namespaced brand no handler in the app returns:
//     `refusal.test.ts` asserts the brand appears in no other production
//     source file. It cannot see runtime-derived payloads, and there is one
//     residual worth knowing — `workspace:getLayout` / `workspace:getUi`
//     answer arbitrary JSON read off disk, so a hand-edited `workspace.json`
//     with the brand at its root would read as a refusal. Only our own
//     renderer writes that file, and anyone who can edit it can do worse.
//
//   * NOT an envelope on every reply (`{ok:true, value} | {ok:false, …}`).
//     That is the only shape that makes a refusal impossible to miss, and it
//     costs a rewrite of every one of the ~60 preload signatures and every
//     renderer call site — to guard a branch that no shipped caller can reach.
//     The brief for this item was explicit that no currently-working call may
//     change its observed behaviour. Success PASSES THROUGH the broker
//     untouched; only the refusal is a new value.
//
// WHAT IT MEANS FOR THE DECLARED TYPES. The preload's per-channel return types
// describe what the HANDLER answers, and they stay exactly true for the
// first-party renderer, which holds every capability and therefore cannot be
// refused. They are not widened by `| IpcRefusal`: doing that would force ~60
// signatures and every call site to branch on a value none of them can receive.
// The obligation lands where the refusal can actually appear — a Phase-4
// caller with a partial grant — and it is ONE obligation in ONE place: the
// plugin bridge checks `isIpcRefusal` once, centrally, and turns it into
// whatever that API's error model is. That is the whole argument for a brand
// over a bare null: a generic layer can DETECT this, and cannot detect null.
// Contract recorded in `docs/extensibility.md` → "How the broker refuses".

/** Why a call was refused. Coarse on purpose — see `IpcRefusal.reason`. */
export type IpcRefusalReason =
  /** the caller holds a grant, but not the capability this channel needs */
  | 'capability-not-held'
  /** the caller has no grant at all — a window we never granted, or one we did not create */
  | 'not-granted'
  /**
   * The channel is not in `CHANNEL_CAPABILITIES`, so it cannot be judged — a
   * wiring bug rather than a permission problem. RESERVED: `broker.handle`
   * takes a `StaticChannel`, so a registered channel is tagged by
   * construction and no caller can be answered this today. It exists because
   * the decision inside the broker has three branches and a reason code that
   * lied about which one fired would be worse than a code nobody receives —
   * but a Phase-4 host should not write a branch expecting it.
   */
  | 'unknown-channel';

/** The brand. A plain data key, so it survives structured clone intact. */
export const IPC_REFUSAL_BRAND = '__ipcRefused';

/**
 * What a refused `invoke` resolves with.
 *
 * Deliberately a plain, JSON-shaped object: everything crossing the IPC
 * boundary is structured-cloned, so a class instance would arrive as a bare
 * object with its prototype gone and an `instanceof` check would silently be
 * false on the other side. That is also why the old throw was useless to a
 * caller — an `Error` reaches the renderer as a string with
 * `Error invoking remote method '…'` glued to the front.
 *
 * `reason` is a coarse code and does NOT name the missing capability. Not
 * secrecy — the channel → capability map is in this same shared folder and
 * ships to every caller, so a host that wants the name calls
 * `capabilityFor(channel)` itself. It is the smallest payload that lets a
 * caller act, and adding a field later is not a breaking change while removing
 * one is.
 */
export interface IpcRefusal {
  readonly [IPC_REFUSAL_BRAND]: true;
  /** the channel that was refused, for the caller's own log line */
  readonly channel: string;
  readonly reason: IpcRefusalReason;
}

/** Build one. The broker is the only thing that should call this. */
export function ipcRefusal(channel: string, reason: IpcRefusalReason): IpcRefusal {
  return { [IPC_REFUSAL_BRAND]: true, channel, reason };
}

/**
 * Is this value the broker refusing, rather than a handler answering?
 *
 * Checks the brand and nothing else. Requiring `channel` and `reason` to be
 * well-formed too would mean a truncated or half-cloned refusal fell through
 * as a legitimate VALUE — refusals must fail towards "this was refused", never
 * away from it.
 */
export function isIpcRefusal(value: unknown): value is IpcRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[IPC_REFUSAL_BRAND] === true
  );
}
