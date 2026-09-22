// #719 — how many processes the app itself has running, by who started them.
//
// The laptop showed 122 `node.exe` at idle and nobody could say whose they
// were. The process census (`process-census.ts`) counts the whole machine;
// this counts OUR share, and it needs no enumeration because we were there at
// every spawn. Read together on the heartbeat line: if our count is small and
// the machine's is huge, someone else is doing the spawning.
//
// Counted per child we HOLD. On Windows that is often a launcher (see
// `transport/kill-tree.ts`), so this is "invocations alive", not "images
// alive". A launcher that died while its child lives on is exactly what this
// cannot see, and it is the census's job.
//
// Deliberately electron-free and logger-free, like the transport services that
// call it: `lifecycle-check` and friends load those under plain Node.
import type { ChildProcess } from 'child_process';

export type ChildKind = 'stream' | 'git' | 'oneshot';

const live: Record<ChildKind, number> = { stream: 0, git: 0, oneshot: 0 };

/**
 * Count `child` as alive until it exits. Call it right after a spawn that
 * returned, and never for one that threw: that child does not exist.
 *
 * Released on the FIRST of `exit` or `error`, once. `error` can arrive instead
 * of `exit` (spawn failed) or after it (a kill that failed), and counting either
 * twice would drift the number below zero for the life of the process.
 */
export function trackChild(kind: ChildKind, child: ChildProcess): void {
  live[kind]++;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    live[kind]--;
  };
  child.once('exit', release);
  child.once('error', release);
}

/** A snapshot, so a caller cannot write through to the live counts. */
export function liveChildren(): Record<ChildKind, number> {
  return { ...live };
}
