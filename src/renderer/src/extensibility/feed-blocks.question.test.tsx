// @vitest-environment jsdom
// A past question reads as a question and its answer, not as JSON (#1201).
//
// The owner: "when you go back into the session and scroll up to where the
// questions were asked, it's displayed in what looks like JSON."
//
// Rendered through the real registry, the way FeedView does. The questions and
// the result sentences are the measured ones (spike/findings/artifacts/s11).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { FeedBlockDto } from '../lib/feed';
import type { SettledQuestion } from '../../../shared/ask-user-question';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();

const COLOUR: SettledQuestion = {
  question: 'Which colour do you prefer?',
  header: 'Colour',
  options: [
    { label: 'Red', description: 'Prefer red' },
    { label: 'Green', description: 'Prefer green' },
  ],
  multiSelect: false,
};
const LANGS: SettledQuestion = {
  question: 'Which of these languages do you use?',
  header: 'Languages',
  options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }],
  multiSelect: true,
};
const RAW = JSON.stringify({ questions: [COLOUR, LANGS] }, null, 2);

function draw(tool: Partial<NonNullable<FeedBlockDto['tool']>>): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const b: FeedBlockDto = {
    seq: 7,
    kind: 'tool',
    sidechain: false,
    tool: { name: 'AskUserQuestion', summary: '', detail: RAW, ...tool },
  };
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const questions = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-question]'));
const chosen = (q: HTMLElement): string[] =>
  Array.from(q.querySelectorAll<HTMLElement>('[data-question-option="chosen"]')).map(
    (li) => li.querySelector('span > span')!.textContent ?? ''
  );

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('a settled question (#1201)', () => {
  it('reads as question, options and the chosen answer, with no JSON on screen', () => {
    const host = draw({
      questions: [COLOUR, LANGS],
      out: 'Your questions have been answered: "Which colour do you prefer?"="Red", "Which of these languages do you use?"="TypeScript, Rust". You can now continue with these answers in mind.',
    });
    expect(host.querySelector('[data-feed-box="question"]')).not.toBeNull();
    const [colour, langs] = questions(host);
    expect(colour.querySelector('[data-question-text]')!.textContent).toBe(
      'Which colour do you prefer?'
    );
    expect(colour.textContent).toContain('Colour');
    expect(colour.textContent).toContain('Prefer red');
    expect(chosen(colour)).toEqual(['Red']);
    // every answer of a multi-select
    expect(chosen(langs)).toEqual(['TypeScript', 'Rust']);
    // what was offered and not chosen is still there to read
    expect(langs.textContent).toContain('Go');
    expect(host.querySelector('[data-question-state]')!.textContent).toBe('answered');
    // no payload by default
    expect(host.textContent).not.toContain('"questions"');
    expect(host.querySelector('pre')).toBeNull();
  });

  it('says a chosen option in WORDS for a screen reader, not only with a tick', () => {
    const host = draw({
      questions: [COLOUR],
      out: 'Your questions have been answered: "Which colour do you prefer?"="Red". You can now continue with these answers in mind.',
    });
    const li = host.querySelector<HTMLElement>('[data-question-option="chosen"]')!;
    expect(li.textContent).toContain('(chosen)');
    expect(li.querySelector('[aria-hidden]')!.textContent).toBe('✓');
  });

  it('a SKIPPED question says skipped', () => {
    const host = draw({
      questions: [COLOUR, LANGS],
      out: 'Your questions have been answered: "Which colour do you prefer?"="Red". You can now continue with these answers in mind.',
    });
    const [colour, langs] = questions(host);
    expect(colour.querySelector('[data-question-skipped]')).toBeNull();
    expect(langs.querySelector('[data-question-skipped]')!.textContent).toBe('Skipped');
    expect(chosen(langs)).toEqual([]);
  });

  it('typed text is shown as what was typed, and no option is ticked for it', () => {
    const host = draw({
      questions: [COLOUR],
      out: 'The user answered: "Which colour do you prefer?"="Teal, please". Read the answers carefully — they may request clarification.',
    });
    const [colour] = questions(host);
    expect(chosen(colour)).toEqual([]);
    expect(colour.querySelector('[data-question-other]')!.textContent).toBe(
      'Typed instead: Teal, please'
    );
  });

  it('declined: says not answered, and shows the result’s own words', () => {
    const host = draw({
      questions: [COLOUR],
      out: 'The user reviewed this request in switchboard and DENIED it.',
    });
    expect(host.querySelector('[data-question-state]')!.textContent).toBe('not answered');
    expect(host.querySelector('[data-question-reason]')!.textContent).toContain('DENIED');
    expect(host.querySelector('[data-question-skipped]')).toBeNull();
    // the question is still there to read
    expect(host.textContent).toContain('Which colour do you prefer?');
  });

  it('no result yet: waiting, with the question readable and nothing marked', () => {
    const host = draw({ questions: [COLOUR] });
    expect(host.querySelector('[data-question-state]')!.textContent).toBe('waiting for an answer');
    expect(host.querySelectorAll('[data-question-option="chosen"]')).toHaveLength(0);
    expect(host.querySelector('[data-question-skipped]')).toBeNull();
  });

  it('answered in their own words: says so, and shows the words', () => {
    const host = draw({ questions: [COLOUR], out: 'The user responded: just pick for me' });
    expect(host.querySelector('[data-question-state]')!.textContent).toBe(
      'answered in their own words'
    );
    expect(host.querySelector('[data-question-responded]')!.textContent).toBe(
      'Typed instead: just pick for me'
    );
    expect(host.querySelector('[data-question-skipped]')).toBeNull();
  });

  it('a note left beside an answer is shown with it', () => {
    const host = draw({
      questions: [COLOUR, LANGS],
      out: 'The user answered: "Which colour do you prefer?"="Red" notes: because warm, "Which of these languages do you use?"="Go". Read the answers carefully.',
    });
    const [colour, langs] = questions(host);
    expect(chosen(colour)).toEqual(['Red']);
    expect(colour.querySelector('[data-question-notes]')!.textContent).toBe('Note: because warm');
    // the question AFTER the note is still read as answered
    expect(chosen(langs)).toEqual(['Go']);
    expect(langs.querySelector('[data-question-skipped]')).toBeNull();
  });

  it('a result cut short does not call the questions past the cut "skipped"', () => {
    const host = draw({
      questions: [COLOUR, LANGS],
      out: 'The user answered: "Which colour do you prefer?"="a long typed answer that runs on',
    });
    const [, langs] = questions(host);
    expect(langs.querySelector('[data-question-skipped]')).toBeNull();
    expect(langs.querySelector('[data-question-cut]')!.textContent).toContain('cut short');
  });

  it('the raw call is one click away, behind the standard expander', () => {
    const host = draw({
      questions: [COLOUR],
      out: 'Your questions have been answered: "Which colour do you prefer?"="Red". You can now continue with these answers in mind.',
    });
    const expander = host.querySelector<HTMLButtonElement>(`[${FEED_EXPANDER_ATTR}]`)!;
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    act(() => expander.click());
    expect(expander.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('pre')!.textContent).toBe(RAW);
  });

  it('clicking in the answers does not fold the box: you can select what was said', () => {
    const host = draw({ questions: [COLOUR], out: undefined });
    const expander = host.querySelector<HTMLButtonElement>(`[${FEED_EXPANDER_ATTR}]`)!;
    act(() => host.querySelector<HTMLElement>('[data-question-text]')!.click());
    expect(expander.getAttribute('aria-expanded')).toBe('false');
  });

  it('a payload that is not the documented shape stays a generic row, raw and honest', () => {
    const host = draw({ questions: undefined });
    expect(host.querySelector('[data-feed-box="question"]')).toBeNull();
    expect(host.querySelector('[data-feed-box="tool"]')).not.toBeNull();
  });
});
