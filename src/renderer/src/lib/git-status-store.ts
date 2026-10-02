// ONE git status per folder, shared (E24 Git v2 item 11, §5.7).
//
// ⚠️ **THE ITEM'S OWN ACCEPTANCE BAR IS "THE SAME STATUS SOURCE", AND THIS IS
// WHAT MAKES THAT TRUE.** Design §4 item 11: *"it must read the **same** status
// source as screen 1 or the two tabs will disagree."* Before this, the Changes
// tab fetched its own status and the card header fetched another — two reads, two
// moments, and nothing to stop them disagreeing. Adding a THIRD reader in the
// Files tab would have made "the tabs disagree" a question of timing rather than
// of design.
//
// So: one fetch per folder, cached, with subscribers. The Changes tab and the
// Files tab read the same object, so a file can never be modified in one tab and
// clean in the other.
//
// ⚠️ **A MODULE, NOT A CONTEXT, AND NOT A PROP.** `FileTree` is deliberately
// placement-agnostic — four props and a callback, no card, no panel, no dockview
// (its header states that as a requirement of the item that built it). Threading
// a status down to it would have been a fifth prop through a host that exists to
// have none. The seam is the same shape as `lib/document-open`'s and
// `lib/diff-open`'s.
//
// FAIL-OPEN: a refusal or a rejection leaves the last good answer standing and
// reports nothing. The Files tab's job is to list files; decorations are a
// decoration, and a tree that blanked because git was slow would be our breakage
// costing a session.
import { answered } from '../../../shared/ipc/refusal';
import type { GitStatusDto } from './git-status';

/** What a reader gets. `null` means nothing has been learned yet. */
export type GitStatusEntry = GitStatusDto | null;

interface Cached {
  status: GitStatusEntry;
  /** a fetch is in flight, so a second reader does not start another */
  pending: boolean;
  /** bumped per fetch, so a superseded answer is dropped */
  round: number;
}

const cache = new Map<string, Cached>();
const listeners = new Set<() => void>();

/**
 * Ask for the per-file `+/−` as well.
 *
 * ⚠️ **ONCE ANY READER WANTS THEM, EVERY READER GETS THEM**, and that is the
 * correct direction for the trade: the numbers cost two extra `git diff`
 * invocations (measured — see `GitStatus.stats`), and the Files tab does not draw
 * them. But a shared cache that answered one reader with stats and another
 * without would mean the second reader's answer depended on whether the first had
 * mounted, which is a worse bug than one spare pair of diffs.
 */
let wantStats = false;

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Subscribe to every folder's status. Returns the unsubscribe. */
export function subscribeGitStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The last answer for `folder`, or `null`. Never triggers a fetch. */
export function getGitStatus(folder: string | undefined): GitStatusEntry {
  if (!folder) return null;
  return cache.get(folder)?.status ?? null;
}

/**
 * Make sure `folder`'s status is being fetched, and fetch it again on `force`.
 *
 * ⚠️ **IDEMPOTENT WITHOUT `force`.** Two tabs mounting on one folder in the same
 * frame must produce ONE `git status`, not two — which is the whole reason this
 * module exists, and the thing a naive `useEffect` in each component gets wrong.
 */
export function refreshGitStatus(
  folder: string | undefined,
  opts: { force?: boolean; stats?: boolean } = {}
): void {
  if (!folder) return;
  if (opts.stats) wantStats = true;
  const held = cache.get(folder) ?? { status: null, pending: false, round: 0 };
  if (held.pending && !opts.force) {
    cache.set(folder, held);
    return;
  }
  if (held.status !== null && !opts.force && !held.pending) {
    // Already answered and nobody asked again. A reader that wants fresher data
    // passes `force` — which is what the ⟲ button and the visibility flip do.
    cache.set(folder, held);
    return;
  }
  /**
   * ⚠️ **THE BRIDGE MAY NOT BE THERE, AND REACHING THROUGH IT WAS A THROW.**
   * `window.switchboard` is installed by the preload, so a module-level reader can
   * run before it exists — and in a unit test that has not stubbed one it is
   * simply absent. Three `FileTree` tests went from passing to
   * `Cannot read properties of undefined` the moment this store was wired in, and
   * that is the test suite catching a real fail-open gap rather than a test
   * problem: a tree whose job is to list files must not die because the git bridge
   * is late. No bridge means no decorations, which is a tree that works exactly as
   * it did before this item.
   */
  // ⚠️ `globalThis`, NOT `window`, AND IT IS NOT A STYLE CHOICE — the same note
  // `lib/document-panels.ts` carries. This module is pure enough that its own
  // tests run in vitest's NODE environment, where a bare `window` is a
  // `ReferenceError` rather than an undefined, so naming it here would make every
  // test a crash. In the renderer the two are the same object.
  const bridge = (
    globalThis as {
      switchboard?: { git?: { status?: (folder: string, withStats?: boolean) => Promise<unknown> } };
    }
  ).switchboard?.git;
  if (typeof bridge?.status !== 'function') return;
  const round = held.round + 1;
  cache.set(folder, { ...held, pending: true, round });
  void bridge
    .status(folder, wantStats)
    .then((raw) => {
      const current = cache.get(folder);
      // A superseded fetch is DROPPED rather than written over a fresher one —
      // the same guard every reader of this channel has carried since #562.
      if (!current || current.round !== round) return;
      const next = answered(raw) as GitStatusDto | undefined;
      // Fail-open: a refusal teaches nothing, so the last good answer stands.
      cache.set(folder, { status: next ?? current.status, pending: false, round });
      notify();
    })
    .catch(() => {
      const current = cache.get(folder);
      if (!current || current.round !== round) return;
      cache.set(folder, { ...current, pending: false });
      notify();
    });
}

/** Test seam — a fresh renderer knows nothing, and neither should a test. */
export function resetGitStatusStore(): void {
  cache.clear();
  listeners.clear();
  wantStats = false;
}

/**
 * Write a status in directly.
 *
 * For the ONE caller that already has a fresher answer than the store: the
 * Changes tab, whose own ⟲ fetches with stats and would otherwise have to ask
 * twice. Not a general back door — it exists so that the two tabs share a
 * moment rather than merely sharing a shape.
 */
export function putGitStatus(folder: string | undefined, status: GitStatusDto): void {
  if (!folder) return;
  const held = cache.get(folder) ?? { status: null, pending: false, round: 0 };
  cache.set(folder, { ...held, status, pending: false });
  notify();
}
