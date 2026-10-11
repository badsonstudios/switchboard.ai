// #1201 — reading a settled question back.
//
// The result strings here are the REAL ones: the first three are verbatim from
// `spike/findings/artifacts/s11/ask-user-question-{answer,other,partial}.json`,
// the fourth is switchboard's own denial as a real transcript on this machine
// recorded it. A test against an invented sentence would only pin our idea of
// what the CLI writes.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
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
describe('readAskResult — the shapes another client can produce, MEASURED (#1226)', () => {
  // These were first written from strings read out of the 2.1.288 binary, with
  // synthetic sentences. The CLI has since been made to produce every one of
  // them (`spike/probes/1226/`), and each test below reads the ARTIFACT of
  // that run: the questions exactly as the CLI asked them and the sentence
  // exactly as it wrote it. Nothing here is typed by hand.
  const ARTIFACTS = path.join(__dirname, '..', '..', 'spike', 'findings', 'artifacts', '1226');
  function measured(mode: string): { questions: SettledQuestion[]; result: string } {
    const record = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, `ask-result-${mode}.json`), 'utf8')) as {
      askInput: unknown;
      toolResults: Array<{ content: string }>;
    };
    const questions = settledQuestions(record.askInput);
    if (!questions) throw new Error(`${mode}: the artifact holds no questions`);
    return { questions, result: record.toolResults[0].content };
  }
  const read = (mode: string): ReturnType<typeof readAskResult> => {
    const m = measured(mode);
    return readAskResult(m.questions, m.result);
  };

  it('a note after an answer does not swallow the next question', () => {
    expect(read('note')).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red', notes: 'PROBE-NOTE because it is warm' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('a preview and a note after an answer are not part of the answer', () => {
    expect(measured('preview').result).toContain(' selected preview:' + String.fromCharCode(10));
    expect(read('preview')).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red', notes: 'PROBE-NOTE bright' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('a note with NO pick is not an answer, and the question after it still is', () => {
    expect(measured('notepick').result).toContain('=(no option selected) notes: ');
    expect(read('notepick')).toEqual({
      state: 'answered',
      answers: [{ answer: null, notes: 'PROBE-NOTE none of these' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('free text instead of choices is a RESPONSE, not "not answered"', () => {
    expect(read('response')).toEqual({
      state: 'responded',
      text: 'PROBE-RESPONSE I would rather describe it in my own words',
    });
  });

  it('free text sent WITH answers: the CLI writes only the text, and so that is what is read', () => {
    // measured: the answers that came with it are not in the sentence at all
    expect(measured('both').result).not.toContain('"="');
    expect(read('both')).toEqual({ state: 'responded', text: 'PROBE-RESPONSE and one more thing' });
  });

  it('⚠️ a multi-select answer sent as an ARRAY is joined with a bare comma, and still ticks its choices', () => {
    const { questions, result } = measured('array');
    expect(result).toContain('="TypeScript,Rust"');
    const outcome = readAskResult(questions, result);
    expect(outcome).toMatchObject({ state: 'answered', answers: [{ answer: 'Red' }, { answer: 'TypeScript,Rust' }] });
    expect(pickedFor(questions[1], 'TypeScript,Rust')).toEqual({ picked: ['TypeScript', 'Rust'], other: null });
    // ...but typed text with a comma in it is still what was typed
    expect(pickedFor(questions[1], 'Zig,Rust')).toEqual({ picked: [], other: 'Zig,Rust' });
  });

  it('"asked for more questions", with answers so far: the answers are read, and nothing after them', () => {
    const { result } = measured('followup');
    expect(result.startsWith('The user asked for more questions before you proceed. So far they answered: ')).toBe(true);
    expect(read('followup')).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('⚠️ ...and with words of their own after the answers, which hold a QUOTE: the last answer is not run on into them', () => {
    const { result } = measured('followboth');
    expect(result).toContain('. They also wrote: "PROBE-RESPONSE but ask me about "shade" too". Call ');
    expect(read('followboth')).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('"asked for more questions" with NO answers but words of their own: those words are the response', () => {
    expect(measured('followtext').result.startsWith('The user asked for more questions before answering.')).toBe(true);
    expect(read('followtext')).toEqual({
      state: 'responded',
      text: 'PROBE-RESPONSE what do you mean by colour',
    });
  });

  it('gone idle: what had been selected before the wait ran out is read from mid-result', () => {
    const { result } = measured('afk');
    expect(result.startsWith('No response after 60s')).toBe(true);
    expect(read('afk')).toEqual({
      state: 'answered',
      answers: [{ answer: 'Red' }, { answer: 'TypeScript, Rust' }],
      cut: false,
    });
  });

  it('"did not answer" is not answered, in the CLI’s own words (measured in S-11, 2.1.233)', () => {
    const r = 'The user did not answer the questions.';
    expect(readAskResult([COLOUR], r)).toEqual({ state: 'declined', reason: r });
  });

  it('every artifact was made by the CLI these shapes are claimed for', () => {
    for (const file of fs.readdirSync(ARTIFACTS)) {
      const record = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file), 'utf8')) as { cliVersion: string | null };
      expect(record.cliVersion, file).toBe('2.1.288');
    }
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
