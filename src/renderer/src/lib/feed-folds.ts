// Folding a burst of looking-around into one row (#1130).
//
// The owner's screenshot: one research burst drawn as about twenty consecutive
// one-line boxes — Grep, Read, Glob, Grep, Grep… — filling two screens for what
// is, to the reader, ONE event: Claude looked around the code.
//
// So a run of consecutive read-only exploration calls becomes one row
// ("Explored the code · 14 searches, 5 files read"), and that row opens onto
// the individual calls exactly as they have always been drawn.
//
// ── WHAT FOLDS ─────────────────────────────────────────────────────────────
//
// (Plus `LSP`, since #1271, through the fold's own list: see `isExploration`.)
//
// `tool.category === 'read'`: Read, Grep, Glob and LS, by main's own taxonomy
// (`shared/tool-taxonomy`). That category is stamped in main and is the same
// one the hold policy reads, so "is this call only looking" has one answer in
// the app. A subagent, or a call of a kind that is not named in this file, is
// an EVENT and is never folded.
//
// ── AND RUNS OF COMMANDS, SINCE #1200 ───────────────────────────────────────
//
// #1130 left shell commands out on purpose ("output-bearing tools stay as
// individual blocks"). The owner then saw the result: "I just had about 12 in
// a row and they weren't grouped at all." So a run of consecutive
// `category === 'shell'` calls folds too, as its own KIND of fold ("Ran 12
// commands"). The two kinds never mix: a Read between two commands is the end
// of one run and the start of nothing.
//
// A COMMAND THAT FAILED IS NEVER FOLDED. That is the whole of the reason shell
// was left out before: a collapse that hides a red exit code behind "Ran 12
// commands" buries the one row you needed. So a failed command is an EVENT,
// like an edit: it ends the run before it and stands on its own, in full, with
// its own "failed" mark. Twelve commands with one failure in the middle are
// "Ran 5 commands", the failed one, "Ran 6 commands". Nothing about a failure
// is ever behind a click.
//
// (Only a COMMAND's failure does this. A Read of a file that is not there is
// marked failed too, and still folds into "Explored the code": a miss while
// looking around is part of looking around, and the ticket is about commands.)
//
// It is a property of the RESULT, so a command joins a run when it starts and
// leaves it if it fails: the fold it was in splits there. The folds are derived
// on every render (below), so that needs no bookkeeping.
//
// Measured before deciding (25 recent conversations on the owner's machine,
// 3,153 shell results): 2.4% failed; about a third of command runs were three
// or more long; the CLI's own error flag was on every result that printed an
// exit code and on the ones that failed without one.
//
// ── WHERE A RUN ENDS ───────────────────────────────────────────────────────
//
// At anything that is not one of those calls: a sentence of prose, an edit, a
// prompt. A burst with one assistant sentence in the middle reads as two folds
// around the sentence, never as one fold that swallowed it. A run also ends
// where the SPEAKER changes — the session to a subagent, or one subagent to
// another — because the caption that says who is speaking hangs off a block,
// and a fold spanning two speakers would put one's work under the other's name.
//
// Runs are found in the list AS RENDERED (after the verbosity filter), so what
// separates two calls is what the reader can see between them. On `normal` a
// hidden thinking block does not split a burst; on `firehose` it is on screen
// and does.
//
// ── DERIVED, NEVER STORED ──────────────────────────────────────────────────
//
// Like `feed-groups`: the list is upserted by seq and evicted at 1,000, so a
// stored grouping would describe a list that no longer exists. One pass.
//
// ── THREE MORE KINDS, SINCE #1271 ───────────────────────────────────────────
//
// The owner: "MCP plugin commands are still not grouped. I see in a session
// right now at least 20 MCP plugin calls in a row for Atlassian." Every MCP
// tool is `other`, and `other` never folded. A count over 3,913 transcripts
// found two more of the same shape: web searches and fetches (76% of them sit
// in a run of three or more) and edits (a thousand runs, the largest thing
// left). So:
//
//   mcp    consecutive calls to ONE server. "Atlassian · 20 calls", and then
//          every distinct tool that was called, with its count.
//   web    WebSearch and WebFetch together. "Searched the web · 4 searches,
//          6 pages", and then what was searched for and which sites.
//   edit   consecutive changes to ONE file (the owner chose this over "any
//          files"). "Edited FeedView.tsx · 5 changes".
//
// These three have a second boundary the first two do not: an MCP run is one
// SERVER and an edit run is one FILE. An Atlassian call followed by a GitHub
// call is two runs; so is an edit to a second file.
//
// AND THEY FOLD ONLY ONCE THEIR RESULT IS IN. A Read is done the moment it is
// asked for, near enough. An edit, a fetch and most MCP calls WAIT ON AN
// APPROVAL first, and a call that is waiting on a person must never be inside
// a closed row. A block's result is attached when it arrives (`tool.out`), so
// "has a result" is the whole test: until then the call is an ordinary row
// under the fold, and it joins when it is done. A result that came back an
// error, which is also what a DENIED call looks like, keeps it out for good
// and splits the run, exactly as a failed command does.
//
// THE CLOSED ROW OF AN MCP FOLD NAMES EVERY TOOL. Unlike Read and Grep, an MCP
// tool can change something, and whether it does is not knowable here: the
// server's own read-only hint reaches the app with its default already
// applied, so silence and "this changes things" look the same. Nothing is
// guessed from a tool's name. The row is the safeguard, and the RAREST tools
// are listed first, so the one `createJiraIssue` among nineteen lookups is the
// first thing on the row and not the part that is cut off on a narrow card.
import type { FeedBlockDto } from './feed';
import { FOLD_LOOKUP_TOOLS, mcpServerLabel } from '../../../shared/tool-fold';

/**
 * The fewest consecutive calls worth folding.
 *
 * Three, not two: folding two rows into one saves a single line and costs a
 * click to read either of them. It also leaves a lone Read or a Read-then-Grep
 * exactly as it has always looked.
 */
export const FOLD_MIN = 3;

/** What a fold is a run OF. No two kinds ever share a run. */
export type FoldKind = 'explore' | 'shell' | 'mcp' | 'web' | 'edit';

/** How many of one thing a run held: a tool's name and its calls. */
export interface FoldPart {
  name: string;
  count: number;
}

/** One run of consecutive calls of one kind. */
export interface FoldRun {
  kind: FoldKind;
  /** the seq of the run's FIRST block — where the fold's row is drawn */
  head: number;
  /** every member's seq, in order, the head included */
  seqs: number[];
  /** Grep, Glob and LS: asking where something is. web: searches made */
  searches: number;
  /** Read: opening a file. web: pages fetched */
  reads: number;
  /** shell: how many commands ran (zero for every other kind) */
  commands: number;
  /** the newest member's one-line header ("Grep src/lib"), for the closed row.
   *  Empty for the kinds whose row says what was called instead (`parts`). */
  latest: string;
  /**
   * mcp: the server, readably ("Atlassian"). edit: the file's name. Empty for
   * the other kinds, whose title is a fixed phrase.
   */
  subject: string;
  /** edit: the file's whole path as the call gave it. mcp: the server's name
   *  as the CLI spells it. Either way, the tooltip under `subject`. */
  path: string;
  /**
   * What the closed row lists after the count.
   *   mcp  every distinct tool called, rarest first, then by first appearance
   *   web  every distinct query and site, in order of first appearance
   * Empty for the other kinds.
   */
  parts: FoldPart[];
}

/** How paths are compared: see `foldRuns`. */
export interface FoldOptions {
  /** Windows and macOS: `Feed.tsx` and `feed.tsx` are one file */
  caseInsensitivePaths?: boolean;
}

/** Is this block a read-only exploration call? */
export function isExploration(b: FeedBlockDto): boolean {
  return (
    b.kind === 'tool' &&
    (b.tool?.category === 'read' || FOLD_LOOKUP_TOOLS.includes(b.tool?.name ?? ''))
  );
}

/** The file an edit call names, as main stamped it: `file_path`, or a
 *  notebook's path. (`filePath` for a block from before the stamp existed.) */
function editedPath(b: FeedBlockDto): string {
  return b.tool?.editPath ?? b.tool?.filePath ?? '';
}

/**
 * Which kind of fold this block's TOOL belongs to, whatever became of the
 * call: the family, before asking whether this particular call may fold.
 *
 * What `keepUnfolded` asks: a call the user has opened must not be folded away
 * when its result arrives, so it has to be recognised while it is still
 * running.
 */
export function foldFamily(b: FeedBlockDto): FoldKind | null {
  if (b.kind !== 'tool' || !b.tool) return null;
  if (isExploration(b)) return 'explore';
  if (b.tool.category === 'shell') return 'shell';
  if (b.tool.mcp) return 'mcp';
  if (b.tool.web) return 'web';
  if (b.tool.category === 'edit' && editedPath(b) !== '') return 'edit';
  return null;
}

/**
 * Which kind of fold this block can be part of, or null for an event.
 *
 * A call whose result came back an error answers null for every kind but
 * `explore`, and an MCP call, a web call or an edit with NO result yet answers
 * null too: see the header.
 */
export function foldKind(b: FeedBlockDto): FoldKind | null {
  const family = foldFamily(b);
  if (family === null) return null;
  // A result that carried a PICTURE is an event too (#1240): the thumbnail is
  // on the tool's own box, and "Explored the code" would put it out of sight.
  if ((b.tool?.pictures?.length ?? 0) > 0) return null;
  if (family === 'explore') return family;
  if (b.tool?.failed === true) return null;
  if (family === 'shell') return family;
  // waiting on an approval, or still running: not inside a closed row
  return b.tool?.out !== undefined ? family : null;
}

/**
 * What ELSE two members of a run must have in common, beyond their kind: the
 * server for an MCP call, the file for an edit. Empty for the kinds that have
 * no second boundary.
 */
function foldKey(b: FeedBlockDto, kind: FoldKind, opts: FoldOptions): string {
  if (kind === 'mcp') return b.tool?.mcp?.server ?? '';
  if (kind !== 'edit') return '';
  const insensitive = opts.caseInsensitivePaths === true;
  const known = pathKeys.get(b);
  if (known && known.insensitive === insensitive) return known.key;
  // the same file spelled two ways is one file: whichever way the slashes
  // lean, and whatever the case where the platform does not tell them apart
  const p = editedPath(b).split(String.fromCharCode(92)).join('/');
  const key = insensitive ? p.toLowerCase() : p;
  pathKeys.set(b, { key, insensitive });
  return key;
}

/**
 * An edit block's path key, worked out once per block.
 *
 * The folds are derived on every render, and a streamed chunk is a render: at
 * a thousand blocks that was a split, a join and a lower-casing per edit, per
 * chunk, for an answer that cannot change. Keyed on the block OBJECT, which
 * the Feed's list keeps for every block a chunk did not touch, and held
 * weakly, so an evicted block takes its entry with it.
 */
const pathKeys = new WeakMap<FeedBlockDto, { key: string; insensitive: boolean }>();

/** the one line a closed fold shows for its newest member */
function captionOf(b: FeedBlockDto, kind: FoldKind): string {
  if (kind === 'explore') return [b.tool?.name, b.tool?.summary].filter(Boolean).join(' ');
  // these three say what was called, in `parts` or in the title itself
  if (kind !== 'shell') return '';
  // a command's own description says what it was FOR; without one, its first line
  const first = (b.tool?.summary ?? '').split(String.fromCharCode(10))[0];
  return b.tool?.description || first;
}

/** the last name in a path, whichever way its slashes lean */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** distinct names with their counts, in order of first appearance */
function tally(names: readonly string[]): FoldPart[] {
  const at = new Map<string, FoldPart>();
  for (const name of names) {
    if (name === '') continue;
    const part = at.get(name);
    if (part) part.count += 1;
    else at.set(name, { name, count: 1 });
  }
  return [...at.values()];
}

/** what a closed row lists after its count */
function partsOf(run: readonly FeedBlockDto[], kind: FoldKind): FoldPart[] {
  if (kind === 'mcp') {
    // RAREST FIRST (a stable sort, so ties keep their first-appearance order):
    // the call that happened once is the one a reader must not miss
    return tally(run.map((b) => b.tool?.mcp?.tool ?? '')).sort((a, b) => a.count - b.count);
  }
  if (kind === 'web') {
    return tally(
      run.map((b) => {
        const web = b.tool?.web;
        if (!web) return '';
        return web.kind === 'search' ? web.query : web.host;
      })
    );
  }
  return [];
}

/** two blocks are the same speaker: both the session, or the same subagent */
function sameSpeaker(a: FeedBlockDto, b: FeedBlockDto): boolean {
  // `===` on the id, as `agentRunHeads` compares it: the fold and the caption
  // above it must agree about where one speaker stops
  return !!a.sidechain === !!b.sidechain && a.agentId === b.agentId;
}

/**
 * The runs worth folding in a rendered list, keyed by their head's seq.
 *
 * `visible` is the list the Feed is about to draw, in seq order.
 */
export function foldRuns(
  visible: readonly FeedBlockDto[],
  min: number = FOLD_MIN,
  opts: FoldOptions = {}
): Map<number, FoldRun> {
  const out = new Map<number, FoldRun>();
  let run: FeedBlockDto[] = [];
  let kind: FoldKind | null = null;
  let key = '';
  const close = (): void => {
    if (kind !== null && run.length >= min) {
      const last = run[run.length - 1];
      const explore = kind === 'explore';
      const web = kind === 'web';
      const server = kind === 'mcp' ? (run[0].tool?.mcp?.server ?? '') : '';
      const path = kind === 'edit' ? editedPath(run[0]) : server;
      out.set(run[0].seq, {
        kind,
        head: run[0].seq,
        seqs: run.map((b) => b.seq),
        reads: explore
          ? run.filter((b) => b.tool?.name === 'Read').length
          : web
            ? run.filter((b) => b.tool?.web?.kind === 'page').length
            : 0,
        searches: explore
          ? run.filter((b) => b.tool?.name !== 'Read').length
          : web
            ? run.filter((b) => b.tool?.web?.kind === 'search').length
            : 0,
        commands: kind === 'shell' ? run.length : 0,
        latest: captionOf(last, kind),
        subject:
          kind === 'mcp' ? mcpServerLabel(server) : kind === 'edit' ? baseName(path) : '',
        path,
        parts: partsOf(run, kind),
      });
    }
    run = [];
    kind = null;
    key = '';
  };
  for (const b of visible) {
    const k = foldKind(b);
    if (k === null) {
      close();
      continue;
    }
    const bKey = foldKey(b, k, opts);
    // a run is one kind, one speaker, and (for a server or a file) one of those
    if (run.length > 0 && (k !== kind || bKey !== key || !sameSpeaker(run[run.length - 1], b))) {
      close();
    }
    kind = k;
    key = bKey;
    run.push(b);
  }
  close();
  return out;
}

/** What the Feed draws once the folds are applied. */
export interface FoldLayout<B> {
  /**
   * The blocks that get a place in the list. A CLOSED fold keeps only its head
   * here — as the place its row is drawn, not as a block: see `folds`.
   */
  rendered: B[];
  /** head seq -> the fold drawn there, and whether it is open */
  folds: Map<number, FoldRun & { open: boolean }>;
}

/**
 * Apply the folds to a rendered list.
 *
 * `isOpen` is asked once per run. A CLOSED run's members other than its head
 * are left out of `rendered` altogether — not hidden, not nested. That is what
 * the Feed's off-screen skipping needs (`use-feed-skipping`: every block a
 * direct child of its group, and no block measured at zero), and it is also
 * the saving: twenty rows that are not on screen are twenty rows not rendered.
 */
export function applyFolds<B extends FeedBlockDto>(
  visible: readonly B[],
  isOpen: (run: FoldRun) => boolean,
  min: number = FOLD_MIN,
  opts: FoldOptions = {}
): FoldLayout<B> {
  const runs = foldRuns(visible, min, opts);
  const folds = new Map<number, FoldRun & { open: boolean }>();
  if (runs.size === 0) return { rendered: visible as B[], folds };
  const dropped = new Set<number>();
  for (const run of runs.values()) {
    const open = isOpen(run);
    folds.set(run.head, { ...run, open });
    if (!open) for (const seq of run.seqs) if (seq !== run.head) dropped.add(seq);
  }
  return {
    rendered: dropped.size === 0 ? (visible as B[]) : visible.filter((b) => !dropped.has(b.seq)),
    folds,
  };
}
