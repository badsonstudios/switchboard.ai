// What a held tool call looks like AS A DIFF (P2-E22-01, #972, §5.16).
//
// ── WHY THIS IS A PURE MODULE AND THE MONACO PART IS NOT ─────────────────────
//
// Everything interesting about putting a real diff in the approval card is a
// decision about a payload off the CLI: is this input diffable at all, what are
// its sides, in what order, and how much of it are we willing to render. None of
// that needs an editor, a DOM or a theme — so none of it lives in the component
// that has all three. `ApprovalDiffView` reads what this produces and draws it.
//
// That split is also what makes the interesting cases testable. The reason the
// panes this replaces were honest-but-useless is not something a screenshot
// shows; it is `MAX_CHARS = 1500` and a four-edit cap, both of which are
// arithmetic, and both of which are asserted here.
//
// ── THE 1500-CHAR CLIP IS GONE, AND WHAT REPLACED IT ────────────────────────
//
// `ToolInputPreview` clipped every field at 1500 characters and appended `…`.
// For a one-line edit that was honest and fast. For the multi-file change the
// card exists to review it was not a review surface, and #953's rule is the one
// it broke: **never silently truncate what a user is being asked to sign for.**
//
// The bound here is two orders of magnitude up, and when it bites it does not
// append an ellipsis — it reports, in `withheld`, exactly how many lines and
// characters are not on screen, so the card can say so. A bound is still needed:
// this runs in the renderer, on a string that arrives over IPC and that nothing
// on the CLI side promises to keep small, and a 40MB `content` would lock the
// window that is supposed to be asking a question.
//
// ── WHAT IS DELIBERATELY NOT DIFFED ─────────────────────────────────────────
//
// Only the tools that have two sides: `Edit`, `Write`, `MultiEdit`. A `Bash`
// command, a read, a `NotebookEdit`'s `new_source` — these have one side, and a
// diff editor showing "everything added" tells the reader less than a tinted
// pane does while costing a great deal more. Dispatch is by SHAPE and not by
// tool name, for the reason `ToolInputPreview`'s own header gives at length:
// `MultiEdit` has already disappeared from the published `sdk-tools.d.ts` while
// still being in the binary's edit set, and `NotebookEdit` keys its path
// `notebook_path`. Names move; shapes have been stable.

/** One change, in apply order, as two sides a diff editor can take. */
export interface DiffHunk {
  /** 1-based position in apply order — the caption the separator carries */
  index: number;
  /** how many changes there are in total, so a caption can say "2 of 5" */
  total: number;
  original: string;
  modified: string;
}

/** What a bound refused to render, so the card can say it out loud (#953). */
export interface Withheld {
  /** lines not on screen, counted the way a person counts them */
  lines: number;
  /** characters not on screen */
  chars: number;
  /** changes not rendered at all — a `MultiEdit` past `MAX_HUNKS` */
  changes: number;
}

export interface ApprovalDiff {
  /**
   * Which shape this came from. Drives the caption only — never whether a diff
   * is drawn, which is `hunks.length > 0`.
   *
   * `'write'` is the one worth naming: its original side is empty, so every line
   * reads as added, and a caption that said "changes" rather than "new contents"
   * would be describing a replacement that is not what a `Write` does.
   */
  kind: 'edit' | 'write' | 'multi-edit';
  /** in apply order; never empty */
  hunks: DiffHunk[];
  /** the file this is about, when the input names one — picks the language */
  path: string;
  /** null when everything in the payload is on screen */
  withheld: Withheld | null;
  /** entries of a `MultiEdit` array that were not a readable `{old,new}` pair */
  unreadable: number;
}

/**
 * The per-side character bound.
 *
 * 200,000 rather than 1,500, and the number is chosen against Monaco rather than
 * against taste: its diff editor carries its own `maxComputationTime` and gives
 * up on a diff it cannot finish, and its `maxFileSize` default is 50MB — so the
 * editor is not what this protects. What it protects is the string arriving over
 * IPC and being held in a React tree that re-renders with the feed: a `content`
 * measured in tens of megabytes is a locked window, and a locked window cannot
 * ask a question.
 *
 * 200k is ~2,500 lines of ordinary source. Nothing an agent writes in one tool
 * call comes near it, which is the point — the bound exists for the pathological
 * case, and the pathological case is told what it cost.
 */
export const MAX_SIDE_CHARS = 200_000;

/**
 * How many of a `MultiEdit`'s changes get rendered.
 *
 * Was 4 (`MAX_EDITS`), because four pane pairs stacked was ~440px in a band that
 * declares `flexShrink: 0` above the workspace. One scrolling editor does not
 * have that problem, so the cap is only about the diff computation: 40 hunks is
 * a genuinely large refactor and still one editor's work.
 *
 * The count of what was hidden is always shown — that is the half of the old
 * behaviour worth keeping, and it is why a cap is allowed to exist at all.
 */
export const MAX_HUNKS = 40;

/**
 * The bound on the WHOLE payload, spent across hunks in apply order.
 *
 * ⚠️ `MAX_SIDE_CHARS` ALONE DOES NOT BOUND A MULTIEDIT, which is why this exists
 * (found in review). That constant is per side per hunk, so 40 hunks × 2 sides ×
 * 200k is ~16M characters — and `joinHunks` would concatenate the lot into two
 * Monaco models. The `Edit` and `Write` paths were protected and the richest payload
 * the card has to review was not, which is the wrong way round.
 *
 * Spent IN ORDER, so what survives the budget is the beginning of the change rather
 * than an arbitrary subset, and whatever it cannot afford is reported — by line, by
 * character and by whole change — rather than silently dropped (#953).
 */
export const MAX_TOTAL_CHARS = 400_000;

/**
 * The separator between hunks, present IDENTICALLY on both sides.
 *
 * ⚠️ THIS IS THE LOAD-BEARING TRICK IN THIS FILE, so it is written down rather
 * than left to be discovered.
 *
 * A `MultiEdit` is N independent `{old_string, new_string}` pairs and the card
 * has to show them as N changes in apply order. Three ways to do that:
 *
 *  1. **One editor per change.** True separation, and it loses to this item's own
 *     done-when: N editors × 2 models each is layout and allocation on arrival,
 *     and "no new long task when an approval arrives" is the criterion.
 *  2. **Concatenate the sides.** This is the "one concatenated blob" the
 *     done-when rules out, and it is worse than it sounds: with nothing between
 *     them, Monaco's own diff will happily merge the tail of change 2 with the
 *     head of change 3 into a single hunk, and apply order stops being legible
 *     at all.
 *  3. **Concatenate, but put an identical line between them.** Monaco reads a
 *     line that matches on both sides as unchanged CONTEXT, which forces a hunk
 *     break exactly at the change boundary — and the line is a place to write
 *     which change is which. One editor's cost, N labelled hunks, apply order on
 *     screen.
 *
 * (3). The glyph is `─`, which no language uses as syntax, so the separator can
 * never be mistaken for something the agent proposed to write. It is scaffolding
 * and the caption says so; `old_string`/`new_string` were already fragments
 * rather than the file, and the panes never claimed otherwise either.
 *
 * ⚠️ AND A PAYLOAD CAN CONTAIN ONE. `rule` widens the dash runs, and `joinHunks`
 * asks `ruleWidthFor` for a width no change already has a line of — because a
 * payload line that matched would let Monaco align real content against the
 * scaffolding, which is the one way this trick can show the user a change that was
 * never proposed. It takes a documentation file that draws its own rules, and it is
 * cheap to rule out, which is a better trade than a comment saying it is unlikely.
 */
export function separatorFor(index: number, total: number, rule = 4): string {
  const dashes = '─'.repeat(Math.max(1, rule));
  return `${dashes} change ${index} of ${total} ${dashes}`;
}

/**
 * Lines the way a person counts them: a trailing newline ENDS the last line.
 *
 * The same rule and the same reason as `ToolInputPreview`'s `lineCount` — almost
 * every file an agent writes ends in a newline, and `split('\n').length` would
 * overstate the common case by one on the very number whose job is to tell the
 * user how big the thing they are signing for is. Counted rather than split
 * because it runs on strings that can be very large.
 */
export function lineCount(s: string): number {
  if (s === '') return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith('\n') ? n : n + 1;
}

/**
 * A bounded side, plus what bounding it cost.
 *
 * `allowance` is the smaller of the per-side cap and what is left of the whole
 * payload's budget, so one enormous hunk cannot spend the next thirty-nine's room.
 */
function bound(s: string, allowance: number): { text: string; lines: number; chars: number } {
  if (s.length <= allowance) return { text: s, lines: 0, chars: 0 };
  // Cut at a LINE, not mid-token: a diff whose last line is half an identifier
  // reads as a change that was never proposed. Falls back to the hard offset
  // when there is no newline to cut at, which is a minified file and is the one
  // case where there is nothing better to do.
  const hard = s.slice(0, Math.max(0, allowance));
  const nl = hard.lastIndexOf('\n');
  const text = nl > 0 ? hard.slice(0, nl + 1) : hard;
  const rest = s.slice(text.length);
  return { text, lines: lineCount(rest), chars: rest.length };
}

/** `input.edits` as pairs — see `ToolInputPreview.editPairs`, same rules. */
function editPairs(
  value: unknown
): { pairs: Array<{ at: number; old: string; next: string }>; total: number; unreadable: number } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const pairs: Array<{ at: number; old: string; next: string }> = [];
  let unreadable = 0;
  value.forEach((entry, i) => {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    if (e && typeof e.old_string === 'string' && typeof e.new_string === 'string') {
      // ⚠️ `at` IS THE POSITION IN THE CLI'S OWN ARRAY, not the position among the
      // readable ones, and the difference is the whole point of the counter beside
      // it. With entry 2 of 5 malformed, numbering the survivors 1..4 would label
      // the THIRD edit the CLI is going to apply as "change 2" — a caption about
      // apply order that is wrong about apply order. Numbering against the source
      // array instead leaves a visible gap (1, 3, 4, 5), which is a better thing
      // for the reader to see: it says WHERE the change nobody could read sits.
      pairs.push({ at: i + 1, old: e.old_string, next: e.new_string });
    } else {
      unreadable++;
    }
  });
  return pairs.length === 0 ? null : { pairs, total: value.length, unreadable };
}

/** The path an input names, in whichever key the tool spells it. */
function pathOf(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/**
 * A held tool call as a diff, or `null` when there is nothing to diff.
 *
 * `null` is the ordinary answer and not a failure: most held calls are a `Bash`
 * command or a read, and the caller renders the simple preview for those.
 *
 * ⚠️ `command` IS TESTED FIRST, and it has to be (found in review). Dispatch here
 * has to agree with `ToolInputPreview`'s, because that component is still the
 * FALLBACK — and it tests `command` before anything else. An input carrying both a
 * `command` and a `content` would otherwise render as a diff of the content in the
 * editor and as the command in the panes, which is one question answered two
 * different ways depending on whether Monaco happened to load. §5.16's rule about a
 * user who "reads one thing on one surface and another on the other" is the whole
 * reason the body is shared in the first place.
 *
 * After that, `edits` before `old_string`/`new_string` — the CLI treats the two as
 * mutually exclusive and strips the singular pair when the array is present, so an
 * input carrying both is a multi-edit.
 */
export function approvalDiff(input: Record<string, unknown>): ApprovalDiff | null {
  if (typeof input.command === 'string') return null;
  const path = pathOf(input);

  const edits = editPairs(input.edits);
  if (edits) {
    const hunks: DiffHunk[] = [];
    let lines = 0;
    let chars = 0;
    let changes = 0;
    let budget = MAX_TOTAL_CHARS;
    for (const pair of edits.pairs) {
      // Out of hunks, or out of budget: the rest are reported as whole changes
      // nobody can see rather than rendered as empty ones.
      if (hunks.length >= MAX_HUNKS || budget <= 0) {
        changes += 1;
        continue;
      }
      const a = bound(pair.old, Math.min(MAX_SIDE_CHARS, budget));
      budget -= a.text.length;
      const b = bound(pair.next, Math.min(MAX_SIDE_CHARS, Math.max(0, budget)));
      budget -= b.text.length;
      lines = Math.max(lines, a.lines, b.lines);
      chars += a.chars + b.chars;
      hunks.push({ index: pair.at, total: edits.total, original: a.text, modified: b.text });
    }
    return {
      kind: 'multi-edit',
      hunks,
      path,
      withheld: lines + chars + changes > 0 ? { lines, chars, changes } : null,
      unreadable: edits.unreadable,
    };
  }

  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const a = bound(input.old_string, MAX_SIDE_CHARS);
    const b = bound(input.new_string, MAX_SIDE_CHARS);
    // The WORST side, not the sum: they are two versions of one thing, and adding
    // them up can report more lines missing than the file has (review).
    const lines = Math.max(a.lines, b.lines);
    const chars = a.chars + b.chars;
    return {
      kind: 'edit',
      hunks: [{ index: 1, total: 1, original: a.text, modified: b.text }],
      path,
      withheld: lines + chars > 0 ? { lines, chars, changes: 0 } : null,
      unreadable: 0,
    };
  }

  if (typeof input.content === 'string') {
    // An EMPTY `Write` is not diffable, and falling through is the right answer
    // rather than an oversight: both sides would be empty, a diff editor would
    // render two blank panes, and `ToolInputPreview` already has a caption that
    // says the file is being written empty — which is the whole message.
    if (input.content === '') return null;
    const b = bound(input.content, MAX_SIDE_CHARS);
    return {
      kind: 'write',
      // Original side EMPTY on purpose. `Write` creates a file or replaces one
      // wholesale, and the renderer is holding a `tool_use` payload rather than
      // the disk — it does not know, and must not imply, what was there before.
      // Everything therefore reads as added, which is exactly what the payload
      // proves and no more (the same rule the `Write` caption obeys today).
      hunks: [{ index: 1, total: 1, original: '', modified: b.text }],
      path,
      withheld: b.lines + b.chars > 0 ? { lines: b.lines, chars: b.chars, changes: 0 } : null,
      unreadable: 0,
    };
  }

  return null;
}

/**
 * The two sides of a whole `ApprovalDiff`, joined for ONE editor.
 *
 * Single-hunk inputs get no separator at all — an `Edit` is one change and a
 * label saying "change 1 of 1" is noise on the surface with the least room. They
 * are also handed through BYTE-EXACT, including a missing trailing newline: with
 * no scaffolding in the editor, what it shows IS the payload, and normalising the
 * ending would show the user a file ending they are not being asked to approve
 * (#953). The trailing newline the multi-hunk join adds is scaffolding on both
 * sides, like the separators, so it misrepresents no individual change.
 */
export function joinHunks(diff: ApprovalDiff): { original: string; modified: string } {
  if (diff.hunks.length === 1) {
    return { original: diff.hunks[0].original, modified: diff.hunks[0].modified };
  }
  // Wide enough that no change already contains a line of it — see `separatorFor`.
  const rule = ruleWidthFor(diff.hunks);
  const original: string[] = [];
  const modified: string[] = [];
  for (const h of diff.hunks) {
    const sep = separatorFor(h.index, h.total, rule);
    // Each side's own trailing newline is dropped before joining. Left on, a
    // change that ends in one puts a blank line before the next separator and a
    // change that does not puts none — so the separators would sit at different
    // distances from the changes above them, which reads as meaning something.
    original.push(sep, trimEnd(h.original));
    modified.push(sep, trimEnd(h.modified));
  }
  // A trailing newline on each side: without it Monaco's last line is the last
  // line of the final change and a diff that ENDS on a change has nowhere to
  // draw the end of it.
  return {
    original: withTrailingNewline(original.join('\n')),
    modified: withTrailingNewline(modified.join('\n')),
  };
}

function withTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/** One trailing newline off, if there is one. See `joinHunks`. */
function trimEnd(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

/**
 * The narrowest dash run no hunk already contains a line of.
 *
 * See `separatorFor`: a payload line identical to a separator would let Monaco treat
 * real content as the scaffolding it aligns on, which is the one way this trick can
 * show the user a change that was never proposed. Widening makes a collision
 * impossible rather than merely unlikely — each step is a string the payload
 * demonstrably did not contain — and it gives up at a width no hand-written file
 * reaches, where the separator is still unique against everything checked.
 */
function ruleWidthFor(hunks: readonly DiffHunk[]): number {
  const lines = new Set<string>();
  for (const h of hunks) {
    for (const l of h.original.split('\n')) lines.add(l);
    for (const l of h.modified.split('\n')) lines.add(l);
  }
  for (let rule = 4; rule < 12; rule += 1) {
    if (!hunks.some((h) => lines.has(separatorFor(h.index, h.total, rule)))) return rule;
  }
  return 12;
}
