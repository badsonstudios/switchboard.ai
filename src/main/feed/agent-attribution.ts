// Which subagent produced a Feed block (#788, §5.10 "Subagent sidechains —
// folded behind an agent header, indented").
//
// WHY THIS EXISTS, AND WHY THE TICKET'S PREMISE NEEDED CORRECTING FIRST.
// #788 was filed saying two concurrent subagents "interleave into one indented
// run" because the CLI writes them into one transcript. Measured over 3,214
// transcripts (246,541 lines, CLI 2.1.226 → 2.1.261), that is not what happens:
//
//   - `isSidechain: true` appears ZERO times in a parent transcript. All
//     136,807 parent lines carrying the field carry it as `false`.
//   - All 68,997 `isSidechain: true` lines live in `subagents/agent-*.jsonl`,
//     and every one of those files holds exactly ONE `agentId` — 333 of 333,
//     no exceptions. Two agentIds never interleave inside a file.
//
// The CLI does not interleave them. **We do.** `TranscriptWatcher` tails every
// subagent file and drains all of them into one `FeedBuffer` in tail-arrival
// order, marking each block sidechain because `full !== w.boundFile`. So the
// symptom the ticket describes is real and lands exactly where it said — the
// mechanism is ours. The repo's own resolved open question #5 had already
// recorded the truth ("no interleaving problem (separate files)"), which is a
// reminder that a premise is worth re-reading before inheriting it.
//
// It is not hypothetical either: of 61 parent sessions with subagents, 34 ran
// two or more and 10 ran two whose time spans genuinely OVERLAP — up to 757
// seconds of it, and one session ran 58 subagents.
//
// TWO MEASUREMENTS SHAPE THE API BELOW.
//  1. `attributionAgent` is on `assistant` lines ONLY (35,287 of 35,287), while
//     `agentId` is also on `user` (22,506) and `attachment` (11,204) lines. A
//     subagent transcript OPENS with an unnamed `user` line, so a name resolved
//     per-block leaves the head of every run anonymous. The name is therefore
//     resolved per-RUN by the renderer, from whichever block in the run first
//     carries one — see `renderer/src/lib/feed-groups.ts`.
//  2. Two concurrently-running subagents can share a name: one measured session
//     ran three overlapping `deep-research-specialist`s. So the name alone does
//     not separate them and `agentId` is the grouping key, never the label.
//
// Probe: `spike/probes/788/`.
import path from 'node:path';

/** `agent-<id>.jsonl` inside a `subagents/` directory — the S-05 layout. */
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/i;

/** Blank and whitespace-only are the same as absent — never a group of their own. */
function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The `agentId` a transcript LINE declares, when it declares one.
 *
 * Present on 100% of subagent-file lines at 2.1.226+ and on none before it, so
 * `undefined` here is an old transcript rather than a malformed one — the
 * caller degrades to an unlabelled, ungrouped sidechain, which is exactly
 * today's behaviour.
 */
export function agentIdFromLine(line: Record<string, unknown>): string | undefined {
  return nonEmpty(line.agentId);
}

/**
 * The `agentId` a subagent transcript PATH names, when the path is one.
 *
 * The fallback for a pre-2.1.226 line, and the reason the grouping cannot come
 * apart mid-run: the FILE is the agent (measured 333/333), so even a line that
 * dropped the field still joins the run its file belongs to. Without this a
 * single fieldless line would break one run into two under the same name.
 */
export function agentIdFromPath(full: string): string | undefined {
  // `.match()`, not `.exec()` — identical for a non-global pattern, and
  // `context-package.test.ts` scans every module on the bus's default read path
  // for `\bexec\b` to prove none of them can start a process. A regex method
  // that shares a name with `child_process.exec` is a false positive there, and
  // the answer is to not write the word rather than to loosen a guard that has
  // to stay blunt to be worth anything. Do not "tidy" this back.
  const m = path.basename(full).match(SUBAGENT_FILE);
  if (!m) return undefined;
  if (path.basename(path.dirname(full)).toLowerCase() !== 'subagents') return undefined;
  return nonEmpty(m[1]);
}


/**
 * The longest agent name worth rendering. Real ones are short — the longest in
 * the corpus, `deep-research-specialist`, is 24 characters.
 */
const MAX_NAME = 64;

/** C0 and C1 controls, plus the Unicode line/paragraph separators. */
function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/**
 * The display name a line declares for its agent (`attributionAgent`).
 *
 * ⚠️ **SANITIZED AND CLAMPED, because this string leaves the app** (#788
 * review). `renderBlock` prepends it as `[subagent: <name>]` into text handed
 * to ANOTHER SESSION's model (`sessionOutput`, #764), where those brackets are
 * structure the reading model parses. A name carrying a newline forges a block
 * boundary in that text — the same class of defect `FeedView.forgery.test.tsx`
 * exists for, one layer further out.
 *
 * The clamp is not tidiness either: the tag is prepended AFTER the text caps
 * and repeats on every block of a run, so an unbounded name eats the
 * sibling-read budget and the tail slice throws away real conversation to make
 * room for it. It also stops the Feed's caption band growing without limit,
 * which is the same bug wearing a different hat.
 *
 * The name comes from a local agent definition file, so this is low likelihood
 * and not low consequence.
 *
 * ⚠️ **Built from CODE POINTS, and NOT from a character class typed into this
 * file.** A backslash-u or backslash-x escape written here through an editing
 * tool lands as the literal byte it names, which turns this file binary and
 * unreviewable; `node scripts/check-nul.js` runs inside `npm run lint` because
 * that has happened in this repo before, and it happened twice while writing
 * this very function. Do not "simplify" this into a regex literal.
 */
export function agentNameFromLine(line: Record<string, unknown>): string | undefined {
  const raw = nonEmpty(line.attributionAgent);
  if (raw === undefined) return undefined;
  let clean = '';
  // Iterating the string yields whole CODE POINTS, so an astral character is
  // one step rather than two surrogate halves. That matters for the clamp
  // below: `slice(0, MAX_NAME)` counts UTF-16 units and can cut a pair down
  // the middle, leaving a lone surrogate that reaches a reader as U+FFFD —
  // the same defect `sliceTail` guards at the other end of the string.
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    clean += cp !== undefined && isControl(cp) ? ' ' : ch;
    if (clean.length >= MAX_NAME) break;
  }
  clean = clean.trim();
  return clean === '' ? undefined : clean;
}

/**
 * The identity to stamp on a block derived from `line`.
 *
 * **ONE ANSWER TO THIS QUESTION, NOT TWO.** Both folds over transcript lines
 * call it — the watcher's live `deriveBlocks` and the readers' `blocksFrom`
 * (`sessions/transcript-blocks.ts`, whose own header says why those two must
 * not differ "in exactly the places a model notices"). `full` is optional
 * because only the watcher knows which FILE a line came out of; a reader
 * pointed at one transcript passes nothing and simply loses the fallback,
 * rather than growing a second, quieter copy of the gate below.
 *
 * ⚠️ **`sidechain` GATES IT, and that is not tidiness.** `agentId` was measured
 * zero times in a parent transcript, but "zero in this corpus" is not "never"
 * (#787's lesson: a measurement can harden into an invariant nobody declared).
 * If a future CLI ever stamped one on a main-conversation line, an ungated read
 * would file the session's own voice under a subagent header — the one outcome
 * worse than no header at all. The gate makes that unreachable rather than
 * unlikely, and it is what falsifies the measurement safely.
 *
 * A NAME is never returned without the id that groups it. Unreachable on
 * today's CLI, where all 35,287 named lines also carry an id — but a block
 * holding a name nothing can display is a field nothing bills, and the caption
 * is keyed on the id.
 */
export function agentOriginFor(
  line: Record<string, unknown>,
  sidechain: boolean,
  full?: string
): { agentId?: string; agentName?: string } {
  if (!sidechain) return {};
  const agentId = agentIdFromLine(line) ?? (full === undefined ? undefined : agentIdFromPath(full));
  if (!agentId) return {};
  const agentName = agentNameFromLine(line);
  return agentName ? { agentId, agentName } : { agentId };
}
