// The CLI's own question, answerable (#563, the `AskUserQuestion` half of
// E18-11).
//
// WHY IT IS THE APPROVAL BAR'S DOCK AND NOT A PLACE OF ITS OWN
// ------------------------------------------------------------
// A question and a permission are the same user question — "what does this
// session want from me?" — and #125 measured what happens when the answer to
// that lives in two places: the user is trained by every prior permission to
// look above the composer, so a chip anywhere else is invisible even while it
// renders perfectly. So this replaces `ApprovalBar` in the same dock rather
// than appearing beside it, and the two can never be on screen at once.
//
// WHAT IT MAY AND MAY NOT DO (P7)
// -------------------------------
// The CLI wrote the question, the options and the descriptions. We render them
// verbatim — never re-worded, never re-ordered, never filtered, and we never
// answer on the session's behalf. The ONLY thing this panel adds is the "Other"
// row, and that is not an invention either: the CLI accepts free text in the
// answer slot and has its own wording for having received some (measured, see
// `shared/ask-user-question`). Adding it is carrying a capability the CLI
// already has, which is the opposite of faking one it kept.
//
// TABS FOR A MULTI-QUESTION CALL, AND THE HAZARD THAT CAME WITH THEM (#566)
// -------------------------------------------------------------------------
// #563 shipped a multi-question call STACKED in one scroller, and said why:
// the VS Code extension's tab strip has a failure a stack cannot have — an
// unanswered tab is OFF SCREEN, so a user can reach Submit without ever seeing
// what else was asked, and the only thing telling them is a subtle dot.
//
// The owner asked for tabs anyway (2026-08-17, answered through this very
// panel — #563's first real use). So this is not the stacked reasoning being
// forgotten; it is the same reasoning being made to hold with tabs, which is
// the whole of #566:
//
//  1. **Submit still requires EVERY question answered.** Unchanged from #563
//     (`allAnswered`): a partial `answers` map is a shape the probe never
//     measured. So the hazard is not "submit blind" — it is milder and
//     different: Submit is dead and the user cannot see why. *(Superseded by
//     #567 — see below. Everything else in this list still holds.)*
//  2. **So every tab states its own answered/unanswered state**, in SHAPE as
//     well as hue (§5.32, never hue alone): `✓` answered, `○` not, and the
//     tab's accessible name SAYS which — "Colour — not answered yet". A dot
//     you have to already understand is exactly what the stacked layout was
//     avoiding.
//  3. **And the panel names what is missing in words.** While Submit is dead,
//     a multi-question panel prints "Still to answer: Languages" beside it.
//     That is the sentence the tab dots were trying to be, and it is the one
//     thing a strip of tabs genuinely cannot say at a glance once there are
//     five of them.
//  4. **The panel OPENS on the first unanswered question** — on arrival, and
//     again after the remount that #563's draft map exists for. You never come
//     back to a panel parked on work that is already done.
//
// A PARTIAL ANSWER IS A REAL ANSWER (#567)
// ----------------------------------------
// #563 and #566 both gated Submit on `allAnswered` for one stated reason: a
// partial `answers` map was unmeasured. It is measured now (2026-08-19,
// findings §3a) — the CLI accepts a short map exactly like a complete one and
// reads the missing question as SKIPPED, not as answered-with-silence. So the
// gate drops to `anyAnswered`: one answer is enough to send.
//
// That trades a milder hazard for a sharper one, and the sharper one is what
// most of the code below is about. "Submit is dead and you cannot see why" is
// annoying; "you sent an answer and did not notice you had skipped a question
// that was off screen behind a tab" is the extension's own failure, arriving
// through the front door. So an unanswered question, from the moment sending is
// possible, is not merely un-ticked anywhere it appears:
//
//  • **its tab** carries the literal word "skipped", and its accessible name
//    stops saying "not answered yet" and starts saying "will be sent as
//    skipped" (a dashed border + strikethrough until #733 — see the tab);
//  • **the question in front of you** replaces its grey dot with those words;
//  • **the sentence beside the button** changes from "Still to answer: X" —
//    which explains a dead button — to "Sending now skips: X", which explains a
//    live one. Same element, opposite job, and the button's own tooltip agrees.
//
// The user should be able to SEE what they are choosing not to say. Nothing
// here nags, blocks or confirms: skipping is a legitimate answer, and the panel
// only has to make it a visible one.
//
// THE PANEL WALKS YOU THROUGH IT (#733)
// -------------------------------------
// #566 shipped without the extension's auto-advance, on the grounds that it is
// a small theft when you wanted to change the answer you just gave. The owner
// used the panel in anger and asked for it: one click per pick-one question,
// and the strip walks itself. So:
//
//  • **A pick-one answer moves to the next UNANSWERED question** — not `i + 1`:
//    re-answering question 1 of 3 with 2 already done lands on 3, and the walk
//    wraps. Only when the click leaves the question ANSWERED (a radio re-click
//    deselects), never for Other (that click is a promise to type, and the field
//    it opens has the caret), never for a checkbox (a tick is not a complete
//    answer), and never past the last unanswered one — that is Send answer's
//    moment, and the panel does not press it for you. Immediate rather than the
//    extension's 300ms: the ✓ on the tab you just left is the confirmation, and
//    a timer is a race with the second click it was meant to allow.
//  • **A Next question button** is the same move on demand — how you get OFF a
//    checkbox question, and a walk that needs no aim at the strip. ONE function
//    (`advance`) behind both, and it is disabled exactly when that function has
//    nowhere to go: a button that wraps you to an answered tab reads as a bug.
//  • **Focus goes with the move**, to the new question's first option. The
//    block that held it has just unmounted, and a focus left to fall to <body>
//    is a keyboard user dropped out of the panel.
//
// ONE QUESTION IS NOT A TAB STRIP. The overwhelmingly common call carries one
// question, and it renders with no tab furniture at all — same panel #563
// shipped, to the pixel.
//
// Keyboard (§5.32): Left/Right walk the STRIP, Up/Down walk the options of the
// question in front of you. The strip is a real `tablist`, so it owes the
// roving tab stop and the arrow keys `tabStripAction` already spells out for
// the card's view tabs — reused rather than re-derived. It differs from that
// strip in one way, deliberately: activation is AUTOMATIC here. The view strip
// is manual because arrowing onto Changes would build a Monaco diff; a
// question panel costs nothing to show, and automatic activation means an
// arrow key cannot leave a user looking at a tab they have not selected —
// which is the off-screen hazard sneaking back in through the keyboard.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { tabStripAction } from '../lib/tabstrip-keys';
import {
  allAnswered,
  answeredInput,
  anyAnswered,
  AskQuestion,
  AskSelection,
  emptySelections,
  questionAnswered,
  toggleOption,
  toggleOther,
} from '../../../shared/ask-user-question';

/** How the panel answers — the card's `decide`, with the answer riding along. */
export type QuestionDecide = (
  decision: 'allow' | 'deny',
  allowAll?: boolean,
  updatedInput?: unknown
) => void;

/**
 * Answers in progress, keyed by request id, OUTSIDE React (#563 review).
 *
 * The Session panel is not `keepMounted` — nothing is, since #873 — so clicking
 * **Changes** to look at the diff before answering "which of these three
 * approaches?", collapsing the card, or a dockview move that remounts the tree
 * all unmount this component. With the selections in component state alone,
 * every tick and every word typed into Other would be gone, silently, on the
 * single most likely thing a person does in the middle of answering a question.
 *
 * Module-level rather than in `sessionStore`: this is scratch input for one
 * request, not session state anything else reads, and the store's permission
 * ledger is about what is HELD rather than about what has been half-typed.
 * Keyed by request id, which is unique per question and dies with it, and
 * cleared the moment the request is answered — so the map holds at most one
 * entry per unanswered question on screen.
 */
const drafts = new Map<string, AskSelection[]>();

/**
 * How many unanswered questions may hold a draft at once.
 *
 * Answering clears its own entry, but a question can also end WITHOUT one — the
 * hold deadline, a session that exits, a card that closes — and nothing tells
 * this module about those. The map is keyed by an id that is never reused, so
 * the entry would simply sit there: unreadable, unreachable and permanent. A
 * cap turns "grows for the life of the process" into "at most twenty small
 * arrays", which is far more than can be on screen and small enough not to
 * think about again. Oldest first, so the draft the user is looking at is the
 * last thing evicted.
 */
const MAX_DRAFTS = 20;

/** Forget a question's in-progress answer. Exported for the test that proves
 *  the draft does not outlive the request it belongs to. */
export function forgetQuestionDraft(requestId: string): void {
  drafts.delete(requestId);
}

function rememberDraft(requestId: string, selections: AskSelection[]): void {
  // delete-then-set so a re-touched draft moves to the END of the insertion
  // order and cannot be evicted while it is the one being typed into
  drafts.delete(requestId);
  drafts.set(requestId, selections);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
}

/**
 * The panel's own background, in one place because the tab strip STICKS to the
 * top of the scroller and has to paint the same thing the panel does — a
 * transparent sticky strip shows the options sliding under it. Two literals
 * would drift the first time either is tuned.
 */
const PANEL_TINT = 'color-mix(in srgb, var(--status-needs-input) 8%, var(--panel2))';

/**
 * Which question to put in front of the user — the first one still missing an
 * answer, or the first question if they are all answered.
 *
 * Used on arrival AND after the remount `drafts` exists for (#563): coming back
 * from the Changes tab onto a tab you already answered, with the unanswered one
 * hidden behind it, is the off-screen hazard #566 owns.
 */
function firstUnanswered(selections: readonly AskSelection[]): number {
  const i = selections.findIndex((s) => !questionAnswered(s));
  return i === -1 ? 0 : i;
}

/**
 * Where an advance goes (#733): the next UNANSWERED question after `from`,
 * wrapping past the end — or -1 when there is nowhere honest to go.
 *
 * `from` itself is never a destination, so "the only unanswered question is the
 * one you are on" and "everything is answered" both come out -1 by
 * construction. That one value is what BOTH triggers read: the auto-advance
 * stays put on it, and the Next question button is disabled by it. Two copies
 * of this rule would drift the first time one of them was tuned.
 */
export function nextUnanswered(selections: readonly AskSelection[], from: number): number {
  const n = selections.length;
  for (let k = 1; k < n; k++) {
    const j = (from + k) % n;
    const sel = selections[j];
    if (sel && !questionAnswered(sel)) return j;
  }
  return -1;
}

export function QuestionPanel({
  requestId,
  questions,
  input,
  queued,
  onDecide,
}: {
  /** the held request this panel answers — also the draft's key */
  requestId: string;
  /** already parsed and validated — see `parseAskUserQuestion` */
  questions: readonly AskQuestion[];
  /** the CLI's whole tool input, carried back verbatim under the answers */
  input: Record<string, unknown>;
  /** other requests this card is still holding, for the same note the bar shows */
  queued: number;
  onDecide: QuestionDecide;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Keyed by INDEX (see `AskSelection`), seeded from the DRAFT so a remount does
  // not throw away half an answer, and re-seeded when the QUESTIONS change —
  // this component stays mounted across consecutive questions in one session,
  // and without the reset the last question's answers would be sitting in the
  // next one's checkboxes. `key` on the caller does the same job for a different
  // card; both, because either alone leaves one of the two paths.
  const [selections, setSelections] = React.useState<AskSelection[]>(
    () => drafts.get(requestId) ?? emptySelections(questions)
  );
  // Which tab is open. Seeded from the SELECTIONS rather than to 0, so a panel
  // that comes back from a remount half-answered opens on the half that is
  // still missing (see `firstUnanswered`).
  const [active, setActive] = React.useState<number>(() => firstUnanswered(selections));
  // The question an ADVANCE just opened, whose first option should get focus
  // once it is in the DOM (#733). A ref and not state: it is a one-shot
  // instruction to the next commit, and it must not itself cause a render.
  // Null for every other way the tab changes — clicking a tab or arrowing the
  // strip already put focus where the user wanted it.
  const focusOnArrival = React.useRef<number | null>(null);
  React.useEffect(() => {
    const next = drafts.get(requestId) ?? emptySelections(questions);
    setSelections(next);
    setActive(firstUnanswered(next));
    focusOnArrival.current = null;
  }, [requestId, questions]);
  const otherRefs = React.useRef<Array<HTMLInputElement | null>>([]);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // The effect above resets `active` when the questions change, but it runs
  // AFTER the render that saw the new list — so a call that shrank from three
  // questions to one would index past the end once, on that render, with
  // nothing to catch it. Clamping costs a line and removes the whole class.
  const activeIndex = Math.min(Math.max(active, 0), questions.length - 1);
  const tabbed = questions.length > 1;
  const tabsId = React.useId();

  const complete = allAnswered(selections);
  // What Submit is gated on since #567: ONE answer, not all of them. `complete`
  // has not gone anywhere — it is what decides whether anything is being
  // skipped, which is what the rest of the panel has to show.
  const sendable = anyAnswered(selections);
  // Sending RIGHT NOW would leave a question unanswered. The state every skip
  // affordance below is keyed off — and, with one question, a state that cannot
  // exist: `sendable` and `complete` are the same thing when there is only one.
  const skipping = sendable && !complete;
  const tabLabel = (q: AskQuestion, i: number): string =>
    q.header ?? t('question.tabFallback', { n: i + 1 });
  const answeredAt = (i: number): boolean =>
    questionAnswered(selections[i] ?? { labels: [], other: false, otherText: '' });
  // The unanswered questions, named in WORDS rather than implied by a glyph on
  // a tab that may be one of five. This is the sentence the extension's tab
  // dots are trying to be, and it answers whichever question is live: "why is
  // Send answer dead?" before anything is answered, and "what am I about to
  // leave out?" once it is not.
  const missing = questions.map((q, i) => tabLabel(q, i)).filter((_, i) => !answeredAt(i));
  const finish = (decision: 'allow' | 'deny', updatedInput?: unknown): void => {
    // The draft dies with the request, whichever way it was answered: the id is
    // never reused, so an entry left behind is a leak that also cannot be read.
    forgetQuestionDraft(requestId);
    onDecide(decision, false, updatedInput);
  };
  const submit = (): void => {
    // ONE answer is the floor (#567). Zero is not a send: an `answers` map with
    // no entries is the one shape around here nobody has measured, and an allow
    // carrying nothing is the allow-all skip this panel exists to prevent.
    if (!sendable) return;
    finish('allow', answeredInput(input, questions, selections));
  };

  const update = (i: number, next: AskSelection): void =>
    setSelections((prev) => {
      const nextAll = prev.map((s, j) => (j === i ? next : s));
      rememberDraft(requestId, nextAll);
      return nextAll;
    });

  // After the commit that mounted the question an advance opened: put focus on
  // its first option. A LAYOUT effect so it lands before paint — the block that
  // held focus unmounted in this same commit, and a passive effect would leave
  // one frame where focus sits on <body> for a screen reader to announce.
  // Scoped to this panel's own DOM, so a popped-out card focuses in its own
  // window (the #573 lesson the strip and the option list both obey).
  //
  // One exception to "first option": a destination with Other ticked and
  // nothing typed (unanswered, so a real destination) focuses the FIELD — the
  // only thing that question is waiting for, and the same promise-to-type
  // `pickOther` keeps. A checked option cannot be the target otherwise: the
  // destination is unanswered by definition.
  //
  // NO dependency list, deliberately: every commit consumes the one-shot ref.
  // Keyed on the active index instead, an advance that ever failed to change it
  // would leave the ref armed, and the next arrow-walk of the strip would yank
  // focus off the tab it reached — breaking the strip's own contract silently.
  React.useLayoutEffect(() => {
    const to = focusOnArrival.current;
    if (to === null) return;
    focusOnArrival.current = null;
    const block = panelRef.current?.querySelector(`[data-question-index="${to}"]`);
    const target =
      block?.querySelector<HTMLElement>('[data-question-other-input]') ??
      block?.querySelector<HTMLElement>('[role="radio"],[role="checkbox"]');
    target?.focus();
  });

  /**
   * THE move (#733), for both triggers: the auto-advance after a pick-one
   * answer, and the Next question button. Reading the closure's selections is
   * safe even mid-click, when they predate the answer being committed: the only
   * slot that answer changes is `from`, and `nextUnanswered` never looks there.
   */
  const advance = (from: number): void => {
    const to = nextUnanswered(selections, from);
    if (to === -1) return;
    focusOnArrival.current = to;
    setActive(to);
  };
  // Nowhere honest to go — the button's disabled state is the same -1 the
  // auto-advance stays put on, never a second rule.
  const canAdvance = tabbed && nextUnanswered(selections, activeIndex) !== -1;

  const pick = (i: number, label: string): void => {
    const sel = selections[i];
    const q = questions[i];
    if (!sel || !q) return;
    const next = toggleOption(q, sel, label);
    update(i, next);
    // A pick-one answer is a COMPLETE answer, so the panel moves on. Not for a
    // checkbox (more ticks may follow — Next question is the way off), and
    // not for a re-click that DESELECTED the radio: that leaves the question
    // unanswered, and walking away from it would hide the very thing just
    // undone. One question has nowhere to go, so `advance` is a no-op there.
    if (!q.multiSelect && questionAnswered(next)) advance(i);
  };

  const pickOther = (i: number): void => {
    const sel = selections[i];
    const q = questions[i];
    if (!sel || !q) return;
    const next = toggleOther(q, sel);
    update(i, next);
    // Ticking Other is a statement of intent to type; the field it opens should
    // already have the caret. After the state lands, or the input is not there
    // yet to focus. And it NEVER advances (#733), not even on a pick-one: the
    // question is not answered until something is typed, and yanking the tab
    // away would take the field with it.
    if (next.other) window.setTimeout(() => otherRefs.current[i]?.focus(), 0);
  };

  return (
    <div
      ref={panelRef}
      data-testid="question-panel"
      role="group"
      aria-label={t('question.title')}
      style={{
        // never give up height: the session is BLOCKED on this, and the CLI has
        // no timeout of its own behind it — measured at 180s with no fallback,
        // see the findings note. (OUR deadline is 30 minutes for a question, and
        // it is the only one there is: `QUESTION_HOLD_MS`.)
        flexShrink: 0,
        borderBlockStart: '2px solid var(--status-needs-input)',
        background: PANEL_TINT,
        padding: '8px 10px',
        fontSize: 11,
        maxBlockSize: 320,
        overflow: 'auto',
      }}
    >
      {/* It arrives without anyone navigating to it, so the heading announces —
          on the heading and not the controls, or every tick would re-read the
          whole panel (the EventsPanel notices' idiom, #314). */}
      <div
        role="status"
        aria-live="polite"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBlockEnd: 6 }}
      >
        {/* -ink, not the bare hue: the title sits on this panel's own 8% tint of
            that same hue, and tokens.css tunes the --status-* hues for dots and
            rings rather than for text on a tint (#246). */}
        <span style={{ fontWeight: 700, color: 'var(--status-needs-input-ink)' }}>
          {t('question.title')}
        </span>
        {queued > 0 && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('approval.more', { n: queued })}</span>
        )}
      </div>
      {/* ONE question gets no tab furniture — the common call, unchanged from
          #563. Several get a real tablist, and then only the selected question
          is in the DOM at all. */}
      {tabbed && (
        <QuestionTabs
          idBase={tabsId}
          labels={questions.map((q, i) => tabLabel(q, i))}
          answered={questions.map((_, i) => answeredAt(i))}
          skipping={skipping}
          active={activeIndex}
          onSelect={setActive}
        />
      )}
      {questions.map((q, i) => {
        if (tabbed && i !== activeIndex) return null;
        const block = (
          <QuestionBlock
            key={`${i}:${q.question}`}
            index={i}
            question={q}
            // the tab already carries the header, in bigger letters and with
            // the answered state on it — the chip would just say it twice
            showHeader={!tabbed}
            skipping={skipping}
            selection={selections[i] ?? { labels: [], other: false, otherText: '' }}
            onPick={pick}
            onPickOther={pickOther}
            onOtherText={(text) => {
              const sel = selections[i];
              if (sel) update(i, { ...sel, otherText: text });
            }}
            onSubmit={submit}
            otherRef={(el) => {
              otherRefs.current[i] = el;
            }}
          />
        );
        if (!tabbed) return block;
        return (
          <div
            key={`panel:${i}`}
            role="tabpanel"
            id={`${tabsId}qpanel-${i}`}
            aria-labelledby={`${tabsId}qtab-${i}`}
            // no tabIndex: APG asks for one only when the panel holds nothing
            // focusable, and every option row in here is a tab stop
          >
            {block}
          </div>
        );
      })}
      {/* Wraps only when tabbed: three buttons and a sentence can outgrow a
          narrow card, and a single-question panel keeps #563's row exactly. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: tabbed ? 'wrap' : undefined }}>
        {/* NEXT QUESTION (#733), first in the row because that is the order
            the owner listed: Next question · Send answer · Don't answer. The
            same `advance` the pick-one auto-advance uses, on demand — the way
            off a checkbox question, and a walk through the panel that needs no
            aim at the strip. Neutral, not primary: Send is still the button
            that finishes the job. */}
        {tabbed && (
          <button
            type="button"
            data-testid="question-next"
            onClick={() => advance(activeIndex)}
            disabled={!canAdvance}
            // a dead button says why, the same idiom Send answer uses
            title={canAdvance ? undefined : t('question.nextHint')}
            style={{
              background: 'var(--panel)',
              color: canAdvance ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '4px 14px',
              cursor: canAdvance ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-ui)',
              fontSize: 12,
              whiteSpace: 'nowrap',
            }}
          >
            {t('question.next')}
          </button>
        )}
        <button
          type="button"
          data-testid="question-submit"
          onClick={submit}
          disabled={!sendable}
          data-question-submit-partial={skipping}
          // A button that is dead says nothing about WHY, and a button that is
          // live says nothing about what it is ABOUT to do. Both need a
          // sentence, and they are different sentences: "answer one of them
          // first" while nothing is answered, and "the rest go back marked
          // skipped" once something is. Belt to the visible affordances rather
          // than a replacement for them — a tooltip nobody hovers is not how
          // anyone finds out they skipped a question (#567).
          title={
            !sendable
              ? t('question.submitHint')
              : skipping
                ? t('question.submitPartialHint')
                : undefined
          }
          style={{
            background: sendable ? 'var(--btn-primary-bg)' : 'var(--panel)',
            color: sendable ? 'var(--btn-primary-text)' : 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '4px 14px',
            cursor: sendable ? 'pointer' : 'not-allowed',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
          }}
        >
          {t('question.submit')}
        </button>
        {/* Refusing IS an answer, and a safe one: the CLI takes a deny as an
            `is_error` tool result and asks again in prose rather than stalling
            (measured, probe mode `deny`). The message is written for the MODEL,
            which reads it — `HookListener.verdict` records what happens when a
            denial sounds like infrastructure: Claude routes around it. */}
        <button
          type="button"
          data-testid="question-dismiss"
          onClick={() => finish('deny')}
          style={{
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '4px 14px',
            cursor: 'pointer',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
          }}
        >
          {t('question.dismiss')}
        </button>
        {/* WHY THIS SENTENCE EXISTS (#566). With the questions stacked, "which
            one is still missing?" was answered by looking down the panel. With
            tabs it is answered by a glyph on a tab that might be off the end of
            the strip — so the panel says it in words instead, right next to the
            button it is about. Only when there IS more than one question: a
            single-question panel keeps exactly the #563 layout, and its Submit
            title already says the same thing.

            IT NOW HAS TWO JOBS (#567), because the button beside it does. While
            nothing is answered it explains a dead button — "Still to answer".
            The moment sending becomes possible it explains a LIVE one, naming
            the questions that will go back skipped, and it is deliberately the
            same element in the same place: the sentence a user has already
            learned to read is the one that has to carry the news.
            NOT a live region: it changes on every tick, and re-reading it each
            time would talk over the option the user just chose. */}
        {tabbed && !complete && (
          <span
            data-testid="question-remaining"
            data-question-skipping={skipping}
            style={{ fontSize: 10.5, color: skipping ? 'var(--status-needs-input-ink)' : 'var(--muted)' }}
          >
            {t(skipping ? 'question.willSkip' : 'question.stillToAnswer', {
              headers: missing.join(', '),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The tab strip for a multi-question call (#566) — one tab per question,
 * labelled by the CLI's own `header`.
 *
 * A REAL `tablist`, because the role is TRUE here (§5.32 rule 3: composite
 * roles only where they are): these tabs select which one of several question
 * panels is shown. Declaring it obliges the roving tab stop and the arrow keys,
 * and `tabStripAction` — written for the card's view strip (#197) — already
 * spells out exactly those semantics, wrap included.
 *
 * Two things it does that the view strip does not:
 *
 *   • **Automatic activation.** The view strip is manual because arrowing onto
 *     Changes would mount a Monaco diff for a tab you were only passing
 *     through. A question costs nothing to show, and manual activation would
 *     let an arrow key leave the user LOOKING at a tab they have not selected —
 *     the off-screen hazard, back in through the keyboard.
 *   • **Every tab states whether it is answered**, in shape as well as hue and
 *     in its accessible NAME, not only as a glyph. This is the half of #566
 *     that keeps the stacked layout's guarantee: an unanswered question is off
 *     screen now, so the tab has to be the one saying so.
 *
 * It STICKS to the top of the panel's scroller: a strip that scrolls away is a
 * strip that stops answering "what else was asked" at exactly the moment a long
 * question makes the panel scroll.
 */
function QuestionTabs({
  idBase,
  labels,
  answered,
  skipping,
  active,
  onSelect,
}: {
  /** `useId` prefix, so tab <-> tabpanel wiring is unique per mounted panel */
  idBase: string;
  /** one per question, in order — the CLI's `header`, or a numbered fallback */
  labels: readonly string[];
  /** one per question, in order */
  answered: readonly boolean[];
  /**
   * Sending is possible AND something here is unanswered (#567), so every
   * unanswered tab is now a tab that is about to be sent as skipped. Not a
   * per-tab flag: it is one fact about the panel, and an unanswered tab means
   * something different depending on it.
   */
  skipping: boolean;
  active: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // `ownerDocument`, not the global `document`: a popped-out card portals this
    // panel into another window, whose focus the main document knows nothing
    // about (the lesson #573 wrote into the view strip's own handler).
    const doc = e.currentTarget.ownerDocument;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const action = tabStripAction(e.key, {
      count: tabs.length,
      current: tabs.indexOf(doc.activeElement as HTMLElement),
    });
    if (!action) return;
    e.preventDefault();
    // Up/Down belong to the option list below and Left/Right belong here; the
    // feed above owns some of both. A walk inside this strip is none of those.
    e.stopPropagation();
    const to = action.kind === 'focus' ? action.index : tabs.indexOf(doc.activeElement as HTMLElement);
    if (to < 0) return;
    // focus BEFORE selecting: the roving tab stop follows selection, so the tab
    // we are leaving loses its stop in the same commit — focus it first and the
    // browser never has to guess where focus went.
    tabs[to]?.focus();
    onSelect(to);
  };

  return (
    <div
      role="tablist"
      data-testid="question-tabs"
      aria-label={t('question.tabs')}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginBlockEnd: 6,
        // Pinned to the top of the panel's scroller, painting the panel's own
        // background so the options slide BEHIND it rather than through it. A
        // strip that scrolls away stops answering "what else was asked" at
        // exactly the moment a long question makes the panel scroll. The
        // negative inline margin cancels the panel's side padding, so the strip
        // spans the full width and nothing shows past its edges.
        position: 'sticky',
        insetBlockStart: 0,
        marginInline: -10,
        paddingInline: 10,
        paddingBlock: '2px 4px',
        background: PANEL_TINT,
        zIndex: 1,
      }}
    >
      {labels.map((text, i) => {
        const on = i === active;
        const done = answered[i] === true;
        // this tab is one of the ones a click on Send answer would leave out
        const willSkip = !done && skipping;
        return (
          <button
            key={`${i}:${text}`}
            type="button"
            role="tab"
            id={`${idBase}qtab-${i}`}
            data-question-tab={i}
            data-question-tab-answered={done}
            data-question-tab-skipping={willSkip}
            aria-selected={on}
            aria-controls={on ? `${idBase}qpanel-${i}` : undefined}
            // The roving stop a tablist owes: one Tab reaches the strip, arrows
            // move inside it. Activation is automatic, so the stop is simply
            // the selected tab — focus and selection cannot come apart.
            tabIndex={on ? 0 : -1}
            // The state in WORDS. The glyph is for the eye and is aria-hidden;
            // this is what a screen reader hears, and "Colour — not answered
            // yet" is a thing a subtle dot has never managed to say. Three
            // states rather than two since #567: "not answered yet" is a
            // to-do, "will be sent as skipped" is a consequence, and once
            // Send answer is live it is the second one that is true.
            aria-label={t(
              done
                ? 'question.tabAnswered'
                : willSkip
                  ? 'question.tabSkipped'
                  : 'question.tabUnanswered',
              { label: text }
            )}
            onClick={() => onSelect(i)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              maxInlineSize: 160,
              background: on ? 'var(--panel)' : 'transparent',
              color: on ? 'var(--text)' : 'var(--muted)',
              // Solid in every state. #567 dashed it (and struck the label
              // through) when the tab would be sent as skipped; on an 11px chip
              // the pair read as a rendering glitch to the person it was built
              // for (#733), so the state is now said in a WORD — see below.
              border: `1px solid ${on ? 'var(--status-needs-input)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-chip)',
              padding: '2px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              fontWeight: on ? 600 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {/* SHAPE first, hue second (§5.32: never hue alone). A filled tick
                and an empty ring are different glyphs before they are different
                colours, and the unanswered one wears the panel's own
                needs-input hue because the missing answer is the thing worth
                looking at. `-ink`, not the bare hue: this is a glyph rendered
                as TEXT (`tokens.drift.test.ts` guards exactly that). */}
            <span
              aria-hidden
              style={{ color: done ? 'var(--status-idle-ink)' : 'var(--status-needs-input-ink)' }}
            >
              {done ? '✓' : '○'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
            {/* "skipped", LITERALLY, when a click on Send answer would leave
                this question out (#733). It replaced a strikethrough + dashed
                border that the owner reported as a rendering glitch: a
                decoration you have to already know the meaning of had failed
                the only legibility test that counts. A word cannot be misread
                as a glitch, and it is still not hue alone (§5.32). It never
                shrinks — a long header ellipsises, the warning does not.
                aria-hidden because the tab's accessible NAME already says
                "will be sent as skipped", and in a full sentence. */}
            {willSkip && (
              <span
                aria-hidden
                data-question-tab-skip-word
                style={{
                  flexShrink: 0,
                  fontSize: 9.5,
                  fontStyle: 'italic',
                  color: 'var(--status-needs-input-ink)',
                }}
              >
                {t('question.tabSkippedWord')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One question: its header, its text, its options, and always an Other row.
 *
 * The header chip is suppressed when the panel is TABBED (#566): the tab is
 * already showing it, with the answered state on it, and a chip repeating it
 * two lines lower is noise. The per-question tick stays either way — it is the
 * confirmation for the question actually in front of you.
 *
 * §5.32 keyboard-complete, and built out of the ARIA pattern rather than out of
 * divs that look like it. The group is a `radiogroup` or a plain `group`
 * depending on arity, every option carries `aria-checked`, and Up/Down walk the
 * options within THIS question — never across into the next one, which would
 * make a two-question panel a single 12-item list with no boundary a screen
 * reader could announce.
 */
function QuestionBlock({
  index,
  question,
  showHeader,
  skipping,
  selection,
  onPick,
  onPickOther,
  onOtherText,
  onSubmit,
  otherRef,
}: {
  index: number;
  question: AskQuestion;
  /** false when a tab already carries the header (#566) — it would say it twice */
  showHeader: boolean;
  /**
   * Send answer is live and something in this call is unanswered (#567). If
   * THIS question is the unanswered one, its own dot stops being a dot and
   * starts being a sentence.
   */
  skipping: boolean;
  selection: AskSelection;
  onPick: (index: number, label: string) => void;
  onPickOther: (index: number) => void;
  onOtherText: (text: string) => void;
  onSubmit: () => void;
  otherRef: (el: HTMLInputElement | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const optionsRef = React.useRef<HTMLDivElement | null>(null);
  const answered = questionAnswered(selection);

  // Up/Down inside one question's option list, wrapping at both ends. Read off
  // the live DOM rather than from an index in state: the Other row is a real
  // option here, and keeping a parallel index of "options plus one" in sync with
  // the rendered list is the kind of duplicate bookkeeping that drifts.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const host = optionsRef.current;
    if (!host) return;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[role="radio"],[role="checkbox"]'));
    if (rows.length === 0) return;
    // `ownerDocument`, NOT the global `document` — the same lesson #573 wrote
    // into the card's tab strip, and the same one the strip above obeys. A
    // popped-out card portals this panel into ANOTHER window, whose focus the
    // main document knows nothing about: with the global, every arrow in a
    // popout computes `at = -1` and Down lands on the second row instead of the
    // next one, while preventDefault has already eaten the browser's own move.
    const at = rows.findIndex((r) => r === host.ownerDocument.activeElement);
    const next =
      e.key === 'ArrowUp'
        ? at <= 0
          ? rows.length - 1
          : at - 1
        : at >= rows.length - 1
          ? 0
          : at + 1;
    rows[next]?.focus();
    e.preventDefault();
    // The feed above owns Up/Down for scrolling and the card owns some of its
    // own keys; a walk inside this list is not a walk in either of those.
    e.stopPropagation();
  };

  const role = question.multiSelect ? 'checkbox' : 'radio';
  const rowStyle = (checked: boolean): React.CSSProperties => ({
    display: 'flex',
    gap: 7,
    alignItems: 'flex-start',
    padding: '4px 6px',
    borderRadius: 4,
    cursor: 'pointer',
    background: checked ? 'color-mix(in srgb, var(--status-needs-input) 14%, var(--panel))' : 'var(--panel)',
    border: `1px solid ${checked ? 'var(--status-needs-input)' : 'var(--border)'}`,
    marginBlockEnd: 3,
  });

  return (
    <div
      data-question-index={index}
      style={{
        marginBlockEnd: 8,
        paddingBlockEnd: 6,
        borderBlockEnd: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBlockEnd: 4 }}>
        {showHeader && question.header && (
          <span
            style={{
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '0 5px',
              flexShrink: 0,
            }}
          >
            {question.header}
          </span>
        )}
        {/* `--text`, not a hue token: this background is already tinted, and a
            token validated against a flat background is not validated against a
            tinted one (#125). */}
        <span style={{ color: 'var(--text)', fontWeight: 600, fontSize: 12, lineHeight: 1.35 }}>
          {question.question}
        </span>
        {/* A tick that costs nothing and answers "which one have I still not
            done?" without making the user re-read every group. `-ink` and not
            the bare hue: this is a GLYPH rendered as text, and tokens.css tunes
            the --status-* hues for dots and rings (the drift guard in
            `tokens.drift.test.ts` catches exactly this).

            WHEN SENDING WOULD SKIP THIS ONE (#567) the dot is not enough. A
            faint `·` is exactly the "merely un-ticked" the issue asked us to
            stop relying on, so the question the user is LOOKING AT says it in
            words instead — and says it out loud, unlike the glyph, because a
            skipped answer is not a decorative state. */}
        {!answered && skipping ? (
          <span
            data-testid="question-skip-note"
            style={{
              marginInlineStart: 'auto',
              flexShrink: 0,
              fontSize: 10,
              color: 'var(--status-needs-input-ink)',
            }}
          >
            {t('question.willSkipThis')}
          </span>
        ) : (
          <span
            aria-hidden
            style={{ marginInlineStart: 'auto', color: answered ? 'var(--status-idle-ink)' : 'var(--faint)' }}
          >
            {answered ? '✓' : '·'}
          </span>
        )}
      </div>
      <div
        ref={optionsRef}
        role={question.multiSelect ? 'group' : 'radiogroup'}
        aria-label={question.header ?? question.question}
        onKeyDown={onKeyDown}
      >
        {question.options.map((o) => {
          const checked = selection.labels.includes(o.label);
          return (
            <div
              key={o.label}
              role={role}
              tabIndex={0}
              aria-checked={checked}
              data-question-option={o.label}
              onClick={() => onPick(index, o.label)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onPick(index, o.label);
              }}
              style={rowStyle(checked)}
            >
              <Marker multi={question.multiSelect} checked={checked} />
              <span style={{ minInlineSize: 0 }}>
                <span style={{ color: 'var(--text)', fontSize: 11.5 }}>{o.label}</span>
                {o.description && (
                  <span style={{ display: 'block', color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.35 }}>
                    {o.description}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {/* ALWAYS, on every question — the owner asked for it by name, and the
            CLI accepts an off-menu answer as a first-class one. It is what keeps
            a question with the wrong four options answerable instead of
            answerable-wrongly. */}
        <div
          role={role}
          tabIndex={0}
          aria-checked={selection.other}
          data-question-option="__other__"
          onClick={() => onPickOther(index)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            onPickOther(index);
          }}
          style={rowStyle(selection.other)}
        >
          <Marker multi={question.multiSelect} checked={selection.other} />
          <span style={{ minInlineSize: 0, flex: 1 }}>
            <span style={{ color: 'var(--text)', fontSize: 11.5 }}>{t('question.other')}</span>
            {selection.other && (
              <input
                ref={otherRef}
                data-question-other-input={index}
                aria-label={t('question.otherLabel', { question: question.question })}
                value={selection.otherText}
                placeholder={t('question.otherPlaceholder')}
                onChange={(e) => onOtherText(e.target.value)}
                // The row this sits inside is itself a checkbox: without this,
                // typing a space would toggle the very row being typed into,
                // and clicking to place the caret would untick it.
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                style={{
                  display: 'block',
                  inlineSize: '100%',
                  marginBlockStart: 4,
                  background: 'var(--panel2)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 11.5,
                }}
              />
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The tick or the dot. Presentation only — `aria-checked` on the row is what
 *  actually carries the state. */
function Marker({ multi, checked }: { multi: boolean; checked: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        inlineSize: 12,
        blockSize: 12,
        marginBlockStart: 2,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: multi ? 3 : '50%',
        border: `1px solid ${checked ? 'var(--status-needs-input)' : 'var(--border)'}`,
        background: checked ? 'var(--status-needs-input)' : 'transparent',
        color: 'var(--panel)',
        fontSize: 9,
        lineHeight: 1,
      }}
    >
      {checked ? (multi ? '✓' : '●') : ''}
    </span>
  );
}
