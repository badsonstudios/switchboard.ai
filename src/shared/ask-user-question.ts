// `AskUserQuestion` — the CLI's own chooser, and the wire rule for answering it
// (#563, the AskUserQuestion half of plan item E18-11).
//
// MEASURED, not guessed: `spike/s11/probe-2-ask-user-question.cjs`, six modes,
// against the CLI on PATH (2.1.233). Artifacts in
// `spike/findings/artifacts/s11/ask-user-question-*.json`; the prose is
// `spike/findings/s-11-ask-user-question.md`. The VS Code extension pointed at
// the right channel; the probe is what makes it a fact.
//
// THE CONTRACT, in one place:
//
//   in   control_request / can_use_tool, tool_name "AskUserQuestion", with
//        input { questions: [ { question, header, options: [ { label,
//        description } ], multiSelect } ] }
//   out  control_response allow, with
//        updatedInput = { ...input, answers: { "<question text>": "A, B" } }
//
// Three properties of that response are load-bearing and none of them are
// obvious, which is why they live in a tested function rather than inline in a
// component:
//
// 1. **The map is keyed by the question TEXT**, not by an index or an id. The
//    payload carries no id, so the text is all there is.
// 2. **A multi-select answer is a STRING**, comma-space joined — not an array.
// 3. **Free text is indistinguishable from a label.** There is no `other`
//    field: the typed text simply goes in the value. The CLI notices anyway —
//    it answers an off-menu choice with "Read the answers carefully — they may
//    request clarification, changes, or that you not proceed" instead of the
//    ordinary "Your questions have been answered" — which is the measured proof
//    that the owner's "Other" is a first-class answer and not a workaround.
//
// Pure and shared, because both ends need it and they must not diverge: the
// renderer builds the payload and main validates it before it reaches the CLI's
// stdin.

/** The tool name, exactly as the CLI sends it. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** One offered answer. `description` is the CLI's own gloss; often absent. */
export interface AskOption {
  label: string;
  description?: string;
}

/** One question in the call. A call may carry several. */
export interface AskQuestion {
  /** the question itself — ALSO the key its answer is filed under */
  question: string;
  /** the short tab-style label the CLI supplies, e.g. "Colour" */
  header?: string;
  options: AskOption[];
  /** true = checkboxes, false/absent = pick one */
  multiSelect: boolean;
}

/**
 * What the user has chosen for ONE question, held by INDEX rather than by text.
 *
 * By index deliberately. The wire keys answers by question text, and nothing in
 * the payload stops one call carrying the same text twice — so text is not a
 * safe key for UI state even though it is the only key the wire has. Indexing
 * the state and building the map at the end means two identical questions
 * render as two answerable groups and then collapse on the wire exactly as the
 * CLI's own consumer collapses them, rather than fighting each other for the
 * same slot while the user is still reading.
 */
export interface AskSelection {
  /** chosen option labels, in the order the options are offered */
  labels: string[];
  /** whether the "Other" row is chosen — its text is the answer, not the word */
  other: boolean;
  /** what the user typed into Other */
  otherText: string;
}

/** A blank selection per question — the panel's initial state. */
export function emptySelections(questions: readonly AskQuestion[]): AskSelection[] {
  return questions.map(() => ({ labels: [], other: false, otherText: '' }));
}

/**
 * Read a `can_use_tool` input as an AskUserQuestion payload, or `null`.
 *
 * DEFENSIVE ON PURPOSE, and `null` is a real answer rather than a failure: the
 * caller falls back to the ordinary approval bar, which can still Allow and Deny
 * the call. A panel that threw — or that rendered a question with no options —
 * would take away the only controls the user had left, on the one message class
 * where the CLI is blocked on us and has no timeout of its own to save it.
 *
 * The CLI's payload is trusted for CONTENT and not for SHAPE. A question with no
 * usable options is dropped rather than rendered, because an option list is what
 * makes it answerable; every question dropped means `null` and the plain bar.
 */
export function parseAskUserQuestion(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== 'object') return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') return null;
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== 'string' || !rec.question) return null;
    if (!Array.isArray(rec.options)) return null;
    const options: AskOption[] = [];
    // Labels are DEDUPED, and this is the shape half of "trusted for content,
    // not for shape" doing real work. The label is the identity of an option
    // everywhere downstream — it is what a selection stores, what `aria-checked`
    // is derived from, what React keys the row on, and what goes on the wire —
    // so two options sharing one would tick together, answer twice ("Red, Red")
    // and collide as React keys. One `Set` and the whole class is gone.
    const seenLabels = new Set<string>();
    for (const o of rec.options) {
      if (!o || typeof o !== 'object') continue;
      const orec = o as Record<string, unknown>;
      if (typeof orec.label !== 'string' || !orec.label) continue;
      if (seenLabels.has(orec.label)) continue;
      seenLabels.add(orec.label);
      options.push({
        label: orec.label,
        description: typeof orec.description === 'string' ? orec.description : undefined,
      });
    }
    // No options = nothing to click. "Other" alone would technically be
    // answerable, but a question the CLI offered no choices for is a payload we
    // do not understand, and guessing at it is how a chooser starts inventing
    // its own questions (P7).
    if (options.length === 0) return null;
    questions.push({
      question: rec.question,
      header: typeof rec.header === 'string' && rec.header ? rec.header : undefined,
      options,
      multiSelect: rec.multiSelect === true,
    });
  }
  return questions.length > 0 ? questions : null;
}

/**
 * Is this question answered?
 *
 * "Other" chosen with nothing typed does NOT count. The word "Other" never
 * crosses the wire — the typed text takes its place — so submitting an empty
 * Other would send an empty answer, and an empty answer reads to the CLI as
 * `"question": ""`, which is a different and worse thing than not answering.
 */
export function questionAnswered(sel: AskSelection): boolean {
  if (sel.labels.length > 0) return true;
  return sel.other && sel.otherText.trim().length > 0;
}

/**
 * Every question answered? — what a COMPLETE answer is.
 *
 * Until #567 this was also what Submit was enabled by, and the reason was
 * honest: a partial `answers` map was a shape the probe had never sent, and the
 * two plausible CLI readings — "the rest were skipped" and "the rest are empty
 * strings" — are different enough to matter.
 *
 * The probe has since sent one (2026-08-19, findings §3a), so the refusal to
 * guess has nothing left to refuse. This predicate stays, unchanged, because
 * "complete" is still a real state worth naming — it is what the panel's tick,
 * its "still to answer" sentence and its skip warnings are all keyed off. What
 * it no longer is, is the gate. See `anyAnswered`.
 */
export function allAnswered(selections: readonly AskSelection[]): boolean {
  return selections.length > 0 && selections.every(questionAnswered);
}

/**
 * Is there anything worth SENDING? — what the Submit button is enabled by (#567).
 *
 * MEASURED, and this is the whole of the change (findings §3a): a partial
 * `answers` map is accepted exactly like a complete one — same success
 * `tool_result`, no error, no retry — and the CLI reads the omitted question as
 * **skipped**. Not as answered-with-silence: it strips empty-string values out
 * of the map before writing the result, so `{q: ''}` and a missing `q` are
 * literally indistinguishable downstream. Two independent runs showed the model
 * noticing the gap unprompted and offering to ask again.
 *
 * So the floor is ONE, not all. A user who wants to answer the question they
 * have an opinion about and leave the other alone can now do that, and see
 * exactly what they are choosing not to say.
 *
 * Why not zero. `empty` — an allow with **no `answers` key at all** — was
 * measured too, and it is the allow-all skip: *"The user did not answer the
 * questions."* An `answers` key present but holding **zero entries** was never
 * sent, so nobody knows what it does. One answer is the smallest map the probe
 * has evidence for, and it is also the only kind of send that means anything.
 */
export function anyAnswered(selections: readonly AskSelection[]): boolean {
  return selections.some(questionAnswered);
}

/**
 * Build the `answers` map that goes back on `updatedInput`.
 *
 * The measured rule, and nothing else: one entry per question keyed by its
 * text, chosen labels comma-space joined, and the Other row contributing its
 * TYPED TEXT in place of the word "Other".
 *
 * Order within a value follows the OPTION order rather than click order, so the
 * same set of ticks always produces the same string — a user who unticks and
 * re-ticks must not send a different answer from the one they read back. Other
 * goes last, where the row is.
 *
 * An unanswered question is OMITTED rather than sent as `""`, and since #567
 * that is a shape the UI deliberately produces rather than one that only shows
 * up when a caller forgets. It is the RIGHT one of the two: the CLI filters
 * empty-string values out of the map before it writes its `tool_result`, so
 * `""` cannot reach the model as "the user said nothing" — but it also cannot
 * be trusted to keep doing that for a value we have no reason to send. Omitting
 * says the same thing and says it in a shape the probe actually measured
 * (findings §3a).
 *
 * The map can therefore be SHORT. It must never be EMPTY — see `anyAnswered`
 * for why zero entries is a different, unmeasured thing — and `answersLookRight`
 * in main refuses one either way.
 */
export function buildAnswers(
  questions: readonly AskQuestion[],
  selections: readonly AskSelection[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const sel = selections[i];
    if (!sel || !questionAnswered(sel)) return;
    const chosen = q.options.map((o) => o.label).filter((label) => sel.labels.includes(label));
    if (sel.other && sel.otherText.trim()) chosen.push(sel.otherText.trim());
    if (chosen.length === 0) return;
    // Last writer wins on a duplicate question text — the collapse the CLI's own
    // consumer performs, since the wire has no other key. See `AskSelection`.
    answers[q.question] = chosen.join(', ');
  });
  return answers;
}

/**
 * The whole `updatedInput` for an allow.
 *
 * The CLI's input carried back VERBATIM with `answers` added — we do not edit
 * the questions, reorder the options or re-word anything (P7: the CLI is asking;
 * we carry the answer). Spreading the original also means a field the CLI adds
 * tomorrow survives a round trip through a panel that has never heard of it.
 */
export function answeredInput(
  input: Record<string, unknown>,
  questions: readonly AskQuestion[],
  selections: readonly AskSelection[]
): Record<string, unknown> {
  return { ...input, answers: buildAnswers(questions, selections) };
}

/**
 * Toggle one option, honouring the question's own arity.
 *
 * Returns a NEW selection; pick-one clears the rest, including Other, because a
 * radio group with two dots lit is not a state the wire can express.
 */
export function toggleOption(q: AskQuestion, sel: AskSelection, label: string): AskSelection {
  if (q.multiSelect) {
    const labels = sel.labels.includes(label)
      ? sel.labels.filter((l) => l !== label)
      : [...sel.labels, label];
    return { ...sel, labels };
  }
  return { labels: sel.labels.includes(label) ? [] : [label], other: false, otherText: sel.otherText };
}

/**
 * Toggle the "Other" row.
 *
 * The typed text SURVIVES being unticked and re-ticked — losing a sentence
 * someone typed because they mis-clicked a radio is the kind of small cruelty
 * that makes people stop using a panel. It is only read when `other` is true.
 */
export function toggleOther(q: AskQuestion, sel: AskSelection): AskSelection {
  if (q.multiSelect) return { ...sel, other: !sel.other };
  return { labels: [], other: !sel.other, otherText: sel.otherText };
}

// ── READING A SETTLED QUESTION BACK (#1201) ─────────────────────────────────
//
// Everything above is about ANSWERING a question. This is the other end: a
// question the user scrolls back to, or one replayed from a transcript when a
// session is resumed. Until #1201 that was a generic tool row whose detail was
// the raw payload: "it's displayed in what looks like JSON."
//
// THE ANSWERS ARE READ FROM THE CLI'S OWN RESULT TEXT. Two sources for what
// that text is, and they are kept apart on purpose:
//
// MEASURED (`spike/findings/s-11-ask-user-question.md`, CLI 2.1.233, and six
// real transcripts on the owner's machine):
//
//   answered     Your questions have been answered: "<q>"="<a>", "<q>"="<a>".
//                You can now continue with these answers in mind.
//   off the menu The user answered: "<q>"="<a>". Read the answers carefully …
//   declined     our own denial text, with `is_error`
//
//   A question the user SKIPPED is simply absent from the sentence ("blank"
//   and "partial" were byte-identical downstream).
//
// READ FROM THE INSTALLED BINARY (2.1.288), NOT YET PROBED. The strings are in
// `claude.exe`; nobody has made the CLI produce them in front of us:
//
//   a pair may carry more after its answer:
//                "<q>"="<a>" selected preview:\n<preview> notes: <notes>
//   and a pair with a note but no pick is
//                "<q>"=(no option selected) notes: <notes>
//   other openings:  … So far they answered: <pairs>. …
//                    Before going idle the user had selected: <pairs>.
//                    The user responded: <free text>
//                    The user did not answer the questions.
//
// switchboard's own panel sends none of the note or preview forms, so they
// arrive only from a question answered in another client. They are handled
// because misreading one would show an ANSWERED question as skipped, and that
// is the one outcome this must not produce.
//
// The CLI escapes nothing in that sentence, so it cannot be parsed on its own:
// a question or an answer may contain a quote, a comma, even `"="`. What makes
// it readable is that WE KNOW THE QUESTIONS. Each one is looked for by its own
// text, and an answer is whatever sits between one question's marker and the
// next one's. The Claude Code VS Code extension, the known-correct consumer of
// this contract, reads it the same way (it also takes a structured copy from
// the transcript when there is one; the stream has no such copy, and one rule
// for both sources is the point).
//
// WHEN IN DOUBT, THE SENTENCE ITSELF IS SHOWN. Any reading this cannot make
// with the questions it holds comes back as `declined` or `responded` with the
// result's own words, never as a confident row of "Skipped".

/** Longest question, label or description kept on a settled block. Display
 *  caps: a question is a sentence or two, and a block is held in memory for
 *  every session that is open. */
export const ASK_TEXT_CAP = 600;
/** ...and how many questions and options of one call are kept. The CLI's own
 *  schema allows four of each; this is head-room, not a contract. */
export const ASK_COUNT_CAP = 8;

/**
 * The questions of one call, clamped for display on a settled block.
 *
 * `clipped` rides along because the answer is looked up by the question's
 * text, and a clamped question must still be found in the result: the lookup
 * then matches on the kept prefix instead of the whole.
 */
export interface SettledQuestion extends AskQuestion {
  /** true when `question` was cut to `ASK_TEXT_CAP` */
  clipped?: true;
}

export function settledQuestions(input: unknown): SettledQuestion[] | null {
  const parsed = parseAskUserQuestion(input);
  if (!parsed) return null;
  return parsed.slice(0, ASK_COUNT_CAP).map((q) => {
    const clipped = q.question.length > ASK_TEXT_CAP;
    const out: SettledQuestion = {
      question: clipped ? q.question.slice(0, ASK_TEXT_CAP) : q.question,
      // LABELS ARE NOT CLAMPED: a label is what an answer is matched against,
      // and a cut one would never match its own answer. Descriptions are prose.
      options: q.options.slice(0, ASK_COUNT_CAP).map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description.slice(0, ASK_TEXT_CAP) } : {}),
      })),
      multiSelect: q.multiSelect,
    };
    if (q.header) out.header = q.header.slice(0, ASK_TEXT_CAP);
    if (clipped) out.clipped = true;
    return out;
  });
}

/** What came back for ONE question. */
export interface AskAnswerRead {
  /** the answer's text; null = nothing was picked or typed */
  answer: string | null;
  /** a note the user left beside it (another client's feature) */
  notes?: string;
}

/** What became of a question call. */
export type AskOutcome =
  /** no result yet: the live panel is where this one is being answered */
  | { state: 'pending' }
  /**
   * One entry per question, in the questions' order; null = not in the
   * sentence. `cut` = the result was cut short before its end, so "not in the
   * sentence" may only mean "past the cut" and must not be called skipped.
   */
  | { state: 'answered'; answers: Array<AskAnswerRead | null>; cut: boolean }
  /** the user answered in their own words instead of through the choices */
  | { state: 'responded'; text: string }
  /** the call came back without answers; `reason` is the result's own words */
  | { state: 'declined'; reason: string };

/** Each is followed by the pairs. Searched for ANYWHERE: two of them open
 *  mid-sentence. */
const PAIR_OPENINGS = [
  'Your questions have been answered: ',
  'The user answered: ',
  'So far they answered: ',
  'Before going idle the user had selected: ',
];
const RESPONDED_PREFIX = 'The user responded: ';
/** the sentences the CLI is known to close the pairs with, each after `".` */
const ANSWERED_TAILS = ['". You can now continue', '". Read the answers carefully'];
const NO_PICK = '(no option selected)';
const NOTES = ' notes: ';
const PREVIEW = ' selected preview:';

export function readAskResult(
  questions: readonly SettledQuestion[],
  result: string | undefined
): AskOutcome {
  if (result === undefined) return { state: 'pending' };
  if (result.startsWith(RESPONDED_PREFIX)) {
    return { state: 'responded', text: result.slice(RESPONDED_PREFIX.length).trim() };
  }
  const opening = PAIR_OPENINGS.map((p) => ({ p, at: result.indexOf(p) }))
    .filter((o) => o.at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  if (!opening) return { state: 'declined', reason: result.trim() };
  const body = result.slice(opening.at + opening.p.length);

  // Where each question's `"<text>"=` sits. Searched in order, so two
  // questions with different text keep their places; one that is not found
  // after the last is looked for from the start, because the wire keys answers
  // by question TEXT and two questions with the same text share one pair.
  const marks: Array<Marker | null> = [];
  let from = 0;
  for (const q of questions) {
    const found = findMarker(body, q, from) ?? (from > 0 ? findMarker(body, q, 0) : null);
    marks.push(found);
    if (found && found.valueAt >= from) from = found.valueAt;
  }
  const placed = [...new Set(marks.filter((m): m is Marker => m !== null).map((m) => m.at))].sort(
    (a, b) => a - b
  );
  const tail = Math.max(...ANSWERED_TAILS.map((t) => body.lastIndexOf(t)));
  // Cut short: main keeps a bounded slice of every result, and a long typed
  // answer can push the end of the sentence past it. Without its known close
  // and without a full stop, the end we have is not the end.
  const cut = tail === -1 && !/[.!?]["')\]]?\s*$/.test(body);

  const answers = marks.map((m) => {
    if (!m) return null;
    const nextAt = placed.find((at) => at > m.at);
    // a pair runs to the `, ` before the next question, or to the close
    const end = nextAt !== undefined ? nextAt - 2 : tail !== -1 ? tail + 1 : body.length;
    return readPair(body.slice(m.valueAt, Math.max(end, m.valueAt)), nextAt === undefined && tail === -1);
  });
  // The sentence had the answered shape but none of OUR questions is in it:
  // the payload and the result have parted, and the honest thing to show is
  // the result's own words rather than rows of "skipped".
  if (questions.length > 0 && answers.every((a) => a === null) && body.includes('"=')) {
    return { state: 'declined', reason: result.trim() };
  }
  return { state: 'answered', answers, cut };
}

interface Marker {
  /** where the pair's opening quote is */
  at: number;
  /** where its value starts: just after `"=` */
  valueAt: number;
}

function findMarker(body: string, q: SettledQuestion, from: number): Marker | null {
  const open = `"${q.question}`;
  let at = body.indexOf(open, from);
  while (at !== -1) {
    // only at the start of the pairs, or after the `, ` that separates two
    const boundary = at === 0 || body.slice(at - 2, at) === ', ';
    const afterText = at + open.length;
    // a whole question is followed at once by `"=`; a clipped one by the rest
    // of its own text first
    const eq = q.clipped
      ? body.indexOf('"=', afterText)
      : body.startsWith('"=', afterText)
        ? afterText
        : -1;
    if (boundary && eq !== -1) {
      const valueAt = eq + 2;
      // a value is a quoted answer, or the words for "nothing picked"
      if (body[valueAt] === '"' || body.startsWith(NO_PICK, valueAt)) return { at, valueAt };
    }
    at = body.indexOf(open, at + 1);
  }
  return null;
}

/**
 * One pair's value: `"<answer>"`, optionally followed by a preview and a note,
 * or `(no option selected)` followed by a note.
 */
function readPair(value: string, openEnded: boolean): AskAnswerRead {
  const notesOf = (rest: string): { notes?: string } => {
    const at = rest.indexOf(NOTES);
    if (at === -1) return {};
    const notes = rest.slice(at + NOTES.length).trim();
    return notes ? { notes } : {};
  };
  if (value.startsWith(NO_PICK)) return { answer: null, ...notesOf(value.slice(NO_PICK.length)) };
  const inner = value.slice(1); // past the opening quote
  // the answer closes at the quote before a preview or a note, when there is
  // one; otherwise at the pair's own last quote
  const extras = [`"${PREVIEW}`, `"${NOTES}`].map((m) => inner.indexOf(m)).filter((i) => i !== -1);
  let close: number;
  if (extras.length > 0) close = Math.min(...extras);
  else {
    const last = inner.lastIndexOf('"');
    // no closing quote at all only happens at a cut: keep what there is
    close = last !== -1 ? last : openEnded ? inner.length : -1;
  }
  if (close === -1) return { answer: null };
  const answer = inner.slice(0, close);
  return { answer: answer === '' ? null : answer, ...notesOf(inner.slice(close + 1)) };
}

/**
 * One answer, set against the options that were offered.
 *
 * `picked` are offered labels; `other` is what was typed instead of, or beside,
 * them. A multi-select answer is the labels joined with ", " (measured), so it
 * is split on that ONLY when no offered label contains ", " itself. Otherwise
 * the labels are found by their own text, longest first.
 *
 * KNOWN LIMIT, inherent in an unescaped format: on a multi-select, typed text
 * that happens to contain an offered label after a ", " ticks that label.
 */
export function pickedFor(
  q: AskQuestion,
  answer: string
): { picked: string[]; other: string | null } {
  const labels = q.options.map((o) => o.label);
  if (labels.includes(answer)) return { picked: [answer], other: null };
  if (!q.multiSelect) return { picked: [], other: answer };
  const parts = labels.some((l) => l.includes(', '))
    ? splitByLabels(answer, labels)
    : answer.split(', ');
  const picked = labels.filter((l) => parts.includes(l));
  const rest = parts.filter((p) => !labels.includes(p));
  return { picked, other: rest.length > 0 ? rest.join(', ') : null };
}

function splitByLabels(answer: string, labels: readonly string[]): string[] {
  const out: string[] = [];
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  let rest = answer;
  while (rest.length > 0) {
    const hit = byLength.find((l) => rest === l || rest.startsWith(`${l}, `));
    if (!hit) {
      out.push(rest);
      break;
    }
    out.push(hit);
    rest = rest.slice(hit.length + 2);
  }
  return out;
}
