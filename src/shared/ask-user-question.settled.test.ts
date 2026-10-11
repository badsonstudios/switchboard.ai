// #1201 — reading a settled question back.
//
// The result strings here are the REAL ones: the first three are verbatim from
// `spike/findings/artifacts/s11/ask-user-question-{answer,other,partial}.json`,
// the fourth is switchboard's own denial as a real transcript on this machine
// recorded it. A test against an invented sentence would only pin our idea of
// what the CLI writes.
import { describe, it, expect } from 'vitest';
import {
  ASK_COUNT_CAP,
  ASK_TEXT_CAP,
  pickedFor,
  readAskResult,
  settledQuestions,
  type SettledQuestion,
} from './ask-user-question';

const COLOUR: SettledQuestion = {
  question: 'Which colour do you prefer?',
  header: 'Colour',
  options: [
    { label: 'Red', description: 'Prefer red' },
    { label: 'Green', description: 'Prefer green' },
    { label: 'Blue', description: 'Prefer blue' },
  ],
  multiSelect: false,
};
const LANGS: SettledQuestion = {
  question: 'Which of these languages do you use?',
  header: 'Languages',
  options: [
    { label: 'TypeScript', description: 'You use TypeScript' },
    { label: 'Rust', description: 'You use Rust' },
    { label: 'Go', description: 'You use Go' },
    { label: 'Python', description: 'You use Python' },
  ],
  multiSelect: true,
};

const ANSWERED =
  'Your questions have been answered: "Which colour do you prefer?"="Red", "Which of these languages do you use?"="TypeScript, Rust". You can now continue with these answers in mind.';
const OTHER =
  'The user answered: "Which colour do you prefer?"="zzz-probe-free-text-Colour", "Which of these languages do you use?"="zzz-probe-free-text-Languages". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
const PARTIAL =
  'Your questions have been answered: "Which colour do you prefer?"="Red". You can now continue with these answers in mind.';
const DENIED =
  'The user reviewed this request in switchboard and DENIED it. This is a deliberate decision by the human operator.';

describe('readAskResult — what became of a question call', () => {
  it('no result yet: pending, and nothing is invented', () => {
    expect(readAskResult([COLOUR, LANGS], undefined)).toEqual({ state: 'pending' });
  });

  it('reads each answer off the CLI’s own sentence, in the questions’ order', () => {
    expect(readAskResult([COLOUR, LANGS], ANSWERED)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('reads the off-the-menu sentence the same way', () => {
    expect(readAskResult([COLOUR, LANGS], OTHER)).toEqual({
      state: 'answered',
      answers: [{ answer: 'zzz-probe-free-text-Colour' }, { answer: 'zzz-probe-free-text-Languages' }],
      cut: false,
    });
  });

  it('a question that is NOT in the sentence was skipped (measured: blank and partial are identical)', () => {
    expect(readAskResult([COLOUR, LANGS], PARTIAL)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, null],
      cut: false,
    });
    // ...whichever one it was
    const second =
      'Your questions have been answered: "Which of these languages do you use?"="Go". You can now continue with these answers in mind.';
    expect(readAskResult([COLOUR, LANGS], second)).toEqual({
      state: 'answered',
      answers: [null, { answer: 'Go' }],
      cut: false,
    });
  });

  it('anything else is NOT answered, and its own words are the reason', () => {
    expect(readAskResult([COLOUR, LANGS], DENIED)).toEqual({ state: 'declined', reason: DENIED });
    expect(readAskResult([COLOUR], '')).toEqual({ state: 'declined', reason: '' });
  });

  it('survives quotes, commas and `"="` inside a question or an answer: the CLI escapes nothing', () => {
    const tricky: SettledQuestion = {
      question: 'Cut "0.8.101" first, or after #978?',
      options: [{ label: 'First' }, { label: 'After' }],
      multiSelect: false,
    };
    const result =
      'The user answered: "Cut "0.8.101" first, or after #978?"="Say "no", "a"="b", then wait.", "Which colour do you prefer?"="Red". Read the answers carefully — they may request clarification.';
    expect(readAskResult([tricky, COLOUR], result)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Say "no", "a"="b", then wait.' }, { answer: 'Red' }],
      cut: false,
    });
  });

  it('two questions with the SAME text share the one pair the wire can carry', () => {
    // answers are keyed by question text, so the real result has ONE pair for
    // both. Both rows show it; neither is called skipped.
    expect(readAskResult([COLOUR, COLOUR], PARTIAL)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'Red' }],
      cut: false,
    });
  });

  it('(synthetic) and if a result ever did carry two, each row takes its own', () => {
    const twice =
      'Your questions have been answered: "Which colour do you prefer?"="Red", "Which colour do you prefer?"="Blue". You can now continue with these answers in mind.';
    expect(readAskResult([COLOUR, COLOUR], twice)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'Blue' }],
      cut: false,
    });
  });

  it('a question clipped for display is still found, by the part that was kept', () => {
    const long = 'Q'.repeat(ASK_TEXT_CAP + 50);
    const [clipped] = settledQuestions({
      questions: [{ question: long, options: [{ label: 'Yes' }, { label: 'No' }] }],
    })!;
    expect(clipped.question).toHaveLength(ASK_TEXT_CAP);
    expect(clipped.clipped).toBe(true);
    const result = `Your questions have been answered: "${long}"="Yes". You can now continue with these answers in mind.`;
    expect(readAskResult([clipped], result)).toEqual({ state: 'answered', answers: [{ answer: 'Yes' }], cut: false });
  });

  it('a closing sentence it has never seen: the answer still ends at its own quote', () => {
    const odd = 'Your questions have been answered: "Which colour do you prefer?"="Red". Carry on.';
    expect(readAskResult([COLOUR], odd)).toEqual({ state: 'answered', answers: [{ answer: 'Red' }], cut: false });
  });

  it('the answered shape about OTHER questions is shown as its own words, not as rows of "skipped"', () => {
    const other =
      'Your questions have been answered: "Something else entirely?"="Yes". You can now continue with these answers in mind.';
    expect(readAskResult([COLOUR, LANGS], other)).toEqual({ state: 'declined', reason: other });
  });
});

describe('pickedFor — an answer set against what was offered', () => {
  it('a pick-one answer is the one label', () => {
    expect(pickedFor(COLOUR, 'Red')).toEqual({ picked: ['Red'], other: null });
  });

  it('a pick-one answer that is no label was typed', () => {
    expect(pickedFor(COLOUR, 'Teal, actually')).toEqual({ picked: [], other: 'Teal, actually' });
  });

  it('a multi-select answer is every label in it, in the order they were offered', () => {
    expect(pickedFor(LANGS, 'Rust, TypeScript')).toEqual({
      picked: ['TypeScript', 'Rust'],
      other: null,
    });
  });

  it('...plus whatever was typed beside them', () => {
    expect(pickedFor(LANGS, 'TypeScript, Zig')).toEqual({ picked: ['TypeScript'], other: 'Zig' });
  });

  it('a label that itself contains ", " is not torn in two', () => {
    const q: SettledQuestion = {
      question: 'Which?',
      options: [{ label: 'Fast, cheap' }, { label: 'Fast' }, { label: 'Good' }],
      multiSelect: true,
    };
    expect(pickedFor(q, 'Fast, cheap, Good')).toEqual({
      picked: ['Fast, cheap', 'Good'],
      other: null,
    });
  });
});

describe('settledQuestions — what is kept on the block', () => {
  it('keeps the CLI’s own shape, and nothing a display does not need', () => {
    expect(settledQuestions({ questions: [COLOUR] })).toEqual([COLOUR]);
  });

  it('is null for a payload that is not the documented shape: that stays a raw row', () => {
    expect(settledQuestions({ questions: 'nope' })).toBeNull();
    expect(settledQuestions(undefined)).toBeNull();
  });

  it('clamps how many and how long: a block is held for every open session', () => {
    const many = Array.from({ length: ASK_COUNT_CAP + 5 }, (_, i) => ({
      question: `q${i}`,
      options: Array.from({ length: ASK_COUNT_CAP + 5 }, (_, j) => ({ label: `o${j}` })),
    }));
    const kept = settledQuestions({ questions: many })!;
    expect(kept).toHaveLength(ASK_COUNT_CAP);
    expect(kept[0].options).toHaveLength(ASK_COUNT_CAP);
  });
});

// The shapes below are in the INSTALLED binary (2.1.288) and have not been
// produced by a probe: the strings were read out of `claude.exe`. They are
// handled because the failure they would otherwise cause is the bad one, an
// answered question shown as skipped.
describe('readAskResult — shapes read from the installed CLI, not yet probed', () => {
  it('a note after an answer does not swallow the next question', () => {
    const r =
      'The user answered: "Which colour do you prefer?"="Red" notes: because warm, "Which of these languages do you use?"="Go". Read the answers carefully — they may request clarification.';
    expect(readAskResult([COLOUR, LANGS], r)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red', notes: 'because warm' }, { answer: 'Go' }],
      cut: false,
    });
  });

  it('a preview and a note after an answer are not part of the answer', () => {
    const r =
      'Your questions have been answered: "Which colour do you prefer?"="Red" selected preview:\n#f00 notes: bright, "Which of these languages do you use?"="Go, Rust". You can now continue with these answers in mind.';
    expect(readAskResult([COLOUR, LANGS], r)).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red', notes: 'bright' }, { answer: 'Go, Rust' }],
      cut: false,
    });
  });

  it('a note with NO pick is not an answer, and the question after it still is', () => {
    const r =
      'The user answered: "Which colour do you prefer?"=(no option selected) notes: none of these, "Which of these languages do you use?"="Go". Read the answers carefully.';
    expect(readAskResult([COLOUR, LANGS], r)).toEqual({
      state: 'answered',
      answers: [{ answer: null, notes: 'none of these' }, { answer: 'Go' }],
      cut: false,
    });
  });

  it('pairs that open mid-sentence are found', () => {
    const soFar =
      'The user wants to clarify before you proceed. So far they answered: "Which colour do you prefer?"="Red". Call AskUserQuestion again.';
    expect(readAskResult([COLOUR, LANGS], soFar)).toMatchObject({
      state: 'answered',
      answers: [{ answer: 'Red' }, null],
    });
    const idle =
      'Before going idle the user had selected: "Which of these languages do you use?"="Go".';
    expect(readAskResult([COLOUR, LANGS], idle)).toMatchObject({
      state: 'answered',
      answers: [null, { answer: 'Go' }],
    });
  });

  it('free text instead of choices is a RESPONSE, not "not answered"', () => {
    expect(readAskResult([COLOUR], 'The user responded: just do it')).toEqual({
      state: 'responded',
      text: 'just do it',
    });
  });

  it('"did not answer" is not answered, in the CLI’s own words', () => {
    const r = 'The user did not answer the questions.';
    expect(readAskResult([COLOUR], r)).toEqual({ state: 'declined', reason: r });
  });
});

describe('readAskResult — a result cut short', () => {
  it('says so: a question past the cut is NOT reported as skipped', () => {
    // main keeps a bounded slice of every result; a long typed answer pushes
    // the rest of the sentence past it
    const cutShort =
      'The user answered: "Which colour do you prefer?"="a very long typed answer that goes on and on';
    const read = readAskResult([COLOUR, LANGS], cutShort);
    expect(read).toEqual({
      state: 'answered',
      answers: [{ answer: 'a very long typed answer that goes on and on' }, null],
      cut: true,
    });
  });

  it('a whole sentence is not "cut", whatever it closes with', () => {
    expect(readAskResult([COLOUR, LANGS], PARTIAL)).toMatchObject({ cut: false });
    const odd = 'Your questions have been answered: "Which colour do you prefer?"="Red". Carry on.';
    expect(readAskResult([COLOUR], odd)).toMatchObject({ cut: false });
  });

  it('the close is the LAST known one: an answer may quote the other', () => {
    const r =
      'The user answered: "Which colour do you prefer?"="he said "go". You can now continue, I think". Read the answers carefully — they may request clarification.';
    expect(readAskResult([COLOUR], r)).toMatchObject({
      answers: [{ answer: 'he said "go". You can now continue, I think' }],
    });
  });
});
