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
//   • Submit does not light up until every question has an answer.
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
    const text = host.textContent ?? '';

    expect(text).toContain('Which colour do you prefer?');
    expect(text).toContain('Which of these languages do you use?');
    for (const label of ['Red', 'Green', 'Blue', 'TypeScript', 'Rust', 'Go', 'Python']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('Prefer red'); // the CLI's own gloss, not dropped
    expect(text).toContain('Colour'); // the header
  });

  it('renders pick-one as radios and multi-select as checkboxes', async () => {
    const host = await mountPanel(REAL_INPUT);

    const first = host.querySelector<HTMLElement>('[data-question-index="0"]')!;
    const second = host.querySelector<HTMLElement>('[data-question-index="1"]')!;
    expect(first.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(second.querySelector('[role="group"]')).not.toBeNull();
    // 3 options + Other, 4 options + Other
    expect(first.querySelectorAll('[role="radio"]')).toHaveLength(4);
    expect(second.querySelectorAll('[role="checkbox"]')).toHaveLength(5);
  });

  it('offers Other on EVERY question — the owner asked for it by name', async () => {
    const host = await mountPanel(REAL_INPUT);
    expect(host.querySelectorAll('[data-question-option="__other__"]')).toHaveLength(2);
  });
});

describe('answering', () => {
  it('sends exactly the updatedInput the CLI accepted in the probe', async () => {
    const calls: Decision[] = [];
    const host = await mountPanel(REAL_INPUT, calls);

    await click(optionRow(host, 0, 'Red'));
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
    // row of question 0, so Down from there wraps to Red, not to TypeScript
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
    await click(optionRow(host, 1, '__other__'));
    await type(host.querySelector<HTMLInputElement>('[data-question-other-input="1"]')!, 'Zig');

    // the tab switch: this component goes away entirely and comes back
    const r = root;
    root = null;
    await act(async () => r!.unmount());
    document.body.innerHTML = '';
    host = await mountPanel(REAL_INPUT, calls);

    expect(optionRow(host, 0, 'Red').getAttribute('aria-checked')).toBe('true');
    expect(optionRow(host, 1, '__other__').getAttribute('aria-checked')).toBe('true');
    // the typed words are still in the box, not just remembered internally
    expect(host.querySelector<HTMLInputElement>('[data-question-other-input="1"]')!.value).toBe('Zig');
    // and it is still a COMPLETE answer, so Submit is live where it was left
    expect(submitButton(host).disabled).toBe(false);

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
