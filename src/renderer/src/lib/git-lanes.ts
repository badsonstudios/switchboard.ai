// The commit graph's geometry (E24 Git v2 item 3, §5.7) — mockup screen 6.
//
// A PURE FUNCTION over `{id, parentIds}` and nothing else. No React, no DOM, no
// git, no clock. That is what makes it testable at WIDTH: the interesting bugs in
// a lane allocator all live past lane 1, and a test that drives it through a
// mounted component can only reach the shapes a fixture repository happens to
// have.
//
// ⚠️ **WHY WE WRITE THIS AND DO NOT TAKE A LIBRARY** (design record §2.2):
// general DAG layout — `dagre`, `d3-dag` — is the wrong shape. A git lane is not
// a graph-drawing problem, it is a **topological walk with a lane-reservation
// scheme**: one pass, one array of "which commit is this lane waiting for". That
// is this file, and it is the only thing in Git v2 we draw ourselves rather than
// ask the real `git` binary for, because no CLI offers it (§5's litmus check).
//
// ⚠️ **THE INPUT MUST BE TOPOLOGICALLY ORDERED, PARENTS AFTER CHILDREN.** That is
// what `--topo-order` is in `LOG_FLAGS` for, and it is the one precondition this
// file cannot check cheaply. A date-ordered list interleaves two branches by
// timestamp, and the allocator would then open a fresh lane for a commit whose
// child it has not seen yet — drawing a history that is not the one in the
// repository. `allocateLanes` reports it rather than guessing: see `orphans`.

/** The one thing a commit has to be, to be laid out. */
export interface LaneCommit {
  id: string;
  parentIds: string[];
}

/**
 * One row's geometry. Everything the renderer needs and nothing it has to derive.
 *
 * The coordinate space is lane INDEXES, not pixels: the renderer multiplies by a
 * spacing it owns, so a narrow card can squeeze the gutter without this file
 * knowing what a pixel is.
 */
export interface LaneRow {
  /** the commit this row is */
  id: string;
  /** which lane its dot sits in */
  lane: number;
  /** its lane continues UP out of this row — i.e. a child above points here */
  up: boolean;
  /** its lane continues DOWN out of this row — i.e. it has a parent */
  down: boolean;
  /**
   * Lanes that pass straight through this row, top to bottom, untouched.
   *
   * Excludes this commit's own lane and every lane merging into it: those are
   * drawn as a dot and as curves, and a vertical line through them as well would
   * paint over the join.
   */
  pass: number[];
  /**
   * Lanes curving IN from above, into this commit's lane.
   *
   * One per extra child — a commit with two children is a fork, and in a
   * newest-first list the fork's two branches are *above* it, converging here.
   */
  merges: number[];
  /**
   * Lanes curving OUT below, from this commit's lane.
   *
   * One per extra parent, so a two-parent merge commit has exactly one. This is
   * the SECOND side of a merge: the first parent stays in this commit's own lane.
   */
  branches: number[];
}

/** What `allocateLanes` produces. */
export interface LaneLayout {
  rows: LaneRow[];
  /**
   * How many lanes the widest row needs — the gutter's natural width.
   *
   * At least 1 even for an empty history, so a caller sizing a column never gets
   * a zero it has to special-case.
   */
  lanes: number;
  /**
   * Commits that appeared with no lane waiting for them and no child above.
   *
   * ⚠️ **NOT AN ERROR, AND THE COUNT IS THE POINT.** The FIRST row is always an
   * orphan — nothing is above it — and so is the tip of every branch the window
   * includes, which is exactly right for `--all`. But a list that is NOT
   * topologically ordered produces orphans everywhere, and a caller that wants to
   * know whether it is drawing a real graph or a pile of disconnected stubs can
   * compare this against the number of branch tips it expects. It is reported
   * rather than asserted on, because "two branch tips" and "a date-ordered list"
   * are indistinguishable from inside one pass.
   */
  orphans: number;
}

/**
 * Lay out a commit list.
 *
 * ONE PASS, and the whole state is `waiting` — slot *i* holds the sha that lane
 * *i* is expecting next, or `null` when the lane is free. Everything else falls
 * out of that:
 *
 * - a commit lands in **the leftmost lane waiting for it**, and every other lane
 *   waiting for it is a merge arriving from above;
 * - a commit nothing is waiting for opens **the leftmost free lane**, which is
 *   what keeps a graph narrow instead of letting it drift right for ever;
 * - its **first parent inherits its lane**, which is what makes a branch read as a
 *   continuous line rather than as a staircase;
 * - every **extra parent** takes a lane already waiting for that parent if there
 *   is one, and a fresh one otherwise.
 *
 * ⚠️ **TWO LANES MAY LEGITIMATELY WAIT FOR THE SAME SHA**, and that is not a bug
 * to be de-duplicated — it is how a fork is represented until the shared parent
 * is reached. Collapsing them early would lose the second line.
 */
export function allocateLanes(commits: readonly LaneCommit[]): LaneLayout {
  /** slot i = the sha lane i expects next, or `null` for a free lane */
  const waiting: (string | null)[] = [];
  const rows: LaneRow[] = [];
  let lanes = 0;
  let orphans = 0;

  /** the leftmost free lane, growing the array only when there is none */
  const claim = (): number => {
    const free = waiting.indexOf(null);
    if (free !== -1) return free;
    waiting.push(null);
    return waiting.length - 1;
  };

  for (const commit of commits) {
    // Every lane expecting this commit. The leftmost is where the dot goes; the
    // rest are its other children's lines, arriving from above.
    const expecting: number[] = [];
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i] === commit.id) expecting.push(i);
    }

    // Which lanes were occupied BEFORE this row — read before anything is freed
    // or reassigned, because `pass` is a statement about the row's top edge.
    const occupiedBefore: number[] = [];
    for (let i = 0; i < waiting.length; i++) {
      if (waiting[i] !== null) occupiedBefore.push(i);
    }

    const up = expecting.length > 0;
    const lane = up ? expecting[0] : claim();
    if (!up) orphans++;
    const merges = expecting.slice(1);
    // The merged-in lanes end here. Freed BEFORE the parents are placed, so a
    // just-vacated lane can be reused by an extra parent instead of widening the
    // graph — which is most of why a real history stays three or four lanes wide.
    for (const m of merges) waiting[m] = null;

    const [firstParent, ...otherParents] = commit.parentIds;
    // THE FIRST PARENT INHERITS THE LANE. Without this every commit would start a
    // new lane and the graph would be a diagonal.
    waiting[lane] = firstParent ?? null;

    const branches: number[] = [];
    for (const parent of otherParents) {
      // A lane already waiting for this parent is where the curve goes — two
      // merges into the same commit share one line below, which is what the
      // repository actually looks like.
      const existing = waiting.indexOf(parent);
      // `!== lane` because a commit CAN name the same parent twice
      // (`commit-tree -p X -p X` is accepted), and a curve from a lane to itself
      // is a loop the renderer would draw as a smudge.
      if (existing !== -1 && existing !== lane) {
        branches.push(existing);
        continue;
      }
      if (existing === lane) continue;
      const fresh = claim();
      waiting[fresh] = parent;
      branches.push(fresh);
    }

    const pass = occupiedBefore.filter((i) => i !== lane && !merges.includes(i));
    rows.push({
      id: commit.id,
      lane,
      up,
      down: commit.parentIds.length > 0,
      pass,
      merges,
      branches,
    });
    lanes = Math.max(lanes, waiting.length);
  }

  return { rows, lanes: Math.max(1, lanes), orphans };
}

/**
 * How many lanes the gutter will actually DRAW.
 *
 * ⚠️ **THE ALLOCATOR IS UNCAPPED AND THE DRAWING IS NOT, DELIBERATELY.** A
 * history can need twenty lanes; a 90px gutter cannot show twenty. Capping inside
 * `allocateLanes` would mean two commits sharing a lane index — a graph that is
 * confidently wrong about which line is which — so the cap lives here, where it is
 * a drawing decision: lanes past it are drawn in the last column and the row says
 * so. Six is what fits at a readable spacing; it is also comfortably past what a
 * real `--topo-order` history of one branch needs (one or two).
 */
export const DRAWN_LANES = 6;

/** Is this lane index beyond what the gutter can distinguish? */
export function laneClamped(lane: number): boolean {
  return lane >= DRAWN_LANES;
}

/** Where a lane index sits, clamped into the drawn columns. */
export function laneColumn(lane: number): number {
  return Math.min(lane, DRAWN_LANES - 1);
}
