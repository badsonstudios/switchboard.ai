// Replaying a resumed conversation's history into the Feed (#395).
//
// THE DEFECT THIS CLOSES. `--resume <id>` restores the model's context and
// re-sends none of it: a stream session's messages start at the NEXT turn. In
// Terminal mode that gap is covered twice — the PTY repaints, and the transcript
// watcher adopts the pre-existing JSONL and derives blocks from it. In Direct
// mode it was covered not at all: there is no terminal, and the watcher does not
// derive a stream session's main transcript, so that two sources cannot
// interleave into one Feed. (Since #977 it does pick up that session's SUBAGENT
// files — and hands them to this Feed rather than buffering them, for the seq
// reason `hydrate` gives.) Every card that resumed after #381 therefore opened blank, with
// no Terminal tab to check against — indistinguishable from a wiped session,
// which is exactly how Dan read it on the 0.3.0 update.
//
// WHAT IT DOES. Reads the conversation's own transcript ONCE, at session start
// — and, since #1140, its subagent transcripts with it, merged in by time — and
// hands the entries to `StreamFeed.hydrate`, which derives blocks with the same
// `blocks.ts` derivation the watcher uses. The live stream then appends above
// them in the same buffer, in the same seq space.
//
// FAIL-OPEN THROUGHOUT (P6). No file, an unreadable file, a file full of
// garbage: the session starts anyway with the empty Session view it has today.
// A resumed card showing no history is a disappointment; a resumed card that
// will not start is a bug.
import { errorText } from '../../shared/error-text';
import fs from 'fs';
import path from 'path';
import { Logger } from '../log/logger';
import { conversationFile } from '../transcripts/paths';
import { agentOriginFor } from './agent-attribution';
import type { BlockOrigin, HydrateOptions } from './blocks';

/**
 * How much of a transcript's TAIL is read back, in bytes.
 *
 * BOUNDED, and read from the END, because this runs synchronously inside
 * `sessions:create` — on the boot path, once per resumed card, and a workspace
 * with a dozen long-lived cards would otherwise stall the main process behind
 * whatever those conversations happen to weigh. The watcher pays a similar cost
 * for a PTY session but pays it on its own poll tick, off the critical path.
 *
 * READING THE TAIL RARELY LOSES ANYTHING THE FEED WOULD HAVE SHOWN: `FeedBuffer`
 * keeps `BLOCK_CAP` (1000) blocks and evicts the oldest, so an ordinary
 * transcript big enough to be truncated here was going to be truncated there
 * anyway. The two budgets are not the same shape, though — a conversation of
 * huge tool results can hit the byte budget well short of 1000 blocks — which is
 * why the number is deliberately generous against the pathological line.
 */
export const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** The most recent transcript lines parsed, whatever the byte budget allowed. */
export const HISTORY_MAX_LINES = 5_000;

/**
 * Parse the tail of one JSONL transcript into entries, oldest first.
 *
 * Exported for its own tests. A line that does not parse is skipped rather than
 * counted: this is the same untrusted-output tolerance `deriveIntents` promises,
 * and the FIRST line is skipped outright when the read started mid-file, because
 * it is a fragment by construction.
 */
export function readTranscriptTail(
  file: string,
  maxBytes = HISTORY_TAIL_BYTES,
  maxLines = HISTORY_MAX_LINES
): Record<string, unknown>[] {
  return readTranscriptWindow(file, maxBytes, maxLines).entries;
}

/** What `readTranscriptWindow` read, and whether it reached the file's start. */
export interface TranscriptWindow {
  entries: Record<string, unknown>[];
  /**
   * The byte window began AFTER the start of the file, so there is older
   * history this read did not see. `false` for a file read whole, or one that
   * could not be read at all.
   *
   * Exists for the bus (#772), which reads a SMALL window first and grows it
   * only when the answer needs more — and has to know the difference between
   * "this is everything" and "this is all I looked at". The line budget is a
   * separate cut and the caller already knows it (`entries.length`).
   */
  cut: boolean;
  /**
   * The file was opened and its bytes decoded (#766).
   *
   * ⚠️ **`entries: []` HAS TWO MEANINGS AND THIS IS THE ONLY THING THAT TELLS
   * THEM APART.** A transcript that exists and is empty, and one that could not
   * be read at all — gone since the path was resolved, locked by another
   * process, on a share that dropped — produce a byte-identical result. Both
   * are fail-open here (P6), and for the Feed the distinction genuinely does
   * not matter: an empty conversation renders the same either way.
   *
   * It matters for #766, whose whole output is a CLAIM ABOUT A SESSION. A
   * package built on a failed read said "this covers the whole conversation"
   * over a document asserting the session had done nothing — which is #772's
   * lie ("a read that stopped short came back looking complete") in the one
   * document whose job is to brief another agent.
   *
   * `true` for a file that was read and happens to be empty; `false` only when
   * the read itself failed.
   */
  read: boolean;
}

/** `readTranscriptTail`, plus whether the window stopped short of byte 0. */
export function readTranscriptWindow(
  file: string,
  maxBytes = HISTORY_TAIL_BYTES,
  maxLines = HISTORY_MAX_LINES
): TranscriptWindow {
  // `read: false` on every failure path, `true` for a file that was read and
  // is simply empty — see `TranscriptWindow.read` for why those are different.
  const unread: TranscriptWindow = { entries: [], cut: false, read: false };
  const empty: TranscriptWindow = { entries: [], cut: false, read: true };
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return unread;
  }
  if (size <= 0) return empty;
  const from = Math.max(0, size - maxBytes);
  // ONE BYTE OF CONTEXT for a truncated read, so the cut can be classified
  // rather than assumed. `from` lands wherever the arithmetic put it, and that
  // is sometimes exactly the start of a line — dropping "the first line" blind
  // would then throw away a whole entry. Reading the byte BEFORE it turns the
  // question into "is there a newline here", and the same `slice` answers both
  // cases: at a boundary it removes only the newline, mid-line it removes the
  // fragment.
  const start = from > 0 ? from - 1 : 0;
  let text: string;
  let fd: number | null = null;
  try {
    // Read with the descriptor closed on EVERY path, including the throwing
    // one: on Windows an open handle PINS the user's transcript and the CLI
    // cannot rotate it (the #179 argument, made again in `watcher.ts`).
    fd = fs.openSync(file, 'r');
    // `allocUnsafe`: only `0..got` is ever decoded, so zeroing up to 4 MB per
    // resumed card buys nothing.
    const buf = Buffer.allocUnsafe(size - start);
    // LOOPED, because a short read costs the NEWEST line — the one the user
    // most wants to see. `readSync` is allowed to return less than asked for,
    // and a partial tail would leave the last entry an unparseable fragment.
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
      if (got >= buf.length) break;
    }
    // Decoded whole, not chunk by chunk: this is one read of a file nobody is
    // appending to yet, so there is no boundary to split a character across.
    text = buf.toString('utf8', 0, got);
  } catch {
    return unread;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do about a failed close — see watcher.ts */
      }
    }
  }
  if (from > 0) {
    // Everything up to and including the first newline belongs to a line that
    // started before the window — or is the boundary newline itself.
    const nl = text.indexOf('\n');
    text = nl < 0 ? '' : text.slice(nl + 1);
  }
  const lines = text.split('\n');
  const out: Record<string, unknown>[] = [];
  // Blanks are dropped BEFORE the cap, not inside the loop: a JSONL file ends
  // with a newline, so the split leaves an empty last element and a cap applied
  // to the raw array would silently spend one of its slots on it.
  for (const line of lines.filter((l) => l.trim() !== '').slice(-maxLines)) {
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e as Record<string, unknown>);
    } catch {
      /* a half-written or oversized line is not history we can show */
    }
  }
  return { entries: out, cut: from > 0, read: true };
}

/**
 * Parse the HEAD of one JSONL transcript into entries, oldest first (#766).
 *
 * ── WHY A SECOND DIRECTION EXISTS AT ALL ───────────────────────────────────
 *
 * Every other reader in this tree wants the newest end: the Feed hydrates what
 * the user is about to look at, the bus answers "what is my sibling doing now".
 * A context package (§5.5) wants one thing that is at the OTHER end of the
 * file — the **task statement**, i.e. the first prompt of the conversation. On
 * any session long enough to matter that line is nowhere near the tail, so a
 * generator built on `readTranscriptWindow` alone would quietly report
 * whatever the user happened to say four hundred turns in AS the goal, and
 * nothing about the answer would look wrong.
 *
 * ── THE MIRROR IMAGE, INCLUDING THE FRAGMENT ───────────────────────────────
 *
 * Same contract as `readTranscriptWindow` with both ends swapped. The partial
 * line is now the LAST one rather than the first, so that is the one dropped —
 * and `cut` correspondingly means "there is NEWER history past this window",
 * not older. A caller that reads both gets two windows it can describe
 * honestly; one that reads only this gets a beginning and knows it.
 *
 * No `maxBytes` overlap check with a tail read is attempted here: this function
 * knows nothing about the other one. `SessionQueries.sessionContext` is where
 * the two are combined, and it only ever takes the GOAL from this window
 * precisely so that overlap cannot double-count anything.
 */
export function readTranscriptHead(
  file: string,
  maxBytes: number,
  maxLines = HISTORY_MAX_LINES
): TranscriptWindow {
  const unread: TranscriptWindow = { entries: [], cut: false, read: false };
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return unread;
  }
  // A file that is genuinely empty was read, and has no newer history behind
  // the window because it has no history at all.
  if (size <= 0) return { entries: [], cut: false, read: true };
  const want = Math.min(Math.max(0, maxBytes), size);
  // `cut: TRUE` for a zero budget over a non-empty file, and the asymmetry with
  // the line above is the point. `cut` means "there is newer history past this
  // window" — a window of no bytes over a file with bytes in it has missed all
  // of them, so reporting `false` would assert completeness about a file this
  // call never opened. `read: false` for the same reason and by the field's own
  // definition: nothing was opened and no bytes were decoded. (Latent for #766,
  // which passes a constant budget; pinned so the next caller inherits a
  // contract that is true rather than convenient.)
  if (want <= 0) return { entries: [], cut: true, read: false };
  let text: string;
  let cut: boolean;
  let fd: number | null = null;
  try {
    // Descriptor closed on every path, including the throwing one — an open
    // handle PINS the user's transcript on Windows and the CLI cannot rotate
    // it (#179; `readTranscriptWindow` and `watcher.ts` make the same point).
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(want);
    // Looped for the same reason the tail read is: `readSync` may return short.
    // Here a short read costs the trailing line, which the cut rule below was
    // going to discard anyway — looped regardless, because "it only loses the
    // line we drop" is a property of the CURRENT rule and would stop holding
    // the moment that rule moved.
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
      if (got >= buf.length) break;
    }
    // Decoded whole. The window's END can land mid-character, so the decode
    // can produce U+FFFD there — and that is harmless HERE for a reason worth
    // stating rather than inheriting: a split character sits at the very end of
    // the buffer by construction, so nothing follows it, so the last newline
    // necessarily precedes it and the fragment cut below throws it away with
    // the partial line it belongs to. (The tail read makes the mirror argument
    // about its START.) A window that reached the end of the file has no such
    // boundary at all.
    text = buf.toString('utf8', 0, got);
    // `got`, not `want`: a read that came up short stopped before the end of
    // the file just as surely as the budget did, and its last line is just as
    // much a fragment.
    cut = got < size;
    if (cut) {
      // Everything after the last newline belongs to a line that continues past
      // the window. No newline at all means the window is one unfinished line,
      // and there is nothing in it to parse.
      //
      // DEFENCE IN DEPTH, and said plainly because a test cannot discriminate
      // it: the prefix of a JSON object is essentially never itself valid JSON,
      // so `JSON.parse` below would reject the fragment anyway and removing
      // these two lines breaks nothing observable. It stays because "a
      // truncated line never parses" is a property of JSON, not of this
      // function, and the cut is what makes the entry count mean "whole
      // entries" by construction rather than by luck.
      const nl = text.lastIndexOf('\n');
      text = nl < 0 ? '' : text.slice(0, nl);
    }
  } catch {
    return unread;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do about a failed close — see watcher.ts */
      }
    }
  }
  const out: Record<string, unknown>[] = [];
  // Blanks dropped BEFORE the cap, so the cap never spends a slot on the empty
  // element a trailing newline leaves behind (`readTranscriptWindow` again).
  // `slice(0, …)` rather than `slice(-…)`: the OLDEST lines are the point.
  for (const line of text.split('\n').filter((l) => l.trim() !== '').slice(0, maxLines)) {
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === 'object' && !Array.isArray(e)) out.push(e as Record<string, unknown>);
    } catch {
      /* a line we cannot parse is not history we can use */
    }
  }
  return { entries: out, cut, read: true };
}

/**
 * How much SUBAGENT transcript one replay reads, across all of a conversation's
 * subagent files, in bytes (#1140).
 *
 * The same budget as the main conversation and for the same reason: this runs
 * synchronously inside `sessions:create`. Spent newest file first, so what is
 * left out when it runs short is the oldest subagent work — the end of the
 * conversation the Feed's own 1,000-block cap evicts first anyway.
 */
export const HISTORY_SIDECHAIN_BYTES = HISTORY_TAIL_BYTES;

/** The most subagent files one replay opens. A session that ran more than this
 *  loses the oldest from its replayed history, never the newest. */
export const HISTORY_SIDECHAIN_FILES = 64;

/** One subagent transcript line, and which agent's file it came out of. */
export interface SidechainEntry {
  entry: Record<string, unknown>;
  origin: BlockOrigin;
}

/** A line's `timestamp` in epoch ms, or NaN when it has none we can read. */
function stampOf(entry: Record<string, unknown>): number {
  return typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
}

/** What `readSidechains` read, and what it left on disk. */
export interface SidechainBacklog {
  /** each file's lines in file order, newest file first */
  files: SidechainEntry[][];
  /** files not opened because every line in them predates `notBefore` */
  olderFiles: number;
  /** files not opened, or opened only in part, because the budget ran out */
  shortFiles: number;
  /** the bytes of those files this read did not cover */
  unreadBytes: number;
}

/** A remainder too small to be worth a file's last line or two (#1140 review):
 *  it would replay as an orphan fragment of a run with nothing before it. */
const SIDECHAIN_MIN_SLICE = 64 * 1024;

/**
 * The subagent transcripts of one conversation, each file's lines in file
 * order, newest file first (#1140).
 *
 * `<conversation>/subagents/agent-*.jsonl`, beside the main transcript — the
 * layout `TranscriptWatcher.subagentFiles` reads, spelled the same way so the
 * two cannot disagree about which files a conversation owns.
 *
 * `notBefore` is the first moment the replayed main conversation covers. A file
 * last written before it holds nothing the merge would keep, so it is not
 * opened at all — on a long conversation that is most of them, and this runs on
 * the boot path once per resumed card.
 *
 * Fail-open like everything else here: a directory that will not list is a
 * conversation with no subagents, and a file that will not read is skipped.
 */
export function readSidechains(
  mainFile: string,
  opts: { maxBytes?: number; maxFiles?: number; notBefore?: number } = {}
): SidechainBacklog {
  const maxBytes = opts.maxBytes ?? HISTORY_SIDECHAIN_BYTES;
  const maxFiles = opts.maxFiles ?? HISTORY_SIDECHAIN_FILES;
  const out: SidechainBacklog = { files: [], olderFiles: 0, shortFiles: 0, unreadBytes: 0 };
  const dir = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents');
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const files: Array<{ full: string; mtimeMs: number; size: number }> = [];
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    try {
      const st = fs.statSync(full);
      if (opts.notBefore !== undefined && st.mtimeMs < opts.notBefore) {
        out.olderFiles++;
        continue;
      }
      files.push({ full, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* gone since the listing — nothing to replay from it */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let budget = maxBytes;
  files.forEach((f, i) => {
    // Not opened at all: past the file cap, or what is left of the budget
    // would buy only the tail end of a run.
    if (i >= maxFiles || budget <= 0 || (budget < f.size && budget < SIDECHAIN_MIN_SLICE)) {
      out.shortFiles++;
      out.unreadBytes += f.size;
      return;
    }
    const entries = readTranscriptTail(f.full, budget);
    // Charged at what the window can have read: the file, or the budget.
    const read = Math.min(budget, f.size);
    budget -= read;
    if (read < f.size) {
      out.shortFiles++;
      out.unreadBytes += f.size - read;
    }
    if (entries.length === 0) return;
    out.files.push(
      entries.map((entry) => ({
        entry,
        origin: { sidechain: true, ...agentOriginFor(entry, true, f.full) },
      }))
    );
  });
  return out;
}

/**
 * The first moment a window of the MAIN conversation covers, or undefined.
 *
 * Read off the first `user` / `assistant` line and nothing else (#1140 review).
 * A main transcript is not monotonic — attachments and hook summaries are
 * routinely stamped minutes or hours behind the lines around them — and taking
 * the window's edge from one of those would admit subagent work from turns the
 * replay is not showing.
 */
export function firstTurnStamp(main: readonly Record<string, unknown>[]): number | undefined {
  for (const e of main) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const at = stampOf(e);
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

/** What `mergeHistory` hands to `hydrate`. */
export interface MergedHistory {
  entries: Record<string, unknown>[];
  origins: Map<Record<string, unknown>, BlockOrigin>;
}

/**
 * The main conversation and its subagent transcripts as ONE list, in the order
 * things happened (#1140).
 *
 * ── WHY A MERGE AT ALL ─────────────────────────────────────────────────────
 *
 * A live session shows a subagent's work where it ran: the watcher drains the
 * subagent's file while the turn that dispatched it is still open. A resumed
 * one used to get the main conversation first and then every subagent file
 * whole, appended after it — so the conversation ended on old subagent work
 * with its newest reply somewhere above. Merging by timestamp puts a replayed
 * conversation back in the order the live one was in.
 *
 * ── WHAT IS GUARANTEED ─────────────────────────────────────────────────────
 *
 * EACH FILE KEEPS ITS OWN ORDER, whatever its timestamps say. A line's time is
 * read as "no earlier than the line before it in the same file", so a missing
 * or out-of-order stamp can move a line relative to OTHER files but never past
 * its own neighbours. The main conversation in particular comes out exactly as
 * it went in.
 *
 * A subagent file's LEADING lines with no stamp take the file's first real one,
 * so they open the run they belong to rather than floating to the top of the
 * conversation. (The main conversation's are left at the top, where they are.)
 *
 * ON A TIE THE MAIN CONVERSATION GOES FIRST: the dispatching `Agent` call is a
 * main-conversation line, and a subagent's first line can share its
 * millisecond.
 *
 * `notBefore` is where a CUT main window begins (`firstTurnStamp`). Subagent
 * lines older than it are left out — they belong to turns the replay is not
 * showing, and would otherwise pile up at the very top with nothing around
 * them. Undefined for a conversation read whole: everything is kept.
 */
export function mergeHistory(
  main: readonly Record<string, unknown>[],
  sidechains: readonly (readonly SidechainEntry[])[],
  notBefore?: number
): MergedHistory {
  const origins = new Map<Record<string, unknown>, BlockOrigin>();
  if (sidechains.length === 0) return { entries: main.slice(), origins };
  interface Timed {
    entry: Record<string, unknown>;
    at: number;
    /** 0 = main; breaks a tie */
    rank: number;
    /** position within its own file */
    i: number;
  }
  const timed: Timed[] = [];
  const add = (entries: readonly Record<string, unknown>[], rank: number, floor: number): void => {
    entries.forEach((entry, i) => {
      const own = stampOf(entry);
      if (!Number.isNaN(own) && own > floor) floor = own;
      timed.push({ entry, at: floor, rank, i });
    });
  };
  add(main, 0, -Infinity);
  sidechains.forEach((file, f) => {
    const kept =
      notBefore === undefined ? file : file.filter((s) => !(stampOf(s.entry) < notBefore));
    for (const s of kept) origins.set(s.entry, s.origin);
    const first = kept.map((s) => stampOf(s.entry)).find((t) => !Number.isNaN(t));
    add(
      kept.map((s) => s.entry),
      f + 1,
      first ?? -Infinity
    );
  });
  // `-Infinity - -Infinity` is NaN, which `||` reads as "equal" and falls
  // through to the rank — the right answer for two lines with no time at all.
  timed.sort((a, b) => a.at - b.at || a.rank - b.rank || a.i - b.i);
  return { entries: timed.map((t) => t.entry), origins };
}

/** Just enough of `StreamFeed` for this to be callable with a test double. */
export interface HydratableFeed {
  hydrate(
    sessionId: string,
    entries: readonly Record<string, unknown>[],
    opts?: HydrateOptions
  ): number;
}

export interface ReplayResumedHistoryArgs {
  /** the LIVE session id — what the Feed is keyed by */
  sessionId: string;
  /** where this provider writes transcripts (the plan's `transcriptsRoot`) */
  projectsRoot: string;
  /** the session's project folder */
  folder: string;
  /** the conversation being resumed (the plan's `resumeSessionId`) */
  nativeSessionId: string;
  /** the clock, for a test that needs the replay to have happened "then" */
  now?: () => number;
}

/**
 * Replay the resumed conversation into a Direct session's Feed. Returns how
 * many blocks landed — 0 when there is nothing to replay, which is a perfectly
 * ordinary outcome (a card resumed on an id whose transcript the user deleted,
 * or a conversation the CLI never wrote a line for).
 *
 * The CALLER decides that this session is both a stream session and a resume;
 * this decides only what history there is.
 */
export function replayResumedHistory(
  feed: HydratableFeed,
  log: Logger,
  args: ReplayResumedHistoryArgs
): number {
  try {
    const file = conversationFile(args.projectsRoot, args.folder, args.nativeSessionId);
    if (!file) {
      // Not an error, and deliberately not a warning: `canResume` said yes a
      // moment ago, but the file can be gone by now, and a resumed session with
      // no history on disk simply starts with today's empty view.
      log.info('resumed conversation has no transcript to replay', {
        sessionId: args.sessionId,
        nativeSessionId: args.nativeSessionId,
      });
      return 0;
    }
    // BEFORE the reads, not after: a line written while they run must count as
    // live rather than be mistaken for backlog and dropped. (Nothing writes
    // during a resume — the CLI says nothing until its first turn — so this is
    // about which way the edge leans, not about a race anyone has seen.)
    const replayedAt = (args.now ?? Date.now)();
    const main = readTranscriptWindow(file);
    // The subagent transcripts too, merged in where they happened (#1140).
    // Left to the watcher they arrive AFTER this replay and land below the
    // newest message; `sidechainBacklogBefore` is what tells the Feed to
    // refuse them when the watcher offers them anyway.
    //
    // "Cut" by EITHER budget: the byte window says so itself, the line cap
    // does not, and a conversation trimmed by it has older turns missing just
    // the same.
    const cut = main.cut || main.entries.length >= HISTORY_MAX_LINES;
    const notBefore = cut ? firstTurnStamp(main.entries) : undefined;
    const backlog = readSidechains(file, { notBefore });
    const merged = mergeHistory(main.entries, backlog.files, notBefore);
    const blocks = feed.hydrate(args.sessionId, merged.entries, {
      origins: merged.origins,
      sidechainBacklogBefore: replayedAt,
    });
    log.info('replayed the resumed conversation into the Feed', {
      sessionId: args.sessionId,
      nativeSessionId: args.nativeSessionId,
      entries: main.entries.length,
      subagentEntries: merged.origins.size,
      // What a "my subagent run vanished after a restart" report needs: how
      // much subagent history this replay chose not to read. Absent when it
      // read all of it, which is the ordinary case.
      ...(backlog.olderFiles || backlog.shortFiles
        ? {
            subagentFilesOlder: backlog.olderFiles,
            subagentFilesShort: backlog.shortFiles,
            subagentBytesUnread: backlog.unreadBytes,
          }
        : {}),
      blocks,
    });
    return blocks;
  } catch (err) {
    // P6: our breakage never blocks a session. The card starts either way.
    log.warn('could not replay the resumed conversation', {
      sessionId: args.sessionId,
      error: errorText(err),
    });
    return 0;
  }
}
