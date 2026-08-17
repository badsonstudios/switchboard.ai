// #563 — the `AskUserQuestion` wire rule.
//
// The payloads here are the REAL ones, lifted from
// `spike/findings/artifacts/s11/ask-user-question-answer.json`, and the expected
// `answers` values are what the probe actually sent and the CLI actually
// accepted ("Your questions have been answered: … "Red", … "TypeScript, Rust"").
// A test written against an invented payload would only pin our idea of the
// contract, which is the failure mode the standing rule exists to stop.
import { describe, it, expect } from 'vitest';
import {
  allAnswered,
  answeredInput,
  AskQuestion,
  buildAnswers,
  emptySelections,
  parseAskUserQuestion,
  questionAnswered,
  toggleOption,
  toggleOther,
} from './ask-user-question';

/** The captured input, verbatim. */
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

const pickOne: AskQuestion = {
  question: 'Which colour do you prefer?',
  header: 'Colour',
  options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  multiSelect: false,
};
const pickMany: AskQuestion = {
  question: 'Which of these languages do you use?',
  header: 'Languages',
  options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }],
  multiSelect: true,
};

describe('parsing the CLI payload', () => {
  it('reads the real captured input', () => {
    const q = parseAskUserQuestion(REAL_INPUT);
    expect(q).toHaveLength(2);
    expect(q?.[0]).toEqual({
      question: 'Which colour do you prefer?',
      header: 'Colour',
      options: [
        { label: 'Red', description: 'Prefer red' },
        { label: 'Green', description: 'Prefer green' },
        { label: 'Blue', description: 'Prefer blue' },
      ],
      multiSelect: false,
    });
    expect(q?.[1].multiSelect).toBe(true);
  });

  it('treats a missing multiSelect as pick-one rather than as multi', () => {
    // The safer default of the two: an accidental checkbox group lets a user
    // send two answers where the CLI expected one.
    const q = parseAskUserQuestion({ questions: [{ question: 'q', options: [{ label: 'a' }] }] });
    expect(q?.[0].multiSelect).toBe(false);
  });

  it('drops an option with no label but keeps the rest', () => {
    const q = parseAskUserQuestion({
      questions: [{ question: 'q', options: [{ label: 'a' }, { description: 'no label' }, { label: 'b' }] }],
    });
    expect(q?.[0].options.map((o) => o.label)).toEqual(['a', 'b']);
  });

  it.each([
    ['not an object', 42],
    ['no questions key', {}],
    ['questions is not an array', { questions: 'nope' }],
    ['questions is empty', { questions: [] }],
    ['a question with no text', { questions: [{ options: [{ label: 'a' }] }] }],
    ['a question with no options array', { questions: [{ question: 'q' }] }],
    ['a question whose options are all unusable', { questions: [{ question: 'q', options: [{}] }] }],
  ])('returns null for %s, so the caller falls back to the plain bar', (_why, input) => {
    expect(parseAskUserQuestion(input)).toBeNull();
  });
});

describe('building the answers map', () => {
  it('produces exactly what the probe sent and the CLI accepted', () => {
    const questions = parseAskUserQuestion(REAL_INPUT)!;
    let sel = emptySelections(questions);
    sel = [toggleOption(questions[0], sel[0], 'Red'), sel[1]];
    sel = [sel[0], toggleOption(questions[1], sel[1], 'TypeScript')];
    sel = [sel[0], toggleOption(questions[1], sel[1], 'Rust')];

    expect(buildAnswers(questions, sel)).toEqual({
      'Which colour do you prefer?': 'Red',
      'Which of these languages do you use?': 'TypeScript, Rust',
    });
  });

  it('joins a multi-select in OPTION order, not in click order', () => {
    // Same ticks, same string, however the user got there — a user who unticks
    // and re-ticks must not send a different answer from the one they read.
    let a = { labels: [] as string[], other: false, otherText: '' };
    for (const l of ['Go', 'TypeScript']) a = toggleOption(pickMany, a, l);
    expect(buildAnswers([pickMany], [a])['Which of these languages do you use?']).toBe(
      'TypeScript, Go'
    );
  });

  it('puts the typed text in place of the word Other', () => {
    const sel = [{ labels: [], other: true, otherText: '  teal, actually  ' }];
    expect(buildAnswers([pickOne], sel)).toEqual({
      'Which colour do you prefer?': 'teal, actually',
    });
  });

  it('appends Other after the chosen labels on a multi-select', () => {
    let a = toggleOption(pickMany, { labels: [], other: false, otherText: '' }, 'Rust');
    a = { ...a, other: true, otherText: 'Zig' };
    expect(buildAnswers([pickMany], [a])['Which of these languages do you use?']).toBe('Rust, Zig');
  });

  it('omits a question nobody answered rather than sending an empty string', () => {
    const sel = emptySelections([pickOne, pickMany]);
    expect(buildAnswers([pickOne, pickMany], sel)).toEqual({});
  });

  it('carries the CLI input back verbatim under the answers', () => {
    const questions = parseAskUserQuestion(REAL_INPUT)!;
    const sel = [
      toggleOption(questions[0], emptySelections(questions)[0], 'Blue'),
      { labels: ['Go'], other: false, otherText: '' },
    ];
    const out = answeredInput({ ...REAL_INPUT, futureField: 'kept' }, questions, sel);
    // Every field the CLI sent survives, including one this build has never
    // heard of — we answer the question, we do not curate it (P7).
    expect(out.questions).toEqual(REAL_INPUT.questions);
    expect(out.futureField).toBe('kept');
    expect(out.answers).toEqual({
      'Which colour do you prefer?': 'Blue',
      'Which of these languages do you use?': 'Go',
    });
  });

  it('collapses a duplicated question text the way the CLI itself must', () => {
    // The wire has no id, so two questions with one text are one key. Nothing
    // clever here — just proof it is a last-writer collapse and not a crash.
    const dup: AskQuestion = { ...pickOne, options: [{ label: 'X' }, { label: 'Y' }] };
    const answers = buildAnswers(
      [dup, dup],
      [
        { labels: ['X'], other: false, otherText: '' },
        { labels: ['Y'], other: false, otherText: '' },
      ]
    );
    expect(answers).toEqual({ 'Which colour do you prefer?': 'Y' });
  });
});

describe('what counts as answered', () => {
  it('does not count Other with nothing typed', () => {
    expect(questionAnswered({ labels: [], other: true, otherText: '   ' })).toBe(false);
    expect(questionAnswered({ labels: [], other: true, otherText: 'x' })).toBe(true);
  });

  it('requires EVERY question, because a partial answers map is unmeasured', () => {
    expect(
      allAnswered([
        { labels: ['Red'], other: false, otherText: '' },
        { labels: [], other: false, otherText: '' },
      ])
    ).toBe(false);
    expect(
      allAnswered([
        { labels: ['Red'], other: false, otherText: '' },
        { labels: ['Go'], other: false, otherText: '' },
      ])
    ).toBe(true);
  });

  it('is false for no questions at all', () => {
    expect(allAnswered([])).toBe(false);
  });
});

describe('toggling', () => {
  it('pick-one replaces the choice and clears Other', () => {
    let sel = { labels: ['Red'], other: true, otherText: 'teal' };
    sel = toggleOption(pickOne, sel, 'Blue');
    expect(sel.labels).toEqual(['Blue']);
    expect(sel.other).toBe(false);
    // the typed text survives — losing a sentence to a mis-click is a cruelty
    expect(sel.otherText).toBe('teal');
  });

  it('pick-one un-ticks when the same option is chosen twice', () => {
    const sel = toggleOption(pickOne, { labels: ['Red'], other: false, otherText: '' }, 'Red');
    expect(sel.labels).toEqual([]);
  });

  it('multi-select accumulates and removes', () => {
    let sel = { labels: [] as string[], other: false, otherText: '' };
    sel = toggleOption(pickMany, sel, 'Rust');
    sel = toggleOption(pickMany, sel, 'Go');
    expect(sel.labels).toEqual(['Rust', 'Go']);
    sel = toggleOption(pickMany, sel, 'Rust');
    expect(sel.labels).toEqual(['Go']);
  });

  it('Other on a pick-one clears the labels; on a multi it does not', () => {
    expect(toggleOther(pickOne, { labels: ['Red'], other: false, otherText: '' })).toMatchObject({
      labels: [],
      other: true,
    });
    expect(toggleOther(pickMany, { labels: ['Rust'], other: false, otherText: '' })).toMatchObject({
      labels: ['Rust'],
      other: true,
    });
  });
});

// ── review follow-up: the label IS the identity, so it has to be unique ──────
describe('duplicate option labels (review #7)', () => {
  // The label is what a selection stores, what `aria-checked` reads, what React
  // keys the row on and what goes on the wire. Two options sharing one would
  // tick together and answer twice.
  it('keeps the first and drops the repeat', () => {
    const q = parseAskUserQuestion({
      questions: [
        {
          question: 'q',
          options: [
            { label: 'Red', description: 'first' },
            { label: 'Red', description: 'second' },
            { label: 'Blue' },
          ],
        },
      ],
    });
    expect(q?.[0].options).toEqual([
      { label: 'Red', description: 'first' },
      { label: 'Blue', description: undefined },
    ]);
  });

  it('so a multi-select can never answer the same label twice', () => {
    const q = parseAskUserQuestion({
      questions: [{ question: 'q', options: [{ label: 'A' }, { label: 'A' }], multiSelect: true }],
    })!;
    expect(buildAnswers(q, [{ labels: ['A'], other: false, otherText: '' }])).toEqual({ q: 'A' });
  });
});
