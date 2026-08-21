// @vitest-environment jsdom
// The CLI's own question, as a rendered contract (#563).
//
// `shared/ask-user-question` pins the WIRE RULE and is where the joining,
// substitution and completeness live. This file pins the claims only a rendered
// DOM can make:
//
//   • what reaches `onDecide` after a real sequence of clicks is the exact
//     `updatedInput` the CLI accepted in the probe — the whole feature is that
//     round trip, and a component that built a beautiful panel and sent the
//     wrong payload would pass every test in the other file;
//   • pick-one and multi-select really render as radios and checkboxes, and
//     really behave like them;
//   • the Other field exists on EVERY question, takes free text, and is what
//     goes on the wire in place of the word;
//   • §5.32: the thing is answerable from the keyboard alone;
//   • Submit does not light up until every question has an answer;
//   • #566: a multi-question call is a TAB STRIP, and the hazard that comes
//     with one — an unanswered question now being off screen — is answered by
//     the tabs themselves rather than inherited from the extension.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { forgetQuestionDraft, QuestionPanel } from './QuestionPanel';
import { parseAskUserQuestion } from '../../../shared/ask-user-question';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;

async function mount(tree: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree);
  });
  return host;
}

/** The captured `AskUserQuestion` input, verbatim from the probe artifact. */
const REAL_INPUT = {
  questions: [
    {
      question: 'Which colour do you prefer?',
      header: 'Colour',
      options: [
        { label: 'Red', description: 'Prefer red' },
        { label: 'Green', description: 'Prefer green' },
        { label: 'Blue', description: 'Prefer blue' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which of these languages do you use?',
      header: 'Languages',
      options: [
        { label: 'TypeScript', description: 'You use TypeScript' },
        { label: 'Rust', description: 'You use Rust' },
        { label: 'Go', description: 'You use Go' },
        { label: 'Python', description: 'You use Python' },
      ],
      multiSelect: true,
    },
  ],
};

const ONE_INPUT = { questions: [REAL_INPUT.questions[0]] };

type Decision = { decision: string; allowAll?: boolean; updatedInput?: unknown };

/** the shape a real held request id has (`stream-permissions.ts`) */
const DRAFT_ID = 'stream:live-A:req-q';

async function mountPanel(
  input: Record<string, unknown>,
  calls: Decision[] = [],
  requestId = DRAFT_ID
): Promise<HTMLElement> {
  const questions = parseAskUserQuestion(input);
  if (!questions) throw new Error('fixture does not parse — fix the fixture, not the parser');
  return mount(
    <QuestionPanel
      requestId={requestId}
      questions={questions}
      input={input}
      queued={0}
      onDecide={(decision, allowAll, updatedInput) =>
        calls.push({ decision, allowAll, updatedInput })
      }
    />
  );
}

/** every option row, in render order, across every question */
function rows(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="radio"],[role="checkbox"]'));
}

function optionRow(host: HTMLElement, questionIndex: number, label: string): HTMLElement {
  const block = host.querySelector<HTMLElement>(`[data-question-index="${questionIndex}"]`);
  if (!block) throw new Error(`no question block ${questionIndex}`);
  const row = block.querySelector<HTMLElement>(`[data-question-option="${label}"]`);
  if (!row) throw new Error(`no option ${label} in question ${questionIndex}`);
  return row;
}

/** the tab for question `i` (#566) — only present when the call carries several */
function tab(host: HTMLElement, i: number): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-question-tab="${i}"]`);
  if (!el) throw new Error(`no tab ${i} — is this a multi-question panel?`);
  return el;
}

/** the question block currently on screen, or null if that one is behind a tab */
const blockOf = (host: HTMLElement, i: number): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-question-index="${i}"]`);

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function press(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    // React's onChange rides the native input event; setting `.value` alone is
    // invisible to it, which is why this goes through the value-setter dance.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** open question `i` — with tabs, this is what a user must do before answering it */
async function openTab(host: HTMLElement, i: number): Promise<void> {
  await click(tab(host, i));
}

const submitButton = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('[data-testid="question-submit"]')!;

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  // the draft map is module state and outlives a test — clear it, or one test's
  // half-answer seeds the next one's panel
  forgetQuestionDraft(DRAFT_ID);
  forgetQuestionDraft('stream:live-A:other-request');
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('rendering the CLI question verbatim (#563)', () => {
  it('shows every question, every option and every description, unedited', async () => {
    const host = await mountPanel(REAL_INPUT);

    expect(host.textContent).toContain('Which colour do you prefer?');
    for (const label of ['Red', 'Green', 'Blue']) expect(host.textContent).toContain(label);
    expect(host.textContent).toContain('Prefer red'); // the CLI's own gloss, not dropped
    // the second question is BEHIND ITS TAB now (#566) — and the tab is
    // labelled by the CLI's own `header`, which is what that field is for
    expect(host.textContent).toContain('Colour');
    expect(host.textContent).toContain('Languages');

    await openTab(host, 1);
    expect(host.textContent).toContain('Which of these languages do you use?');
    for (const label of ['TypeScript', 'Rust', 'Go', 'Python']) {
      expect(host.textContent).toContain(label);
    }
    expect(host.textContent).toContain('You use Rust');
  });

  it('renders pick-one as radios and multi-select as checkboxes', async () => {
    const host = await mountPanel(REAL_INPUT);

    const first = blockOf(host, 0)!;
    expect(first.querySelector('[role="radiogroup"]')).not.toBeNull();
    // 3 options + Other
    expect(first.querySelectorAll('[role="radio"]')).toHaveLength(4);
    // …and the other question really is absent, not merely hidden: an inert
    // copy in the DOM would still be in every arrow-key walk and every query
    expect(blockOf(host, 1)).toBeNull();

    await openTab(host, 1);
    const second = blockOf(host, 1)!;
    expect(second.querySelector('[role="group"]')).not.toBeNull();
    // 4 options + Other
    expect(second.querySelectorAll('[role="checkbox"]')).toHaveLength(5);
    expect(blockOf(host, 0)).toBeNull();
  });

  it('offers Other on EVERY question — the owner asked for it by name', async () => {
    const host = await mountPanel(REAL_INPUT);
    expect(blockOf(host, 0)!.querySelectorAll('[data-question-option="__other__"]')).toHaveLength(1);
    await openTab(host, 1);
    expect(blockOf(host, 1)!.querySelectorAll('[data-question-option="__other__"]')).toHaveLength(1);
  });
});

describe('answering', () => {
  it('sends exactly the updatedInput the CLI accepted in the probe', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(REAL_INPUT, calls);

    await click(optionRow(host, 0, 'Red'));
    await openTab(host, 1);
    await click(optionRow(host, 1, 'TypeScript'));
    await click(optionRow(host, 1, 'Rust'));
    await click(submitButton(host));

    expect(calls).toEqual([
      {
        decision: 'allow',
        allowAll: false,
        updatedInput: {
          questions: REAL_INPUT.questions,
          answers: {
            'Which colour do you prefer?': 'Red',
            'Which of these languages do you use?': 'TypeScript, Rust',
          },
        },
      },
    ]);
  });

  it('pick-one replaces rather than accumulates', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(ONE_INPUT, calls);

    await click(optionRow(host, 0, 'Red'));
    await click(optionRow(host, 0, 'Blue'));
    await click(submitButton(host));

    expect((calls[0].updatedInput as { answers: Record<string, string> }).answers).toEqual({
      'Which colour do you prefer?': 'Blue',
    });
    expect(optionRow(host, 0, 'Red').getAttribute('aria-checked')).toBe('false');
    expect(optionRow(host, 0, 'Blue').getAttribute('aria-checked')).toBe('true');
  });

  it('sends the typed text, never the word "Other"', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(ONE_INPUT, calls);

    await click(optionRow(host, 0, '__other__'));
    const field = host.querySelector<HTMLInputElement>('[data-question-other-input="0"]')!;
    await type(field, 'teal, obviously');
    await click(submitButton(host));

    const answers = (calls[0].updatedInput as { answers: Record<string, string> }).answers;
    expect(answers).toEqual({ 'Which colour do you prefer?': 'teal, obviously' });
    expect(JSON.stringify(answers)).not.toContain('"Other"');
  });

  it('refusing is a plain deny that carries no answers', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(REAL_INPUT, calls);

    await click(host.querySelector<HTMLElement>('[data-testid="question-dismiss"]')!);

    expect(calls).toEqual([{ decision: 'deny', allowAll: false, updatedInput: undefined }]);
  });

  it('never asks for a standing grant — allowAll is false on every path', async () => {
    // "Allow all (this session)" answers future calls at the server with no
    // answers at all, which for a question means silently skipping it.
    const calls: Decision[] = [];
    const host = await mountPanel(ONE_INPUT, calls);
    await click(optionRow(host, 0, 'Red'));
    await click(submitButton(host));
    await click(host.querySelector<HTMLElement>('[data-testid="question-dismiss"]')!);

    expect(calls.every((c) => c.allowAll === false)).toBe(true);
  });
});

describe('submit is gated on a COMPLETE answer', () => {
  it('is disabled until every question has one', async () => {
    const host = await mountPanel(REAL_INPUT);
    expect(submitButton(host).disabled).toBe(true);

    await click(optionRow(host, 0, 'Red'));
    expect(submitButton(host).disabled).toBe(true); // one of two

    await openTab(host, 1);
    await click(optionRow(host, 1, 'Go'));
    expect(submitButton(host).disabled).toBe(false);
  });

  it('a ticked Other with nothing typed does not count as an answer', async () => {
    // The word never crosses the wire, so an empty Other would send `""` —
    // a different and worse thing than not answering.
    const host = await mountPanel(ONE_INPUT);
    await click(optionRow(host, 0, '__other__'));

    expect(submitButton(host).disabled).toBe(true);

    await type(host.querySelector<HTMLInputElement>('[data-question-other-input="0"]')!, 'x');
    expect(submitButton(host).disabled).toBe(false);
  });

  it('clicking a disabled submit sends nothing', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(REAL_INPUT, calls);
    await click(submitButton(host));
    expect(calls).toEqual([]);
  });
});

describe('keyboard-complete (§5.32)', () => {
  it('every option row is focusable and answers to Space and Enter', async () => {
    const host = await mountPanel(ONE_INPUT);
    for (const row of rows(host)) expect(row.tabIndex).toBe(0);

    await press(optionRow(host, 0, 'Green'), ' ');
    expect(optionRow(host, 0, 'Green').getAttribute('aria-checked')).toBe('true');

    await press(optionRow(host, 0, 'Blue'), 'Enter');
    expect(optionRow(host, 0, 'Blue').getAttribute('aria-checked')).toBe('true');
    expect(optionRow(host, 0, 'Green').getAttribute('aria-checked')).toBe('false');
  });

  it('Up and Down walk the options of ONE question and wrap', async () => {
    const host = await mountPanel(REAL_INPUT);
    const red = optionRow(host, 0, 'Red');
    red.focus();

    await press(red, 'ArrowDown');
    expect(document.activeElement).toBe(optionRow(host, 0, 'Green'));

    // and never across the boundary into the next question: Other is the last
    // row of question 0, so Down from there wraps to Red. Since #566 the next
    // question is not even in the DOM — this stays as the proof that the walk
    // is scoped to one question's list rather than to whatever is on screen
    optionRow(host, 0, '__other__').focus();
    await press(optionRow(host, 0, '__other__'), 'ArrowDown');
    expect(document.activeElement).toBe(optionRow(host, 0, 'Red'));

    // and Up from the top wraps to the bottom of the SAME question
    await press(optionRow(host, 0, 'Red'), 'ArrowUp');
    expect(document.activeElement).toBe(optionRow(host, 0, '__other__'));
  });

  it('Enter in the Other field submits when the panel is complete', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(ONE_INPUT, calls);
    await click(optionRow(host, 0, '__other__'));
    const field = host.querySelector<HTMLInputElement>('[data-question-other-input="0"]')!;
    await type(field, 'chartreuse');

    await press(field, 'Enter');

    expect(calls).toHaveLength(1);
    expect((calls[0].updatedInput as { answers: Record<string, string> }).answers).toEqual({
      'Which colour do you prefer?': 'chartreuse',
    });
  });

  it('typing a space in Other does not toggle the row it sits in', async () => {
    const host = await mountPanel(ONE_INPUT);
    await click(optionRow(host, 0, '__other__'));
    const field = host.querySelector<HTMLInputElement>('[data-question-other-input="0"]')!;

    await press(field, ' ');

    expect(optionRow(host, 0, '__other__').getAttribute('aria-checked')).toBe('true');
  });

  it('announces itself, because it arrives without anyone navigating to it', async () => {
    const host = await mountPanel(ONE_INPUT);
    const live = host.querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
  });
});

// ── review follow-up: a half-answered question survives a remount ────────────
describe('an answer in progress is not thrown away by a remount (#563 review)', () => {
  // The Session panel is NOT keepMounted, so clicking Changes to look at the
  // diff before answering "which of these three approaches?", collapsing the
  // card, or a dockview move all unmount this component. With the selections in
  // component state alone, every tick and every typed word would be gone —
  // silently, on the single most likely thing a person does mid-question.
  it('keeps the ticks and the typed Other text across an unmount', async () => {
    const calls: Decision[] = [];
    let host = await mountPanel(REAL_INPUT, calls);
    await click(optionRow(host, 0, 'Red'));
    await openTab(host, 1);
    await click(optionRow(host, 1, '__other__'));
    await type(host.querySelector<HTMLInputElement>('[data-question-other-input="1"]')!, 'Zig');

    // the tab switch: this component goes away entirely and comes back
    const r = root;
    root = null;
    await act(async () => r!.unmount());
    document.body.innerHTML = '';
    host = await mountPanel(REAL_INPUT, calls);

    // both answered, so the panel comes back on the first tab
    expect(tab(host, 0).getAttribute('aria-selected')).toBe('true');
    expect(optionRow(host, 0, 'Red').getAttribute('aria-checked')).toBe('true');
    // and it is still a COMPLETE answer, so Submit is live where it was left
    expect(submitButton(host).disabled).toBe(false);

    await openTab(host, 1);
    expect(optionRow(host, 1, '__other__').getAttribute('aria-checked')).toBe('true');
    // the typed words are still in the box, not just remembered internally
    expect(host.querySelector<HTMLInputElement>('[data-question-other-input="1"]')!.value).toBe('Zig');

    await click(submitButton(host));
    expect((calls[0].updatedInput as { answers: Record<string, string> }).answers).toEqual({
      'Which colour do you prefer?': 'Red',
      'Which of these languages do you use?': 'Zig',
    });
  });

  it('does not outlive the request — a NEW question starts blank', async () => {
    let host = await mountPanel(REAL_INPUT);
    await click(optionRow(host, 0, 'Red'));
    await click(submitButton(host)); // incomplete, so this is a no-op…
    forgetQuestionDraft(DRAFT_ID); // …and this is what answering does

    const r = root;
    root = null;
    await act(async () => r!.unmount());
    document.body.innerHTML = '';
    host = await mountPanel(REAL_INPUT);

    expect(optionRow(host, 0, 'Red').getAttribute('aria-checked')).toBe('false');
  });

  it('a different request never sees another question answer', async () => {
    const first = await mountPanel(REAL_INPUT);
    await click(optionRow(first, 0, 'Red'));
    const r = root;
    root = null;
    await act(async () => r!.unmount());
    document.body.innerHTML = '';

    const second = await mountPanel(ONE_INPUT, [], 'stream:live-A:other-request');
    expect(optionRow(second, 0, 'Red').getAttribute('aria-checked')).toBe('false');
  });
});

// ── #566: tabs for a multi-question call ─────────────────────────────────────
describe('a multi-question call is a tab strip (#566)', () => {
  /** the same call, but the first question has no `header` of its own */
  const NO_HEADER = {
    questions: [
      {
        question: 'Which colour do you prefer?',
        options: [{ label: 'Red' }, { label: 'Blue' }],
        multiSelect: false,
      },
      REAL_INPUT.questions[1],
    ],
  };

  const remaining = (host: HTMLElement): HTMLElement | null =>
    host.querySelector<HTMLElement>('[data-testid="question-remaining"]');

  it('ONE question gets no tab furniture at all', async () => {
    // The overwhelmingly common call. It must look exactly as #563 shipped it —
    // a strip of one tab is a strip that only ever costs a line of height.
    const host = await mountPanel(ONE_INPUT);
    expect(host.querySelector('[data-testid="question-tabs"]')).toBeNull();
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(host.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    // …including the header chip inside the block, which the tab would have
    // taken over
    expect(host.textContent).toContain('Colour');
    // and nothing telling the user what is missing — the Submit title says it
    expect(remaining(host)).toBeNull();
  });

  it('one tab per question, labelled by the CLI header, wired to its panel', async () => {
    const host = await mountPanel(REAL_INPUT);
    const strip = host.querySelector<HTMLElement>('[data-testid="question-tabs"]')!;
    expect(strip.getAttribute('role')).toBe('tablist');
    expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(tab(host, 0).textContent).toContain('Colour');
    expect(tab(host, 1).textContent).toContain('Languages');

    // the selected tab points at a tabpanel that is actually in the DOM; the
    // unselected one points at nothing, because a dangling aria-controls is
    // worse than none (§5.32, as-built)
    const panelId = tab(host, 0).getAttribute('aria-controls')!;
    expect(host.querySelector(`[id="${panelId}"]`)?.getAttribute('role')).toBe('tabpanel');
    expect(tab(host, 1).getAttribute('aria-controls')).toBeNull();
  });

  it('a question with no header of its own gets a numbered tab, not a blank one', async () => {
    const host = await mountPanel(NO_HEADER);
    expect(tab(host, 0).textContent).toContain('Question 1');
    expect(tab(host, 1).textContent).toContain('Languages');
  });

  it('every tab says whether it is answered — in its NAME, not just a dot', async () => {
    // The whole hazard #566 inherits from the extension: with the questions
    // stacked, "which one have I not done?" was answered by looking. Off
    // screen, a subtle dot is the only thing left — so the tab has to SAY it.
    const host = await mountPanel(REAL_INPUT);
    expect(tab(host, 0).getAttribute('data-question-tab-answered')).toBe('false');
    expect(tab(host, 0).getAttribute('aria-label')).toBe('Colour — not answered yet');
    expect(tab(host, 1).getAttribute('aria-label')).toBe('Languages — not answered yet');

    await click(optionRow(host, 0, 'Red'));

    expect(tab(host, 0).getAttribute('data-question-tab-answered')).toBe('true');
    expect(tab(host, 0).getAttribute('aria-label')).toBe('Colour — answered');
    // and the one still missing has not changed its story
    expect(tab(host, 1).getAttribute('aria-label')).toBe('Languages — not answered yet');
  });

  it('names what is still missing while Submit is dead, and stops when it is not', async () => {
    const host = await mountPanel(REAL_INPUT);
    expect(remaining(host)?.textContent).toContain('Colour');
    expect(remaining(host)?.textContent).toContain('Languages');

    await click(optionRow(host, 0, 'Red'));
    expect(remaining(host)?.textContent).not.toContain('Colour');
    expect(remaining(host)?.textContent).toContain('Languages');

    await openTab(host, 1);
    await click(optionRow(host, 1, 'Go'));
    expect(submitButton(host).disabled).toBe(false);
    expect(remaining(host)).toBeNull();
  });

  it('opens on the first question that still needs an answer, after a remount', async () => {
    // Coming back from the Changes tab onto a question you already answered,
    // with the unanswered one hidden behind it, IS the off-screen hazard.
    let host = await mountPanel(REAL_INPUT);
    await click(optionRow(host, 0, 'Red'));

    const r = root;
    root = null;
    await act(async () => r!.unmount());
    document.body.innerHTML = '';
    host = await mountPanel(REAL_INPUT);

    expect(tab(host, 1).getAttribute('aria-selected')).toBe('true');
    expect(blockOf(host, 1)).not.toBeNull();
    expect(blockOf(host, 0)).toBeNull();
  });

  it('clicking a tab shows that question and never touches the answers', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(REAL_INPUT, calls);
    await click(optionRow(host, 0, 'Red'));
    await openTab(host, 1);
    await click(optionRow(host, 1, 'Go'));
    await openTab(host, 0);

    expect(optionRow(host, 0, 'Red').getAttribute('aria-checked')).toBe('true');
    expect(calls).toEqual([]); // walking the tabs is not answering anything
  });
});

describe('the tab strip is keyboard-complete (§5.32, #566)', () => {
  it('Left and Right walk the strip and wrap, and selection follows focus', async () => {
    const host = await mountPanel(REAL_INPUT);
    tab(host, 0).focus();

    await press(tab(host, 0), 'ArrowRight');
    expect(document.activeElement).toBe(tab(host, 1));
    // AUTOMATIC activation: a question costs nothing to show, and an arrow that
    // only moved focus would leave the user looking at a tab they had not
    // selected — the off-screen hazard, back in through the keyboard
    expect(tab(host, 1).getAttribute('aria-selected')).toBe('true');
    expect(blockOf(host, 1)).not.toBeNull();

    // wraps at the end, as APG specifies for a tab strip
    await press(tab(host, 1), 'ArrowRight');
    expect(document.activeElement).toBe(tab(host, 0));
    expect(tab(host, 0).getAttribute('aria-selected')).toBe('true');

    // and the other way
    await press(tab(host, 0), 'ArrowLeft');
    expect(document.activeElement).toBe(tab(host, 1));
    expect(tab(host, 1).getAttribute('aria-selected')).toBe('true');
  });

  it('Home and End jump to the ends', async () => {
    const host = await mountPanel(REAL_INPUT);
    tab(host, 0).focus();

    await press(tab(host, 0), 'End');
    expect(tab(host, 1).getAttribute('aria-selected')).toBe('true');

    await press(tab(host, 1), 'Home');
    expect(tab(host, 0).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps ONE tab stop, on the selected tab — the roving stop a tablist owes', async () => {
    const host = await mountPanel(REAL_INPUT);
    expect(tab(host, 0).tabIndex).toBe(0);
    expect(tab(host, 1).tabIndex).toBe(-1);

    await openTab(host, 1);
    expect(tab(host, 0).tabIndex).toBe(-1);
    expect(tab(host, 1).tabIndex).toBe(0);
  });

  it('Up and Down stay inside the open question and never change the tab', async () => {
    const host = await mountPanel(REAL_INPUT);
    const red = optionRow(host, 0, 'Red');
    red.focus();

    await press(red, 'ArrowDown');
    expect(document.activeElement).toBe(optionRow(host, 0, 'Green'));
    expect(tab(host, 0).getAttribute('aria-selected')).toBe('true');

    await press(optionRow(host, 0, 'Green'), 'ArrowUp');
    expect(document.activeElement).toBe(red);
    expect(tab(host, 0).getAttribute('aria-selected')).toBe('true');
  });
});
