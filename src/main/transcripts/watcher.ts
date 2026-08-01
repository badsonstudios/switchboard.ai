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
import { Logger } from '../log/logger';
import { ToolCategory, toolCategory } from '../../shared/tool-taxonomy';
import { BindingDiagnostics, BindingState } from '../../shared/transcripts';
import { conversationExists, slugForCwd } from './paths';
import { DriftDetector } from './drift';
import { DiscoverySchedule, DiscoveryScheduleOptions } from './discovery-scheduler';

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

/**
 * One rendered unit of the Feed (P2-E12-06, §5.10): derived from transcript
 * lines, read-only by construction. `detail` is capped — the Feed is a view,
 * not an archive; the transcript stays the source of truth.
 */
export interface FeedBlock {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  /** user/assistant/thinking prose */
  text?: string;
  tool?: {
    name: string;
    /** presentation class — the renderer dispatches on this, never on the
     *  raw name (PowerShell must render like Bash; review P1 #9) */
    category: ToolCategory;
    summary: string;
    detail?: string;
    /** Bash: the tool call's own description field (block header, E10-06) */
    description?: string;
    /** Edit/Write: structured fields for the inline diff preview (E10-06) */
    filePath?: string;
    oldString?: string;
    newString?: string;
    /** tool_result output, attached when it arrives (block re-emitted) */
    out?: string;
  };
  /** TodoWrite checklist (E10-06) */
  todos?: Array<{ content: string; status: string }>;
  /** thinking: how long it lasted (set when the next block lands) */
  durationMs?: number;
  /** true when the line came from a subagent transcript */
  sidechain: boolean;
  ts?: string;
}

/** Feed blocks kept per session (view buffer, not an archive). */
const BLOCK_CAP = 1000;
const DETAIL_CAP = 4000;
const TEXT_CAP = 20_000;

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
  tails: Map<string, { offset: number; buf: string }>;
  snap: TranscriptSnapshot;
  blocks: FeedBlock[];
  blockSeq: number;
  /** tool_use id -> its block, so a later tool_result can attach its OUT */
  toolBlocks: Map<string, FeedBlock>;
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
  /** Discovery scheduling knobs (P2-E15-11) — injectable so tests can drive
   *  filesystem events and simulate an unusable watch. */
  discovery?: Omit<DiscoveryScheduleOptions, 'log'>;
}

/** CLI plumbing disguised as user text — never conversation. */
function isPlumbing(text: string): boolean {
  return text.trimStart().startsWith('<local-command-');
}

/** Flatten a tool_result content field (string or text-item array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((x) => x?.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('\n');
  }
  return '';
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
    session: { cwd: string; nativeSessionId?: string; projectsRoot?: string }
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
        this.discovery.release(prev.projectsRoot);
      }
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
    if (prev) this.discovery.release(prev.projectsRoot);
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
      tails: new Map(),
      snap: this.blankSnap(sessionId, root),
      blocks: [],
      blockSeq: 0,
      toolBlocks: new Map(),
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
    w.blocks = [];
    w.blockSeq = 0;
    w.toolBlocks.clear();
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
    if (!w || w.conversationStarted) return;
    w.conversationStarted = true;
    // A turn just ran, so the CLI is writing a transcript right now if it has
    // not already. Look immediately rather than at whatever the ladder had
    // decayed to — this is the moment binding is most likely to succeed.
    this.discovery.markDirty(w.projectsRoot);
    this.refreshBinding(w);
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
      this.discovery.release(gone.projectsRoot);
    }
    if (this.sessions.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    return [...(this.sessions.get(sessionId)?.blocks ?? [])];
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
    const sweeping = new Set<string>();
    for (const w of this.sessions.values()) {
      if (!sweeping.has(w.projectsRoot) && this.discovery.shouldSweep(w.projectsRoot, now)) {
        sweeping.add(w.projectsRoot);
        this.discovery.noteSwept(w.projectsRoot, now);
      }
    }

    for (const w of this.sessions.values()) {
      const maySweep = sweeping.has(w.projectsRoot);
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
            w.tails.set(full, { offset: 0, buf: '' });
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
          if (!w.tails.has(full)) w.tails.set(full, { offset: 0, buf: '' });
        }
      }
      // The tail drain is NEVER gated. It is the latency-critical path (it is
      // what puts words on the screen), and it is a cheap stat + read from a
      // known offset on a file we already hold — not a directory walk. This
      // item moves discovery off the hot thread, not the thing the hot thread
      // exists for.
      for (const [full, tail] of w.tails) this.drain(w, full, tail);
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
    let text: string;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(262_144); // snapshot-sized first lines are real
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8', 0, n);
    } catch {
      return null;
    }
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

  private drain(w: WatchedSession, full: string, tail: { offset: number; buf: string }): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      return;
    }
    if (st.size <= tail.offset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(full, 'r');
      chunk = Buffer.alloc(st.size - tail.offset);
      fs.readSync(fd, chunk, 0, chunk.length, tail.offset);
      fs.closeSync(fd);
    } catch {
      return;
    }
    tail.offset = st.size;
    tail.buf += chunk.toString('utf8');
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

  private emitBlock(w: WatchedSession, b: Omit<FeedBlock, 'seq' | 'sidechain'>, sidechain: boolean): FeedBlock {
    // a thinking block's duration becomes known when the NEXT block lands
    const prev = w.blocks[w.blocks.length - 1];
    if (prev?.kind === 'thinking' && !prev.durationMs && prev.ts && b.ts) {
      const ms = Date.parse(b.ts) - Date.parse(prev.ts);
      if (Number.isFinite(ms) && ms > 0) {
        prev.durationMs = ms;
        this.reemit(w, prev);
      }
    }
    const block: FeedBlock = { ...b, seq: ++w.blockSeq, sidechain };
    w.blocks.push(block);
    if (w.blocks.length > BLOCK_CAP) w.blocks.splice(0, w.blocks.length - BLOCK_CAP);
    this.reemit(w, block);
    return block;
  }

  /** Send a block (new OR updated — same seq) to the listeners. */
  private reemit(w: WatchedSession, block: FeedBlock): void {
    for (const l of this.blockListeners) {
      try {
        l(w.sessionId, block);
      } catch (err) {
        this.opts.log.error('block listener threw', { sessionId: w.sessionId, error: String(err) });
      }
    }
  }

  /** Derive Feed blocks (E12-06) from one transcript line. Tolerant: unknown
   *  shapes produce nothing, never a throw. */
  private deriveBlocks(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    const sidechain = full !== w.boundFile || e.isSidechain === true;
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const message = e.message as { content?: unknown; role?: string } | undefined;
    if (!message) return;
    if (e.isMeta === true) return; // CLI-internal lines are not conversation
    if (e.type === 'user') {
      // a real prompt is a string (or text items); tool_result items attach
      // their output to the originating tool block (E10-06 OUT sections).
      // <local-command-*> wrappers (slash-command stdout/caveats, often with
      // raw ANSI inside) are CLI plumbing, not conversation (Dan 2026-07-22).
      if (typeof message.content === 'string' && message.content.trim()) {
        if (isPlumbing(message.content)) return;
        this.emitBlock(w, { kind: 'user', text: message.content.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (Array.isArray(message.content)) {
        for (const c of message.content as Array<{
          type?: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
        }>) {
          if (c?.type === 'text' && c.text?.trim() && !isPlumbing(c.text)) {
            this.emitBlock(w, { kind: 'user', text: c.text.slice(0, TEXT_CAP), ts }, sidechain);
          } else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
            const target = w.toolBlocks.get(c.tool_use_id);
            if (target?.tool && !target.tool.out) {
              target.tool.out = toolResultText(c.content).slice(0, DETAIL_CAP);
              w.toolBlocks.delete(c.tool_use_id);
              this.reemit(w, target);
            }
          }
        }
      }
      return;
    }
    if (e.type !== 'assistant' || !Array.isArray(message.content)) return;
    for (const c of message.content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>) {
      if (c?.type === 'text' && c.text?.trim()) {
        this.emitBlock(w, { kind: 'assistant', text: c.text.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (c?.type === 'thinking' && c.thinking?.trim()) {
        this.emitBlock(w, { kind: 'thinking', text: c.thinking.slice(0, TEXT_CAP), ts }, sidechain);
      } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
        const input = c.input ?? {};
        // TodoWrite renders as a checklist block, not a raw tool row (E10-06)
        if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
          const todos = (input.todos as Array<{ content?: unknown; status?: unknown }>)
            .slice(0, 30)
            .map((td) => ({ content: String(td?.content ?? ''), status: String(td?.status ?? '') }));
          this.emitBlock(w, { kind: 'todos', todos, ts }, sidechain);
          continue;
        }
        const primary =
          input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.description ?? input.pattern;
        const summary = typeof primary === 'string' ? primary.slice(0, 120) : '';
        let detail: string | undefined;
        try {
          detail = JSON.stringify(input, null, 2)?.slice(0, DETAIL_CAP);
        } catch {
          detail = undefined;
        }
        const tool: NonNullable<FeedBlock['tool']> = {
          name: c.name,
          category: toolCategory(c.name),
          summary,
          detail,
        };
        // structured fields for the rich blocks (E10-06)
        if (typeof input.description === 'string') tool.description = input.description.slice(0, 120);
        if (typeof input.file_path === 'string') tool.filePath = input.file_path;
        if (typeof input.old_string === 'string') tool.oldString = input.old_string.slice(0, 1500);
        if (typeof input.new_string === 'string') tool.newString = input.new_string.slice(0, 1500);
        if (c.name === 'Write' && typeof input.content === 'string') {
          tool.newString = input.content.slice(0, 1500);
        }
        const block = this.emitBlock(w, { kind: 'tool', tool, ts }, sidechain);
        const useId = (c as { id?: unknown }).id;
        if (typeof useId === 'string') {
          w.toolBlocks.set(useId, block);
          // bounded: forget the oldest mappings past 200 in-flight calls
          if (w.toolBlocks.size > 200) {
            const first = w.toolBlocks.keys().next().value;
            if (first !== undefined) w.toolBlocks.delete(first);
          }
        }
      }
    }
  }

  private absorb(w: WatchedSession, full: string, e: Record<string, unknown>): void {
    if (full === w.boundFile && typeof e.sessionId === 'string' && !w.snap.nativeSessionId) {
      w.snap.nativeSessionId = e.sessionId;
    }
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
