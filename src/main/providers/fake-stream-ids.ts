// The fake stream CLI's conversation ids — ONE PER SPAWN, not one per world (#603).
//
// Until #603 there was a single `FAKE_SESSION_ID` constant and EVERY fake
// Direct session announced it, so every card in an e2e run claimed the SAME
// native conversation. The real CLI cannot produce that state, and the main
// process is full of logic keyed on the native id — #484's orphan-repair sweep,
// #539's duplicate-pointer untangle, adoption, `conversationExists` — so all of
// it saw a run's cards as one conversation. It broke
// `feed-restore-position.spec.ts` twice during #539 (two cards, two folders, one
// id) and it is what surfaced #539's folder-scoping gap. `fake-stream-protocol`
// already says why that matters: a fake missing something the real thing does is
// a fake that hides a bug. The missing something is uniqueness.
//
// DETERMINISTIC, not random. A counter, so a spec can still name the id it
// expects: the Nth fake conversation started under one home is always
// `00000000-fake-4000-8000-<n, zero-padded>`, and the FIRST is byte-for-byte the
// id the old constant had — which is why the single-card specs that assert it
// did not have to change what they assert, only where they read it from.
import fs from 'fs';
import path from 'path';

/**
 * The first four groups of the uuid, fixed so a fake id is recognisable on
 * sight and greppable. `fake` sits where the version nibble would be: nothing
 * we read parses uuids, and it makes an id that leaked into a real
 * `~/.claude/projects` obvious to a human.
 */
const FAKE_ID_PREFIX = '00000000-fake-4000-8000-';

/**
 * The id of the Nth fake conversation (0-based), uuid-SHAPED so it can be a
 * transcript file name and a `session_id` on the wire without any consumer
 * noticing the difference.
 *
 * The counter is the last group's 12 digits, so the ids sort the way they were
 * handed out. `n` is a small integer in every real use (one per session start
 * in one isolated home); beyond 12 digits the shape would break, which nothing
 * can reach and nothing guards.
 */
export function fakeSessionId(n: number): string {
  return FAKE_ID_PREFIX + String(n).padStart(12, '0');
}

/**
 * The FIRST fake conversation's id, and the fallback when no counter can be
 * claimed.
 *
 * Deliberately identical to the constant that used to serve every session, so
 * "the only Direct card in this test" keeps the id its spec already asserts and
 * the change costs nothing where there was never a collision to have.
 */
export const FAKE_SESSION_ID = fakeSessionId(0);

/**
 * How far to probe past the directory count before giving up.
 *
 * Only reachable if the directory is unusable in a way that is not "this number
 * is taken" — and giving up means returning the FIRST id, i.e. the shared
 * constant and the very collision this file exists to remove. So the probe
 * stops at the first error that is not `EEXIST` rather than spending a thousand
 * syscalls arriving at a wrong answer slowly.
 */
const PROBE_LIMIT = 1000;

/**
 * Claim the next unused id, atomically, across PROCESSES.
 *
 * Every fake session is a separate child of the app, so an in-memory counter
 * would restart at zero for each one — the bug this replaces. The counter is
 * therefore the FILESYSTEM: one empty marker file per id handed out, in a
 * directory of the caller's choosing (the isolated home's `.claude`, so it is
 * scoped exactly like the transcripts it names and thrown away with them).
 *
 * `wx` is the whole mechanism: it fails if the file exists, so two children
 * racing cannot both believe they claimed `n`. The directory's entry count is
 * the starting HINT — markers are contiguous, so it is normally right first try
 * — and the probe forward covers the race where it is not. Reusing the
 * directory across app launches is the point: a card that starts fresh after a
 * relaunch must not be handed the id the previous launch's card is still
 * pointing at, which would recreate the collision at one remove.
 *
 * FAIL-OPEN, like everything else in the fake: an fs that will not create files
 * returns the old shared constant, i.e. exactly the behaviour that shipped
 * before this function existed, rather than taking the session down.
 *
 * WHERE IT LANDS. Under Playwright and under `check:fake-stream` the home is a
 * temp directory that is thrown away with the run. A developer who starts the
 * app by hand with `SWITCHBOARD_FAKE_PROVIDER=stream` gets it in their real
 * `~/.claude` instead, growing by one zero-byte file per session — deliberately
 * accepted rather than worked around: it is one visibly-named directory of
 * empty markers next to a `projects/` tree the same fake has always written
 * into, and deleting it costs nothing but a restart of the numbering.
 */
export function claimFakeSessionId(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const start = fs.readdirSync(dir).length;
    for (let n = start; n < start + PROBE_LIMIT; n++) {
      try {
        fs.writeFileSync(path.join(dir, String(n)), '', { flag: 'wx' });
        return fakeSessionId(n);
      } catch (e) {
        // `EEXIST` is the ONLY error that means "someone claimed this number
        // between the readdir and now"; anything else (a permission, a handle
        // limit, a full disk) will say the same thing about every other number
        // too, so stop rather than probe it 999 more times.
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') break;
      }
    }
  } catch {
    // fail open — see the docblock
  }
  return FAKE_SESSION_ID;
}
