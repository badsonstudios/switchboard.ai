// Staging, unstaging and discarding, from the renderer (E24 Git v2 item 12).
//
// ⚠️ **THE OWNER'S OWN RULE IS WHY THIS ITEM EXISTS AT ALL**: *"a row with a `＋`
// that does nothing is worse than a row with no `＋`"*. The mockup draws stage and
// discard on every row, so the scope was layers 1 AND 2 together, and until now
// those two verbs have been ABSENT from the slot that holds the other three.
//
// ⚠️ **AND DISCARD IS THE ONLY OPERATION IN SWITCHBOARD THAT CAN DESTROY WORK NO
// OTHER COPY OF EXISTS.** An untracked file that is cleaned is gone — not in the
// index, not in a commit, not in a reflog. Everything about how this module is
// shaped follows from that one fact:
//
//  * **the confirm is mandatory and names the count**, because "discard" on a
//    group heading can mean forty files and the heading does not say so;
//  * **the status is re-read in MAIN**, so what gets deleted is decided from
//    git's own answer rather than from a renderer list that is a moment old;
//  * **a refusal is reported, never swallowed.** A write that silently did
//    nothing would have the surface keep drawing the change it thinks it removed.
import { answered } from '../../../shared/ipc/refusal';

/** What a write did, mirroring `GitWriteResult` in main. */
export interface WriteOutcome {
  ok: boolean;
  /** git's own words where we have them — see main on why they are not ours */
  reason?: string;
  applied: number;
}

type WriteFn = (folder: string, paths: readonly string[]) => Promise<unknown>;

/** What the ⋯ offers — modifiers of the one commit path, never a second one. */
export interface CommitFlags {
  amend?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
}

type CommitFn = (folder: string, message: string, opts?: CommitFlags) => Promise<unknown>;

interface GitWriteBridge {
  stage?: WriteFn;
  unstage?: WriteFn;
  discard?: WriteFn;
  commit?: CommitFn;
}

/**
 * The bridge, through `globalThis`.
 *
 * ⚠️ `globalThis`, NOT `window` — the note `lib/git-status-store.ts` and
 * `lib/document-panels.ts` both carry: this module is pure enough that its tests
 * run in vitest's NODE environment, where a bare `window` is a `ReferenceError`
 * rather than an undefined. In the renderer the two are the same object.
 */
function bridge(): GitWriteBridge | undefined {
  return (globalThis as { switchboard?: { git?: GitWriteBridge } }).switchboard?.git;
}

/**
 * Can this build change a repository at all?
 *
 * The preload may not have installed yet, and a future build could ship without
 * the write channels. Either way the answer is the same and it is the owner's
 * rule: the buttons are ABSENT rather than drawn dead.
 */
export function canWriteGit(): boolean {
  const g = bridge();
  return (
    typeof g?.stage === 'function' &&
    typeof g?.unstage === 'function' &&
    typeof g?.discard === 'function'
  );
}

const NO_BRIDGE: WriteOutcome = {
  ok: false,
  applied: 0,
  reason: 'this build of switchboard cannot change a repository',
};

/** One call, with `answered()` and a catch — the shape every consumer uses. */
async function run(fn: WriteFn | undefined, folder: string, paths: readonly string[]): Promise<WriteOutcome> {
  if (typeof fn !== 'function' || !folder || paths.length === 0) return NO_BRIDGE;
  try {
    const raw = await fn(folder, paths);
    // ⚠️ **`answered()` BEFORE THE CAST (#650), AND IT MATTERS MORE ON A WRITE.**
    // A channel can answer with a REFUSAL instead of its payload, and a refusal
    // read as a value would be `undefined.ok` — or worse, a surface reporting
    // success for something that never ran.
    const out = answered(raw) as WriteOutcome | undefined;
    if (!out || typeof out.ok !== 'boolean') {
      return { ok: false, applied: 0, reason: 'switchboard was not allowed to run that' };
    }
    return out;
  } catch {
    // A rejected invoke is not a refusal and `answered` never sees it: a handler
    // that threw, a window torn down mid-call. Fail-open means SAYING so, not
    // pretending it worked.
    return { ok: false, applied: 0, reason: 'switchboard could not reach git' };
  }
}

export function stageFiles(folder: string, paths: readonly string[]): Promise<WriteOutcome> {
  return run(bridge()?.stage, folder, paths);
}

export function unstageFiles(folder: string, paths: readonly string[]): Promise<WriteOutcome> {
  return run(bridge()?.unstage, folder, paths);
}

/**
 * ⚠️ **DESTRUCTIVE. THE CALLER MUST HAVE CONFIRMED.**
 *
 * Not enforced here, and that is deliberate rather than lax: a confirm is a
 * question for a human, so it belongs to the surface that has one in front of it
 * — and a `confirm` buried in a module would be unmockable, untestable and
 * impossible to word in context. What this module owes is that the operation is
 * named clearly enough that no caller can reach it by accident, and
 * `confirmDiscard` below is the wording every caller shares.
 */
export function discardFiles(folder: string, paths: readonly string[]): Promise<WriteOutcome> {
  return run(bridge()?.discard, folder, paths);
}

/**
 * What the confirm has to say.
 *
 * ⚠️ **IT NAMES THE COUNT, AND FOR MORE THAN ONE FILE IT NAMES NOTHING ELSE.**
 * Design §4 item 12: *"Discard is destructive: confirm, naming the file count."*
 * A dialog reading "Discard changes?" over a group heading can mean forty files,
 * and the heading does not say which. One file gets its name, because that is the
 * most useful thing to be told; many get a count, because a list of forty names
 * in a dialog is a wall nobody reads.
 *
 * Returned as a KEY plus values rather than a sentence, so the catalog owns the
 * words and the plural is ICU's problem rather than ours.
 */
/**
 * Can this build commit?
 *
 * ⚠️ **ASKED SEPARATELY FROM `canWriteGit`, EVEN THOUGH ONE CAPABILITY COVERS
 * BOTH.** They are different surfaces: the row buttons and the commit box appear
 * and disappear independently, and a build with the three path verbs and no
 * `commit` would otherwise draw a Commit button that cannot work — the owner's
 * rule, which this whole layer exists to honour.
 */
export function canCommit(): boolean {
  return typeof bridge()?.commit === 'function';
}

/**
 * Make a commit.
 *
 * ⚠️ **THE EMPTY-MESSAGE CHECK IS HERE *AND* IN MAIN *AND* IN GIT, and that is
 * three on purpose.** Git's is the real one (measured: *"Aborting commit due to
 * empty commit message"*). Main's is so a bad IPC payload cannot reach argv.
 * This one is so the BUTTON can be disabled — which is the difference between a
 * surface that tells you the rule and one that lets you break it and then
 * complains.
 */
export async function commitChanges(
  folder: string,
  message: string,
  flags: CommitFlags = {}
): Promise<WriteOutcome> {
  const fn = bridge()?.commit;
  if (typeof fn !== 'function' || !folder) return NO_BRIDGE;
  if (message.trim() === '') return { ok: false, applied: 0, reason: 'a commit needs a message' };
  try {
    const out = answered(await fn(folder, message, flags)) as WriteOutcome | undefined;
    if (!out || typeof out.ok !== 'boolean') {
      return { ok: false, applied: 0, reason: 'switchboard was not allowed to commit' };
    }
    return out;
  } catch {
    return { ok: false, applied: 0, reason: 'switchboard could not reach git' };
  }
}

/**
 * Is there anything for a commit to capture?
 *
 * ⚠️ **AMEND IS THE EXCEPTION AND IT IS NOT A SPECIAL CASE, IT IS THE COMMONEST
 * USE.** Measured: `commit --amend` with an empty index succeeds — it replaces
 * the message — and fixing a message you just wrote is the main reason anyone
 * reaches for amend. A button disabled on "nothing staged" would make that
 * impossible.
 */
export function hasSomethingToCommit(stagedCount: number, flags: CommitFlags): boolean {
  return flags.amend === true || stagedCount > 0;
}

export function confirmDiscard(paths: readonly string[]): {
  key: string;
  values: { count: number; file: string };
} {
  return {
    key: paths.length === 1 ? 'scm.discardOneConfirm' : 'scm.discardManyConfirm',
    values: { count: paths.length, file: paths[0] ?? '' },
  };
}
