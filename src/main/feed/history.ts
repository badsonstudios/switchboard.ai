// Replaying a resumed conversation's history into the Feed (#395).
//
// THE DEFECT THIS CLOSES. `--resume <id>` restores the model's context and
// re-sends none of it: a stream session's messages start at the NEXT turn. In
// Terminal mode that gap is covered twice — the PTY repaints, and the transcript
// watcher adopts the pre-existing JSONL and derives blocks from it. In Direct
// mode it was covered not at all: there is no terminal, and the watcher is told
// `deriveFeed: false` for a stream session so that two sources cannot interleave
// into one Feed. Every card that resumed after #381 therefore opened blank, with
// no Terminal tab to check against — indistinguishable from a wiped session,
// which is exactly how Dan read it on the 0.3.0 update.
//
// WHAT IT DOES. Reads the conversation's own transcript ONCE, at session start,
// and hands the entries to `StreamFeed.hydrate`, which derives blocks with the
// same `blocks.ts` derivation the watcher uses. The live stream then appends
// above them in the same buffer, in the same seq space.
//
// FAIL-OPEN THROUGHOUT (P6). No file, an unreadable file, a file full of
// garbage: the session starts anyway with the empty Session view it has today.
// A resumed card showing no history is a disappointment; a resumed card that
// will not start is a bug.
import fs from 'fs';
import { Logger } from '../log/logger';
import { conversationFile } from '../transcripts/paths';

/**
 * How much of a transcript's TAIL is read back, in bytes.
 *
 * BOUNDED, and read from the END, because this runs synchronously inside
 * `sessions:create` — on the boot path, once per resumed card, and a workspace
 * with a dozen long-lived cards would otherwise stall the main process behind
 * whatever those conversations happen to weigh. The watcher pays a similar cost
 * for a PTY session but pays it on its own poll tick, off the critical path.
 *
 * READING THE TAIL LOSES NOTHING THE FEED WOULD HAVE SHOWN in the ordinary
 * case: `FeedBuffer` keeps `BLOCK_CAP` (1000) blocks and evicts the oldest, so a
 * transcript big enough to be truncated here was going to be truncated there.
 * The number is deliberately generous against the pathological line — a single
 * tool result can run to hundreds of kilobytes — so that a conversation of big
 * outputs still replays a useful stretch of its recent past.
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
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return [];
  }
  if (size <= 0) return [];
  const from = Math.max(0, size - maxBytes);
  let text: string;
  let fd: number | null = null;
  try {
    // Read with the descriptor closed on EVERY path, including the throwing
    // one: on Windows an open handle PINS the user's transcript and the CLI
    // cannot rotate it (the #179 argument, made again in `watcher.ts`).
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    // Decoded whole, not chunk by chunk: this is one read of a file nobody is
    // appending to yet, so there is no boundary to split a character across.
    text = buf.toString('utf8', 0, n);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do about a failed close — see watcher.ts */
      }
    }
  }
  const lines = text.split('\n');
  // A tail read starts mid-line by construction; the fragment is not JSON and
  // must not be counted as a malformed transcript either.
  if (from > 0) lines.shift();
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
  return out;
}

/** Just enough of `StreamFeed` for this to be callable with a test double. */
export interface HydratableFeed {
  hydrate(sessionId: string, entries: readonly Record<string, unknown>[]): number;
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
    const entries = readTranscriptTail(file);
    const blocks = feed.hydrate(args.sessionId, entries);
    log.info('replayed the resumed conversation into the Feed', {
      sessionId: args.sessionId,
      nativeSessionId: args.nativeSessionId,
      entries: entries.length,
      blocks,
    });
    return blocks;
  } catch (err) {
    // P6: our breakage never blocks a session. The card starts either way.
    log.warn('could not replay the resumed conversation', {
      sessionId: args.sessionId,
      error: String(err),
    });
    return 0;
  }
}
