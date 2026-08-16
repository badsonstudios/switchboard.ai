// @vitest-environment jsdom
// Find-in-page, scoped to one panel's subtree (P2-E16-02, §5.30 as corrected;
// the body of the `find-document` provider since #533).
import { describe, it, expect, beforeEach } from 'vitest';
import { applyMatches, clearMatches, focusMatch, MATCH_CAP } from './document-find';

/** The count, which is what most of these cases are actually about. */
const count = (root: HTMLElement, query: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean }): number =>
  applyMatches(root, query, opts).matches.length;

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});

describe('applyMatches', () => {
  it('wraps every case-insensitive occurrence and counts them', () => {
    host.innerHTML = '<p>The Feed feeds the feed.</p>';
    expect(count(host, 'feed')).toBe(3);
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(3);
    // the text is untouched — only the wrapping changed
    expect(host.textContent).toBe('The Feed feeds the feed.');
  });

  it('finds matches across elements, and leaves the markup intact', () => {
    host.innerHTML = '<p>alpha <strong>beta</strong> alpha</p>';
    expect(count(host, 'alpha')).toBe(2);
    expect(host.querySelector('strong')?.textContent).toBe('beta');
  });

  it('an empty or blank query matches nothing rather than everything', () => {
    host.innerHTML = '<p>text</p>';
    expect(count(host, '')).toBe(0);
    expect(count(host, '   ')).toBe(0);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
  });

  it('searching twice does not match inside its own highlights', () => {
    host.innerHTML = '<p>aaa</p>';
    expect(count(host, 'a')).toBe(3);
    expect(count(host, 'a')).toBe(3);
    expect(host.querySelectorAll('mark')).toHaveLength(3);
  });

  it('restores the DOM exactly when cleared', () => {
    const before = '<p>one <em>two</em> three</p>';
    host.innerHTML = before;
    applyMatches(host, 'e');
    clearMatches(host);
    expect(host.innerHTML).toBe(before);
  });

  it('never matches the viewer’s OWN chrome (#533)', () => {
    // `lib/document-render` injects text into this subtree — a fence's language
    // label and its Copy button — and the shared bar LISTS what it finds, so a
    // search for "copy" used to turn up three of our own buttons. The copy
    // button is also the one whose textContent `activate()` overwrites, which
    // would delete a mark behind `clearMatches`' back.
    host.innerHTML =
      '<div class="doc-code"><div class="doc-code-head">' +
      '<span class="doc-code-lang">ts</span>' +
      '<button data-doc-copy="">Copy</button></div>' +
      '<pre><code>const copy = 1;</code></pre></div>';
    expect(count(host, 'copy')).toBe(1); // the code, not the button
    expect(count(host, 'ts')).toBe(0);
    expect(host.querySelector('[data-doc-copy]')?.textContent).toBe('Copy');
  });

  it('searches inside code fences — that is where the command is', () => {
    host.innerHTML = '<pre><code>npm run e2e</code></pre>';
    expect(count(host, 'npm run')).toBe(1);
  });

  // --- what the shared bar needs that the private one did not (#533) --------

  it('reports each match with enough context for the results list', () => {
    host.innerHTML = '<p>the needle is here</p>';
    const { matches, truncated } = applyMatches(host, 'needle');
    expect(truncated).toBe(false);
    expect(matches).toEqual([{ text: 'the needle is here', offset: 4, length: 6 }]);
  });

  it('honours the bar’s Match case chip', () => {
    host.innerHTML = '<p>Feed feed FEED</p>';
    expect(count(host, 'feed', { caseSensitive: true })).toBe(1);
    expect(count(host, 'feed')).toBe(3);
  });

  it('honours Whole word — including a term with no word boundary of its own', () => {
    host.innerHTML = '<p>feed feeds prefeed</p>';
    expect(count(host, 'feed', { wholeWord: true })).toBe(1);
    // `\\b--force\\b` would match NOTHING here; the lookarounds this uses do the
    // thing the user means. The regression that argument exists to prevent.
    host.innerHTML = '<p>run --force now, not --forced</p>';
    expect(count(host, '--force', { wholeWord: true })).toBe(1);
  });

  it('takes a term full of regex metacharacters literally', () => {
    host.innerHTML = '<p>a.b and axb</p>';
    expect(count(host, 'a.b')).toBe(1);
  });

  it('stops at the cap and SAYS it stopped, rather than marking a whole book', () => {
    host.innerHTML = `<p>${'x'.repeat(MATCH_CAP + 50)}</p>`;
    const { matches, truncated } = applyMatches(host, 'x');
    expect(matches).toHaveLength(MATCH_CAP);
    expect(truncated).toBe(true);
  });

  it('a document with EXACTLY the cap is not called truncated', () => {
    // the flag is raised holding a match we declined, so "2000+" is only ever
    // printed when there is a 2001st — a capped number reported as a total is
    // the wrong-total-told-confidently failure one layer down
    host.innerHTML = `<p>${'x'.repeat(MATCH_CAP)}</p>`;
    const { matches, truncated } = applyMatches(host, 'x');
    expect(matches).toHaveLength(MATCH_CAP);
    expect(truncated).toBe(false);
  });

  // #477's copy path: `activate()` copies a code block by reading
  // `pre.textContent`, and a search running WHILE the user copies must not put
  // its own chrome in their clipboard.
  it('marks do not leak into the text a code block copies', () => {
    host.innerHTML = '<pre><code>npm run e2e</code></pre>';
    applyMatches(host, 'run');
    expect(host.querySelectorAll('mark')).toHaveLength(1);
    expect(host.querySelector('pre')?.textContent).toBe('npm run e2e');
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

  it('REFUSES an index that is not there, rather than wrapping onto some other match', () => {
    // #533: the index is a snapshot position from the last `search`, and a
    // document rewritten under an open bar is re-marked without the bar
    // re-querying. Wrapping would answer "yes, I jumped" while highlighting an
    // unrelated match — the confident lie §5.31 exists to refuse. The bar wraps
    // its own index across groups; this one only ever answers for what is here.
    expect(focusMatch(host, 3)).toBe(-1);
    expect(focusMatch(host, -1)).toBe(-1);
    expect(host.querySelectorAll('mark[data-doc-match-current]')).toHaveLength(0);
    expect(focusMatch(host, 2)).toBe(2);
  });

  it('answers -1 rather than throwing when there is nothing to focus', () => {
    clearMatches(host);
    expect(focusMatch(host, 0)).toBe(-1);
  });
});
