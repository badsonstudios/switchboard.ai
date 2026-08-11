// TranscriptWatcher (P1-E2-06): tolerant live tailer over Claude Code's JSONL
// transcripts, per the S-04/S-05 findings:
//   - transcripts appear on FIRST PROMPT, not spawn — absence is normal
//   - discovery = new-file detection VALIDATED against cwd/sessionId (the
//     adoption race is real; slug math only narrows the scan)
//   - recursive scan: subagent transcripts live nested at
//     <slug>/<session-uuid>/subagents/agent-<id>.jsonl with a .meta.json
//   - tolerant reader: malformed/unknown lines counted, never thrown
//   - transcript is TELEMETRY authority (tokens, tools, files); status
//     authority is hooks (E2-05)
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { Logger } from '../log/logger';
import { BindingDiagnostics, BindingState } from '../../shared/transcripts';
import { FeedBlock, deriveIntents } from '../feed/blocks';
import { FeedBuffer } from '../feed/buffer';
import { conversationExists, slugForCwd } from './paths';
import { DriftDetector } from './drift';
import { DiscoverySchedule, DiscoveryScheduleOptions, rootKey } from './discovery-scheduler';

// Re-exported: these moved to `paths.ts` so the provider adapters can use them
// without importing the watcher (P2-E15-01).
export { conversationExists, slugForCwd };

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface TranscriptSnapshot {
  sessionId: string;
  bound: boolean;
  /** what the UI shows when `bound` is false — and why (P2-E15-10) */
  binding: BindingState;
  bindingDiag: BindingDiagnostics;
  nativeSessionId?: string;
  usage: UsageTotals;
  /** last-seen model id from the transcript, for cost estimation */
  model?: string;
  /**
   * The conversation title the CLI wrote into its own transcript (§5.11,
   * P2-E7-06) — what fills a blank task label. Undefined until a line carries
   * one, which may be line 8 or line 510 or never.
   *
   * DE-DUPED AT SOURCE: only ever assigned when the value actually changes, so
   * the 14 identical `ai-title` lines a 171-line transcript carries move this
   * once. Everything downstream (the persist, the renderer push) hangs off that
   * one move.
   */
  title?: string;
  lines: number;
  malformed: number;
  /** Schema keys this run has never seen before (§5.26 drift detector). Sits
   *  beside `malformed` on purpose: both count "the file was not what we
   *  expected", and neither ever changes what gets ingested.
   *
   *  `readonly` and genuinely frozen: one array is shared by every snapshot
   *  taken under a root rather than copied per call (that IS the saving), so
   *  the compiler carries the invariant instead of a comment nobody reads. */
  driftKeys: readonly string[];
  toolsSeen: string[];
  filesTouched: string[];
  subagents: Array<{ agentId: string; agentType?: string; description?: string }>;
  /** latest TodoWrite plan progress (OQ #13), if the session uses one */
  plan?: { total: number; completed: number; inProgress: number };
  lastActivityAt: string | null;
}

// `FeedBlock` moved to `../feed/blocks.ts` in P2-E18-10, when the Feed grew a
// second source. Re-exported so every existing importer is unaffected: the type
// is the Feed's, not the transcript's, and both sources now build it with the
// same code.
export type { FeedBlock };

/**
 * Where we are in one file we are tailing.
 *
 * The `StringDecoder` is PER TAIL and lives as long as the tail does (#194). A
 * drain reads whatever bytes have arrived since the last tick, so a chunk
 * boundary lands wherever the writer happened to flush — routinely in the
 * MIDDLE of a multi-byte UTF-8 character. Decoding each chunk on its own
 * (`chunk.toString('utf8')`) turns that character into replacement characters
 * on both sides of the boundary: the JSON still parses, so nothing is counted
 * as malformed, and the corruption lands silently in the user's Feed, a file
 * path, or a tool argument. The decoder holds the partial sequence until the
 * rest of it arrives on a later tick — the same job `stream-service.ts` gets
 * from `setEncoding('utf8')` on the CLI's stdout, for the same reason.
 *
 * There is deliberately no `end()`/flush: a tail is only ever dropped when the
 * bytes it was waiting for stopped being interesting (rebind, `/clear`,
 * unwatch), and flushing would emit replacement characters for a character the
 * writer was in the middle of — the exact garbage this exists to prevent.
 */
interface Tail {
  offset: number;
  buf: string;
  dec: StringDecoder;
}

function newTail(): Tail {
  return { offset: 0, buf: '', dec: new StringDecoder('utf8') };
}

interface WatchedSession {
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  /** where THIS session's provider writes transcripts (P2-E15-01). Defaults to
   *  the watcher's own root; a provider that writes somewhere else says so via
   *  its `transcripts` capability, and one watcher can then serve both. */
  projectsRoot: string;
  boundFile: string | null;
  watchedSince: number;
  /** One-shot latches so the two CLOCK-driven verdict changes each prod
   *  discovery exactly once instead of every tick (P2-E15-11). */
  widenedMarked: boolean;
  cwdDeadlineMarked: boolean;
  /** A TURN HAS RUN in this session (P2-E15-10 evidence #1). Latched, because
   *  a turn having happened never becomes untrue.
   *
   *  Deliberately NOT "hooks have spoken to us": `SessionStart` fires at CLI
   *  launch and carries a session_id, so treating any hook traffic as evidence
   *  would start the give-up clock on every card at spawn — and a transcript
   *  is not created until the FIRST PROMPT (the S-07 measurement). Every card
   *  you opened and had not typed into yet would turn red 45 seconds later,
   *  which is precisely the false alarm this item exists to remove. */
  conversationStarted: boolean;
  /** A transcript is sitting under our folder that nobody can claim (evidence
   *  #2 — deliberately independent, because AR-P1-8's point is that binding
   *  rides TWO contracts in series and the UI should be able to say which one
   *  went quiet).
   *
   *  RECOMPUTED every poll, never latched: while two same-folder cards are
   *  waiting out the ambiguity deadline, each can see the other's file as
   *  unclaimable. Latching would leave the innocent one permanently marked —
   *  so the evidence must be able to RETRACT when the file finds its owner. */
  candidateSeen: boolean;
  /** when the current run of evidence began — the clock the give-up deadline
   *  runs on. Not `watchedSince`: a session nobody has prompted is not late.
   *  Cleared when the evidence retracts. */
  evidenceSince: number | null;
  /** Transcripts we were bound to and gave up: a `/clear`'s previous
   *  conversation, or a mis-bind we corrected. They stay on disk, unclaimable
   *  by us for ever, so without this they would count as "a file under our
   *  folder that nobody can take" — turning our own abandoned history into
   *  permanent evidence that our transcript is missing (P2-E15-10). */
  abandoned: Set<string>;
  /**
   * The last tick on which THIS session took part in its root's sweep (#388).
   *
   * The root decides when the disk may be touched; this decides who the touching
   * is done for. A session that has stopped looking (`stillLooking` says which)
   * skips the ordinary sweeps its live neighbours are still buying and takes one
   * every `quietRungDue` — the same rung #129 gives a root where nobody is
   * looking, now paid per session because that is how the cost is incurred.
   *
   * Updated on every sweep this session takes part in, looking or not, so the
   * value is simply "sweeps ago" and a session that stops looking long after its
   * last scan drops to the quiet rung from where it already stood rather than
   * from zero. Lives here rather than in the scheduler for the reason
   * `quietRungDue` gives: it dies with the entry, so there is no second
   * lifecycle to keep in step with `unwatch`.
   *
   * 0 until the first sweep this session takes part in. Both routes out of that
   * agree it is due: `stillLooking` is true for a card this new (nothing reaches
   * the quiet rung without spending 45 seconds first), and `quietRungDue` is
   * asked in wall-clock milliseconds, where a zero is a subtraction of the whole
   * epoch. A new card never waits out a rung before anyone looks for it.
   */
  lastDiscoveryAt: number;
  tails: Map<string, Tail>;
  snap: TranscriptSnapshot;
  /** the Feed's own state — seq, cap, tool-result stitching (P2-E18-10) */
  feed: FeedBuffer;
  /**
   * When this session's CLI process died, or null while it is still up (#200).
   *
   * A dead CLI writes nothing more — every byte it completed is in the page
   * cache by the time the OS tells us it exited, and anything still sitting in
   * its own userspace buffer died with it. So once this is set the watch is
   * finishing OUR OWN reading, not following a writer, and `maybeQuiesce`
   * decides when there is nothing left for it to learn.
   */
  exitedAt: number | null;
  /**
   * Frozen (#200): this session does no more disk I/O, ever.
   *
   * NOT the same as unwatched. The entry stays in `sessions` with its snapshot
   * and its Feed buffer intact, because that is what a CRASHED CARD READS —
   * `blocks()` serves the Feed its backlog when the pane mounts, `snapshot()`
   * answers `transcripts:binding`. Unwatching a crashed session would empty
   * both. One-way: nothing un-quiesces, because a restart is a new live id and
   * a new `watch()`.
   */
  quiesced: boolean;
  /**
   * Does the Feed take its blocks from THIS session's transcript?
   *
   * False for a stream session, whose Feed is built from typed messages by
   * `StreamFeed` (P2-E18-10). Everything else the watcher does — binding,
   * usage totals, the native id, drift — is still wanted there, so the answer
   * is a flag on the watch rather than "do not watch at all". Two sources
   * feeding one Feed would render every block twice.
   */
  deriveFeed: boolean;
  /**
   * Read this provider's conversation title off a transcript line (§5.11), or
   * undefined when the provider declares no `titles` capability — in which case
   * no line is ever inspected and `snap.title` stays undefined for ever. That
   * is the "an adapter that does not declare titles starts no title watch at
   * all" half of P2-E7-06, and it is a per-SESSION field because the provider
   * is a per-session fact: one watcher serves cards on different adapters.
   */
  readTitle?: (line: Record<string, unknown>) => string | undefined;
}

/** After this long unbound, widen discovery beyond the slug prefilter. */
const WIDEN_AFTER_MS = 10_000;

/** After this long without a hooks-delivered native id, an ambiguous
 *  same-cwd session may bind on cwd evidence alone (fail-open: hooks being
 *  dead must not leave the Feed empty forever). */
const CWD_BIND_FALLBACK_MS = 30_000;

/** After this long WITH EVIDENCE and still unbound, stop calling it "searching"
 *  and tell the user we failed. Chosen to be longer than CWD_BIND_FALLBACK_MS
 *  so the fail-open cwd bind gets its full chance first — note the two clocks
 *  have DIFFERENT origins (`evidenceSince` vs `watchedSince`), so that ordering
 *  holds comfortably in the common case (evidence arrives at the first prompt)
 *  rather than by arithmetic. */
const BIND_GIVEUP_MS = 45_000;

/**
 * How long a card NOBODY HAS EVER PROMPTED keeps discovery on the fast ladder
 * (#388) — for its root, and for itself.
 *
 * `awaiting-prompt` deliberately never times out as a VERDICT (see
 * `deriveBinding`): a session you opened and walked away from is not broken, and
 * saying so would be the false alarm P2-E15-10 exists to remove. That is a
 * statement about what the UI may claim, and #388 is the discovery-scheduling
 * question hiding behind it: nothing about "we must not accuse this card"
 * requires walking 2,090 directory entries on its behalf, ten times a second,
 * for the life of the process. Before this, one such card held its whole root on
 * the fast ladder for ever — the same shape #129 fixed one rung up.
 *
 * WHAT DISCOVERY IS EVEN DOING FOR IT: nothing, in the healthy case. The CLI
 * writes no transcript until the first prompt (the S-07 measurement), so there
 * is by contract nothing on disk to find — and at the moment there IS, two
 * independent accelerators fire. Hooks reach `noteConversationStarted`, which
 * marks the root dirty; and the transcript appearing is a NEW path on the
 * recursive watch, which buys a full pass down the ladder. Sweeping is
 * load-bearing only when BOTH are dead, and there `GIVEN_UP_MS` still finds it —
 * #129's own argument for choosing that number against the degraded path.
 *
 * SO WHY A TIMEOUT AND NOT "IT NEVER VOTES"? Because the doubly-degraded case is
 * real (a network home where recursive `fs.watch` is unreliable, plus a blocked
 * hooks listener), and there a card prompted seconds after it opened would bind
 * up to half a minute late instead of inside two seconds — a regression on a
 * healthy card, which is a different bargain from #129's, where the user had
 * already been told the search had failed. A timeout keeps the fast ladder for
 * the window in which a first prompt is actually likely and drops it for the
 * card that is genuinely just sitting there.
 *
 * THE NUMBER is `BIND_GIVEUP_MS`, and the same 45 seconds for the same reason:
 * it is this file's answer to "how long do we keep looking before we stop paying
 * to look". A session WITH evidence spends it and is declared `unbound`; a
 * session with none spends it and goes quiet without any verdict at all — the
 * UI still says `awaiting-prompt`, for ever, because that remains true. It is
 * also comfortably past both clock-driven discovery deadlines (`WIDEN_AFTER_MS`
 * 10s and `CWD_BIND_FALLBACK_MS` 30s), so neither has to be reasoned about
 * against it. Separately injectable so a test can drive this population without
 * moving the give-up verdict that every other test in the file depends on.
 */
const UNPROMPTED_FAST_MS = BIND_GIVEUP_MS;

/**
 * How long a BOUND session's watch keeps draining after its process died (#200).
 *
 * One more drain is provably enough on a local filesystem: the exit
 * notification is causally after every write the dead process completed, so
 * whatever is on disk when it arrives is everything there will ever be — and a
 * drain reads to EOF, not a chunk at a time. The three seconds are for the
 * cases where that reasoning has a seam: a home directory on SMB, where `stat`
 * size can lag the writes it is reporting, and a transport that reports the
 * exit a beat before the last flush lands. Thirty more ticks of `stat` on one
 * known file is not a cost worth shaving; losing the last words of a crashed
 * turn out of the Feed is.
 *
 * Measured from the DEATH, deliberately, not from the last bytes read. Making
 * it "quiet since we last learned something" needs a timestamp of its own and
 * buys nothing a test can tell apart: nothing is writing, and a transcript
 * bound late — after this window has already passed — is still drained by the
 * tick that binds it, because the drain runs before the freeze does.
 */
const POST_EXIT_SETTLE_MS = 3_000;

/**
 * The hard ceiling on ANY post-exit watching (#200).
 *
 * An UNBOUND session that dies is the case that actually matters: a crash
 * during the first turn routinely leaves a transcript on disk that we have not
 * claimed yet (the widen grace alone is 10s, and an ambiguous same-cwd bind
 * waits `CWD_BIND_FALLBACK_MS` for a native id), and giving up at the moment of
 * death would leave that card's Feed permanently empty where today it fills
 * seconds later. So discovery runs on until the binding question is ANSWERED —
 * `deriveBinding` reaching `unbound` — and this is the backstop for the state
 * combinations that never reach a verdict at all (a session nobody prompted
 * stays `awaiting-prompt` for ever, deliberately). Comfortably past
 * `BIND_GIVEUP_MS` so the UI's own verdict lands first whenever there is one.
 *
 * Since #388 that unprompted session spends most of the hunt on the quiet rung
 * rather than the ladder, which costs it nothing: a dead process writes nothing
 * new, and the three things that could still change its verdict — a late native
 * id, a sibling closing, the `cwdDeadlineMarked` latch — all mark the root dirty
 * and buy the sweeps back.
 */
const POST_EXIT_HUNT_MS = 90_000;

export interface TranscriptWatcherOptions {
  /** Default root for sessions that do not name one, and the first root seeded.
   *  Optional: a workspace whose provider has no transcripts capability watches
   *  nothing, and there is no root to speak of (P2-E15-01). */
  projectsRoot?: string;
  log: Logger;
  pollMs?: number;
  /** how long to trust the slug prefilter before widening discovery */
  widenAfterMs?: number;
  /** how long an ambiguous same-cwd session waits for a native id before
   *  falling back to best-effort cwd binding */
  cwdBindFallbackMs?: number;
  /** how long a session searches WITH EVIDENCE before the UI says it failed */
  bindGiveUpMs?: number;
  /** how long a never-prompted card keeps discovery on the fast ladder (#388) */
  unpromptedFastMs?: number;
  /** how long a bound session keeps draining after its process died (#200) */
  postExitSettleMs?: number;
  /** the hard ceiling on watching anything for an exited session (#200) */
  postExitHuntMs?: number;
  /** Discovery scheduling knobs (P2-E15-11) — injectable so tests can drive
   *  filesystem events and simulate an unusable watch. */
  discovery?: Omit<DiscoveryScheduleOptions, 'log'>;
}

/**
 * Read a byte range out of `file` with the descriptor closed on EVERY path —
 * including the one where the read throws (#179).
 *
 * Both readers here used to `openSync` / `readSync` / `closeSync` inside one
 * `try`, so a read that threw skipped the close and leaked the descriptor. On
 * Windows an open handle PINS the file: the user's own transcript then can't be
 * rotated or deleted (EBUSY) for the lifetime of the app. Fail-open means our
 * failures cost the user nothing — that has to include their files, not just
 * their session.
 *
 * Returns the number of bytes read, or `null` when the file could not be read
 * at all (missing, locked, mid-rotation) — every caller treats that as "nothing
 * to see yet" and tries again on the next tick.
 */
function readRange(file: string, buf: Buffer, position: number): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    return fs.readSync(fd, buf, 0, buf.length, position);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // A throw out of `finally` REPLACES the value the body returned, so an
        // unlucky close (EBADF, a descriptor the OS already reclaimed) would
        // escape past the `catch` above and reach callers that are written to
        // never see a throw. There is nothing useful to do about a failed close
        // anyway — the descriptor is gone either way.
      }
    }
  }
}

/**
 * What one poll tick's pre-pass decided, for the session loop to read (#388).
 *
 * The pre-pass answers per ROOT and the loop spends per SESSION, and every
 * question here has to be answered exactly once: `noteSwept` mutates the
 * backoff, `setGivenUp` moves the rung, and `stillLooking` reads binding state a
 * re-entrant listener can change mid-tick. Named as a value rather than passed
 * as four arguments because the four are one decision.
 *
 * `sweeping`, `reprieved` and `quiet` are keyed by the RAW root spelling — the
 * scheduler de-dupes roots itself, and the session loop only ever has the raw
 * string. `looking` is keyed by session id.
 */
interface SweepPlan {
  /** roots the disk may be touched for at all on this tick */
  sweeping: Set<string>;
  /** ...of which these sweeps were still owed to the root's last evidence */
  reprieved: Set<string>;
  /** per session: is it still looking for a transcript? (`stillLooking`) */
  looking: Map<string, boolean>;
}

/** Path equality that tolerates case + separator differences on win32. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export class TranscriptWatcher {
  private readonly sessions = new Map<string, WatchedSession>();
  // Files that were already under a root when we first watched it, PER ROOT.
  // One flat set would let seeding a second root swallow the first root's live
  // files — trivially so if one root nests inside the other, or is merely
  // spelled differently. Keyed by root, cross-contamination is impossible by
  // construction (P2-E15-01).
  //
  // What this does and does NOT buy: it stops a session adopting a transcript
  // that predates our watch of that root. It does not stop a NEW card adopting
  // the transcript of a card closed earlier in the same run — that file arrived
  // after the seed, and nothing here distinguishes it. Pre-existing, and the
  // cwd-evidence rules in `claim()` are what stand between us and it.
  private readonly known = new Map<string, Set<string>>();
  private readonly listeners = new Set<(s: TranscriptSnapshot) => void>();
  private readonly blockListeners = new Set<(sessionId: string, b: FeedBlock) => void>();
  private readonly resetListeners = new Set<(sessionId: string, cause?: 'clear') => void>();
  private timer: NodeJS.Timeout | null = null;
  // ONE detector for the whole watcher, not one per session: every session is
  // reading transcripts written by the same CLI build, so a new field is one
  // piece of news however many sessions happen to see it (§5.26 "warned once").
  private readonly drift: DriftDetector;
  // `driftKeys` rides every snapshot, and every snapshot is structured-cloned
  // to the renderer. It is empty in the overwhelming majority of runs and
  // identical for every session under one root, so it is built once per root
  // and invalidated when the detector actually reports something.
  private readonly driftCache = new Map<string, readonly string[]>();
  // Decides when discovery may touch the disk (P2-E15-11 / AR-P1-8). The 100ms
  // tick still runs — the TAIL DRAIN is latency-critical and stays on it — but
  // the directory walking behind it is now event-driven with a timed floor.
  private readonly discovery: DiscoverySchedule;

  constructor(private readonly opts: TranscriptWatcherOptions) {
    this.discovery = new DiscoverySchedule({ log: opts.log, ...(opts.discovery ?? {}) });
    this.drift = new DriftDetector((key, sample) => {
      this.driftCache.clear();
      this.opts.log.warn('transcript schema drift: unknown key', {
        key,
        // which line type, and which CLI BUILD wrote it — the version is
        // sitting on the very line we are inspecting, and without it the log
        // entry cannot be turned into a bug report without guesswork
        line: sample,
        hint: 'the CLI writes a field src/main/transcripts/schema.ts does not declare — see §5.26',
      });
    });
    if (opts.projectsRoot) this.seed(opts.projectsRoot);
  }

  private driftKeysFor(root: string): readonly string[] {
    let keys = this.driftCache.get(root);
    if (!keys) {
      keys = Object.freeze(this.drift.keys(root));
      this.driftCache.set(root, keys);
    }
    return keys;
  }

  /** A snapshot with nothing in it yet. Two callers (first watch, and a reset
   *  after a corrected mis-bind) and they must not drift apart. */
  private blankSnap(sessionId: string, projectsRoot: string): TranscriptSnapshot {
    return {
      sessionId,
      bound: false,
      binding: 'awaiting-prompt',
      bindingDiag: {
        conversationStarted: false,
        candidateSeen: false,
        searchingMs: null,
        projectsRoot,
      },
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      lines: 0,
      malformed: 0,
      driftKeys: [],
      toolsSeen: [],
      filesTouched: [],
      subagents: [],
      lastActivityAt: null,
    };
  }

  /** Record everything already under `root`, once, so it can never be mistaken
   *  for a transcript this app's sessions produced. */
  private seed(root: string): void {
    if (this.known.has(root)) return;
    this.known.set(root, new Set(this.scan(root)));
  }

  /** Start watching. Returns false when the root is unusable — the caller owns
   *  saying so, because it is the one that knows which CARD this is. */
  watch(
    sessionId: string,
    session: {
      cwd: string;
      nativeSessionId?: string;
      projectsRoot?: string;
      /**
       * Should this session's Feed be built from its transcript? Default true.
       *
       * A stream session says false: its Feed comes from typed messages
       * (P2-E18-10), and deriving from both sources would double every block.
       * The rest of the watch — binding, usage, native id, drift — is unchanged
       * and still wanted, which is why this is a flag and not a decision to
       * stop watching.
       */
      deriveFeed?: boolean;
      /** How this session's provider spells a conversation title (§5.11).
       *  Omitted = it has none, and no line is inspected for one. */
      readTitle?: (line: Record<string, unknown>) => string | undefined;
    }
  ): boolean {
    const root = session.projectsRoot ?? this.opts.projectsRoot ?? '';
    // Re-watching an id REPLACES a watch, so the old root loses a reference.
    // Without this the refcount only ever climbs and the handle outlives every
    // session on it — the leak `release()` exists to prevent, reintroduced.
    const prev = this.sessions.get(sessionId);
    // A relative root would make the poll loop crawl from the process cwd every
    // 100ms. First-party adapters today; the check is here because Phase 4
    // makes this string third-party and this is the cheapest moment to draw the
    // line (§5.29 — validate at the boundary, not at the use site).
    if (!root || !path.isAbsolute(root)) {
      // A relative root would make the poll loop crawl from the process cwd
      // every 100ms. Absolute is the bar, deliberately not narrower: a home
      // directory on a UNC share is a real setup, not an attack.
      this.opts.log.warn('transcript watch refused: root is not an absolute path', {
        sessionId,
        root,
      });
      // never leave a previous watch of this id running under a stale root
      this.sessions.delete(sessionId);
      if (prev) {
        this.discovery.markDirty(prev.projectsRoot);
        // ...but only if it still holds one. A quiesced session gave its
        // reference back when it froze (#200), and a second release would
        // decrement a refcount that belongs to whichever LIVE sessions are on
        // this root — closing their watch out from under them.
        if (!prev.quiesced) this.discovery.release(prev.projectsRoot);
      }
      // The one path that removes the last live session without going through
      // `unwatch` — and therefore the one that could leave the interval ticking
      // over an all-frozen map (#200).
      this.stopPollingIfIdle();
      return false;
    }
    this.seed(root);
    // Starts the watch for this root if it is the first session on it, and asks
    // for an immediate first sweep either way — a new card must not wait out a
    // backoff step before anyone looks for its transcript.
    //
    // Registered BEFORE the old root is released so that re-watching under the
    // SAME root never dips the refcount to zero — which would tear the watch
    // down and immediately rebuild it, losing every event in between.
    this.discovery.register(root);
    // A quiesced predecessor already gave its reference back (#200) — see the
    // refused-root branch above for why releasing it twice is not harmless.
    if (prev && !prev.quiesced) this.discovery.release(prev.projectsRoot);
    this.sessions.set(sessionId, {
      sessionId,
      cwd: session.cwd,
      nativeSessionId: session.nativeSessionId,
      projectsRoot: root,
      boundFile: null,
      watchedSince: Date.now(),
      widenedMarked: false,
      cwdDeadlineMarked: false,
      conversationStarted: false,
      candidateSeen: false,
      evidenceSince: null,
      abandoned: new Set(),
      lastDiscoveryAt: 0,
      tails: new Map(),
      snap: this.blankSnap(sessionId, root),
      feed: new FeedBuffer((b) => this.reemit(sessionId, b)),
      exitedAt: null,
      quiesced: false,
      deriveFeed: session.deriveFeed !== false,
      readTitle: session.readTitle,
    });
    this.ensurePolling();
    return true;
  }

  /**
   * Late-arriving native id (from hooks) tightens binding validation — and
   * CORRECTS a same-cwd mis-bind (Dan's 2026-07-21 find: two sessions in one
   * folder cross-wired their Feeds): if we already bound a transcript whose
   * sessionId doesn't match the id the hooks just delivered, unbind and let
   * discovery re-run with the id as the authority.
   */
  setNativeSessionId(sessionId: string, nativeId: string, cause?: 'clear'): void {
    const w = this.sessions.get(sessionId);
    if (!w) return;
    // Frozen means frozen (#200). This is the sharpest reason quiescing has to
    // switch the evidence sites off rather than merely stop the poll: a hook
    // arriving late for a dead session, naming an id we did not bind, would
    // reach `resetBinding` and BLANK the crashed card's Feed and snapshot —
    // with no polling left to rebuild either. Nothing about a corpse's binding
    // is worth correcting; the user is reading what it managed to say.
    if (w.quiesced) return;
    w.nativeSessionId = nativeId;
    // The id is the AUTHORITY that `claim()` was waiting for: a transcript it
    // refused a moment ago may be claimable now, and that file is already on
    // disk, so no filesystem event is ever coming to tell us to look again.
    // Every evidence site that can change a sweep's verdict must say so — the
    // watch only knows about the disk.
    this.discovery.markDirty(w.projectsRoot);
    // Deliberately NOT evidence that a conversation started: this fires from
    // `SessionStart` too, which the CLI sends at launch (P2-E15-10 — see
    // `conversationStarted`). The caller tells us about turns separately.
    if (w.boundFile && w.snap.nativeSessionId && w.snap.nativeSessionId !== nativeId) {
      if (cause === 'clear') {
        // not a mis-bind: /clear started a fresh conversation on purpose
        this.opts.log.info('conversation cleared — rebinding to the new transcript', {
          sessionId,
          from: w.snap.nativeSessionId,
          to: nativeId,
        });
      } else {
        this.opts.log.warn('transcript mis-bind corrected (same-cwd race)', {
          sessionId,
          boundTo: w.snap.nativeSessionId,
          actual: nativeId,
        });
      }
      this.resetBinding(w, cause);
    }
  }

  /** Drop the current binding and start discovery over, clean. */
  private resetBinding(w: WatchedSession, cause?: 'clear'): void {
    // Whatever we were reading is now positively somebody else's conversation
    // (a corrected mis-bind) or a closed chapter of our own (`/clear`). Either
    // way it will sit there unclaimable for the rest of the run, so it must
    // stop being treated as a transcript we failed to pick up.
    if (w.boundFile) w.abandoned.add(w.boundFile);
    w.boundFile = null;
    // Discovery has to start over for this session right now — a corrected
    // mis-bind or a `/clear` both leave it hunting, and the transcript it needs
    // may already be on disk, so there is no future filesystem event to wait
    // for.
    this.discovery.markDirty(w.projectsRoot);
    w.tails.clear();
    w.feed.reset();
    w.snap = this.blankSnap(w.sessionId, w.projectsRoot);
    // A fresh search starts now, so the give-up clock restarts — otherwise a
    // rebind ten minutes into a healthy session would report as failed on
    // arrival. What survives depends on WHY we are here, and the two causes
    // genuinely differ:
    //
    //  - a corrected MIS-BIND: the conversation is still running and its
    //    transcript exists, we were merely reading the wrong one. A turn
    //    demonstrably ran — that is how we learned the correct id — so the
    //    evidence stands and a failure to re-find it is worth reporting.
    //  - a `/clear`: the CLI minted a BRAND-NEW conversation, and it will not
    //    write a transcript for it until the next prompt. Carrying the old
    //    turn's evidence over would put a cleared-and-then-idle session into a
    //    red failure state 45 seconds later — B1 again, one step further along.
    //    The next prompt re-latches it through the ordinary `working` path.
    w.candidateSeen = false;
    w.evidenceSince = null;
    if (cause === 'clear') w.conversationStarted = false;
    this.refreshBinding(w); // re-arms the clock from whatever evidence survived
    // the renderer must drop the stolen blocks too — the correct transcript
    // re-emits from seq 1 and would otherwise interleave with the old tail
    for (const l of this.resetListeners) l(w.sessionId, cause);
  }

  /**
   * The session's derived blocks were discarded — a corrected mis-bind, or
   * (cause 'clear') the CLI's /clear starting a fresh conversation.
   */
  onReset(l: (sessionId: string, cause?: 'clear') => void): () => void {
    this.resetListeners.add(l);
    return () => this.resetListeners.delete(l);
  }

  /**
   * A TURN HAS RUN in this session — the only thing that makes a missing
   * transcript newsworthy on its own (P2-E15-10). The caller owns this because
   * only it can tell a turn from a launch: `SessionStart` and `UserPromptSubmit`
   * both arrive as hook traffic carrying a session id, and only the second one
   * means the CLI has written, or is about to write, a transcript.
   */
  noteConversationStarted(sessionId: string): void {
    const w = this.sessions.get(sessionId);
    // `quiesced`: a frozen session's state never moves again (#200), and
    // latching evidence here would restart a give-up clock that nothing is
    // polling to resolve. Nor may a corpse prod discovery on its root: it gave
    // its reference back when it froze, and the sweep would be spent on behalf
    // of a session that cannot use it.
    if (!w || w.quiesced) return;
    // A turn just ran, so the CLI is writing a transcript right now if it has
    // not already. Look immediately rather than at whatever the ladder had
    // decayed to — this is the moment binding is most likely to succeed.
    //
    // ABOVE the latch, deliberately (#129). The latch is about EVIDENCE — a
    // turn having run never becomes untrue, so the second one tells the binding
    // state nothing — but the prod is bookkeeping, and every later turn is
    // still the strongest possible sign that a transcript is being written
    // right now. It is also the only prod a session that has GIVEN UP gets from
    // a user who simply keeps typing: the give-up clock only starts once a turn
    // has run, so by construction every such session has this latch already
    // closed. It cannot cost more than the fast ladder's own rate, which is
    // what an unbound sibling is paying anyway.
    this.discovery.markDirty(w.projectsRoot);
    if (w.conversationStarted) return;
    w.conversationStarted = true;
    this.refreshBinding(w);
  }

  /**
   * THIS SESSION'S CLI PROCESS IS GONE (#200).
   *
   * Not `unwatch`, deliberately — that is the whole of the decision this item
   * had to make. The watch is what the CRASHED CARD READS: `blocks()` hands the
   * Feed its backlog when the pane mounts, `snapshot()` answers
   * `transcripts:binding`, and both live inside the entry `unwatch` deletes.
   * Tearing the watch down on exit would stop the polling AND empty the card
   * the user came back to look at.
   *
   * So the watch QUIESCES instead: it keeps working for as long as it could
   * still learn something, then freezes — no further disk I/O on behalf of a
   * dead process, every derived value preserved and readable for ever. The two
   * windows are `POST_EXIT_SETTLE_MS` (bound: drain to the end) and
   * `POST_EXIT_HUNT_MS` (unbound: finish the hunt, or hit the ceiling).
   *
   * Called from `manager.onSessionExit`, so it fires for EVERY death including
   * the ones the app asked for — a Restart or a card close runs `tearDownLive`
   * first and the exit lands afterwards, on an id that is already unwatched.
   * A no-op for an unknown id, and a one-way latch for a known one, which is
   * what makes it safe beside the reap either way round.
   */
  noteSessionExited(sessionId: string): void {
    const w = this.sessions.get(sessionId);
    if (!w || w.exitedAt !== null) return;
    const now = Date.now();
    w.exitedAt = now;
    // A death is an evidence site like any other, and this file's rule is that
    // every one of them says so (see `noteConversationStarted`) — with more
    // reason here than anywhere, because this is the LAST discovery window this
    // session will ever get and the ladder may be sitting at 2s of it. For an
    // unbound session that window is the entire hunt; for a bound one,
    // `subagentFiles()` only runs on a sweep tick, so a subagent transcript that
    // appeared just before the crash would otherwise miss its only chance
    // inside the settle window and be lost for good.
    this.discovery.markDirty(w.projectsRoot);
    // Drain HERE, not on the next tick. Everything the CLI ever wrote is on
    // disk by the time its exit reaches us, and up to a poll interval of it may
    // be unread — the last words of the crashed turn. On the settle path the
    // next tick would get them anyway; this is what makes a zero-length settle
    // window (and the case where the ceiling has already passed) still correct.
    for (const [full, tail] of w.tails) this.drain(w, full, tail);
    this.maybeQuiesce(w, Date.now());
  }

  /** Has this exited session run out of things it could still learn? */
  private maybeQuiesce(w: WatchedSession, now: number): void {
    if (w.exitedAt === null || w.quiesced) return;
    // A wall clock that steps BACKWARDS (NTP, VM resume, the user changing it)
    // would make both subtractions below negative and park a dead session's
    // watch on the disk until real time caught up — an hour of pointless
    // scanning for an hour-sized jump. Re-anchor and lose nothing: these
    // windows are about how long we have been waiting, not about when it began.
    if (now < w.exitedAt) w.exitedAt = now;
    if (now - w.exitedAt >= (this.opts.postExitHuntMs ?? POST_EXIT_HUNT_MS)) {
      this.quiesce(w, 'post-exit ceiling');
      return;
    }
    if (!w.boundFile) {
      // Still hunting. The verdict is the watcher's OWN — `deriveBinding`
      // reaching `unbound` means the give-up clock expired, i.e. there is
      // nothing left to find. Stopping earlier would both cut short a bind that
      // was about to succeed and freeze the pane mid-sentence at "Looking for
      // this session's transcript…" for a session that is never coming back.
      if (w.snap.binding === 'unbound') this.quiesce(w, 'binding gave up');
      return;
    }
    if (now - w.exitedAt >= (this.opts.postExitSettleMs ?? POST_EXIT_SETTLE_MS)) {
      this.quiesce(w, 'drained to the end');
    }
  }

  /** Freeze one session: no more I/O, every derived value kept. One-way. */
  private quiesce(w: WatchedSession, why: string): void {
    if (w.quiesced) return;
    w.quiesced = true;
    // Nothing writes these files again and nothing reads the tails again, so
    // the partial-line buffer and the per-tail decoder are released now rather
    // than held for the lifetime of the card.
    w.tails.clear();
    // The search is over, so nothing about it is true any more — the same
    // argument `refreshBinding` makes for a session that BINDS, and the same
    // failure if it is skipped: `searchingMs` is computed live in `snapshot()`
    // from this, so a frozen session would report a search still running, hours
    // long, in the diagnostics a bug report is written from.
    //
    // `bindingDiag.candidateSeen` deliberately stands. It is not a clock but the
    // last thing we actually observed, and it is what picks WHICH explanation
    // the pane shows ("transcripts are being written here, none of them match"
    // vs "nothing has turned up at all"). That answer does not stop being true
    // because we stopped looking.
    w.evidenceSince = null;
    // We have STOPPED LOOKING, so "searching" has become a lie the pane would
    // tell for the rest of the run. Only reachable via the ceiling — the branch
    // above quiesces an unbound session precisely when the verdict lands — and
    // only for a session with evidence behind it, which is exactly what
    // `unbound` is defined to rest on. `awaiting-prompt` freezes untouched:
    // no turn ever ran, so no transcript was ever owed.
    if (w.snap.binding === 'searching') {
      w.snap.binding = 'unbound';
      this.emit(w);
    }
    // The last dead session on a root closes its recursive `fs.watch`, the same
    // handle `unwatch` releases — which is why `unwatch` must not release it a
    // second time for a session that came through here.
    //
    // No `markDirty`: the entry stays in `sessions` holding its `boundFile` and
    // its cwd, so nothing a sibling's sweep would conclude has changed. It is
    // the REMOVAL of an entry that moves those verdicts, and that is still
    // `unwatch`'s to announce.
    this.discovery.release(w.projectsRoot);
    this.opts.log.info('transcript watch quiesced — session exited', {
      sessionId: w.sessionId,
      reason: why,
      bound: !!w.boundFile,
      lines: w.snap.lines,
      msSinceExit: Date.now() - (w.exitedAt ?? Date.now()),
    });
    this.stopPollingIfIdle();
  }

  /**
   * What the watcher can honestly say about this session's binding right now
   * (P2-E15-10). Pure derivation from evidence already held — it decides
   * nothing and changes no behaviour; `claim()`'s heuristics are untouched.
   */
  private deriveBinding(w: WatchedSession): BindingState {
    if (w.boundFile) return 'bound';
    // No evidence a conversation started. This is the NORMAL state of a
    // freshly spawned session and stays until something says otherwise — it
    // deliberately never times out, because a session you opened and walked
    // away from is not broken.
    //
    // It also means `unbound` ALWAYS rests on positive evidence. With hooks
    // dead and nothing on disk we genuinely cannot tell "nobody has prompted
    // it" from "the CLI is writing somewhere we are not looking" — and
    // announcing a failure we cannot distinguish from silence is a guess
    // wearing a warning's clothes.
    if (w.evidenceSince === null) return 'awaiting-prompt';
    const giveUp = this.opts.bindGiveUpMs ?? BIND_GIVEUP_MS;
    return Date.now() - w.evidenceSince > giveUp ? 'unbound' : 'searching';
  }

  /** Recompute binding state and, if anything the UI shows MOVED, tell the
   *  listeners. Called from the poll and from every evidence site, so the UI
   *  never waits on a transcript line that is not coming. */
  private refreshBinding(w: WatchedSession): void {
    if (w.boundFile) {
      // The search is over, so nothing about it is true any more. Without
      // this, `searchingMs` keeps counting up for the rest of a perfectly
      // healthy session's life and `candidateSeen` stays stuck at whatever it
      // was on the sweep that bound — two diagnostics that would end up in a
      // bug report saying the opposite of what is happening.
      w.evidenceSince = null;
      w.candidateSeen = false;
    } else {
      // The give-up clock runs on the CURRENT run of evidence, and evidence
      // can retract: `candidateSeen` is recomputed each poll, so a file that
      // finds its rightful owner stops counting against this session and the
      // clock resets rather than marking it for the rest of the run.
      const hasEvidence = w.conversationStarted || w.candidateSeen;
      if (!hasEvidence) w.evidenceSince = null;
      else w.evidenceSince ??= Date.now();
    }

    const next = this.deriveBinding(w);
    const d = w.snap.bindingDiag;
    // The diagnostics decide WHICH explanation the pane shows, so a change in
    // them is as user-visible as a change of state — a session that reaches
    // `unbound` on one contract and later fails the other would otherwise keep
    // showing the first diagnosis for the rest of the run (the IPC pull only
    // happens at mount).
    const diagMoved =
      d.conversationStarted !== w.conversationStarted || d.candidateSeen !== w.candidateSeen;
    // Mutated in place, and `searchingMs` is filled in by `snapshot()` rather
    // than stored: this runs every 100ms per unbound session, and a value that
    // is stale the instant it is written has no business being cached.
    d.conversationStarted = w.conversationStarted;
    d.candidateSeen = w.candidateSeen;
    const entering = next !== w.snap.binding;
    // Nothing the UI shows has moved. This runs on every 100ms poll tick for
    // every unbound session, so without this return it is a push firehose
    // rather than the two or three messages a session's lifetime deserves.
    if (!entering && !diagMoved) return;
    w.snap.binding = next;
    if (entering && next === 'unbound') {
      // The one state that means something is wrong, so it earns a log line
      // naming which of the two contracts (§5.26) went quiet.
      this.opts.log.warn('transcript binding gave up', {
        sessionId: w.sessionId,
        cwd: w.cwd,
        projectsRoot: w.projectsRoot,
        conversationStarted: w.conversationStarted,
        candidateSeen: w.candidateSeen,
      });
    }
    this.emit(w);
  }

  /** Push this session's snapshot to the update listeners. */
  private emit(w: WatchedSession): void {
    const snap = this.snapshot(w.sessionId);
    if (!snap) return;
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch (err) {
        this.opts.log.error('transcript listener threw', {
          sessionId: w.sessionId,
          error: String(err),
        });
      }
    }
  }

  /** This pre-existing file is the session's OWN resumed conversation. */
  private isOwnResumedFile(w: WatchedSession, full: string): boolean {
    return !!w.nativeSessionId && path.basename(full) === `${w.nativeSessionId}.jsonl`;
  }

  /**
   * Would a refusal to claim this file be NEWS (P2-E15-10)? Only a file that
   * could plausibly have been ours counts:
   *  - subagent files are bound after the main transcript by design, so their
   *    refusal is the normal path, not a symptom;
   *  - a file another session already owns is that session's, and two cards in
   *    one folder taking turns is expected — counting it would make every
   *    same-folder pair report a binding problem it does not have.
   */
  private isEvidence(w: WatchedSession, full: string): boolean {
    if (full.includes(`${path.sep}subagents${path.sep}`)) return false;
    if (w.abandoned.has(full)) return false;
    for (const other of this.sessions.values()) {
      if (other !== w && other.boundFile === full) return false;
    }
    return true;
  }

  /** Another watched session shares this cwd — binding is ambiguous. */
  private hasCwdSibling(w: WatchedSession): boolean {
    for (const other of this.sessions.values()) {
      if (other !== w && sameFolder(other.cwd, w.cwd)) return true;
    }
    return false;
  }

  unwatch(sessionId: string): void {
    const gone = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (gone) {
      // Removing a session changes three things a sweep concludes for its
      // SIBLINGS, and no filesystem event describes any of them: its bound file
      // becomes unowned (so `claim()`'s "already owned" check and `isEvidence`
      // both flip), and `hasCwdSibling` can go false, which un-blocks the
      // ambiguous cwd-only bind. The file is already on disk and only gets
      // appends afterwards — which the `rename` filter drops — so nothing else
      // would ever prod discovery.
      this.discovery.markDirty(gone.projectsRoot);
      // ...and the last session off a root closes its recursive watch. Closing
      // every card otherwise leaves a live OS watch on ~/.claude/projects for
      // the rest of the process's life.
      //
      // ONCE (#200). A quiesced session already gave this reference back when
      // it froze, and the reap in `sessions:create` unwatches exactly such a
      // session — so an unguarded release here would take a reference belonging
      // to a LIVE sibling on the same root and close the watch it is binding
      // through. `markDirty` above stays unconditional: it is this entry
      // LEAVING that changes what a sibling's sweep concludes (its bound file
      // becomes unowned, `hasCwdSibling` can go false), and that is true
      // whether it was frozen or not.
      if (!gone.quiesced) this.discovery.release(gone.projectsRoot);
    }
    this.stopPollingIfIdle();
  }

  /** No session left that would DO anything on a tick — stop ticking (#200).
   *  Subsumes the old "the map is empty" test: a card whose session crashed
   *  keeps its entry for the overlay to read, so counting entries would leave
   *  the 100ms interval running over a set of frozen sessions for ever. */
  private stopPollingIfIdle(): void {
    if (!this.timer) return;
    for (const w of this.sessions.values()) if (!w.quiesced) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(sessionId: string): TranscriptSnapshot | undefined {
    const w = this.sessions.get(sessionId);
    return w
      ? {
          ...w.snap,
          bindingDiag: {
            ...w.snap.bindingDiag,
            searchingMs: w.evidenceSince === null ? null : Date.now() - w.evidenceSince,
          },
          // per ROOT, not per session: one provider writes every transcript
          // under a root, so "which keys are new" is one answer there, and
          // attributing it to whichever session happened to see it first would
          // be an accident of scheduling dressed up as information
          driftKeys: this.driftKeysFor(w.projectsRoot),
          toolsSeen: [...w.snap.toolsSeen],
          filesTouched: [...w.snap.filesTouched],
          subagents: [...w.snap.subagents],
        }
      : undefined;
  }

  /**
   * Test/diagnostic view of one root's discovery schedule (#388).
   *
   * A passthrough to `DiscoverySchedule.stats`, and it exists because this item
   * made the per-ROOT rung invisible from outside. Every byte of disk work is
   * now decided per session, so a test that counts syscalls can no longer tell a
   * root that everyone gave up on from one still on the fast ladder — which left
   * `poll()`'s give-up quorum, the whole of #129, with no failing test if it
   * were deleted (mutation-checked; it survived). This is the observable that
   * puts that guard back.
   *
   * Nothing in the app calls it, and that is deliberate rather than sloppy:
   * #129 declined to expose `fastSweepsLeft` because nothing would have read it,
   * and the difference here is that something does.
   */
  discoveryStats(root: string): ReturnType<DiscoverySchedule['stats']> {
    return this.discovery.stats(root);
  }

  onUpdate(l: (s: TranscriptSnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Live Feed blocks as they are derived (P2-E12-06). */
  onBlock(l: (sessionId: string, b: FeedBlock) => void): () => void {
    this.blockListeners.add(l);
    return () => this.blockListeners.delete(l);
  }

  /** Backlog of derived blocks for a session (attach/replay). */
  blocks(sessionId: string): FeedBlock[] {
    return this.sessions.get(sessionId)?.feed.list() ?? [];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.discovery.stop();
  }

  // --- internals -------------------------------------------------------------

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 100);
    this.timer.unref?.();
  }

  // Every caller now passes a root explicitly (P2-E15-01) — there is no
  // process-wide "the transcripts directory" any more.
  private scan(root: string, depth = 0, acc: string[] = []): string[] {
    if (depth > 4) return acc;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return acc;
    }
    for (const name of names) {
      const full = path.join(root, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) this.scan(full, depth + 1, acc);
      else if (name.endsWith('.jsonl')) acc.push(full);
    }
    return acc;
  }

  /**
   * Is this session still LOOKING for a transcript (#129, #388)?
   *
   * The one predicate behind both discovery throttles: it decides whether a
   * session votes to keep its ROOT on the fast ladder, and whether the session
   * itself takes part in the sweeps that ladder allows. Level-driven and never
   * latched anywhere — every answer is recomputed from state the rest of the
   * file already maintains, so a session that starts looking again is back at
   * full speed on the very next tick with no event required and nothing to
   * un-stick.
   *
   * The four answers, and why:
   *
   *  - QUIESCED (#200): no. A dead session's frozen watch scans nothing already
   *    and can learn nothing, so counting it — including a `bound` one — would
   *    hold a root fast on behalf of a corpse. HONEST SCOPE, and #388 shrank it:
   *    since the gate below, that no longer costs any I/O. A corpse's vote can
   *    only change the answer when every LIVE session on the root has stopped
   *    looking too — and those are now throttled to the same rung the root would
   *    have dropped to, so they scan at the same rate either way. What is left
   *    is the root's RUNG being honest, and a standing guard: the moment
   *    anything spends a root's rung outside the per-session loop, the corpse
   *    would be paying for it again. Deleting this clause passed every
   *    syscall-counting test in the suite, which is why `discoveryStats` exists
   *    — the claim is now asserted where it can still be seen.
   *  - `unbound` (#129): no. The give-up clock expired 45 seconds ago and the UI
   *    told the user so; it kept walking the whole tree anyway.
   *  - `awaiting-prompt` (#388): yes for `UNPROMPTED_FAST_MS` from the moment we
   *    started watching, then no. See that constant for the argument, which is
   *    the whole of this item's second half: no transcript is owed to a card
   *    nobody has prompted, and both accelerators that could tell us one has
   *    appeared prod discovery themselves.
   *  - `searching` or `bound`, alive: yes. A bound session is NOT done with
   *    discovery — `subagentFiles()` only runs on a swept tick — which is why
   *    the question is "still looking", not "still unbound".
   */
  private stillLooking(w: WatchedSession, now: number): boolean {
    if (w.quiesced) return false;
    if (w.snap.binding === 'unbound') return false;
    if (w.snap.binding === 'awaiting-prompt') {
      // Measured from `watchedSince`, the only clock a session with no evidence
      // has. A `/clear` puts a long-lived card back into `awaiting-prompt` with
      // an old `watchedSince`, so it goes quiet at once — which is right, and
      // provably safe rather than merely defensible: a card that has just been
      // cleared and left alone is precisely a card nobody is typing into, and
      // `resetBinding(cause: 'clear')` is only reachable from
      // `setNativeSessionId`, i.e. from the hooks. If we learned about the
      // `/clear` at all then the hooks are alive, so the next prompt is
      // guaranteed to reach `noteConversationStarted` and prod discovery.
      return now - w.watchedSince <= (this.opts.unpromptedFastMs ?? UNPROMPTED_FAST_MS);
    }
    return true;
  }

  /**
   * May THIS session take part in its root's sweep on this tick (#388)?
   *
   * A session that has stopped looking is not cut off — that would make it a
   * session that can NEVER bind, the failure #129 spent its whole recovery half
   * avoiding. It gets the identical two-part deal, one level down:
   *
   *  - every REPRIEVE sweep, immediately. A reprieve is what the scheduler owes
   *    its last piece of evidence, and every evidence site on the root feeds it:
   *    `markDirty` from a turn, a native id, a `/clear`, a sibling binding or
   *    closing; a NEW path on the recursive watch; an event with no filename.
   *    So the moment anything happens that a sweep would conclude differently
   *    about, this session is looking properly again — before its own state has
   *    to change, and whether or not the root as a whole is quiet.
   *  - otherwise, one sweep every `GIVEN_UP_MS`, which is the floor #129
   *    guarantees a root and this guarantees a session inside a root that is
   *    still fast for somebody else.
   *
   * THE COMPOSED WORST CASE, stated honestly, because it is not simply
   * `GIVEN_UP_MS`: this is a floor on the session, and the root still decides
   * when a sweep happens at all, so a due session waits for the root's next one.
   * `lastDiscoveryAt` only ever advances on a tick the ROOT also swept, so it
   * can never run ahead of `lastSweepAt` — which means that on a root where
   * nobody is looking the two clocks are in phase and the answer is exactly
   * `GIVEN_UP_MS`, and on a root still fast for somebody else it is that plus
   * the root's own rung (2s at the ladder's cap).
   *
   * The one corner where it is worse: a root that goes QUIET in the gap between
   * this session's last look and its next due time. The root's rung is reset
   * from its own last sweep, so the session waits out a fresh `GIVEN_UP_MS` on
   * top of the one it had nearly finished — up to twice the interval since it
   * last looked, and only when the watch and the hooks are BOTH dead, since
   * either one would prod the root and buy a reprieve. Accepted rather than
   * fixed: the fix is to let a due session force a sweep, which hands every
   * throttled session the power to set the root's rate and gives back the
   * per-root bound #129 exists to provide. It is also the direction #129 chose
   * to be wrong in one level up — nothing here is waiting on a verdict, because
   * the verdict has already been given.
   */
  private sessionMaySweep(w: WatchedSession, now: number, plan: SweepPlan): boolean {
    if (plan.looking.get(w.sessionId)) return true;
    if (plan.reprieved.has(w.projectsRoot)) return true;
    return this.discovery.quietRungDue(w.lastDiscoveryAt, now);
  }

  private poll(): void {
    const now = Date.now();
    // Which roots may be walked on THIS tick (P2-E15-11). Two properties, and
    // both are load-bearing — the pre-pass exists to satisfy them together:
    //
    //  - decided ONCE PER ROOT, not per session. `noteSwept` mutates the
    //    backoff, so asking-and-consuming inside the session loop would let the
    //    first session on a shared root take the sweep and leave every later
    //    one with nothing. `sessions` iterates in insertion order, so the same
    //    session wins every time and its siblings starve indefinitely.
    //  - CONSUMED here, before the loop, never committed after it. `claim()`
    //    marks the root dirty when it binds and only ever runs from inside this
    //    loop, so a post-pass `noteSwept` would clear — on the very same tick —
    //    the flag the bind had just raised, killing the sibling notification
    //    that mark exists for (P2-E15-10: evidence can RETRACT). Same hazard
    //    for anything a listener does re-entrantly during `drain()`.
    //
    // Pass one answers ONE question per root: is anybody here still looking?
    // (#129) A session the watcher has already declared `unbound` gave up 45
    // seconds ago and the UI said so — yet it kept walking the entire tree on
    // every rung of the ladder, for ever. When that is true of every session on
    // a root, the root drops to the slow rung; the moment it stops being true,
    // or any evidence site prods it, it is back on the fast one.
    //
    // `stillLooking` is the whole of that question, per session, and #388 made
    // it serve two answers rather than one: this quorum, and which sessions take
    // part in the sweep the quorum allows. ONE predicate deliberately — the
    // per-root rung and the per-session gate must not be able to disagree about
    // whether a session is worth spending a scan on, or either becomes a way
    // around the other. (The same reason `slowRung` serves both the interval and
    // the filesystem-event floor in the scheduler.)
    //
    // Grouped by `rootKey`, not by the raw string, because the quorum is ONE
    // answer per root and two sessions can spell one directory differently (a
    // provider's `transcripts` capability vs the default root — the case that
    // helper exists for). The honest scope of that: it is NOT a sweep fix. Each
    // root here is set-and-then-asked in the same step, so even under raw
    // grouping every spelling gets the answer its own sessions deserve — and
    // the second spelling never sweeps at all, before this item or after, since
    // the first one has consumed the tick's sweep by the time it is asked. What
    // it buys is a STABLE flag: raw grouping would set it true and false again
    // on every 100ms tick, with `setGivenUp`'s log line each way.
    //
    // `sweeping` deliberately stays keyed by the raw spelling it always was —
    // the scheduler de-dupes the sweep itself, so that set is unchanged.
    const roots = new Map<string, string>();
    const seeking = new Set<string>();
    const plan: SweepPlan = { sweeping: new Set(), reprieved: new Set(), looking: new Map() };
    for (const w of this.sessions.values()) {
      const key = rootKey(w.projectsRoot);
      if (!roots.has(key)) roots.set(key, w.projectsRoot);
      // Decided ONCE for the tick and remembered, not re-derived in the loop
      // below (#388). Both readers must get the same answer: a listener
      // re-entering during an earlier session's `drain()` can move a LATER
      // session's `snap.binding` between the two passes, and a session that
      // voted to hold its root fast and was then gated out of the sweep it had
      // just voted for is a tick of pure waste in each direction.
      const looking = this.stillLooking(w, now);
      plan.looking.set(w.sessionId, looking);
      if (looking) seeking.add(key);
    }
    for (const [key, root] of roots) {
      // Before `shouldSweep`, so the rung this tick is decided on takes the
      // give-up into account rather than lagging it by one sweep.
      //
      // Every root a session names is answered, including one whose sessions
      // are all frozen (#200): this pre-pass decides per ROOT and the answer
      // does not depend on which session asks — a corpse can only reach a
      // verdict its live siblings would have reached on the same tick, and on a
      // root it left alone `noteSwept` has no state to mutate.
      this.discovery.setGivenUp(root, !seeking.has(key));
      if (this.discovery.shouldSweep(root, now)) {
        plan.sweeping.add(root);
        // A REPRIEVE sweep is one the root still owed its last piece of
        // evidence. It is what puts a session that has stopped looking straight
        // back into the sweep instead of leaving it to wait out its quiet rung —
        // #129's recovery half, per session. `noteSwept` reports it because
        // `noteSwept` is what spends it.
        if (this.discovery.noteSwept(root, now)) plan.reprieved.add(root);
      }
    }

    for (const w of this.sessions.values()) {
      // The point of the whole item: a card left sitting on a crashed session
      // costs nothing per tick once its watch has frozen (#200). Everything
      // below this line touches the disk.
      if (w.quiesced) continue;
      // ...and the same again per SESSION (#388). The root decides whether the
      // disk may be touched at all; this decides who it is touched FOR, because
      // that is how the cost is actually incurred — `discoveryCandidates` is a
      // full walk of the tree PER unbound session on a swept tick, so before
      // this one live card kept every session beside it that had stopped looking
      // paying ~2,100 syscalls a sweep at the root's fast rung.
      const maySweep = plan.sweeping.has(w.projectsRoot) && this.sessionMaySweep(w, now, plan);
      // Only when this session actually takes part: a sweep it sat out is not a
      // sweep it can count against its own rung.
      if (maySweep) w.lastDiscoveryAt = now;
      // discovery: scan narrowly (this session's slug dirs, case-insensitive)
      // until bound; widen to the full root if binding hasn't happened after a
      // grace period (slug math is a PREFILTER, never the authority — the
      // spike's own rule; Claude lowercases drive letters, and future slug
      // rule changes must degrade to a slower scan, not silent unbound)
      if (!w.boundFile) {
        const widen = now - w.watchedSince > (this.opts.widenAfterMs ?? WIDEN_AFTER_MS);
        // Two verdict changes are driven by the CLOCK alone, and no filesystem
        // event or evidence site describes either: `widen` opening discovery to
        // the whole root, and the ambiguous-cwd deadline in `claim()` releasing
        // the fail-open bind. Before this item the next 100ms tick acted on
        // them; without these latches they would wait out the ladder instead,
        // binding ~2s later than today — a real regression against "binds no
        // slower than today", small but on exactly the fallback paths that
        // exist because something has already gone wrong.
        if (widen && !w.widenedMarked) {
          w.widenedMarked = true;
          this.discovery.markDirty(w.projectsRoot);
        }
        if (!w.cwdDeadlineMarked && now - w.watchedSince >= (this.opts.cwdBindFallbackMs ?? CWD_BIND_FALLBACK_MS)) {
          w.cwdDeadlineMarked = true;
          this.discovery.markDirty(w.projectsRoot);
        }
        let candidates = false;
        // The ONLY disk-walking branch for an unbound session, and the one that
        // AR-P1-8 measured at ~21,000 syscalls/sec on this machine once `widen`
        // was true. Everything below still runs every tick.
        for (const full of maySweep ? this.discoveryCandidates(w, widen) : []) {
          if (w.tails.has(full)) continue;
          // pre-existing files are never adopted — EXCEPT our own resumed
          // conversation (<nativeId>.jsonl existed before this launch by
          // definition; Dan's 2026-07-22 find: resumed cards had an empty
          // Session view forever). Replaying it from 0 also gives the Feed
          // the conversation history back.
          if (this.known.get(w.projectsRoot)?.has(full) && !this.isOwnResumedFile(w, full)) continue;
          const evidence = this.isEvidence(w, full);
          if (this.claim(w, full)) {
            w.tails.set(full, newTail());
          } else if (evidence) {
            // A transcript appeared under OUR folder during OUR watch and we
            // could not take it. That is the storage-layout contract moving —
            // the exact failure AR-P1-8 says the UI must stop hiding.
            candidates = true;
          }
        }
        // Assigned from THIS SWEEP, not OR-ed into the old value: the moment a
        // sibling claims the file that was troubling us, it stops being
        // evidence against this session and the give-up clock resets.
        //
        // Only on a sweep tick, though. Between sweeps we have not looked, and
        // "we did not look" is not the same news as "we looked and found
        // nothing" — clearing it on every unswept tick would retract the
        // evidence ~20 times a second and hold `evidenceSince` at null, so the
        // give-up clock could never run and a genuinely unbound session would
        // sit in `searching` for ever. The value stands until the next sweep
        // replaces it, and any event that could change it marks the root dirty.
        //
        // On the quiet rung (#388) "the next sweep" can be `GIVEN_UP_MS` away,
        // so this diagnostic goes stale for up to that long on a session that
        // has stopped looking — which is the same staleness #129 already accepts
        // for a root where nobody is, and it cannot move the binding state: a
        // session only reaches that rung with the verdict already settled, and
        // any event that would unsettle it buys a reprieve sweep first.
        if (maySweep) w.candidateSeen = candidates;
        // Never gated: this drives `searchingMs`, `awaiting-prompt` and the
        // give-up clock. Making the UI's own clocks event-driven would make
        // them lumpy for no I/O saving — it touches no disk.
        this.refreshBinding(w);
      } else if (maySweep) {
        // bound: only look for new subagent files under our session dir. Same
        // gate — it is a `readdirSync` per bound session per tick, and the
        // recursive watch covers this directory too, so a subagent transcript
        // still shows up as fast as the filesystem can tell us about it.
        for (const full of this.subagentFiles(w)) {
          if (!w.tails.has(full)) w.tails.set(full, newTail());
        }
      }
      // The tail drain is NEVER gated. It is the latency-critical path (it is
      // what puts words on the screen), and it is a cheap stat + read from a
      // known offset on a file we already hold — not a directory walk. This
      // item moves discovery off the hot thread, not the thing the hot thread
      // exists for.
      for (const [full, tail] of w.tails) this.drain(w, full, tail);
      // ...and if the process behind all of that is dead, ask whether this was
      // the last tick worth spending on it (#200). After the drain, so a tick
      // that read the final bytes still delivers them.
      if (w.exitedAt !== null) this.maybeQuiesce(w, now);
    }
  }

  // Discovery runs against the SESSION's root, not the watcher's: two providers
  // writing to different places must not have their conversations offered to
  // each other's sessions (P2-E15-01).
  private discoveryCandidates(w: WatchedSession, widen: boolean): string[] {
    if (widen) return this.scan(w.projectsRoot);
    const want = slugForCwd(w.cwd).toLowerCase();
    const acc: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(w.projectsRoot, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase() === want) {
        this.scan(path.join(w.projectsRoot, e.name), 1, acc);
      }
    }
    return acc;
  }

  private subagentFiles(w: WatchedSession): string[] {
    if (!w.boundFile) return [];
    const dir = path.join(path.dirname(w.boundFile), path.basename(w.boundFile, '.jsonl'), 'subagents');
    const acc: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(path.join(dir, e.name));
    }
    return acc;
  }

  /** Bind only files that VERIFIABLY belong to this session (the race fix).
   *  Positive evidence is required — Dan's 2026-07-22 find: resumed/compacted
   *  transcripts open with a summary record that has NO cwd, and the old
   *  "check cwd if present" rule let a widened scan claim a foreign file. */
  private claim(w: WatchedSession, full: string): boolean {
    if (full.includes(`${path.sep}subagents${path.sep}`)) return false; // handled post-bind
    if (w.boundFile) return false; // one main transcript per session
    // ...and one session per transcript: a file another session already owns
    // is never a candidate (keeps the #8 cwd fallback from double-binding)
    for (const other of this.sessions.values()) {
      if (other !== w && other.boundFile === full) return false;
    }
    const head = this.readHead(full);
    if (!head) return false;
    const cwdOk = typeof head.cwd === 'string' && sameFolder(head.cwd, w.cwd);
    // a known-wrong id or wrong cwd is always disqualifying
    if (w.nativeSessionId && head.sessionId && head.sessionId !== w.nativeSessionId) return false;
    if (typeof head.cwd === 'string' && !cwdOk) return false;
    // id evidence: a matching head sessionId, or the FILENAME itself once the
    // hooks told us our id — head lines can be unparseably huge (a fresh
    // transcript may open with a file-history-snapshot line bigger than any
    // sane read window; Dan's empty PLUSNative session, 2026-07-22)
    const idMatch =
      !!w.nativeSessionId &&
      (head.sessionId === w.nativeSessionId ||
        path.basename(full) === `${w.nativeSessionId}.jsonl`);
    if (!idMatch) {
      // Once the hooks delivered our id, ONLY id evidence may bind: a file
      // whose head sessionId is unparseable (oversized snapshot lines) must
      // not be adopted on cwd alone — its filename not matching our id is
      // the tell that it's someone else's conversation.
      if (w.nativeSessionId) return false;
      // without an id match we need a positive cwd match — absence of
      // evidence is NOT evidence the file is ours
      if (!cwdOk) return false;
      // Same-cwd sessions make cwd-only claims AMBIGUOUS (two sessions in
      // one folder must not steal each other's transcript): wait for the
      // hooks to deliver our native id, then bind on the id match. But if
      // the hooks never deliver one (listener broken/blocked — the designed
      // fail-open path), fall back to best-effort cwd binding after a
      // deadline: a possibly-crossed Feed beats a forever-empty one, and a
      // late native id still corrects a mis-bind (setNativeSessionId).
      if (this.hasCwdSibling(w)) {
        const deadline = this.opts.cwdBindFallbackMs ?? CWD_BIND_FALLBACK_MS;
        if (Date.now() - w.watchedSince < deadline) return false;
        this.opts.log.warn('ambiguous cwd-only bind (no native id after deadline)', {
          sessionId: w.sessionId,
          file: path.basename(full),
        });
      }
    }
    w.boundFile = full;
    // A bind changes what a sweep would conclude for every OTHER session on
    // this root, and no filesystem event describes it. P2-E15-10's
    // `candidateSeen` can RETRACT — a sibling only learns that the file
    // troubling it found its rightful owner by sweeping again — so this is
    // correctness, not speed.
    this.discovery.markDirty(w.projectsRoot);
    w.snap.bound = true;
    w.snap.nativeSessionId = typeof head.sessionId === 'string' ? head.sessionId : undefined;
    this.opts.log.info('transcript bound', { sessionId: w.sessionId, file: path.basename(full) });
    return true;
  }

  /** First cwd + sessionId found in the head of the file — summary/meta
   *  records on line 1 carry neither, so scan a handful of lines. */
  private readHead(full: string): { cwd?: string; sessionId?: string } | null {
    const buf = Buffer.alloc(262_144); // snapshot-sized first lines are real
    const n = readRange(full, buf, 0);
    if (n === null) return null;
    const text = buf.toString('utf8', 0, n);
    const out: { cwd?: string; sessionId?: string } = {};
    for (const line of text.split('\n').slice(0, 25)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { cwd?: unknown; sessionId?: unknown };
        if (out.cwd === undefined && typeof e.cwd === 'string') out.cwd = e.cwd;
        if (out.sessionId === undefined && typeof e.sessionId === 'string') out.sessionId = e.sessionId;
        if (out.cwd !== undefined && out.sessionId !== undefined) break;
      } catch {
        /* oversized/partial line or junk — keep scanning; an empty result
           still lets a filename id-match bind (claim() decides) */
      }
    }
    return out;
  }

  private drain(w: WatchedSession, full: string, tail: Tail): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return;
    }
    if (st.size < tail.offset) {
      // The file SHRANK — truncated or rewritten under us. Every byte the tail
      // is holding describes content that no longer exists: a partial line in
      // `buf` and, since #194, a half-decoded multi-byte character inside the
      // decoder. Carrying either across would prepend garbage to whatever the
      // writer puts there next, which is precisely the failure a per-tail
      // decoder would otherwise introduce. So resync: resume from the file's
      // new end with clean state. For the ordinary truncate-to-zero that means
      // the rewritten file is read from the top on the following tick — where
      // before this the tail simply stalled for ever, because `st.size <=
      // tail.offset` stayed true no matter what was written afterwards.
      //
      // Only detectable when a tick actually OBSERVES the smaller size; a
      // truncate-and-regrow that happens entirely between two polls is
      // invisible here, and always was. Nothing about a JSONL transcript
      // shrinks in normal operation — the CLI only appends.
      tail.offset = st.size;
      tail.buf = '';
      tail.dec = new StringDecoder('utf8');
      return;
    }
    if (st.size === tail.offset) return;
    const chunk = Buffer.alloc(st.size - tail.offset);
    const n = readRange(full, chunk, tail.offset);
    if (n === null) return;
    // Advance by what was actually READ, not by the size `stat` reported. They
    // are the same for the normal full read; they differ if the file shrank
    // between the stat and the read, and trusting `st.size` there would both
    // append the untouched zero-fill of the buffer and skip past bytes we never
    // saw.
    tail.offset += n;
    // Through the tail's own decoder, NOT `chunk.toString('utf8', 0, n)`: the
    // trailing bytes of a character split across this boundary are held back
    // and prepended to the next chunk instead of decoding to U+FFFD twice
    // (#194). `subarray` is a view, so the normal full-read case costs nothing.
    tail.buf += tail.dec.write(chunk.subarray(0, n));
    let nl: number;
    let touched = false;
    while ((nl = tail.buf.indexOf('\n')) >= 0) {
      const line = tail.buf.slice(0, nl);
      tail.buf = tail.buf.slice(nl + 1);
      if (!line.trim()) continue;
      w.snap.lines++;
      touched = true;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        w.snap.malformed++;
        continue;
      }
      // §5.26 drift detection sits HERE — after the parse, before absorb, and
      // with no branch between it and ingestion. The line is absorbed whatever
      // it reports; the detector observes, it does not gate (see drift.ts).
      this.drift.inspect(
        w.projectsRoot,
        e,
        `type=${typeof e.type === 'string' ? e.type : '(none)'} cli=${
          typeof e.version === 'string' ? e.version : '(unknown)'
        }`
      );
      this.absorb(w, full, e);
    }
    if (touched) {
      w.snap.lastActivityAt = new Date().toISOString();
      this.emit(w);
    }
  }

  /** Send a block (new OR updated — same seq) to the listeners. */
  private reemit(sessionId: string, block: FeedBlock): void {
    for (const l of this.blockListeners) {
      try {
        l(sessionId, block);
      } catch (err) {
        this.opts.log.error('block listener threw', { sessionId, error: String(err) });
      }
    }
  }

  /**
   * Derive Feed blocks (E12-06) from one transcript line.
   *
   * The DERIVATION itself moved to `../feed/blocks.ts` in P2-E18-10, shared
   * with the stream source so a block cannot look one way from a transcript and
   * another from a stream. What stays here is what only the watcher knows:
   * whether the line came from a subagent file, and whether this session's Feed
   * is transcript-driven at all.
   *
   * Tolerant: unknown shapes produce nothing, never a throw.
   */
  private deriveBlocks(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (!w.deriveFeed) return;
    const sidechain = full !== w.boundFile || e.isSidechain === true;
    for (const intent of deriveIntents(e)) {
      if (intent.t === 'tool-result') {
        w.feed.attachResult(intent.toolUseId, intent.out);
        continue;
      }
      const block = w.feed.push(intent.block, sidechain);
      if (intent.toolUseId) w.feed.remember(intent.toolUseId, block);
    }
  }

  private absorb(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (full === w.boundFile && typeof e.sessionId === 'string' && !w.snap.nativeSessionId) {
      w.snap.nativeSessionId = e.sessionId;
    }
    this.absorbTitle(w, full, e);
    this.deriveBlocks(w, full, e);
    const message = e.message as
      | { usage?: Record<string, number>; content?: unknown; model?: string }
      | undefined;
    if (typeof message?.model === 'string') w.snap.model = message.model;
    const usage = message?.usage;
    if (usage) {
      w.snap.usage.input += usage.input_tokens ?? 0;
      w.snap.usage.output += usage.output_tokens ?? 0;
      w.snap.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
      w.snap.usage.cacheCreate += usage.cache_creation_input_tokens ?? 0;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const c of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
      if (c?.type === 'tool_use') {
        if (c.name && !w.snap.toolsSeen.includes(c.name)) w.snap.toolsSeen.push(c.name);
        const fp = c.input?.file_path ?? c.input?.path ?? c.input?.notebook_path;
        if (typeof fp === 'string' && !w.snap.filesTouched.includes(fp)) {
          w.snap.filesTouched.push(fp);
        }
        if ((c.name === 'Agent' || c.name === 'Task') && full === w.boundFile) {
          this.pickupSubagentMeta(w);
        }
        if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
          const todos = c.input.todos as Array<{ status?: string }>;
          w.snap.plan = {
            total: todos.length,
            completed: todos.filter((td) => td.status === 'completed').length,
            inProgress: todos.filter((td) => td.status === 'in_progress').length,
          };
        }
      }
    }
  }

  /**
   * The conversation title, if this line carries one (§5.11, P2-E7-06).
   *
   * Three gates, each of which removes a real failure rather than a
   * hypothetical one:
   *
   *  - **no `readTitle`** — the provider declares no `titles` capability, so
   *    nothing is inspected at all. Not "we look and find nothing": there is no
   *    shared spelling of a title anywhere in this file to look for.
   *  - **the BOUND file only** — a subagent's transcript is a different
   *    conversation with its own title, and letting one through would relabel
   *    the card with whatever a `Task` call happened to be doing.
   *  - **an unchanged value is not a change** — the CLI re-emits the settled
   *    title every turn (14 identical lines in a 171-line transcript, measured),
   *    so without this every turn on every open session would push a snapshot
   *    the renderer re-renders and a card the store re-writes. THIS is the
   *    de-dupe P2-E7-06 asks for; everything downstream inherits it.
   *
   * Last-wins otherwise, because the CLI revises: an observed session went
   * `"…preview windows"` → `"…preview feature"` one line later.
   */
  private absorbTitle(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (!w.readTitle || full !== w.boundFile) return;
    const title = w.readTitle(e);
    if (typeof title !== 'string' || !title || title === w.snap.title) return;
    w.snap.title = title;
  }

  /** Read meta sidecars for any agent files under our session dir (S-05). */
  private pickupSubagentMeta(w: WatchedSession): void {
    if (!w.boundFile) return;
    const dir = path.join(path.dirname(w.boundFile), path.basename(w.boundFile, '.jsonl'), 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue;
      const agentId = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      if (w.snap.subagents.some((s) => s.agentId === agentId)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as {
          agentType?: string;
          description?: string;
        };
        w.snap.subagents.push({ agentId, agentType: meta.agentType, description: meta.description });
      } catch {
        w.snap.subagents.push({ agentId });
      }
    }
  }
}
