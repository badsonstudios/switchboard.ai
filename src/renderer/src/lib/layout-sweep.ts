// The SWEEP — how §5.8's layout plan actually gets applied (P2-E9-07, #217).
//
// lib/layout-mode answers "where should every card be?"; this answers "how do
// we get there without two answers fighting each other?". They are deliberately
// two files: the first is pure arithmetic over a card list, the second is a
// small state machine over an ASYNC effect, and the bugs they each have are
// nothing alike. Keeping the machine here — rather than as module `let`s beside
// the dockview code that drives it — is what makes its ordering, its abort and
// its coalescing assertable without an Electron window.
//
// It is dockview-free ON PURPOSE. The grid the moves land in rides along on the
// REQUEST (see `SweepPort.applyMove`), so nothing in this file has to know what
// a `DockviewApi` is and the tests hand it plain objects — the same trick
// lib/layout-mode plays with `LayoutCard`.
import type { Ladder } from './presentation';
import type { LayoutMove, LayoutTrigger } from './layout-mode';

/**
 * A sweep somebody asked for: why, and — on the un-maximize path — the exact
 * rungs to put back.
 *
 * `restore` travels WITH the trigger and is never split from it. A queued sweep
 * that kept the trigger and dropped this would re-apply the current mode instead
 * of putting the user's own prior arrangement back, which is the difference
 * between §5.8's "restores the prior layout" and "rearranges the workspace
 * again".
 *
 * Callers extend it with whatever their effects need (SessionGrid adds the
 * `DockviewApi` the moves land in); everything below is generic over that.
 */
export interface SweepRequest {
  readonly trigger: LayoutTrigger;
  readonly restore?: Readonly<Record<string, Ladder>>;
}

/** Everything a sweep touches that is not this file's business. */
export interface SweepPort<Req extends SweepRequest> {
  /**
   * May anything sweep at all right now?
   *
   * Re-asked on every request INCLUDING the drained one, because the reason a
   * sweep is forbidden — teardown, a boot restore still placing panels — is
   * usually something that started while the previous sweep was running.
   */
  ready(): boolean;
  /**
   * Would this request produce any work? The cheap early-out, asked before the
   * card list is built: reactive triggers arrive on every status push (several a
   * second while agents stream) and under the default mode there is nothing for
   * any of them to do.
   */
  needed(req: Req): boolean;
  /** The moves to make. Computed HERE, at the moment the sweep runs, never at
   *  the moment it was asked for — see the coalescing note on `createSweeper`. */
  plan(req: Req): readonly LayoutMove[];
  /** Make one move. Awaited; see `runMoves`. */
  applyMove(move: LayoutMove, req: Req): Promise<void> | void;
  /**
   * Abandon the rest of the plan (teardown began underneath it).
   *
   * A PROPERTY, not a method shorthand, because this is the one member that
   * gets handed to `runMoves` as a bare reference — and a method declaration
   * says the function may want the `this` it was read off, which is what
   * `unbound-method` objects to (#255 T2, same call as #663). It never has:
   * every implementer already writes `aborted: () => …`, so the signature is
   * type-identical for all of them and only stops promising a `this` that was
   * never used.
   */
  aborted: () => boolean;
  /** Fail-open: a layout mode is a convenience, never a reason to throw out of
   *  an event handler and leave the workspace half-swept. */
  onError(err: unknown): void;
}

export interface Sweeper<Req extends SweepRequest> {
  /**
   * Ask for a sweep. The promise resolves when the workspace has SETTLED —
   * this sweep and anything it drained afterwards.
   *
   * A request that was refused or merely queued is handed THE CHAIN'S promise,
   * not a fresh resolved one, so every caller settles at the same moment the
   * cards stop moving — which is immediately when nothing was running.
   *
   * Nothing in the app awaits it (a layout change is not something a click
   * waits on); the tests do, which is the entire reason it is a promise and not
   * a void.
   */
  request(req: Req): Promise<void>;
}

/**
 * Apply a plan's moves, IN ORDER, ONE AT A TIME.
 *
 * Sequential and awaited is the whole point, not an oversight: a card comes
 * home to the dock slot it remembers (E9-05's reveal contract), so two moves
 * running at once read that slot's group while the other one is still creating
 * — or destroying — it. dockview drops a group when its last panel goes, which
 * is also why lib/layout-mode's `plan` puts every expand before every collapse.
 *
 * `aborted` is checked AFTER each move rather than before: a sweep that has
 * already started a move sees it through, and only then asks whether the world
 * it was moving cards in still exists.
 */
export async function runMoves(
  applyMove: (move: LayoutMove) => Promise<void> | void,
  moves: Iterable<LayoutMove>,
  aborted: () => boolean = () => false
): Promise<void> {
  for (const move of moves) {
    await applyMove(move);
    if (aborted()) return;
  }
}

/**
 * The re-entrancy guard around `runMoves`: one sweep at a time, and AT MOST ONE
 * more queued behind it.
 *
 * Every move awaits, and the reactive triggers arrive in bursts — a status
 * change is one store write, and three sessions finishing inside a second is
 * three. Without this, two sweeps would interleave their reveals and removals
 * and the loser would be applying a plan computed against a workspace that no
 * longer exists.
 *
 * COALESCING TO ONE RE-RUN IS ENOUGH, and that follows from `plan` being asked
 * at run time: the last run always sees the truth, so a third pending request
 * would only recompute the same answer. The one thing the queue does discriminate
 * on is the trigger — a `switch` OUTRANKS a queued `react`, because the user
 * asked for that one and a mode change must not be swallowed by a status push
 * that happened to arrive first.
 */
export function createSweeper<Req extends SweepRequest>(port: SweepPort<Req>): Sweeper<Req> {
  let sweeping = false;
  let queued: Req | null = null;
  // The settle promise spans the WHOLE chain — the running sweep plus whatever
  // it drains — so a caller that awaits one request cannot be handed back a
  // workspace that is about to move again.
  let settled: Promise<void> = Promise.resolve();
  let markSettled: (() => void) | null = null;

  function request(req: Req): Promise<void> {
    if (!port.ready()) return settled;
    if (sweeping) {
      if (req.trigger === 'switch' || !queued) queued = req;
      return settled;
    }
    if (!port.needed(req)) return settled;

    sweeping = true;
    if (!markSettled) settled = new Promise<void>((resolve) => (markSettled = resolve));
    void (async () => {
      try {
        await runMoves((move) => port.applyMove(move, req), port.plan(req), port.aborted);
      } catch (err) {
        port.onError(err);
      } finally {
        sweeping = false;
        const again = queued;
        queued = null;
        try {
          // Re-entering through `request` and not straight into the loop: the
          // drained sweep gets the full fence back (`ready`, `needed`), because
          // the world it was queued in is not the world it is about to run in.
          if (again) void request(again);
        } finally {
          // ...and only when nothing picked the chain up does the chain end.
          // In its own `finally` so a port that throws from `ready`/`needed`
          // cannot strand the chain: an unresolved `settled` would leave every
          // later request awaiting a promise that never lands.
          if (!sweeping) {
            const done = markSettled;
            markSettled = null;
            done?.();
          }
        }
      }
    })();
    return settled;
  }

  return { request };
}
