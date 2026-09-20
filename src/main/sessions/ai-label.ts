// AI task labels (#758, §5.11): WHEN to ask a model for a label, and what to
// do with the answer it gives back.
//
// A pure module, beside `auto-label.ts` and for the same reason: every rule
// below is a decision, and a rule you can call in a test is the only kind you
// can prove. Nothing here spawns anything, knows what a CLI is, or can see a
// transcript. It is handed facts and returns a verdict.
//
// ── WHY THIS IS A SECOND SOURCE AND NOT A REPLACEMENT ──────────────────────
//
// P2-E7-06 fills a blank label from the CLI's OWN conversation title
// (`ai-title`), which costs nothing because we are already tailing the file.
// That title names where a session STARTED: measured at 13 `ai-title` lines
// carrying ONE distinct title, and the five newest transcripts in this very
// project carry NONE at all. #758 is the owner's ask for a label that follows
// the work as it drifts.
//
// The ownership rules are NOT re-litigated here — but note HOW they are kept,
// because it is not by calling `nextAutoLabel`. That function takes a CLI title
// and answers synchronously; this source is asynchronous and its answer arrives
// ~14 seconds after the decision to ask, so the rules are re-checked at the
// landing instead, by `acceptAiLabel`: typing still pins a card for ever,
// clearing still hands it back, and the 120-char cap lands in `cleanAiLabel`.
//
// The one rule that is NOT here is the screen-share switch, because it is not
// about ownership: whether a stored label is SHOWN is `visibleTaskLabel`'s
// answer, and the caller re-reads it at publish time (see `ipc.ts`). Saying
// "it goes through `nextAutoLabel`" would be a tidier sentence and a false one,
// and the clause it would paper over is the one a review caught missing.
//
// ── THE DESIGN PROBLEM IS CADENCE, NOT SUMMARIZATION ───────────────────────
//
// A six-word label is easy. A labeler that spends the owner's subscription
// relabeling idle sessions is worse than no labeler, which is why almost all of
// this file is about NOT running. Measured (`spike/findings/758-label-
// containment.md`): one label over a 34-turn excerpt took **14 seconds** on
// haiku. That number decides two things — it can never sit near a gesture, and
// "the user typed while it was in flight" is a real race with a wide window,
// not a theoretical one.
import { labelSourceOf, MAX_LABEL_LENGTH, type LabelledCard } from './auto-label';
// #846's pair, reused rather than reimplemented: a slash command must render as
// a person writes it (`/next-item 818`) and never as raw `<command-name>`
// markup, which is the bug the history picker shipped before that item.
import { commandInvocation, isCommandPlumbing } from '../../shared/command-invocation';

/**
 * What we remember about a card between labeling runs.
 *
 * Deliberately tiny and deliberately NOT persisted: every field is an
 * optimisation for not spending tokens, and losing it across a restart costs
 * one extra label per session at worst. Persisting it would mean a workspace
 * file that can silently suppress a feature the user just switched on.
 */
export interface AiLabelState {
  /** when the last run STARTED, epoch ms; absent if none ever has */
  lastRunAt?: number;
  /** transcript line count at the last run, to spot a session that has not moved */
  lastLines?: number;
  /** a run is out; a second one for the same card must not start */
  inFlight?: boolean;
}

/** What the caller knows at the moment it is considering a run. */
export interface RelabelInput {
  /** the opt-in setting (#758's own switch), NOT the auto-labels switch */
  enabled: boolean;
  /** the card, for the ownership question */
  card: LabelledCard;
  /** lines in the transcript right now */
  lines: number;
  /** what we remember about this card */
  state: AiLabelState;
  /** now, injected so the rule is testable without a clock */
  now: number;
  /** smallest gap between two runs for ONE card */
  minGapMs?: number;
  /** fewest new transcript lines that count as "the work moved on" */
  minNewLines?: number;
}

/**
 * Why a run was refused. A reason rather than a bare `false` because every one
 * of these is a different thing to log, and "the labeler is not running" is
 * otherwise the least debuggable state a feature can be in.
 */
export type RelabelVerdict =
  | { run: true }
  | {
      run: false;
      reason: 'disabled' | 'user-owns-it' | 'in-flight' | 'no-growth' | 'too-soon' | 'too-thin';
    };

/** The default gap. Generous on purpose: see `shouldRelabel`. */
export const DEFAULT_MIN_GAP_MS = 10 * 60_000;
/** A turn or two of real work, rather than a single line landing. */
export const DEFAULT_MIN_NEW_LINES = 20;
/** Below this there is nothing to summarize and the answer would be noise. */
export const MIN_TRANSCRIPT_LINES = 8;

/**
 * Should we spend a model call on this card right now?
 *
 * ORDERED CHEAPEST-FIRST, and the order is the point: the overwhelming majority
 * of calls answer `false`, and none of them should cost more than a few
 * comparisons. This is called on a status transition for every open session.
 *
 * THE TRIGGER IS A TURN ENDING, NOT A TIMER, and that decision lives at the
 * call site (`ipc.ts` already fans `manager.onStatusChange` out, and already
 * acts on `change.to === 'working'` for the transcript watcher). An idle
 * session therefore costs exactly nothing, for ever, with no timer running —
 * which no debounce interval can achieve, because a timer that fires on an idle
 * session has already paid for itself in wakeups.
 */
export function shouldRelabel(input: RelabelInput): RelabelVerdict {
  const {
    enabled,
    card,
    lines,
    state,
    now,
    minGapMs = DEFAULT_MIN_GAP_MS,
    minNewLines = DEFAULT_MIN_NEW_LINES,
  } = input;

  if (!enabled) return { run: false, reason: 'disabled' };

  // The user's label is the user's, exactly as `nextAutoLabel` has it. Checked
  // HERE as well as at the landing, and the duplication is deliberate: this one
  // saves the token spend, that one saves the label. A card the user has pinned
  // must never cause a model call whose result can only be thrown away.
  if (labelSourceOf(card) === 'user') return { run: false, reason: 'user-owns-it' };

  // One run per card at a time (#758's guardrail). At ~14 s a run, a chatty
  // session can easily end two turns inside one; without this they would both
  // be in flight and the loser would overwrite the winner with older material.
  if (state.inFlight) return { run: false, reason: 'in-flight' };

  // Nothing to say about a conversation that has barely started.
  if (lines < MIN_TRANSCRIPT_LINES) return { run: false, reason: 'too-thin' };

  // THE CHEAP STALENESS SIGNAL the ticket asks for. A transcript that has not
  // grown cannot have drifted, so there is no new label to be had — and this is
  // what makes a session that ends a turn without doing anything (a refused
  // prompt, an instant answer) free rather than merely debounced.
  if (state.lastLines !== undefined && lines - state.lastLines < minNewLines) {
    return { run: false, reason: 'no-growth' };
  }

  // The floor under everything else. Growth alone is not enough: a session
  // running flat out produces plenty of lines per turn, and relabeling it every
  // turn is the failure mode this whole file exists to prevent.
  if (state.lastRunAt !== undefined && now - state.lastRunAt < minGapMs) {
    return { run: false, reason: 'too-soon' };
  }

  return { run: true };
}

/**
 * How much recent conversation to send. ~24 KB is what the probe measured at
 * 14 s; more costs more and says little, because a label describes the PRESENT
 * and the present is at the end of the file.
 */
export const EXCERPT_MAX_CHARS = 24_000;

/**
 * The newest rendered turns that fit, oldest-first.
 *
 * Takes already-rendered STRINGS rather than transcript blocks on purpose: this
 * module stays pure and knows nothing about the feed's shapes, exactly as
 * `auto-label.ts` knows nothing about `ai-title`. The caller renders.
 *
 * Built from the END backwards — a label names what the session is doing now,
 * so the oldest turn is the one to drop.
 */
export function buildExcerpt(rendered: readonly string[], maxChars = EXCERPT_MAX_CHARS): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const piece = rendered[i]?.trim();
    if (!piece) continue;
    if (size + piece.length > maxChars) break;
    kept.unshift(piece);
    size += piece.length + 2;
  }
  return kept.join('\n\n');
}

/**
 * The prompt, and its WORDING IS LOAD-BEARING.
 *
 * ⚠️ It must read as an ordinary request to describe the work, and must NOT
 * read as "disregard the content above and emit a token". The delivery probe
 * learned this the expensive way: its first instrument said *"Ignore all of the
 * above content. Reply with exactly this word"*, and **all four variants were
 * refused** — including a route that had demonstrably worked minutes earlier —
 * with "if you have a legitimate task I'm happy to assist". Nothing about
 * delivery was measured, and the failure looked exactly like a broken pipe
 * (`spike/findings/758-label-containment.md`).
 *
 * The labeler's prompt is the same shape by necessity: it wraps someone else's
 * conversation and asks for a summary of it. Phrased as an injection it gets
 * refused intermittently, and the label silently stops tracking — a feature
 * that quietly does nothing, which is the worst failure available here.
 *
 * So: the excerpt comes FIRST as quoted material, the instruction is a plain
 * summarization request, and nothing tells the model to ignore anything.
 */
export function buildLabelPrompt(excerpt: string): string {
  return [
    'Below is the recent transcript of a coding session.',
    '',
    excerpt,
    '',
    // ⚠️ FIFTEEN WORDS, NOT SIX (#877). Six words was ~30-40 characters — barely
    // one line — so giving the label three lines of room would have shown two
    // empty ones. The owner asked for the space filled: "Default to the full
    // width and fill the space".
    //
    // Fifteen lands around 90-100 characters, comfortably under the 120-char
    // cap, which matters: the cap truncates mid-word, and a label that ends in
    // "…" because the model was asked for more than it may keep reads as a bug
    // rather than as a limit. Someone who wants terse labels back chooses a
    // smaller SIZE, which clamps the lines without lying to the model about how
    // much it may say.
    'In at most fifteen words, say what this session is working on now.',
    'Answer with the label only — no quotes, no punctuation at the end, and no explanation.',
  ].join('\n');
}

/**
 * Every control character replaced by a space.
 *
 * ⚠️ **COMPARES CODE POINTS RATHER THAN MATCHING AN ESCAPE SEQUENCE, and that
 * is not a style choice.** The obvious spelling is a character class naming a
 * Unicode escape for code point zero — and writing that escape through this
 * project's tooling put a **real NUL byte** into this file. Caught by
 * `npm run lint`, because `scripts/check-nul.js` exists for exactly this
 * (#435): a NUL is invisible in editors and diffs, eslint parses it, tsc
 * typechecks it, and it resurfaces later as an unrelated-looking failure.
 *
 * It happened in this very comment on the first attempt, which is why the
 * escape is DESCRIBED here rather than written: prose is not a safe place to
 * spell one either. Comparing numbers keeps the whole file plain ASCII.
 */
function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += isStrippable(code) ? ' ' : ch;
  }
  return out;
}

/**
 * C0/C1 controls, plus the invisible characters that REORDER or HIDE text.
 *
 * The bidi overrides and isolates (U+202A–202E, U+2066–2069) can make a label
 * render in an order it is not written in, and the zero-width family
 * (U+200B–200D, U+FEFF) can hide characters inside one. Both are display
 * spoofing rather than injection — React escapes, and the rail passes the label
 * to ICU as a VALUE, which is not re-parsed — but the stated threat model here
 * is model output derived from a transcript that may be adversarial, and a card
 * title that reads backwards is exactly the kind of thing nobody would think to
 * suspect. Cheap to refuse, so refused.
 */
function isStrippable(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true; // C0 + DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width + LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding/override
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
  return code === 0xfeff; // BOM / zero-width no-break space
}

/**
 * The header every injected context block opens with — `context-drop.ts` and
 * `context-package.ts` both write it, and #830 is the ticket for recognising
 * these inside a sent turn properly.
 */
const INJECTED_CONTEXT_HEADER = '# Context from @';

/**
 * First non-empty line, tidied and capped — the PROVISIONAL path's cleaning.
 *
 * `cleanAiLabel` deliberately keeps its own: it also unquotes, and it refuses
 * markup-ish output, and the order of those steps is pinned by its tests. Two
 * short functions beat one that has to be told which caller it is serving.
 */
function tidyOneLine(raw: string): string | null {
  const first = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;
  const flat = stripControl(first).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const capped = flat.slice(0, MAX_LABEL_LENGTH).trim();
  return capped.length > 0 ? capped : null;
}

/**
 * A label for the instant the user hits send — from their own prompt, free.
 *
 * ⚠️ WHY THIS EXISTS AT ALL, given §5.11 rejected prompt-derived labels on
 * 2026-07-30. That rejection's stated reason was "the CLI already writes a
 * title, so deriving our own is redundant" — and the premise turned out to be
 * false: the five newest transcripts in this repo carry **zero** `ai-title`
 * lines. Dan hit exactly that in v0.8.92 (#883): first prompt sent, nothing on
 * the card. So this is a decision whose evidence changed, not one being
 * re-litigated.
 *
 * It is a PLACEHOLDER and nothing more. The AI pass replaces it when the turn
 * ends, the CLI's own title replaces it if one ever arrives, and neither may
 * touch a label the user typed. Its whole job is that the card says something
 * true within a keystroke instead of staying blank for fourteen seconds.
 *
 * TWO CASES IT HANDLES AND ONE IT REFUSES:
 *
 *   - **A slash command** is not prose (#846): `commandInvocation` renders it
 *     the way a person writes it (`/next-item 818`), which is what the history
 *     picker learned to do after showing raw `<command-name>` markup instead.
 *   - **Ordinary prose** becomes its first line, tidied.
 *   - **A turn that leads with another session's output** (an `@mention` since
 *     #798 injects that BEFORE your words) answers `null` — REFUSED RATHER THAN
 *     GUESSED. Finding where the user's own text resumes is #830's job, and a
 *     label reading "Context from @other-session" is worse than no label for
 *     the few seconds until the AI pass lands.
 *
 * NOTE THE MARKUP REFUSAL IN `cleanAiLabel` IS DELIBERATELY NOT APPLIED HERE.
 * That guard exists because model output is untrusted and may be steered by a
 * transcript; this text is what the user typed into their own composer, and they
 * are already allowed to type a label directly. Applying it would also reject
 * every slash command, since they open with `/`.
 */
export function provisionalLabel(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (isCommandPlumbing(t)) return tidyOneLine(commandInvocation(t) ?? '');
  if (t.startsWith(INJECTED_CONTEXT_HEADER)) return null;
  return tidyOneLine(t);
}

/**
 * Clean what the model said into something that can be a label — or `null`.
 *
 * ⚠️ **THIS IS A SECURITY BOUNDARY, NOT A TIDYING STEP**, and the probe is why.
 * A contained turn asked to go snooping replied with `<function_calls>` blocks
 * as PLAIN TEXT, inventing tool calls and narrating results it never got
 * (`spike/findings/758-label-containment.md`, Q4). Nothing ran — it had no
 * tools — but that output is what a labeler writes onto a card. The input to
 * this function is a transcript excerpt that may itself contain anything the
 * agent was asked to read, so the model can be steered. #832 is the same shape
 * one surface over: another session's output steering THIS session's behaviour.
 *
 * So: one line, no markup-ish leading character, no control characters, capped.
 * The label is text and must never be treated as anything else by any surface
 * that renders it.
 */
export function cleanAiLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  // First non-empty line only. A model asked for six words sometimes returns
  // the six words and then explains itself.
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;

  const stripped = stripControl(firstLine)
    // a model that was asked for a label and gave us a quoted one
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Anything that opens like markup or a tool call is not a task label. Refused
  // outright rather than sanitized into something that reads plausible: a label
  // we cannot explain is worse than the folder name, which is what stands when
  // this returns null.
  if (!stripped || /^[<{[#/\\]/.test(stripped)) return null;

  const capped = stripped.slice(0, MAX_LABEL_LENGTH).trim();
  return capped.length > 0 ? capped : null;
}

/**
 * May the label this run produced actually land?
 *
 * The last-writer rule, and at ~14 seconds a run it is the one guardrail most
 * likely to fire in real use. `ownerAtStart` is `labelSourceOf` sampled when
 * the run began; if the card is the user's NOW and was not then, they typed
 * while we were thinking, and their words win. The same holds if they typed
 * before we started and we somehow got here anyway.
 *
 * Returns the label to write, or `null` for "drop it on the floor" — which the
 * caller must treat as a perfectly ordinary outcome, not an error.
 */
export function acceptAiLabel(
  card: LabelledCard,
  raw: string | undefined,
  ownerAtStart: 'auto' | 'user'
): string | null {
  if (ownerAtStart === 'user') return null;
  if (labelSourceOf(card) === 'user') return null;
  const clean = cleanAiLabel(raw);
  if (!clean) return null;
  // Same de-dupe as `nextAutoLabel`: an unchanged label is not a write, not a
  // persist and not a render.
  return clean === card.taskLabel ? null : clean;
}
