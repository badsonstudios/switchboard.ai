// Prompt History (#1203): which blocks are your prompts, what each is called,
// and how a recalled one meets what is already typed.
import { describe, it, expect } from 'vitest';
import type { FeedBlockDto } from './feed';
import { filterPrompts, promptAge, promptsOf, recallInto } from './prompt-history';

let seq = 1;
const block = (over: Partial<FeedBlockDto>): FeedBlockDto => ({
  seq: seq++,
  kind: 'assistant',
  sidechain: false,
  ...over,
});
const user = (text: string, over: Partial<FeedBlockDto> = {}): FeedBlockDto =>
  block({ kind: 'user', text, ...over });
const NL = String.fromCharCode(10);

describe('promptsOf — the prompts you sent', () => {
  it('is your prompts, NEWEST FIRST, each with the block to go back to', () => {
    const a = user('first thing', { ts: '2026-10-11T10:00:00.000Z' });
    const b = user('second thing');
    const list = promptsOf([a, block({ text: 'an answer' }), b, block({ text: 'another' })]);
    expect(list.map((p) => p.text)).toEqual(['second thing', 'first thing']);
    expect(list.map((p) => p.seq)).toEqual([b.seq, a.seq]);
    expect(list[1].ts).toBe('2026-10-11T10:00:00.000Z');
    expect('ts' in list[0]).toBe(false);
  });

  it('only YOURS: a subagent’s instructions, tool rows and notices are not prompts', () => {
    const mine = user('do the thing');
    const list = promptsOf([
      mine,
      user('review this diff', { sidechain: true }),
      block({ kind: 'tool', tool: { name: 'Bash', summary: 'ls' } }),
      block({ kind: 'notice' }),
      block({ kind: 'thinking', text: 'hmm' }),
    ]);
    expect(list.map((p) => p.seq)).toEqual([mine.seq]);
  });

  it('a slash command is listed as you typed it, and its plumbing is not listed', () => {
    const list = promptsOf([
      user('<command-name>/next-item</command-name><command-args>1203</command-args>'),
      user('<command-message>next-item is running</command-message>'),
    ]);
    expect(list).toEqual([expect.objectContaining({ text: '/next-item 1203', command: true })]);
  });

  it('a prompt that merely MENTIONS the markup is still a prompt', () => {
    const list = promptsOf([user('what does <command-name> mean in a transcript?')]);
    expect(list).toHaveLength(1);
    expect(list[0].command).toBe(false);
  });

  it('nothing sent is not a prompt', () => {
    expect(promptsOf([user(''), user('   '), block({ kind: 'user' })])).toEqual([]);
    expect(promptsOf([])).toEqual([]);
  });

  it('the text is the prompt as sent, whole and trimmed: it is what "use again" puts back', () => {
    const long = `line one${NL}line two${NL}${'x'.repeat(500)}`;
    expect(promptsOf([user(`  ${long}  `)])[0].text).toBe(long);
  });
});

describe('filterPrompts', () => {
  const list = promptsOf([user('Fix the tail-pin gesture'), user('Write the release notes'), user('fix the notes')]);

  it('every word typed, in any order, whatever the case', () => {
    expect(filterPrompts(list, 'notes FIX').map((p) => p.text)).toEqual(['fix the notes']);
    expect(filterPrompts(list, 'the').length).toBe(3);
  });

  it('nothing typed is everything, in the same order', () => {
    expect(filterPrompts(list, '   ')).toEqual(list);
  });

  it('no match is an empty list, not an error', () => {
    expect(filterPrompts(list, 'zebra')).toEqual([]);
  });
});

describe('recallInto — "use again" never costs what you typed', () => {
  it('an empty box takes the prompt', () => {
    expect(recallInto('', 'run the tests')).toBe('run the tests');
    expect(recallInto(`  ${NL} `, 'run the tests')).toBe('run the tests');
  });

  it('a box with words in it KEEPS them; the prompt is added after a blank line', () => {
    expect(recallInto('and also', 'run the tests')).toBe(`and also${NL}${NL}run the tests`);
    expect(recallInto(`half a thought${NL}`, 'x')).toBe(`half a thought${NL}${NL}x`);
  });

  it('recalling what is already there changes nothing', () => {
    expect(recallInto('run the tests', 'run the tests')).toBe('run the tests');
  });
});

describe('promptAge', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  it.each([
    ['2026-10-11T11:59:40.000Z', { unit: 'now', count: 0 }],
    ['2026-10-11T11:45:00.000Z', { unit: 'minutes', count: 15 }],
    ['2026-10-11T09:00:00.000Z', { unit: 'hours', count: 3 }],
    ['2026-10-08T12:00:00.000Z', { unit: 'days', count: 3 }],
  ])('%s', (ts, want) => {
    expect(promptAge(ts, now)).toEqual(want);
  });

  it('no time, or one that cannot be read, says nothing', () => {
    expect(promptAge(undefined, now)).toBeNull();
    expect(promptAge('yesterday-ish', now)).toBeNull();
  });
});
