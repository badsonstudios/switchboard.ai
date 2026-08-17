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
// WHY NOT THE EXTENSION'S TAB STRIP
// ---------------------------------
// The VS Code extension renders a multi-question call as tabs across the top
// with a 300ms auto-advance after each pick-one. It is nicer to look at and it
// has a failure this cannot have: an unanswered tab is off screen, so Submit
// can be reached without ever seeing what else was asked. Stacked in one
// scroller, every question is visible, and Submit does not light up until they
// all have an answer — the rule the extension's tab dots are trying to convey.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  allAnswered,
  answeredInput,
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
 * The Session panel is not `keepMounted` — only the terminal is — so clicking
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
  React.useEffect(() => {
    setSelections(drafts.get(requestId) ?? emptySelections(questions));
  }, [requestId, questions]);
  const otherRefs = React.useRef<Array<HTMLInputElement | null>>([]);

  const complete = allAnswered(selections);
  const finish = (decision: 'allow' | 'deny', updatedInput?: unknown): void => {
    // The draft dies with the request, whichever way it was answered: the id is
    // never reused, so an entry left behind is a leak that also cannot be read.
    forgetQuestionDraft(requestId);
    onDecide(decision, false, updatedInput);
  };
  const submit = (): void => {
    if (!complete) return;
    finish('allow', answeredInput(input, questions, selections));
  };

  const update = (i: number, next: AskSelection): void =>
    setSelections((prev) => {
      const nextAll = prev.map((s, j) => (j === i ? next : s));
      rememberDraft(requestId, nextAll);
      return nextAll;
    });

  const pick = (i: number, label: string): void => {
    const sel = selections[i];
    if (!sel) return;
    update(i, toggleOption(questions[i], sel, label));
  };

  const pickOther = (i: number): void => {
    const sel = selections[i];
    if (!sel) return;
    const next = toggleOther(questions[i], sel);
    update(i, next);
    // Ticking Other is a statement of intent to type; the field it opens should
    // already have the caret. After the state lands, or the input is not there
    // yet to focus.
    if (next.other) window.setTimeout(() => otherRefs.current[i]?.focus(), 0);
  };

  return (
    <div
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
        background: 'color-mix(in srgb, var(--status-needs-input) 8%, var(--panel2))',
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
      {questions.map((q, i) => (
        <QuestionBlock
          key={`${i}:${q.question}`}
          index={i}
          question={q}
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
      ))}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          type="button"
          data-testid="question-submit"
          onClick={submit}
          disabled={!complete}
          // A disabled button says nothing about WHY. The title does, and it is
          // the only place the "all of them" rule is visible to someone who has
          // answered one question and is looking for the way out.
          title={complete ? undefined : t('question.submitHint')}
          style={{
            background: complete ? 'var(--btn-primary-bg)' : 'var(--panel)',
            color: complete ? 'var(--btn-primary-text)' : 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '4px 14px',
            cursor: complete ? 'pointer' : 'not-allowed',
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
      </div>
    </div>
  );
}

/**
 * One question: its header, its text, its options, and always an Other row.
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
  selection,
  onPick,
  onPickOther,
  onOtherText,
  onSubmit,
  otherRef,
}: {
  index: number;
  question: AskQuestion;
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
    const at = rows.findIndex((r) => r === document.activeElement);
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
        {question.header && (
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
            `tokens.drift.test.ts` catches exactly this). */}
        <span
          aria-hidden
          style={{ marginInlineStart: 'auto', color: answered ? 'var(--status-idle-ink)' : 'var(--faint)' }}
        >
          {answered ? '✓' : '·'}
        </span>
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
