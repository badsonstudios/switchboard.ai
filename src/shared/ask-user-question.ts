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
 * Every question answered? What the Submit button is enabled by.
 *
 * ALL of them, and this is a deliberate refusal to guess. A partial `answers`
 * map is a shape the probe did not measure, and the two plausible CLI readings —
 * "the rest were skipped" and "the rest are empty strings" — are different
 * enough to matter. Requiring a complete answer means we only ever send the
 * shape that was measured. The user who wants to answer only one question has a
 * measured route: Other, in their own words.
 */
export function allAnswered(selections: readonly AskSelection[]): boolean {
  return selections.length > 0 && selections.every(questionAnswered);
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
 * An unanswered question is OMITTED rather than sent empty; `allAnswered` is
 * what stops that happening from the UI, and this stays honest if some later
 * caller forgets.
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
