// Session find — the transcript search engine (P2-E17-01, §5.31).
//
// WHY THIS READS A FILE AND NOT THE SCREEN. Measured on the real transcript
// this module's fixture was captured from: 4,697 lines derive **1,579 blocks**
// against a `BLOCK_CAP` of 1,000, so ~37% of a long session is already gone from
// the renderer's view buffer — working as designed, since `watcher.ts` calls the
// Feed "a view buffer, not an archive". A find that searched what is rendered
// would answer "no results" for a string that is provably in the session, which
// is worse than shipping nothing: it teaches the user to distrust the one tool
// whose entire value is being trusted. So main scans the JSONL, which is the
// complete archive. (§5.31's table says 3,356 blocks / 70% for the same file;
// that figure counts `message.content` ITEMS, of which 1,235 are `tool_result`s
// that attach to a block rather than making one. See the fixture's header — the
// conclusion is the same, the number is not.)
//
// WHAT IT DOES NOT DO, stated rather than discovered:
//
//  * it scans the session's MAIN transcript, so the blocks a SUBAGENT FILE
//    contributes (`<session>/subagents/agent-*.jsonl`) are not searched. The
//    watcher interleaves those on whichever poll tick they arrive, so their
//    ordinal is a property of timing rather than of a file and no rescan could
//    reproduce it. Recorded as the epic's follow-up. Note the bound file's OWN
//    `isSidechain: true` lines ARE scanned — they are in this file, and
//    `alignToLoaded` knows to count them apart.
//  * a hit in a block the renderer has evicted is READABLE here but not
//    jump-to-able in place (the v1 boundary §5.31 records): it carries a snippet
//    and `earlierThanLoaded: true`, and no `seq`. This is the one remaining
//    reason a hit cannot be jumped to; the OTHER one — "this session's Feed came
//    from the stream, so nothing lines up" — is closed by `alignBySrcId` (#458).
//  * a `tool_result` whose `tool_use` has fallen out of the 200-entry
//    `AWAITING_CAP` map is not searched. It is not attached in the Feed either,
//    so a hit there would advertise output the user cannot reach.
//
// FAIL-OPEN throughout (§5.31 litmus 3): a missing transcript, an unreadable
// one, a malformed line, an uncompilable regex and a scan that runs past its
// deadline are all REPORTED as an empty or partial answer. Nothing here throws
// at its caller, because a failed search must leave the session untouched.
//
// THE ONE HAZARD THIS MODULE DOES NOT FULLY CLOSE, so that E17-02 decides it
// with its eyes open: **a user-supplied regex runs on the main thread**, and a
// backtracking pattern is unbounded there. Measured on this code before the
// screen below existed: `(a+)+$` against 60 characters held the main thread for
// **146 seconds** — every terminal, the watcher's poll and the whole UI dead for
// the duration. `unsafeRegexShape` refuses the shapes that do it by accident and
// `deadlineMs` bounds everything that is merely slow, but neither is a proof:
// `(a|a)*` is still exponential and still passes. The real fix is to run
// `scanOne` off the main thread (a `UtilityProcess` that can be terminated), and
// nothing calls this channel with `regex: true` until E17-02 puts a toggle in
// front of a user — which is the moment to do it.
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import {
  TranscriptHit,
  TranscriptQuery,
  TranscriptSearchGroup,
  TranscriptSearchRequest,
  TranscriptSearchResult,
} from '../../shared/transcripts';
// shared, because the renderer builds the same two clauses to PAINT what this
// counts (#520) — see `shared/find-matching.ts`
import { escapeLiteral, wholeWordBody } from '../../shared/find-matching';
import { BLOCK_CAP, FeedBlock, FULL_CAPS, IDENTITY_ONLY_CAPS, deriveIntents } from '../feed/blocks';

/** One session to scan, and what the renderer is holding for it. */
export interface SearchTarget {
  sessionId: string;
  /** the bound transcript, or null when the session has not got one */
  file: string | null;
  /**
   * The blocks the renderer currently has, newest last — `watcher.blocks()`.
   *
   * Used ONLY to turn a file ordinal into the live Feed `seq` E17-02 scrolls
   * to. Empty is fine and simply means no hit is jump-to-able.
   */
  loaded?: readonly FeedBlock[];
}

export interface SearchOptions {
  /** hits kept across the whole scope before `truncated` is set */
  limit?: number;
  /** characters of context either side of a match in the snippet */
  contextChars?: number;
  /** bytes per read; the engine yields to the event loop after each one */
  chunkBytes?: number;
  /** wall-clock ceiling on the whole search; past it, the answer is partial */
  deadlineMs?: number;
  /**
   * What "give the event loop a turn" means. Injectable because it is the seam
   * two of the done-when clauses are checked through: a test drives the
   * append-while-scanning case from here, and the main-thread budget is what
   * the default (`setImmediate`) exists to protect.
   */
  onChunk?: () => Promise<void> | void;
  /** clock, injectable so a timing assertion is not a race */
  now?: () => number;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_CONTEXT = 120;
const DEFAULT_CHUNK = 256 * 1024;

/**
 * How long a whole search may spend before it gives up and answers partially.
 *
 * Three seconds, against a measured 45ms for the largest real transcript on this
 * machine — i.e. ~65x headroom, so nothing a user does in anger reaches it and
 * everything that does is pathological. It is not a latency target; it is the
 * ceiling on how long a slow pattern over a wide scope may keep the main thread
 * busy in 4ms slices before the answer stops being worth the wait.
 */
const DEFAULT_DEADLINE = 3_000;

const DEADLINE_MESSAGE = 'the search ran out of time — these results are partial';

/**
 * How many tool calls may be waiting for their output at once.
 *
 * Deliberately `FeedBuffer.remember`'s number: a `tool_result` whose `tool_use`
 * has fallen out of that map does not reach the Feed either, so anchoring a hit
 * to it would advertise output the user cannot see when they jump.
 */
const AWAITING_CAP = 200;


/**
 * Does this pattern have the shape that backtracks exponentially?
 *
 * A QUANTIFIER APPLIED TO A GROUP THAT ALREADY CONTAINS ONE — `(a+)+`, `(a*)*`,
 * `(\s*)+`, `([a-z]+){2,}`. That is the shape somebody produces by accident, and
 * it is the one that took 146 seconds of main thread in the measurement above.
 *
 * DELIBERATELY NARROW, in both directions, and both are worth saying out loud:
 *
 *  - it does NOT refuse a quantified ALTERNATION. `(foo|bar)+` is an ordinary
 *    pattern and blows up only when the branches overlap (`(a|a)*`), which needs
 *    a real analysis rather than a scan. Refusing every `(x|y)+` would reject
 *    far more working patterns than it protects, and this is a find bar.
 *  - so it is NOT a safety proof. It is a guard rail on the cliff people walk
 *    off, and the header says what the actual fix is.
 *
 * Written as a scan rather than a regex on purpose: the thing being examined is
 * a regex, and matching one with another is how you get a second bug.
 */
export function unsafeRegexShape(pattern: string): boolean {
  const openGroups: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++; // whatever it escapes is a literal, quantifier characters included
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      openGroups.push(i);
      continue;
    }
    if (c !== ')') continue;
    const start = openGroups.pop();
    if (start === undefined) continue; // unbalanced; `new RegExp` will say so
    const next = pattern.slice(i + 1);
    const quantified = next.startsWith('*') || next.startsWith('+') || /^\{\d+,/.test(next);
    if (quantified && containsQuantifier(pattern.slice(start + 1, i))) return true;
  }
  return false;
}

/**
 * An unescaped `*`, `+`, `?` or open-ended `{n,}` outside a character class.
 *
 * `prev` starts at `(` because the body handed in here is what sat INSIDE one,
 * and that is exactly what distinguishes the `?` in `(?:err|warn)` — a group
 * prefix, and the commonest shape in any real pattern — from the `?` in `(a?)`,
 * which is a quantifier and does blow up under an outer `+`.
 */
function containsQuantifier(body: string): boolean {
  let inClass = false;
  let prev = '(';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      prev = '';
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      prev = c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      prev = c;
      continue;
    }
    if (c === '*' || c === '+') return true;
    if (c === '?' && prev !== '(') return true;
    if (c === '{' && /^\{\d+,/.test(body.slice(i))) return true;
    prev = c;
  }
  return false;
}

/**
 * The matcher for a query, or the reason it could not be built.
 *
 * `re: null` with no error is an EMPTY term — not a failure, just nothing to
 * look for. The bar clears its count and says nothing.
 */
export function compileMatcher(q: TranscriptQuery): {
  re: RegExp | null;
  error?: { code: 'bad-pattern'; message: string };
} {
  const term = typeof q.term === 'string' ? q.term : '';
  if (!term) return { re: null };
  if (q.regex && unsafeRegexShape(term)) {
    // Reported as a bad pattern rather than a new error code: from where the
    // user is standing this IS "that pattern will not do", and inventing a
    // second failure the bar has to render differently buys nothing. The
    // message says which shape and what to do about it.
    return {
      re: null,
      error: {
        code: 'bad-pattern',
        message:
          'a repeat inside a repeat (like "(a+)+") can take minutes to match — ' +
          'simplify the inner group',
      },
    };
  }
  const flags = q.caseSensitive ? 'g' : 'gi';
  let body = q.regex ? term : escapeLiteral(term);
  // Lookarounds rather than `\b`, and the reason is in `wholeWordBody`.
  if (q.wholeWord) body = wholeWordBody(body);
  try {
    return { re: new RegExp(body, flags) };
  } catch (err) {
    // The whole point of the clause: a user typing `(` into a regex find gets a
    // told-you-so, not an exception crossing the IPC boundary as a rejection.
    return { re: null, error: { code: 'bad-pattern', message: String((err as Error)?.message ?? err) } };
  }
}

/**
 * A cheap test against the RAW JSONL line, or null when one is not safe.
 *
 * The scan derives every line so its block ordinals stay in step with the Feed,
 * but only a line that could possibly contain the term needs its TEXT built —
 * and building the text of a tool call means a `JSON.stringify` of the whole
 * input, which is the most expensive thing derivation does.
 *
 * SOUNDNESS, since a false negative here is a missed hit. The transcript is
 * written by `JSON.stringify` (the CLI is a Node program), and that escapes
 * exactly `"`, `\` and the control characters inside a string while leaving
 * every other printable ASCII byte alone — a weaker claim than "JSON does",
 * which is false: a conforming producer may `\u`-escape anything it likes. So a
 * term of printable ASCII with neither quote nor backslash appears VERBATIM in
 * the raw line whenever it appears in any decoded string value. Anything else —
 * a regex, a path with a backslash, a term with a newline or a non-ASCII
 * character — gets no prefilter and every line is derived in full.
 *
 * Two more things the fast path rests on, both checked rather than assumed:
 * nothing this module builds JOINS two values with a character that could also
 * sit inside one (see the todos collect), so no match can span a boundary the
 * raw line does not have; and the numbers `flattenValues` re-stringifies come
 * out identical to the ones in the file, because `String(n)` and
 * `JSON.stringify(n)` are the same conversion. `search.test.ts` runs the same
 * terms down both paths over the real transcript, drawing them from the file's
 * own text so the awkward characters are in the sample.
 *
 * Word boundaries are deliberately dropped from the prefilter: it must be
 * permissive, and the real matcher applies them afterwards.
 */
function prefilterFor(q: TranscriptQuery): RegExp | null {
  if (q.regex) return null;
  const term = q.term ?? '';
  if (!term || !/^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(term)) return null;
  return new RegExp(escapeLiteral(term), q.caseSensitive ? '' : 'i');
}

/**
 * Every string and scalar inside a tool input, flattened for searching.
 *
 * The two guards are against a pathological input rather than a real one — a
 * tool call is two or three levels deep and a `MultiEdit`'s longest observed
 * argument list is in the hundreds. They sit far enough above that to be
 * unreachable in practice, which matters: anything they DID cut would be a
 * silent false negative in a tool that must not have any.
 */
function flattenValues(v: unknown, acc: string[], depth = 0): void {
  if (depth > 16 || acc.length > 50_000) return;
  if (typeof v === 'string') acc.push(v);
  else if (typeof v === 'number' || typeof v === 'boolean') acc.push(String(v));
  else if (Array.isArray(v)) for (const x of v) flattenValues(x, acc, depth + 1);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc.push(k);
      flattenValues(x, acc, depth + 1);
    }
  }
}

/**
 * A tool block's input as searchable text rather than as JSON.
 *
 * `tool.detail` is `JSON.stringify(input, null, 2)`, which means every backslash
 * in it is doubled and every newline is a literal `\n` — so searching it for
 * `C:\Projects\switchboard` or for a two-line snippet would find nothing on the
 * platform this app is developed on. Parsing it back and flattening the values
 * searches what the user actually sees when the block expands.
 */
function toolInputText(detail: string | undefined): string {
  if (!detail) return '';
  try {
    const acc: string[] = [];
    flattenValues(JSON.parse(detail), acc);
    return acc.join('\n');
  } catch {
    // Not round-trippable (a cap, a cycle) — the JSON text is still better than
    // nothing, escapes and all.
    return detail;
  }
}

/** What a hit needs to know about the block it belongs to. */
export interface BlockAnchor {
  /** ordinal among ALL blocks this file derives — what `blockIndex` reports */
  index: number;
  /**
   * Ordinal among the file's NON-SIDECHAIN blocks, which is the space alignment
   * works in, or undefined for a sidechain block.
   *
   * Two counters rather than one because the bound transcript can carry
   * `isSidechain: true` lines of its own — `watcher.ts` marks a block sidechain
   * when it comes from a subagent FILE *or* when the line says so — and the
   * watcher's `FeedBuffer` gives those a `seq` like any other while the Feed
   * keeps them visibly apart. Counting them in one number and then aligning
   * against `loaded.filter(b => !b.sidechain)` silently shifts every mapping
   * past the first such line, which is a jump to the wrong block: found in
   * review, and invisible to the fixture, whose 3,531 `isSidechain` fields are
   * every one of them `false`.
   */
  mainIndex?: number;
  kind: FeedBlock['kind'];
  ts?: string;
  toolName?: string;
  /** the message's own id for this block, when it had one — `FeedBlock.srcId` */
  srcId?: string;
}

/** A hit, plus the ordinal that resolves its `seq` once the file is aligned. */
interface PendingHit {
  hit: TranscriptHit;
  mainIndex?: number;
}

/** One session's scan state. */
interface ScanState {
  blocks: number;
  mainBlocks: number;
  /** the last BLOCK_CAP NON-SIDECHAIN anchors — what alignment compares */
  trail: BlockAnchor[];
  hits: PendingHit[];
  total: number;
}

function pushTrail(state: ScanState, a: BlockAnchor): void {
  // Sidechain anchors are deliberately not kept: they are not in `loadedMain`,
  // so they would only ever be a position the comparison has to skip.
  if (a.mainIndex === undefined) return;
  state.trail.push(a);
  if (state.trail.length > BLOCK_CAP) state.trail.shift();
}

/**
 * Line the file's block ordinals up with the renderer's `seq` numbers.
 *
 * The watcher pushes MAIN-transcript blocks in file order, so the non-sidechain
 * blocks it is still holding are the last K entries of the same sequence this
 * scan just derived. Anchoring on the newest of them and verifying a few more is
 * what turns that from an assumption into a check — and the check matters,
 * because the two readers are independent: the watcher may not have drained the
 * lines we just read, or a `/clear` may have reset its buffer mid-scan.
 *
 * Both sides are counted in NON-SIDECHAIN ordinals — `trail` holds only those
 * (see `pushTrail`) and `loadedMain` is the renderer's blocks with the sidechain
 * ones removed. The two sequences are then the same sequence, which is the whole
 * basis for the arithmetic below.
 *
 * TWO WAYS TO LINE THEM UP, tried in that order (#458).
 *
 * `alignByShape` is the original and reads the file's own timestamps back off
 * the rendered blocks. It is exact for a Feed the WATCHER built, and it cannot
 * work at all for one the STREAM built: a Direct session's blocks are stamped
 * with the moment the message reached us, because stream-json carries no
 * timestamp of its own. Since #381 Direct is the default transport, that made
 * §5.31's flagship gesture dead for most sessions.
 *
 * `alignBySrcId` is the answer, and it is a stronger join than the one it backs
 * up rather than a looser one: it matches on the ids the ANTHROPIC API put in
 * the message — which both sources receive, unchanged, in the same field.
 *
 * Returns the non-sidechain ordinal that `loadedMain[0]` corresponds to, or null
 * when the two cannot be lined up — in which case every hit is snippet-only.
 * Guessing would scroll the Feed to the wrong block, which is the same class of
 * lie as searching the DOM.
 */
export function alignToLoaded(
  trail: readonly BlockAnchor[],
  loaded: readonly FeedBlock[]
): { firstLoadedIndex: number; loadedMain: FeedBlock[] } | null {
  const loadedMain = loaded.filter((b) => !b.sidechain);
  if (loadedMain.length === 0 || trail.length === 0) return null;
  const found = alignByShape(trail, loadedMain) ?? alignBySrcId(trail, loadedMain);
  return found === null ? null : { firstLoadedIndex: found, loadedMain };
}

/** Tail-match on kind + timestamp + tool name. Exact for a watcher-built Feed. */
function alignByShape(
  trail: readonly BlockAnchor[],
  loadedMain: readonly FeedBlock[]
): number | null {
  const same = (a: BlockAnchor, b: FeedBlock): boolean =>
    a.kind === b.kind && a.ts === b.ts && (a.toolName ?? undefined) === (b.tool?.name ?? undefined);
  const last = loadedMain[loadedMain.length - 1];
  let found: number | null = null;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (!same(trail[i], last)) continue;
    // Verify a handful more before trusting it. One block matching on
    // kind+timestamp+tool name is common in a transcript (two `Read`s in the
    // same second); six in a row in the same order is not.
    const probes = Math.min(5, loadedMain.length - 1, i);
    let ok = true;
    for (let m = 1; m <= probes; m++) {
      if (!same(trail[i - m], loadedMain[loadedMain.length - 1 - m])) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const anchorAt = trail[i].mainIndex;
    if (anchorAt === undefined) continue; // `pushTrail` keeps none, belt and braces
    const firstLoadedIndex = anchorAt - (loadedMain.length - 1);
    if (firstLoadedIndex < 1) continue;
    // A SECOND candidate means we cannot tell which block the view is showing,
    // and the two answers differ by however far apart they sit — a jump to the
    // wrong block. Rare with real data (a transcript timestamps every line, so
    // six matching blocks in a row is effectively an identity), and the case it
    // guards is the one that matters: a couple of untimestamped blocks, where
    // "it matched" carries almost no information at all.
    if (found !== null) return null;
    found = firstLoadedIndex;
  }
  return found;
}

/**
 * Line the two up on BLOCK IDENTITY — the join that works on both transports.
 *
 * `FeedBlock.srcId` is `tool:<tool_use id>` or `msg:<message id>`: fields the
 * model's own API put in the message, which the CLI writes into the JSONL and
 * hands to a Direct session over stream-json inside the same `message` object.
 * Neither is ours and neither is a timestamp, which is exactly why they survive
 * the transport the shape match cannot.
 *
 * ONE MATCH IS AN ANCHOR, not a vote. A `tool_use` id is unique across the whole
 * conversation, so finding it on both sides fixes the offset outright — and the
 * offset is what makes every OTHER block jumpable too, prose and user prompts
 * included, none of which carry an id of their own.
 *
 * FOUR THINGS IT REFUSES rather than resolves, because a jump to the wrong
 * block is the lie this module exists to avoid:
 *
 *  - an id that appears TWICE in the file's trail — a message that produced
 *    several blocks, with only some of them still inside the window. "It
 *    matched" then does not say which one;
 *  - two ids that imply DIFFERENT offsets — the two sequences are not the same
 *    sequence, so no single arithmetic maps them;
 *  - an offset that would put `loadedMain[0]` BEFORE the file's first block.
 *    Conservative rather than protective, and deliberately so: see the note on
 *    the check itself;
 *  - an offset the surrounding blocks disagree with (`shapeAgrees`).
 *
 * `null` from any of them is the honest list-only answer §5.31 already ships.
 */
function alignBySrcId(
  trail: readonly BlockAnchor[],
  loadedMain: readonly FeedBlock[]
): number | null {
  /** srcId -> its ordinal in the file, or null once the id has been seen twice */
  const inFile = new Map<string, number | null>();
  /** ordinal -> the anchor, for the shape check below. Built in the same pass. */
  const byMainIndex = new Map<number, BlockAnchor>();
  for (const a of trail) {
    if (a.mainIndex === undefined) continue;
    byMainIndex.set(a.mainIndex, a);
    if (a.srcId === undefined) continue;
    inFile.set(a.srcId, inFile.has(a.srcId) ? null : a.mainIndex);
  }
  if (inFile.size === 0) return null;

  let firstLoadedIndex: number | null = null;
  for (let p = 0; p < loadedMain.length; p++) {
    const id = loadedMain[p].srcId;
    if (id === undefined) continue;
    const at = inFile.get(id);
    // `undefined`: not in the file's window at all — evicted from the trail, or
    // newer than the bytes we read, which for a stream session is ordinary (the
    // CLI writes the JSONL a beat after it says the same thing down the pipe).
    // `null`: ambiguous, see the docblock.
    if (at === undefined || at === null) continue;
    const candidate = at - p;
    if (firstLoadedIndex === null) firstLoadedIndex = candidate;
    else if (firstLoadedIndex !== candidate) return null;
  }
  // Below 1 puts `loadedMain[0]` before the file's first block. `alignByShape`
  // has drawn the same line since E17-01 and this matches it, but be clear
  // about what it costs: the arithmetic downstream would in fact survive a
  // negative offset, so this is CONSERVATIVE rather than protective. What it
  // refuses is a view holding MORE conversation at the front than the file
  // does — which is exactly a RESUMED Direct session, whose Feed is hydrated
  // from the previous conversation (#395) before the new transcript has a word
  // in it. Whether that is even reachable depends on whether `--resume` appends
  // to the same JSONL or starts a fresh one, which is a CLI contract nobody has
  // measured; refusing is the answer that cannot be wrong either way. See the
  // hand-off note for #458.
  if (firstLoadedIndex === null || firstLoadedIndex < 1) return null;
  return shapeAgrees(byMainIndex, loadedMain, firstLoadedIndex) ? firstLoadedIndex : null;
}

/**
 * Does every block the offset lines up actually look like its counterpart?
 *
 * The id fixes one position; this checks the rest of the window, on the two
 * properties both sources derive identically (`blocks.ts`). It is what catches a
 * Feed that holds a block the file does not — an interrupted turn whose tokens
 * were never written down, say — instead of shifting every hit past it by one.
 *
 * A block still taking tokens is SKIPPED, not compared: it has not finished
 * becoming itself. A `TodoWrite` call opens as an ordinary `tool` row on the
 * strength of `content_block_start` and only the message that follows reveals it
 * to be a `todos` checklist, so comparing mid-turn would refuse a perfectly good
 * alignment for the half-second that takes.
 */
function shapeAgrees(
  byMainIndex: ReadonlyMap<number, BlockAnchor>,
  loadedMain: readonly FeedBlock[],
  firstLoadedIndex: number
): boolean {
  for (let p = 0; p < loadedMain.length; p++) {
    const b = loadedMain[p];
    if (b.streaming === true) continue;
    const a = byMainIndex.get(firstLoadedIndex + p);
    if (!a) continue; // outside the window the file gave us — nothing to check
    if (a.kind !== b.kind) return false;
    if ((a.toolName ?? undefined) !== (b.tool?.name ?? undefined)) return false;
  }
  return true;
}

const defaultYield = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/**
 * Scan one session's transcript.
 *
 * Chunked, with a yield between chunks, because THIS IS THE THREAD THAT PUMPS
 * EVERY TERMINAL: node-pty's data callbacks and the watcher's 100ms poll both
 * run on the main event loop, so a single synchronous read-and-derive of a
 * multi-megabyte transcript would stall every session in the window while it
 * ran. See `search.test.ts` for the measured numbers.
 *
 * READS TO EOF RATHER THAN TO A SIZE TAKEN UP FRONT, which is what makes a
 * search of a file being appended to right now correct in both directions: the
 * reads are sequential from one descriptor so no byte is seen twice, and
 * stopping only when the descriptor says "nothing more" picks up whatever landed
 * during the scan instead of stopping at a stale `stat`. A trailing PARTIAL line
 * — the half-written record of a turn in flight — is dropped rather than parsed,
 * so it cannot be counted now and again when it is complete.
 *
 * It terminates because the reader outruns the writer by orders of magnitude: a
 * chunk is 256 KB off the page cache, and the thing appending is a CLI printing
 * a conversation. There is no ceiling on top of that, deliberately — a ceiling
 * is a silent truncation, which is the failure this whole module exists to
 * avoid, traded against a race nothing on this machine can win.
 */
async function scanOne(
  target: SearchTarget,
  re: RegExp,
  prefilter: RegExp | null,
  opts: Required<
    Pick<SearchOptions, 'limit' | 'contextChars' | 'chunkBytes' | 'now' | 'deadlineMs'>
  > & {
    onChunk: () => Promise<void> | void;
  },
  budget: { longestBlockMs: number; expired: boolean; deadlineAt: number }
): Promise<{ state: ScanState; searched: boolean }> {
  const state: ScanState = { blocks: 0, mainBlocks: 0, trail: [], hits: [], total: 0 };
  // No file, or the deadline went while an earlier session in the scope was
  // being scanned: either way this one was not searched, and `searched: false`
  // is what stops the bar reporting a confident 0 for it.
  if (!target.file || budget.expired) return { state, searched: false };

  let fd: number;
  try {
    fd = fs.openSync(target.file, 'r');
  } catch {
    // Gone, locked, mid-rotation. Not an error the user did anything about.
    return { state, searched: false };
  }

  /** tool_use id -> the block its output will attach to */
  const awaiting = new Map<string, BlockAnchor>();
  const remember = (id: string, a: BlockAnchor): void => {
    awaiting.set(id, a);
    if (awaiting.size > AWAITING_CAP) {
      const first = awaiting.keys().next().value;
      if (first !== undefined) awaiting.delete(first);
    }
  };

  const collect = (anchor: BlockAnchor, field: string, text: string): void => {
    if (!text) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let sinceCheck = 0;
    while ((m = re.exec(text)) !== null) {
      // The deadline, checked BETWEEN matches — every 64 of them, because a
      // clock read per match on a term like "e" is real work for no information.
      // It bounds a pattern that is merely slow (a lot of matches over a lot of
      // text); it cannot bound one whose single `exec` backtracks for minutes,
      // which is what `unsafeRegexShape` and the header's follow-up are for.
      if (++sinceCheck >= 64) {
        sinceCheck = 0;
        if (opts.now() >= budget.deadlineAt) {
          budget.expired = true;
          return;
        }
      }
      if (m[0].length === 0) {
        // A pattern that can match nothing (`a*`, `\b`) would otherwise spin on
        // one index for ever.
        re.lastIndex++;
        if (re.lastIndex > text.length) break;
        continue;
      }
      state.total++;
      if (state.hits.length >= opts.limit) continue;
      const start = Math.max(0, m.index - opts.contextChars);
      const end = Math.min(text.length, m.index + m[0].length + opts.contextChars);
      const prefix = start > 0 ? '…' : '';
      // Deliberately NOT whitespace-normalised: `matchStart` is an offset into
      // this exact string, and collapsing runs of spaces would move the match
      // out from under it.
      const snippet = prefix + text.slice(start, end) + (end < text.length ? '…' : '');
      state.hits.push({
        // Carried beside the hit rather than on it: this is the ordinal
        // alignment works in, and it has no meaning to the renderer.
        ...(anchor.mainIndex !== undefined ? { mainIndex: anchor.mainIndex } : {}),
        hit: {
          sessionId: target.sessionId,
          blockIndex: anchor.index,
          // Only ever set to true by a successful alignment that puts this block
          // before the window. Claiming it here would say "earlier in the
          // session" about a block that is on screen every time alignment fails.
          earlierThanLoaded: false,
          kind: anchor.kind,
          field,
          snippet,
          matchStart: prefix.length + (m.index - start),
          matchLength: m[0].length,
          ...(anchor.ts ? { ts: anchor.ts } : {}),
        },
      });
    }
  };

  const processLine = (line: string): void => {
    if (!line.trim()) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Tolerant reader, the watcher's own rule: a malformed line is skipped,
      // never thrown. It derives no blocks there either, so the ordinals stay
      // in step.
      return;
    }
    const interesting = prefilter === null || prefilter.test(line);
    // The watcher's own rule (`watcher.ts` → `deriveBlocks`), minus the half it
    // owns: a block is sidechain when its line says so, OR when it came from a
    // subagent file — and a subagent file is not this one.
    const sidechain = entry.isSidechain === true;
    for (const intent of deriveIntents(entry, interesting ? FULL_CAPS : IDENTITY_ONLY_CAPS)) {
      if (intent.t === 'tool-result') {
        const anchor = awaiting.get(intent.toolUseId);
        if (!anchor) continue;
        awaiting.delete(intent.toolUseId);
        if (interesting) collect(anchor, 'tool.out', intent.out);
        continue;
      }
      const b = intent.block;
      const anchor: BlockAnchor = {
        index: ++state.blocks,
        ...(sidechain ? {} : { mainIndex: ++state.mainBlocks }),
        kind: b.kind,
        ...(b.ts ? { ts: b.ts } : {}),
        ...(b.tool?.name ? { toolName: b.tool.name } : {}),
        // Carried whatever the caps were: identity is not text (`blocks.ts`).
        ...(b.srcId ? { srcId: b.srcId } : {}),
      };
      pushTrail(state, anchor);
      if (intent.toolUseId) remember(intent.toolUseId, anchor);
      if (!interesting) continue;
      if (b.text) collect(anchor, 'text', b.text);
      if (b.tool) {
        collect(anchor, 'tool.name', b.tool.name);
        // `tool.input` subsumes summary/description/filePath/old/new — they are
        // all fields of the same input object, so searching them separately
        // would report one match several times.
        collect(anchor, 'tool.input', toolInputText(b.tool.detail));
      }
      if (b.todos?.length) {
        // NEWLINE-separated, and that is the prefilter's rule showing through
        // rather than a formatting choice: the fast path is only sound because
        // a term that would span two joined values must contain a character
        // JSON escapes, which turns the prefilter off. Joining with a SPACE
        // would make `"ship it pending"` matchable here and invisible in the
        // raw line — a hit the fast path would silently skip.
        collect(anchor, 'todos', b.todos.map((t) => `${t.content}\n${t.status}`).join('\n'));
      }
    }
  };

  try {
    const buf = Buffer.allocUnsafe(opts.chunkBytes);
    const dec = new StringDecoder('utf8');
    let pending = '';
    let pos = 0;
    for (;;) {
      const chunkStart = opts.now();
      let n: number;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, pos);
      } catch {
        break;
      }
      if (n === 0) break;
      pos += n;
      // Through a decoder that lives as long as the scan (#194's lesson): a
      // chunk boundary lands wherever it lands, routinely in the middle of a
      // multi-byte character, and decoding each chunk on its own would turn that
      // character into replacement characters on both sides — silently changing
      // the text being searched.
      pending += dec.write(buf.subarray(0, n));
      // A cursor rather than re-slicing `pending` per line: a chunk holds ~100
      // lines and slicing off the front of a 256 KB string for each of them is
      // quadratic work for nothing. One slice per chunk.
      let from = 0;
      let nl: number;
      while ((nl = pending.indexOf('\n', from)) >= 0) {
        processLine(pending.slice(from, nl));
        from = nl + 1;
      }
      if (from > 0) pending = pending.slice(from);
      budget.longestBlockMs = Math.max(budget.longestBlockMs, opts.now() - chunkStart);
      // A deadline that has already gone stops the scan HERE rather than at the
      // end of the file: the answer is partial either way, and the difference is
      // whether the rest of the read is spent finding that out.
      if (budget.expired || opts.now() >= budget.deadlineAt) {
        budget.expired = true;
        break;
      }
      await opts.onChunk();
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // An open descriptor PINS the file on Windows (#179) — the close matters
      // more than knowing whether it worked.
    }
  }
  return { state, searched: true };
}

/**
 * Search a SCOPE — a list of sessions (§5.31's fourth decision).
 *
 * A list rather than an id because that is the entire seam §10's cross-session
 * search needs: the same engine with a longer list, and a result surface of its
 * own. The find bar passes one entry today.
 */
export async function searchTranscripts(
  targets: readonly SearchTarget[],
  request: TranscriptSearchRequest,
  options: SearchOptions = {}
): Promise<TranscriptSearchResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const opts = {
    limit: options.limit ?? DEFAULT_LIMIT,
    contextChars: options.contextChars ?? DEFAULT_CONTEXT,
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE,
    onChunk: options.onChunk ?? defaultYield,
    now,
  };
  const empty = (extra?: Partial<TranscriptSearchResult>): TranscriptSearchResult => ({
    hits: [],
    total: 0,
    truncated: false,
    groups: targets.map((t) => ({
      sessionId: t.sessionId,
      hits: 0,
      blocks: 0,
      searched: false,
      aligned: false,
    })),
    elapsedMs: now() - started,
    longestBlockMs: 0,
    ...extra,
  });

  const { re, error } = compileMatcher(request.query);
  if (error) return empty({ error });
  if (!re) return empty();

  const prefilter = prefilterFor(request.query);
  const budget = { longestBlockMs: 0, expired: false, deadlineAt: started + opts.deadlineMs };
  const hits: TranscriptHit[] = [];
  const groups: TranscriptSearchGroup[] = [];
  let total = 0;

  for (const target of targets) {
    // The limit is GLOBAL and spent in walk order rather than divided up front,
    // so a common term does not get a smaller allowance because the scope
    // happens to be wide. A later session is still scanned once the allowance is
    // gone — that is what keeps its `groups[].hits` count honest — it simply
    // stops keeping snippets.
    const remaining = Math.max(0, opts.limit - hits.length);
    const { state, searched } = await scanOne(
      target,
      re,
      prefilter,
      { ...opts, limit: remaining },
      budget
    );
    total += state.total;
    const alignment = alignToLoaded(state.trail, target.loaded ?? []);
    for (const pending of state.hits) {
      const hit = pending.hit;
      // A sidechain block has no `mainIndex`, so it never resolves to a seq: it
      // IS in the Feed, but which of the loaded sidechain blocks it is depends
      // on subagent files this scan never read.
      if (alignment && pending.mainIndex !== undefined) {
        const offset = pending.mainIndex - alignment.firstLoadedIndex;
        hit.earlierThanLoaded = offset < 0;
        const block = offset >= 0 ? alignment.loadedMain[offset] : undefined;
        if (block) hit.seq = block.seq;
      }
      hits.push(hit);
    }
    groups.push({
      sessionId: target.sessionId,
      hits: state.total,
      blocks: state.blocks,
      searched,
      aligned: alignment !== null,
    });
  }

  return {
    hits,
    total,
    truncated: total > hits.length,
    groups,
    elapsedMs: now() - started,
    longestBlockMs: budget.longestBlockMs,
    ...(budget.expired ? { error: { code: 'timed-out' as const, message: DEADLINE_MESSAGE } } : {}),
  };
}
