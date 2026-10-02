// Branch and sync, from the renderer (E24 Git v2 item 15).
//
// ⚠️ **THE THREE NETWORK VERBS ARE THE ONLY THINGS IN THIS APP THAT REACH OUT ON
// THE USER'S CREDENTIALS, and the surface has to behave accordingly:** they can
// take a while (somebody else's server is the bound), so a button that does not
// show it is busy will be pressed again — and a second `push` while the first is
// in flight is two pushes.
//
// ⚠️ **AND `pull` CANNOT HALF-HAPPEN.** Main runs it `--ff-only`, so it either
// works completely or changes nothing and says why. That is what lets this be one
// button instead of a merge surface we do not have.
import { answered } from '../../../shared/ipc/refusal';
import type { WriteOutcome } from './git-write';

interface SyncBridge {
  fetch?: (folder: string) => Promise<unknown>;
  pull?: (folder: string) => Promise<unknown>;
  push?: (folder: string, opts?: { setUpstream?: boolean }) => Promise<unknown>;
  checkout?: (folder: string, branch: string) => Promise<unknown>;
  createBranch?: (folder: string, name: string, from?: string) => Promise<unknown>;
}

/** `globalThis`, not `window` — the note every module in this family carries. */
function bridge(): SyncBridge | undefined {
  return (globalThis as { switchboard?: { git?: SyncBridge } }).switchboard?.git;
}

/**
 * Can this build sync at all?
 *
 * All five or none, for the reason every `can*` in this epic is all-or-nothing:
 * a build with `push` and no `pull` would draw a ↓ that cannot work, which is the
 * owner's rule about a control that does nothing.
 */
export function canSync(): boolean {
  const g = bridge();
  return (
    typeof g?.fetch === 'function' &&
    typeof g?.pull === 'function' &&
    typeof g?.push === 'function' &&
    typeof g?.checkout === 'function' &&
    typeof g?.createBranch === 'function'
  );
}

const NO_BRIDGE: WriteOutcome = {
  ok: false,
  applied: 0,
  reason: 'this build of switchboard cannot reach a remote',
};

async function run(call: Promise<unknown> | undefined): Promise<WriteOutcome> {
  if (!call) return NO_BRIDGE;
  try {
    const out = answered(await call) as WriteOutcome | undefined;
    if (!out || typeof out.ok !== 'boolean') {
      return { ok: false, applied: 0, reason: 'switchboard was not allowed to do that' };
    }
    return out;
  } catch {
    return { ok: false, applied: 0, reason: 'switchboard could not reach git' };
  }
}

export function fetchRemote(folder: string): Promise<WriteOutcome> {
  const g = bridge();
  return run(folder && g?.fetch ? g.fetch(folder) : undefined);
}

export function pullRemote(folder: string): Promise<WriteOutcome> {
  const g = bridge();
  return run(folder && g?.pull ? g.pull(folder) : undefined);
}

/**
 * Push.
 *
 * ⚠️ **`setUpstream` IS A SECOND, EXPLICIT PRESS AND NEVER AN AUTOMATIC RETRY.**
 * A push that failed for want of an upstream is a different thing from one that
 * failed because somebody else pushed first — and quietly adding the flag would
 * PUBLISH a branch the user had not decided to publish. The surface offers it as
 * its own action once git has said that is what is missing.
 */
export function pushRemote(folder: string, opts: { setUpstream?: boolean } = {}): Promise<WriteOutcome> {
  const g = bridge();
  return run(folder && g?.push ? g.push(folder, opts) : undefined);
}

export function checkoutBranch(folder: string, branch: string): Promise<WriteOutcome> {
  const g = bridge();
  return run(folder && branch && g?.checkout ? g.checkout(folder, branch) : undefined);
}

export function createBranch(folder: string, name: string, from?: string): Promise<WriteOutcome> {
  const g = bridge();
  return run(folder && name && g?.createBranch ? g.createBranch(folder, name, from) : undefined);
}

/**
 * Did git refuse a push only because the branch has no upstream?
 *
 * ⚠️ **MATCHED ON GIT'S OWN WORD, AND THAT IS A DEPENDENCY WORTH NAMING.** git
 * says *"The current branch <name> has no upstream branch"* and then suggests
 * `--set-upstream` itself. Reading that is how the surface knows to offer the
 * second press rather than making the user guess — and if a future git rewords
 * it, the consequence is that the offer stops appearing, not that anything
 * breaks. A wrong match in the other direction would be worse, which is why the
 * pattern is the distinctive phrase rather than a loose "upstream".
 */
export function needsUpstream(reason: string | undefined): boolean {
  return typeof reason === 'string' && /no upstream branch/i.test(reason);
}
