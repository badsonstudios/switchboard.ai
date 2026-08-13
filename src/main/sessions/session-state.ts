// Who deletes a session's on-disk state (#290).
//
// WHAT IS THERE. Every session switchboard starts gets one directory,
// `<userData>/sessions/<sessionId>/`, and exactly two files land in it:
//
//   * `settings.json` — written by the provider adapter (`providers/claude.ts`
//     `writeSessionSettings`, and `providers/fake-stream.ts` through the same
//     function) and handed to the CLI as `--settings <path>` at spawn;
//   * `hook-token` — written by `HookListener.registerSession`.
//
// Nothing else writes inside one. `stateDir`'s ROOT also holds the generated
// `hook-forwarder.cjs`, which is per-install, not per-session, and is not this
// module's business.
//
// WHAT WAS MISSING. #282 gave `hook-token` an owner: it is deleted when the
// token leaves `HookListener`'s map, and a startup sweep takes the ones a
// previous run left behind. It deliberately stopped there — its own comment
// said so — and the DIRECTORY and the `settings.json` in it stayed nobody's
// job: one directory per session ever started, kept for the life of the
// install. That is the strictly larger half of the same leak, and this module
// is its owner.
//
// THE LIFECYCLE, AND WHY IT IS THIS ONE. The directory is named for the LIVE
// session id, which `SessionManager.create` mints fresh from `randomUUID()` on
// every spawn — including every restart and every resume. So a directory
// belongs to exactly one CLI process and can never be wanted again once that
// process is gone:
//
//   * a RESUME does not read it. The resume identity comes off the transcript
//     and the stream (#404), the replay reads `~/.claude/projects` (#431), and
//     the resumed session is a NEW id that gets its own fresh directory and its
//     own freshly-written `settings.json` from `buildSpawn`. Nothing under
//     `stateDir` survives into the next session by design.
//   * so the right moment is the session's death, not the card's. Deleting on
//     "card forgotten" would keep a dead session's settings file alive for as
//     long as the user leaves the card sitting there, and would miss the case
//     #282 was careful about: a session that exits on its own and is never
//     touched again reaches no card-level teardown at all.
//
// `SessionManager` calls `removeSessionStateDir` at both points a live session
// can end — its `onExit` (the self-exit path) and `remove()` (card close /
// restart, after the transport teardown has been asked for) — which are the
// same two points #282's token delete is reached through. Both are idempotent:
// the second call finds nothing and says nothing.
//
// WHAT IS LEFT FOR THE SWEEP. Two paths still leave a directory behind, and
// they are why `sweepOrphanSessionStateDirs` exists rather than being belt and
// braces: an app quit with sessions still running (the kill goes out, the
// exits do not come back before the process is gone), and a crash or a
// force-quit. The third — a spawn that THROWS, which leaves a complete
// directory because `buildSpawn` writes the settings file before there is a
// process — is taken by `create()`'s own catch, since nothing else ever runs
// for that id again.
//
// FIXTURES ONLY IN TESTS. Every test in this module's suite points `stateDir`
// at a registered temp directory (`src/test-temp-dirs.ts`). Nothing in a test
// may be aimed at a real per-user state directory — the run-10 incident behind
// `withTempDirAt`'s comment (a sweeper pointed at a live `%TEMP%`, ~81,600
// directories gone) is what that rule is made of.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';

/**
 * The shape `SessionManager.create` mints — `crypto.randomUUID()`, which is
 * always lower-case RFC 4122 — and the ONLY name this module will delete.
 *
 * Shape, not a list, is #354's convention and here it is doing two jobs.
 *
 * For the sweep it is the filter: `hook-forwarder.cjs` sits in the same root, a
 * user (or a support session) can put anything beside it, and a name that is
 * not a UUID was not made by us. For the targeted removal it is a GUARD on a
 * recursive delete whose path is built from a string: `''`, `'.'`, `'..'` and
 * anything carrying a separator cannot match, so there is no id — however it
 * was arrived at — that turns `removeSessionStateDir` into a delete of
 * `stateDir` itself or of something above it.
 *
 * The cost of the guard is that a session id from outside `create()` (a probe
 * in `hooks/hook-check.ts`, a hand-written test id) is silently not cleaned up.
 * That is the right way round: production has exactly one producer of these
 * directories and it always uses `randomUUID`.
 *
 * Two details that look like style and are not:
 *
 *   * NO `/i`. `randomUUID()` is lower-case, so upper case is not something we
 *     wrote — and on a case-sensitive filesystem accepting it would mean
 *     deleting a directory that is definitively somebody else's.
 *   * `$(?![\s\S])` rather than `$`, because JavaScript's `$` also matches
 *     BEFORE a trailing newline: `<uuid>\n` is a legal directory name on POSIX
 *     and a plain `$` would have made it a candidate.
 */
const SESSION_DIR_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/;

/** Exported for the tests that pin the guard, not for call sites. */
export function isSessionStateDirName(name: string): boolean {
  return SESSION_DIR_NAME.test(name);
}

/**
 * 24 h, mirroring `scripts/sweep-temp-orphans.js`.
 *
 * READ THE SWEEP'S COMMENT BEFORE TREATING THIS AS A SAFETY MECHANISM. In the
 * temp sweeper the age floor IS the concurrency story. Here it is not, and it
 * cannot be: a session left running for two days has a directory older than
 * this the whole time. What makes the sweep safe is that it runs at startup
 * behind `app.requestSingleInstanceLock()` (#289), when no session of ours
 * exists and no second instance can be running — the same argument
 * `HookListener.sweepOrphanTokens` rests on, and the same warning: if the lock
 * ever goes, this sweep has to go with it.
 *
 * What the floor buys is a day of grace for the one thing an age check CAN
 * catch — a directory this run is about to be told to keep, e.g. if a future
 * caller moves the sweep off the bootstrap. It costs one app start's delay in
 * reclaiming a crashed run's leftovers, which nobody can perceive.
 */
export const DEFAULT_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A soft ceiling on how long a sweep may spend, mirroring #354's budget.
 *
 * The pile this drains can be large on a machine that has been dogfooding since
 * before this module existed — one directory per session ever started — and
 * this runs synchronously on the bootstrap path. Whatever the budget does not
 * reach is still there for the next start, and the pile only ever shrinks.
 */
export const DEFAULT_SWEEP_BUDGET_MS = 2_000;

/**
 * Delete one session's state directory. Best-effort, never throws (P6).
 *
 * Returns whether there was a directory to remove — for the caller's logging
 * and for the tests; a `false` is the ORDINARY case on the second of the two
 * lifecycle calls, and on every session that never got as far as a spawn.
 *
 * `force: true` makes the ENOENT of that second call a success rather than a
 * warning, which is the whole reason a double-call needs no coordination. The
 * bounded retry covers the ENOTEMPTY/EPERM a virus scanner or an indexer
 * holding one file inside the tree produces on Windows; it is deliberately
 * small (2 × 20 ms) because this runs on the main thread while a card closes.
 */
export function removeSessionStateDir(stateDir: string, sessionId: string, log: Logger): boolean {
  if (!isSessionStateDirName(sessionId)) return false;
  const dir = path.join(stateDir, sessionId);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
    return true;
  } catch (err) {
    // One line and nothing more. A directory that will not go is disk
    // housekeeping — the startup sweep gets it next time — and must never be
    // why a teardown step, a card close or an exit notification fails.
    log.warn('could not remove session state dir', { sessionId, error: String(err) });
    return false;
  }
}

export interface SweepResult {
  /** directories deleted */
  removed: number;
  /** matched the name filter but were kept (too young, or out of budget) */
  kept: number;
  /** matched and were tried, but the delete failed */
  failed: number;
}

/**
 * Drop every session state directory a previous run left behind.
 *
 * SAFE BECAUSE OF WHEN IT RUNS, not because of what it checks. `stateDir` is a
 * fixed path under `userData`, so two instances would be sweeping each other's
 * live sessions; `src/main/index.ts` takes `app.requestSingleInstanceLock()` as
 * the first statement of the bootstrap (#289) and a second instance quits
 * before it can reach this. Within this process the call site is the bootstrap,
 * before any IPC handler is registered, so no session of ours exists yet — the
 * same shape as `HookListener.sweepOrphanTokens`, one directory level up.
 *
 * A live session's directory is therefore never a candidate — but `keep` says
 * so IN THE FUNCTION rather than leaving it a property of the call site. The
 * set is empty at bootstrap, which is the point: the only way this stays true
 * for a future caller that sweeps at some other moment is for the guard to
 * travel with the sweep. An age floor cannot stand in for it (a session left
 * running for two days is older than any floor worth having), and neither can
 * the single-instance lock, which says nothing about THIS process's sessions.
 *
 * A candidate must clear all six, in the order that costs least:
 *   1. it is a direct child of `stateDir` — one `readdir`, no recursion;
 *   2. it is a directory, off the dirent, so a symlink or junction pointing
 *      somewhere interesting answers `false` rather than being followed;
 *   3. its name is a UUID (`SESSION_DIR_NAME`) — which is what keeps
 *      `hook-forwarder.cjs` and anything a human put here out of it;
 *   4. it is not in `keep`;
 *   5. there is budget left (`budgetMs`);
 *   6. it is older than `minAgeMs`.
 *
 * Nothing here throws. A directory it cannot list, stat or delete is counted,
 * named in one log line, and left for the next start.
 */
export function sweepOrphanSessionStateDirs(
  stateDir: string,
  opts: {
    log: Logger;
    /** ids this process is using RIGHT NOW — never candidates, whatever age */
    keep?: ReadonlySet<string>;
    minAgeMs?: number;
    budgetMs?: number;
    /** injected in tests so the age floor can be exercised against a fixture */
    now?: () => number;
  }
): SweepResult {
  const { log } = opts;
  const keep = opts.keep ?? new Set<string>();
  const minAgeMs = opts.minAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_SWEEP_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const result: SweepResult = { removed: 0, kept: 0, failed: 0 };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (err) {
    // Expected on a first run: nothing has made `stateDir` yet. ENOENT is not
    // worth a line; anything else (permissions, EMFILE) is worth exactly one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('could not scan state dir for orphaned session dirs', { error: String(err) });
    }
    return result;
  }

  const startedAt = now();
  let budgetSpent = false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!isSessionStateDirName(e.name)) continue;
    // Before the stat and before the budget: a live session's directory is not
    // "kept for now", it is not ours to consider at all.
    if (keep.has(e.name)) continue;
    // Budget checked BEFORE the stat, so an exhausted sweep stops doing work
    // rather than stopping at the delete.
    if (now() - startedAt >= budgetMs) {
      result.kept++;
      // ONE line, the first time, because `kept` cannot tell the two reasons
      // apart and they mean opposite things to whoever reads the log: "younger
      // than the floor" is the sweep working as designed, "ran out of budget"
      // is the pile not draining as fast as it is filling.
      if (!budgetSpent) {
        budgetSpent = true;
        log.info('session state dir sweep hit its budget — the rest waits for the next start', {
          budgetMs,
        });
      }
      continue;
    }
    const dir = path.join(stateDir, e.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      // vanished between readdir and stat, or unreadable — either way not ours
      // to worry about on this pass
      result.failed++;
      continue;
    }
    if (now() - mtimeMs < minAgeMs) {
      result.kept++;
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
      result.removed++;
    } catch {
      result.failed++;
    }
  }

  if (result.removed > 0 || result.failed > 0) {
    log.info('swept orphaned session state dirs', {
      removed: result.removed,
      kept: result.kept,
      failed: result.failed,
    });
  }
  return result;
}
