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
// `tool.category === 'read'`: Read, Grep, Glob and LS, by main's own taxonomy
// (`shared/tool-taxonomy`). That category is stamped in main and is the same
// one the hold policy reads, so "is this call only looking" has one answer in
// the app. An edit, a subagent, a web search, an MCP tool is an EVENT and is
// never folded.
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
import type { FeedBlockDto } from './feed';

/**
 * The fewest consecutive calls worth folding.
 *
 * Three, not two: folding two rows into one saves a single line and costs a
 * click to read either of them. It also leaves a lone Read or a Read-then-Grep
 * exactly as it has always looked.
 */
export const FOLD_MIN = 3;

/** What a fold is a run OF. The two never share a run. */
export type FoldKind = 'explore' | 'shell';

/** One run of consecutive calls of one kind. */
export interface FoldRun {
  kind: FoldKind;
  /** the seq of the run's FIRST block — where the fold's row is drawn */
  head: number;
  /** every member's seq, in order, the head included */
  seqs: number[];
  /** Grep, Glob and LS: asking where something is */
  searches: number;
  /** Read: opening a file */
  reads: number;
  /** shell: how many commands ran (zero for an exploration run) */
  commands: number;
  /** the newest member's one-line header ("Grep src/lib"), for the closed row */
  latest: string;
}

/** Is this block a read-only exploration call? */
export function isExploration(b: FeedBlockDto): boolean {
  return b.kind === 'tool' && b.tool?.category === 'read';
}

/**
 * Which kind of fold this block can be part of, or null for an event.
 *
 * A shell command whose result came back an error answers null: see the header.
 */
export function foldKind(b: FeedBlockDto): FoldKind | null {
  if (b.kind !== 'tool') return null;
  if (b.tool?.category === 'read') return 'explore';
  if (b.tool?.category === 'shell' && b.tool.failed !== true) return 'shell';
  return null;
}

/** the one line a closed fold shows for its newest member */
function captionOf(b: FeedBlockDto, kind: FoldKind): string {
  if (kind === 'explore') return [b.tool?.name, b.tool?.summary].filter(Boolean).join(' ');
  // a command's own description says what it was FOR; without one, its first line
  const first = (b.tool?.summary ?? '').split(String.fromCharCode(10))[0];
  return b.tool?.description || first;
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
  min: number = FOLD_MIN
): Map<number, FoldRun> {
  const out = new Map<number, FoldRun>();
  let run: FeedBlockDto[] = [];
  let kind: FoldKind | null = null;
  const close = (): void => {
    if (kind !== null && run.length >= min) {
      const last = run[run.length - 1];
      const explore = kind === 'explore';
      out.set(run[0].seq, {
        kind,
        head: run[0].seq,
        seqs: run.map((b) => b.seq),
        reads: explore ? run.filter((b) => b.tool?.name === 'Read').length : 0,
        searches: explore ? run.filter((b) => b.tool?.name !== 'Read').length : 0,
        commands: explore ? 0 : run.length,
        latest: captionOf(last, kind),
      });
    }
    run = [];
    kind = null;
  };
  for (const b of visible) {
    const k = foldKind(b);
    if (k === null) {
      close();
      continue;
    }
    // a run is one kind and one speaker
    if (run.length > 0 && (k !== kind || !sameSpeaker(run[run.length - 1], b))) close();
    kind = k;
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
  min: number = FOLD_MIN
): FoldLayout<B> {
  const runs = foldRuns(visible, min);
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
