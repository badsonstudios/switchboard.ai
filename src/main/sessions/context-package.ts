// The Level-2 context package (P2-E11-09, §5.5) — built by reading, not by asking.
//
// WHAT §5.5 ASKS FOR: a structured handoff — goal, decisions, files touched,
// current state, key snippets — that gets injected into another session under a
// "Context from @A:" header, so B can pick up A's work without B's user copying
// anything across.
//
// ── WHY THE MECHANICAL VARIANT IS THE ONE BUILT FIRST ───────────────────────
//
// §5.5 lists three generators and calls this one the fallback: (a) mechanical
// extraction from the JSONL, (b) a headless `claude -p` pass, (c) ask A's own
// agent. It is built first for two reasons that outlive the ordering.
//
//   1. THE CANONICAL TRIGGER IS THE RATE-LIMIT CASE — "my five-hour window
//      drained mid-task, hand this off" — and that is precisely the moment both
//      of the other two generators are unavailable. The fallback is the only
//      rung that is there when the ladder is actually needed.
//   2. IT IS THE ONLY VARIANT THAT CAN BE TESTED. The same transcript produces
//      the same package, byte for byte, for ever; an LLM-written one is a
//      different document every time and "is it correct" stops being a question
//      a suite can answer.
//
// And a third, from #760's findings note: a headless `claude -p` probe run in a
// temp cwd with `--permission-mode bypassPermissions` went and enumerated the
// machine's other live sessions, read the user's transcripts, and sent messages
// to six sessions across four unrelated projects. A CWD IS NOT A SANDBOX. This
// module sidesteps that entirely by invoking nothing — see `NO MODEL RUNS HERE`
// below, which is asserted rather than promised.
//
// ── WHAT IT WILL AND WILL NOT CLAIM ─────────────────────────────────────────
//
// Four of §5.5's five sections are honestly mechanical: the task statement, the
// todo/plan state, the files touched, and the recent activity are all facts
// sitting in the file. **"Decisions" is not.** Recovering "we decided to use a
// named pipe because HTTP would re-admit the localhost class" from prose is the
// job of a language model, and a mechanical extractor that emitted a section
// titled "Decisions" would be putting a confident label on the nearest thing it
// could find. So the nearest thing it can find ships under its own name — the
// user's own later instructions, which is where a course correction is actually
// recorded — and §5.5's honesty rule ("a briefed continuation, never a
// resumption") is applied to the package's own headings, not just to the UI.
//
// ── NO MODEL RUNS HERE, AND THAT IS A TESTED PROPERTY ───────────────────────
//
// The done-when is "no LLM is invoked on the default path. Assert it." This
// module therefore takes no dependency that could invoke one: it is a pure
// function of entries in and text out, it spawns nothing, it opens no socket,
// and `context-package.test.ts` asserts all of that against the source text the
// way `queries.test.ts` asserts transport-freedom. A summarizer that quietly
// spent the user's subscription tokens on chrome is the P7 violation §5.11
// already refused once.
//
// ── BYTE-STABILITY IS A CONSTRAINT ON THE CODE, NOT JUST A TEST ─────────────
//
// "The same transcript yields the same package" rules out more than it sounds
// like. No `Date.now()` (a generated-at stamp would break it on the second
// run), no `Math.random()`, no iteration over a plain object's keys or a `Set`
// where insertion order is not the intended order, and — the one that is easy
// to miss — **no `toLocaleString`/`Intl`**: a thousands separator is a property
// of the machine's locale, so `1,234` here and `1.234` there is the same
// package rendering differently on two of the user's computers. Numbers are
// formatted by hand. Timestamps that appear in the output come FROM THE
// TRANSCRIPT, which is stable by construction.
import { DerivationCaps, FeedBlock, TEXT_CAP, touchedPath } from '../feed/blocks';
import { blocksFrom, renderBlock, sliceTail } from './transcript-blocks';
// TYPE-ONLY, and it has to stay that way: `queries.ts` imports this module for
// `sessionContext`, so a VALUE import here would close a runtime cycle between
// them. A type import is erased.
import type { SessionSummary } from './queries';

/**
 * How much of each field the package's derivation keeps.
 *
 * A profile of its own rather than `DISPLAY_CAPS`, because a handoff document
 * and a scrolling view want different things from the same line, and
 * `DerivationCaps` exists precisely so that wanting different things does not
 * mean writing a second extractor (see `blocks.ts`).
 *
 *  - `summary: 200` against the Feed's 120. The summary of a `Bash` block is
 *    the command, and 120 characters truncates a real one mid-flag — on screen
 *    that is fine because the row can be opened, but a handoff has no rows to
 *    open.
 *  - `detail: 600` against the Feed's 4000. A tool's OUTPUT is the single
 *    largest thing in a transcript and almost none of it briefs anybody; what
 *    is worth carrying is the shape of the result ("2 files changed", the first
 *    line of a stack trace). 0 would have been cheaper still and was rejected:
 *    it would silently blank the `-> …` half of every tool line in the recent
 *    activity section, which is where a failure announces itself.
 *  - `todos: 100` against the Feed's 30. The plan is a whole SECTION here, and
 *    a checklist quietly cut at 30 items would hand the next session a plan
 *    whose remaining work had been removed from it.
 *  - `edit: 0`. `oldString`/`newString` exist for the inline diff preview the
 *    renderer draws. Nothing in this file reads them, and building them would
 *    copy up to 1500 characters per edit for no reader.
 */
export const PACKAGE_CAPS: DerivationCaps = {
  text: TEXT_CAP,
  detail: 600,
  summary: 200,
  edit: 0,
  todos: 100,
};

/** The task statement's budget — a long opening brief is worth carrying whole. */
export const GOAL_CHAR_CAP = 2_000;

/** Each later instruction, individually. */
export const INSTRUCTION_CHAR_CAP = 600;

/** How many later instructions are carried, newest last. */
export const MAX_INSTRUCTIONS = 6;

/**
 * One todo item's budget, and the section's.
 *
 * `PACKAGE_CAPS.todos` bounds how MANY items the derivation keeps and nothing
 * bounds how long one is — `asDisplayString` does not cap the content. Review
 * measured the hole: 100 items of 10 KB each produced a **1,001,520-character**
 * plan section, ~250,000 estimated tokens, from a single `TodoWrite`. Every
 * other section is bounded; a handoff that can outweigh the transcript it
 * summarises defeats §5.5's entire premise, so this one is bounded twice —
 * per item, so one pathological entry cannot eat the list, and overall.
 */
export const TODO_ITEM_CHAR_CAP = 300;
export const PLAN_CHAR_CAP = 4_000;

/** How many files are listed before the rest becomes a count. */
export const MAX_FILES = 60;

/** The recent-activity section's budget, cut from the front. */
export const SNIPPET_CHAR_CAP = 6_000;

/** How many blocks the recent-activity section draws from. */
export const SNIPPET_BLOCKS = 24;

/** Marks recent activity cut at the front, so a reader knows it holds a tail. */
export const ACTIVITY_TRIM_MARKER = '…[earlier activity trimmed]';

/** "Where it left off" — the last thing the assistant actually said. */
export const STATE_CHAR_CAP = 2_000;

/**
 * Characters per token, for the ESTIMATE this module reports.
 *
 * FOUR is the standard rule of thumb for English prose under a BPE tokenizer
 * and it is wrong in both directions here: source code and file paths tokenize
 * worse than prose (nearer 3), long natural-language passages better (nearer
 * 4.5). It is used anyway, and called an estimate everywhere it surfaces,
 * because the alternative is shipping a tokenizer — a dependency, a model
 * version to track, and a number that would still be an approximation of what
 * the *target* model does with the text.
 *
 * WHAT THE NUMBER IS FOR: §5.5's drop dialog offers "last response | summary
 * handoff | full excerpt" with sizes shown per option, so the user can see that
 * one of them will eat a third of the session they are dropping it into. An
 * order of magnitude is the whole job; two significant figures are not.
 */
export const CHARS_PER_TOKEN = 4;

/** An order-of-magnitude size for a piece of text. Never a token COUNT. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The sections a package carries, in the order they are rendered. */
export type SectionId = 'goal' | 'instructions' | 'plan' | 'files' | 'activity' | 'state';

export interface PackageSection {
  id: SectionId;
  /** The heading, written to say what the content actually IS (see header). */
  title: string;
  /** The rendered body. Empty when the transcript held nothing for it. */
  text: string;
  /** An estimate of `text`, never a count. */
  tokens: number;
  /**
   * THIS SECTION dropped something it had — too many files, too many
   * instructions, a body over its cap. It does NOT mean the window was short:
   * that is `ContextPackage.coverage`, and conflating the two would let a
   * package report "complete" because each of its sections fitted.
   */
  truncated: boolean;
}

export interface ContextPackage {
  session: SessionSummary;
  /**
   * How much of the conversation this package actually saw.
   *
   * #772's lesson, applied before it can be made again: a read that stopped
   * short used to come back looking complete, and a handoff is the worst place
   * for that — the next session is being told this is the state of the work.
   * Rendered into the document itself, not just carried on the object, because
   * the reader that most needs it is a model that will never see this field.
   *
   *  - `'whole'` — the read reached the start of the file.
   *  - `'recent'` — it did not; there is older history this does not cover.
   *  - `'unreadable'` — the session HAS a transcript and it could not be read
   *    (gone since the path was resolved, locked, a share that dropped). Its
   *    own value rather than `'recent'`, because "here is the recent part" is
   *    as false as "here is all of it" when the answer is "here is none of it":
   *    every section would read as "the session has done nothing", which is a
   *    statement about the work rather than about the read. A session that has
   *    no transcript AT ALL is a different and normal state, and is `'whole'` —
   *    there is genuinely nothing to have missed.
   */
  coverage: 'whole' | 'recent' | 'unreadable';
  sections: PackageSection[];
  /**
   * The sum of the section estimates — the CONTENT, not the document.
   *
   * `renderPackage` adds headings, a preamble and the session's own details on
   * top of this, so the rendered string estimates a few hundred tokens higher.
   * Stated rather than quietly fixed up, because the two numbers answer
   * different questions: this one is what the drop dialog compares against the
   * other fidelity options (§5.5), and `estimateTokens(renderPackage(pkg))` is
   * what actually lands in the target's context window.
   */
  tokens: number;
}

/** Everything the builder needs. No file handles, no clock, no network. */
export interface PackageSource {
  session: SessionSummary;
  /** The read window's entries, oldest first. */
  entries: readonly Record<string, unknown>[];
  /**
   * The conversation's opening prompt, when the window did not reach it.
   *
   * The task statement is the one fact that lives at the START of the file, and
   * on a long session the tail window is nowhere near it. The caller reads a
   * small head window for this and passes ONLY this — see
   * `SessionQueries.sessionContext`, where taking anything else from that window
   * would risk double-counting against an overlapping tail.
   */
  goalFromHead?: string;
  /** The window began after the file's start — there is older history unread. */
  cut: boolean;
  /**
   * The session has a transcript and it could not be read at all.
   *
   * Distinct from `entries: []`, which is also what a brand-new session looks
   * like. See `ContextPackage.coverage`.
   */
  unreadable?: boolean;
}

/** Which verbs a tool implies for the file it names. */
function verbFor(tool: string): string {
  if (tool === 'Edit' || tool === 'NotebookEdit' || tool === 'MultiEdit') return 'edited';
  if (tool === 'Write') return 'wrote';
  if (tool === 'Read' || tool === 'NotebookRead') return 'read';
  // Glob, LS, Grep and anything else that names a `path`: it was looked at, and
  // claiming more than that would be inventing an edit that never happened.
  return 'looked at';
}

/**
 * Verbs in a FIXED order, not the order they happened.
 *
 * Byte-stability is the reason, and it is not hypothetical: a file read then
 * edited and a file edited then read are the same file in the same state, and
 * rendering them as "read, edited" and "edited, read" would make the package
 * depend on the order the agent happened to work in — which changes between two
 * runs over two transcripts of the same task, and looks like a diff in the
 * handoff when nothing about the work differs.
 */
const VERB_ORDER = ['wrote', 'edited', 'read', 'looked at'] as const;

interface FileTouch {
  verbs: Set<string>;
  calls: number;
  /**
   * The ordinal of this file's MOST RECENT touch.
   *
   * The map is keyed by FIRST touch, so its own order cannot answer "what has
   * this session been working on lately" — a file opened at turn 1 and edited
   * again at turn 500 sits at the very front of it. Selecting by map position
   * therefore dropped exactly the file the work had been ABOUT, in favour of
   * sixty files glanced at once near the end. Measured in review.
   */
  lastSeen: number;
}

/**
 * Files touched, from the tool calls themselves.
 *
 * Walks the raw entries rather than the derived blocks, because `FeedBlock.tool`
 * carries `filePath` for `file_path` ONLY — deliberately, since the renderer
 * keys its inline diff off that field and must not be offered one for a `Glob`.
 * The rule for "which key names a file" is `touchedPath`, shared with the
 * watcher's `filesTouched` so the session card and this handoff cannot end up
 * describing the same session differently.
 *
 * Insertion-ordered: a `Map` preserves it, and first-touch order reads as the
 * shape of the work — where it started, what it spread to.
 */
function filesTouched(entries: readonly Record<string, unknown>[]): Map<string, FileTouch> {
  const files = new Map<string, FileTouch>();
  let seen = 0;
  for (const entry of entries) {
    // `isMeta` skipped, which is ONE DELIBERATE DIFFERENCE from the watcher's
    // otherwise-identical walk: `deriveIntents` drops meta lines, so the
    // package's prose sections never see them, and a files list built from
    // lines the rest of the document cannot mention would be internally
    // inconsistent. The rule for WHICH KEY names a file is shared
    // (`touchedPath`); which LINES count is each consumer's own question.
    if (entry.isMeta === true) continue;
    const message = entry.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const c of content as Array<{
      type?: string;
      name?: unknown;
      input?: Record<string, unknown>;
    }>) {
      if (c?.type !== 'tool_use') continue;
      const path = touchedPath(c.input);
      if (path === undefined) continue;
      const existing = files.get(path);
      const touch = existing ?? { verbs: new Set<string>(), calls: 0, lastSeen: 0 };
      touch.verbs.add(verbFor(typeof c.name === 'string' ? c.name : ''));
      touch.calls += 1;
      touch.lastSeen = seen++;
      if (!existing) files.set(path, touch);
    }
  }
  return files;
}

/**
 * Did the DERIVATION cut anything out of this block before we ever saw it?
 *
 * `PACKAGE_CAPS` is applied inside `deriveIntents`, which trims a tool result to
 * `detail`, a tool's one-line summary to `summary` and prose to `text` — with no
 * marker, and invisibly to everything downstream. Review measured the
 * consequence: a 5,016-character tool result ending in the actual error message
 * came back as its first 600 characters with `truncated: false`, i.e. the
 * section swore it was complete while holding none of the thing worth handing
 * over. `queries.ts` documents exactly this trap for `SessionOutput` ("⚠️ NOT a
 * promise that everything else is whole") — the package inherited the trap
 * without the caveat, and unlike a "what is my sibling up to" read, a HANDOFF is
 * where "the output was cut" is the fact the next session most needs.
 *
 * `>=` rather than `>`: the cap is a `slice`, so a field that hit it lands
 * exactly ON it. That means a field whose true length is the cap to the
 * character reports truncated when it was not — the cheap direction to be
 * wrong in, and the same one `SessionOutput.truncated` already chooses.
 *
 * ⚠️ ONLY FIELDS THE DOCUMENT ACTUALLY CONTAINS. `tool.detail` — the
 * `JSON.stringify` of the tool's INPUT — is capped by the same number and is
 * rendered by nothing here, and counting it made this fire on **435 of the
 * 1,172 tool blocks (37%)** in the real fixture. A warning that true on a third
 * of calls, about text the reader will never see, is not a warning; it is a
 * constant, and it would have drained the flag of the meaning the rest of this
 * function gives it. Measured in review, not reasoned about.
 *
 * `todos` IS counted, because `renderBlock` draws a checklist into the activity
 * section: a 120-item `TodoWrite` arrives here as 100 items, and the section
 * used to report itself complete while holding five sixths of the list.
 * (`edit` is genuinely irrelevant — `PACKAGE_CAPS.edit` is 0 and nothing reads
 * `oldString`/`newString`.)
 */
function derivationCut(block: FeedBlock): boolean {
  if ((block.text?.length ?? 0) >= PACKAGE_CAPS.text) return true;
  if ((block.todos?.length ?? 0) >= PACKAGE_CAPS.todos) return true;
  const tool = block.tool;
  if (!tool) return false;
  return (
    (tool.out?.length ?? 0) >= PACKAGE_CAPS.detail ||
    tool.summary.length >= PACKAGE_CAPS.summary
  );
}

/** `truncate` that says so in-band, so a model knows it holds a fragment. */
function cap(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let kept = text.slice(0, limit);
  // A `slice` counts UTF-16 code units, so it can land between the halves of an
  // astral character (an emoji, most CJK extension blocks) and leave a lone
  // high surrogate at the end — which encodes as U+FFFD in the document a model
  // reads. Deterministic, so byte-stability is untouched either way; dropped
  // because a replacement character at a boundary is noise the reader has to
  // decide about.
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return { text: kept.trimEnd() + ' …[truncated]', truncated: true };
}

/**
 * What the USER said in this block, if this block is the user saying something.
 *
 * ── ONE RULE, TWO CALLERS, AND THE SECOND ONE IS IN ANOTHER FILE ────────────
 *
 * `userTexts` below reads the tail window; `SessionQueries.firstPrompt` reads
 * the head window for the same fact — the conversation's opening prompt. They
 * were two copies of this predicate, and the copies disagreed about one case,
 * which is precisely the case that matters:
 *
 * **An attachment-only turn.** "look at this" typed into nothing but a pasted
 * screenshot sends NO text block at all (#491), so a filter on text alone skips
 * it. `userTexts` handled that and `firstPrompt` did not — so a session that
 * OPENED with a screenshot had its second prompt returned as the goal, printed
 * under that heading with total confidence. That is the round-1 blocker exactly,
 * reached through the fix for it. Review found it; two copies of a rule found it
 * for us, as `touchedPath` in `feed/blocks.ts` predicted they would.
 *
 * It cannot say what the picture showed. It can say a prompt happened and what
 * rode with it, which is the difference between a gap and an unexplained gap.
 *
 * `undefined` means "this block is not the user speaking" — including a
 * SUBAGENT's turn, which lands in the same file as a sidechain `user` line. A
 * `Task` brief reported as something the human asked for is a misattribution
 * the reader cannot detect.
 */
export function promptText(block: FeedBlock): string | undefined {
  if (block.kind !== 'user' || block.sidechain) return undefined;
  const text = (block.text ?? '').trim();
  if (text) return text;
  const a = block.attachments;
  if (!a) return undefined;
  const parts: string[] = [];
  if (a.images) parts.push(`${a.images} image${a.images === 1 ? '' : 's'}`);
  if (a.documents) parts.push(`${a.documents} document${a.documents === 1 ? '' : 's'}`);
  return parts.length ? `[the user sent ${parts.join(' and ')} with no text]` : undefined;
}

/** Prose the user actually typed, oldest first. */
function userTexts(blocks: readonly FeedBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const text = promptText(b);
    if (text !== undefined) out.push(text);
  }
  return out;
}

function section(
  id: SectionId,
  title: string,
  body: { text: string; truncated: boolean }
): PackageSection {
  return { id, title, text: body.text, tokens: estimateTokens(body.text), truncated: body.truncated };
}

/**
 * Build the package. Pure: same input, same output, for ever.
 *
 * Every section is produced even when it is empty — an absent section and an
 * empty one are different claims, and "no file was touched" is a real and
 * useful thing to tell the next session. The done-when "a transcript with no
 * tool calls still yields a usable package" is exactly this property: a
 * planning-only session is a real session.
 */
export function buildContextPackage(src: PackageSource): ContextPackage {
  const blocks = blocksFrom(src.entries, PACKAGE_CAPS);
  const prompts = userTexts(blocks);

  // ── Goal ────────────────────────────────────────────────────────────────
  //
  // THERE IS NO FALLBACK TO `prompts[0]` WHEN THE WINDOW IS CUT, and that
  // absence is the whole point. `prompts[0]` is the conversation's opening
  // prompt only when the window reached the start of the file; on a cut window
  // it is merely the oldest prompt that survived the byte budget, and printing
  // that under the heading "Goal" is the exact failure the two-window read
  // exists to prevent — stated in this module's header, in `sessionContext`'s,
  // and in DESIGN.md §5.5.
  //
  // The head read can legitimately come back empty: 128 KB of a conversation
  // that opens with a pasted screenshot is all base64, and `firstPrompt` is
  // fail-open so a read error lands here as `undefined` too. In that state the
  // honest answer is that we do not know the goal, which is what
  // `emptySection('goal', …)` says. A fallback would make that sentence
  // unreachable and replace it with a confident wrong answer.
  const known = src.goalFromHead ?? (src.cut ? undefined : prompts[0]);
  const goal = cap((known ?? '').trim(), GOAL_CHAR_CAP);

  // ── Later instructions (the honest stand-in for "decisions") ────────────
  //
  // Everything the user said AFTER the opening brief, and the condition is
  // "is this prompt the goal" rather than "did the goal come from the other
  // window" — WHICH IS NOT THE SAME TEST, and the difference is reachable.
  //
  // The two windows are usually disjoint: the caller only reads the head when
  // the tail stopped short of byte 0. But a transcript sized just past the tail
  // budget has a tail that is *cut* and that can still reach the opening
  // PROMPT. (Not the first LINE — `readTranscriptWindow` discards everything up
  // to the first newline whenever it starts past byte 0, so line 1 is never in
  // a cut tail. The band opens when `isMeta` lines and `<local-command-*>`
  // plumbing precede the prompt, which is the ordinary shape of a real
  // transcript.) Keying off `goalFromHead !== undefined` there would open the
  // handoff with the task statement and then repeat it verbatim as the user's
  // first "later instruction". Comparing the text closes the band for one
  // comparison.
  //
  // When the goal is unknown (above), NOTHING is dropped: every prompt in the
  // window is a later instruction, because none of them has been claimed as the
  // task statement.
  const goalIsFirstPrompt = known !== undefined && prompts[0] === known;
  const later = goalIsFirstPrompt ? prompts.slice(1) : prompts;
  const keptInstructions = later.slice(-MAX_INSTRUCTIONS);
  const instructionBodies = keptInstructions.map((t) => {
    const c = cap(t, INSTRUCTION_CHAR_CAP);
    return { line: '- ' + c.text.replace(/\n/g, '\n  '), truncated: c.truncated };
  });
  const instructions = {
    text: instructionBodies.map((b) => b.line).join('\n'),
    truncated: keptInstructions.length < later.length || instructionBodies.some((b) => b.truncated),
  };

  // ── Plan / todo state ───────────────────────────────────────────────────
  // The NEWEST checklist, not a merge of all of them: `TodoWrite` rewrites the
  // whole list every call, so the last one is the state and any earlier one is
  // a superseded draft.
  //
  // THE PREDICATE IS `kind === 'todos'`, NOT "a todos block with items in it",
  // and the difference is a bug the second version has: a `TodoWrite` that
  // CLEARS the list (`todos: []`) is a real call the CLI writes, and skipping
  // it resurrects the previous checklist and presents finished work to the next
  // session as still pending. The newest call is the state, empty or not.
  //
  // `!sidechain` for the same reason `lastProse` and `lastTool` carry it, and
  // it was missing here: a `Task` SUBAGENT writes its own `TodoWrite` into this
  // same file, so any session whose last delegation kept a checklist handed the
  // next session the subagent's scratch list AS ITS PLAN, with the main
  // conversation's real plan dropped.
  const lastTodos = [...blocks].reverse().find((b) => b.kind === 'todos' && !b.sidechain);
  const todos = lastTodos?.todos ?? [];
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.filter((t) => t.status === 'in_progress').length;
  const planItems = todos.map((t) => cap(`- [${t.status}] ${t.content}`, TODO_ITEM_CHAR_CAP));
  const planBody = todos.length
    ? `${done} of ${todos.length} done, ${active} in progress.\n\n` +
      planItems.map((i) => i.text).join('\n')
    : // Not the same claim as "kept no todo list", and `emptySection` cannot
      // tell them apart — an emptied list is a fact worth carrying, because it
      // usually means the work it held is finished.
      lastTodos
      ? 'The todo list was emptied.'
      : '';
  const planCapped = cap(planBody, PLAN_CHAR_CAP);
  const plan = {
    text: planCapped.text,
    // Three independent ways this section can have lost something, and only one
    // of them is measurable here: `PACKAGE_CAPS.todos` cuts the COUNT inside the
    // derivation where this cannot see it, so it is inferred from the one
    // condition that implies it.
    truncated:
      planCapped.truncated || planItems.some((i) => i.truncated) || todos.length >= PACKAGE_CAPS.todos,
  };

  // ── Files touched ───────────────────────────────────────────────────────
  const files = filesTouched(src.entries);
  // ── SELECT BY LAST TOUCH, RENDER BY FIRST ────────────────────────────────
  //
  // Two different orders, and conflating them has now been wrong in both
  // directions. `slice(0, N)` kept where the work STARTED and dropped where it
  // got to; `slice(-N)` on a map keyed by FIRST touch kept the sixty files most
  // recently *discovered* and dropped the one edited at turn 1 and again at
  // turn 500 — the file the session had been working on the whole time.
  //
  // So selection is by `lastSeen` (recency of actual work) and rendering keeps
  // the map's insertion order (the shape of the work: where it began, what it
  // spread to). Byte-stable: `lastSeen` is a unique ordinal, so the sort has no
  // ties to break, and the render order is the Map's, which is insertion.
  const all = [...files.entries()];
  const keep = new Set(
    [...all]
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, MAX_FILES)
      .map(([path]) => path)
  );
  const shown = all.filter(([path]) => keep.has(path));
  const hidden = files.size - shown.length;
  const fileLines = shown.map(([path, touch]) => {
    const verbs = VERB_ORDER.filter((v) => touch.verbs.has(v)).join(', ');
    const calls = touch.calls === 1 ? '1 call' : `${touch.calls} calls`;
    return `- ${path} — ${verbs} (${calls})`;
  });
  const files_ = {
    // The marker says WHY these are the ones missing, because after the change
    // above the dropped files are not "the earlier ones" — they are the ones
    // this session stopped touching soonest, which can include the very first
    // file it opened.
    text:
      (hidden > 0 ? `- …and ${hidden} more, not touched as recently\n` : '') +
      fileLines.join('\n'),
    truncated: hidden > 0,
  };

  // ── Recent activity ─────────────────────────────────────────────────────
  const tail = blocks.slice(-SNIPPET_BLOCKS);
  const rendered = tail
    .map(renderBlock)
    .filter((s) => s !== '')
    .join('\n\n');
  // CUT FROM THE FRONT, keeping the newest — `sessionOutput`'s lesson, for the
  // same reason: the front of the recent window is the least recent thing in
  // it, and "what is happening now" is the whole point of the section.
  const activityOverflow = rendered.length > SNIPPET_CHAR_CAP;
  const activity = {
    text: activityOverflow
      ? ACTIVITY_TRIM_MARKER +
        '\n\n' +
        sliceTail(rendered, SNIPPET_CHAR_CAP - ACTIVITY_TRIM_MARKER.length - 2)
      : rendered,
    truncated: activityOverflow || tail.length < blocks.length || tail.some(derivationCut),
  };

  // ── Where it left off ───────────────────────────────────────────────────
  const lastProse = [...blocks]
    .reverse()
    .find((b) => b.kind === 'assistant' && !b.sidechain && (b.text ?? '').trim());
  // `!sidechain` on both: a subagent's closing sentence is not what THIS
  // session last said, and its last tool call is not what this session last
  // did. `renderBlock` marks a subagent line in the activity section; a bare
  // "Last action:" here has nowhere to carry that mark, so the honest move is
  // to answer about the main conversation only.
  const lastTool = [...blocks]
    .reverse()
    .find((b) => b.kind === 'tool' && b.tool && !b.sidechain);
  // THE PROSE IS CAPPED, THE ACTION IS NOT, and the order matters: capping the
  // joined string would let a long closing paragraph push "Last action:" off
  // the end entirely. The action is one short line and is the more actionable
  // of the two — "it was editing X when it stopped" is what the next session
  // needs to know — so it is the one that always survives.
  const stateParts: string[] = [];
  const prose = cap((lastProse?.text ?? '').trim(), STATE_CHAR_CAP);
  if (prose.text) stateParts.push(prose.text);
  if (lastTool?.tool) {
    stateParts.push(`Last action: ${lastTool.tool.name} ${lastTool.tool.summary}`.trimEnd());
  }
  const state = {
    text: stateParts.join('\n\n'),
    // `derivationCut` on both: a closing message long enough to hit
    // `PACKAGE_CAPS.text`, or a last action whose summary hit `summary`, was
    // cut before this function ever saw it.
    truncated:
      prose.truncated ||
      (lastProse !== undefined && derivationCut(lastProse)) ||
      (lastTool !== undefined && derivationCut(lastTool)),
  };

  const sections: PackageSection[] = [
    section('goal', 'Goal', goal),
    section('instructions', 'What the user asked for along the way', instructions),
    section('plan', 'Plan / todo state', plan),
    section('files', 'Files touched', files_),
    section('activity', 'Recent activity', activity),
    section('state', 'Where it left off', state),
  ];

  return {
    session: src.session,
    coverage: src.unreadable ? 'unreadable' : src.cut ? 'recent' : 'whole',
    sections,
    tokens: sections.reduce((n, s) => n + s.tokens, 0),
  };
}

/**
 * What a section says when the transcript held nothing for it.
 *
 * A SENTENCE RATHER THAN A BLANK, on every section, because the reader is a
 * model about to act: "no file was read or changed" is a fact it can use, and
 * an empty heading is an ambiguity it will resolve by guessing. This is also
 * what makes "a transcript with no tool calls still yields a usable package"
 * true of the rendered document and not just of the object.
 *
 * `coverage` changes two of them, and the distinction is the point: a package
 * that read the WHOLE conversation and found no opening prompt is describing a
 * session that has not been asked anything yet, while one that read only the
 * recent end is describing its own blind spot. Printing the second sentence in
 * the first case would invent a missing history that does not exist.
 */
function emptySection(id: SectionId, coverage: ContextPackage['coverage']): string {
  // EVERY coverage-sensitive section branches, and the review that found two of
  // them unhedged is why this is one predicate rather than a per-case judgement
  // call: `plan` and `state` each read as a fact about the SESSION ("kept no
  // todo list", "has not said anything yet") when all they knew was how far
  // back the read went. `sessionContext`'s doc justifies the entire 2 MB budget
  // by calling exactly that sentence a confident wrong answer, so leaving the
  // sentence itself unhedged made the budget the only thing standing between
  // the package and the lie.
  // "…in the part of the conversation this covers" is vacuous under a `Covers:
  // nothing` header — it reads as though something WAS covered. The preamble
  // carries the weight, but six sections quietly implying otherwise undercut it.
  if (coverage === 'unreadable') return '_Not known — the transcript could not be read._';
  const partial = coverage !== 'whole';
  switch (id) {
    case 'goal':
      return partial
        ? '_The opening prompt is not in the part of the conversation this covers._'
        : '_This session has not been given a prompt yet._';
    case 'instructions':
      return partial
        ? '_No further instructions in the part of the conversation this covers._'
        : '_The user has given no instructions beyond the opening prompt._';
    case 'plan':
      return partial
        ? '_No todo list in the part of the conversation this covers._'
        : '_This session kept no todo list._';
    case 'files':
      return partial
        ? '_No file was read or changed in the part of the conversation this covers._'
        : '_No file has been read or changed._';
    case 'activity':
      return partial
        ? '_Nothing readable in the part of the conversation this covers._'
        : '_This session has produced no readable output._';
    case 'state':
      return partial
        ? '_Nothing in the part of the conversation this covers says where it left off._'
        : '_The session has not said anything yet._';
  }
}

/**
 * What the document says about its own reach.
 *
 * The `unreadable` line is deliberately blunt. Every section below it will read
 * as "the session has done nothing", and a model handed that WITHOUT this line
 * would conclude something false about the work rather than something true
 * about the read.
 */
const COVERAGE_LINE: Record<ContextPackage['coverage'], string> = {
  whole: 'the whole conversation',
  recent:
    'the most recent part of the conversation — there is older history not included here',
  unreadable:
    '**nothing — this session\'s transcript could not be read.** The empty sections below ' +
    'say what this handoff could not see, NOT what the session did. Do not conclude from ' +
    'them that no work was done.',
};

/**
 * Group a number without `toLocaleString` — see the header on byte-stability.
 *
 * `Intl` formats to the machine's locale, so the same package would render
 * `1,234` on one of the user's computers and `1.234` on another. This one
 * always groups with a comma because the document is English.
 */
function groupDigits(n: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/**
 * The package as the provider-neutral markdown handoff doc §5.5 asks for.
 *
 * MARKDOWN AND NOT JSON because of who reads it: this text is injected into
 * another session's conversation as a prompt, sometimes a *different vendor's*
 * (§5.5's cross-provider handoff), and prose with headings is the one format
 * every model handles natively. The structured object stays available for the
 * drop dialog, which needs the per-section sizes rather than the text.
 *
 * The preamble is not decoration. A model handed a document titled "Goal /
 * Plan / Files touched" will assume a person or a capable summarizer wrote it,
 * and will treat the "Plan" as reasoning rather than as a checklist copied out
 * of a file. Saying plainly that this was extracted mechanically is what makes
 * the rest of it safe to trust at the level it deserves — §5.5's honesty rule,
 * stated to the reader that actually consumes this.
 */
export function renderPackage(pkg: ContextPackage): string {
  const lines: string[] = [];
  lines.push(`# Context from @${pkg.session.name}`);
  lines.push('');
  lines.push(
    'This handoff was extracted mechanically from the session transcript — no model ' +
      'wrote it. It reports what the conversation *contains*, not what it meant, so ' +
      'treat it as notes rather than as a briefing.'
  );
  lines.push('');
  lines.push(`- **Session:** ${pkg.session.name} (${pkg.session.providerId})`);
  lines.push(`- **Folder:** ${pkg.session.folder}`);
  lines.push(`- **Covers:** ${COVERAGE_LINE[pkg.coverage]}`);
  lines.push(`- **Estimated size:** ~${groupDigits(pkg.tokens)} tokens of content`);
  for (const s of pkg.sections) {
    lines.push('');
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.text.trim() === '' ? emptySection(s.id, pkg.coverage) : s.text);
  }
  // A trailing newline, so appending this to a composer's draft never joins the
  // last line of the handoff to whatever the user types next.
  return lines.join('\n') + '\n';
}
