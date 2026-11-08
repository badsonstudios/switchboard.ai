// @vitest-environment jsdom
// #717 — your own prompt in the conversation: its own colour, and a prompt
// longer than one line folds to its first line until you click it ("click on it
// to read the full prompt if it's more than one line, and click again to
// collapse it"). "More than one line" is a line break, or more than
// ONE_LINE_CHARS characters: a rule on the text, never a measurement (see the
// component for why).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';
import { renderFeedBlock } from './feed-render';
import { ONE_LINE_CHARS } from './feed-blocks';
import { formatSiblingPrompt } from '../../../shared/sibling-message';
import type { FeedBlockDto } from '../lib/feed';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const registry = createRendererRegistry();
const NL = String.fromCharCode(10);

function draw(text: string): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const b: FeedBlockDto = { seq: 1, kind: 'user', sidechain: false, text };
  act(() => {
    root.render(renderFeedBlock(registry, b));
  });
  return host;
}

const prompt = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.feed-prompt')!;
const fold = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>('[aria-expanded]');

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

describe('your prompt in the conversation (#717)', () => {
  it('is drawn in the prompt colours, through the class the contrast test measures', () => {
    expect(prompt(draw('a short question'))).not.toBeNull();
  });

  it('a one-line prompt has no fold: it is just its words', () => {
    const host = draw('a short question');
    expect(fold(host)).toBeNull();
    expect(prompt(host).textContent).toBe('a short question');
  });

  it('a prompt longer than one line starts folded to its first line', () => {
    const host = draw(`first line of the ask${NL}second line${NL}third line`);
    const f = fold(host)!;
    expect(f.getAttribute('aria-expanded')).toBe('false');
    expect(prompt(host).textContent).toContain('first line of the ask');
    expect(prompt(host).textContent).not.toContain('third line');
    expect(prompt(host).textContent).toContain('click to expand');
  });

  it('a click opens it in full, and a second click folds it again', () => {
    const host = draw(`first line of the ask${NL}second line${NL}third line`);
    act(() => fold(host)!.click());
    expect(fold(host)!.getAttribute('aria-expanded')).toBe('true');
    expect(prompt(host).textContent).toContain('third line');
    expect(prompt(host).textContent).toContain('click to collapse');
    act(() => fold(host)!.click());
    expect(fold(host)!.getAttribute('aria-expanded')).toBe('false');
    expect(prompt(host).textContent).not.toContain('third line');
  });

  it('one long line, past about one line of words, folds too', () => {
    const long = `Please look through the sessions list ${'and keep going '.repeat(8)}to the end.`;
    expect(long.length).toBeGreaterThan(ONE_LINE_CHARS);
    const host = draw(long);
    expect(fold(host)!.getAttribute('aria-expanded')).toBe('false');
    act(() => fold(host)!.click());
    expect(prompt(host).textContent).toContain('to the end.');
  });

  it('a message from another session folds to who sent it and their words, not its header', () => {
    const forwarded = formatSiblingPrompt({ id: 'c1', name: 'PropaneMon' }, 'the regulator reads 42 psi', 'user', 'ab12cd34');
    const host = draw(forwarded);
    const f = fold(host)!;
    expect(f.getAttribute('aria-expanded')).toBe('false');
    expect(f.textContent).toContain('From "PropaneMon": the regulator reads 42 psi');
    expect(f.textContent).not.toContain('another switchboard session');
  });

  it('a stray line break at either end does not fold a one-line prompt', () => {
    expect(fold(draw(`fix it${NL}`))).toBeNull();
    expect(fold(draw(`${NL}fix it`))).toBeNull();
  });

  it('a line right at the limit is shown in full, unfolded', () => {
    expect(fold(draw('x'.repeat(ONE_LINE_CHARS)))).toBeNull();
  });
});
