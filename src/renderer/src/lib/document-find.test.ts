// @vitest-environment jsdom
// Find-in-page, scoped to one panel's subtree (P2-E16-02, §5.30 as corrected).
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMatches, clearMatches, focusMatch } from './document-find';

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

describe('applyMatches', () => {
  it('wraps every case-insensitive occurrence and counts them', () => {
    host.innerHTML = '<p>The Feed feeds the feed.</p>';
    expect(applyMatches(host, 'feed')).toBe(3);
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(3);
    // the text is untouched — only the wrapping changed
    expect(host.textContent).toBe('The Feed feeds the feed.');
  });

  it('finds matches across elements, and leaves the markup intact', () => {
    host.innerHTML = '<p>alpha <strong>beta</strong> alpha</p>';
    expect(applyMatches(host, 'alpha')).toBe(2);
    expect(host.querySelector('strong')?.textContent).toBe('beta');
  });

  it('an empty or blank query matches nothing rather than everything', () => {
    host.innerHTML = '<p>text</p>';
    expect(applyMatches(host, '')).toBe(0);
    expect(applyMatches(host, '   ')).toBe(0);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });

  it('searching twice does not match inside its own highlights', () => {
    host.innerHTML = '<p>aaa</p>';
    expect(applyMatches(host, 'a')).toBe(3);
    expect(applyMatches(host, 'a')).toBe(3);
    expect(host.querySelectorAll('mark')).toHaveLength(3);
  });

  it('restores the DOM exactly when cleared', () => {
    const before = '<p>one <em>two</em> three</p>';
    host.innerHTML = before;
    applyMatches(host, 'e');
    clearMatches(host);
    expect(host.innerHTML).toBe(before);
  });

  it('searches inside code fences — that is where the command is', () => {
    host.innerHTML = '<pre><code>npm run e2e</code></pre>';
    expect(applyMatches(host, 'npm run')).toBe(1);
  });
});

describe('focusMatch', () => {
  beforeEach(() => {
    host.innerHTML = '<p>x x x</p>';
    applyMatches(host, 'x');
  });

  it('marks exactly one match as current', () => {
    focusMatch(host, 1);
    const current = [...host.querySelectorAll<HTMLElement>('mark[data-doc-match-current]')];
    expect(current).toHaveLength(1);
    expect([...host.querySelectorAll('mark')].indexOf(current[0])).toBe(1);
  });

  it('wraps in both directions, like every find bar ever built', () => {
    expect(focusMatch(host, 3)).toBe(0);
    expect(focusMatch(host, -1)).toBe(2);
  });

  it('answers -1 rather than throwing when there is nothing to focus', () => {
    clearMatches(host);
    expect(focusMatch(host, 0)).toBe(-1);
  });
});
