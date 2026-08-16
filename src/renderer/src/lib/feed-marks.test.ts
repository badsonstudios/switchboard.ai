// @vitest-environment jsdom
// The Session view's find marks (#520).
//
// The bug: a jump revealed the block and highlighted nothing, so "1 of 12" put
// the conversation somewhere plausible and left the eye to re-read it. These
// cases pin the four things the fix has to be true about — it marks the term,
// it says WHICH match is the current one, it never changes the text (the #477
// copy path reads `textContent`), and it does not touch text nodes React is
// holding on to.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearFeedMarks,
  feedMarkMatcher,
  markFeedMatches,
  moveCurrentMark,
  sameFindQuery,
  FEED_MATCH_ATTR,
  FEED_MATCH_CURRENT_ATTR,
} from './feed-marks';
import { FEED_SEQ_ATTR } from './feed-reveal';
import { decorateFeedMarkdown } from './feed-markdown';
import { renderMarkdown } from './markdown';
import { codeForCopyButton } from './feed-code';

const LABELS = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.replaceChildren(host);
});

/** One feed block wrapper, the way `FeedView`'s `Block` renders it. */
function block(seq: number, inner: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(FEED_SEQ_ATTR, String(seq));
  el.innerHTML = inner;
  host.append(el);
  return el;
}

const marks = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`mark[${FEED_MATCH_ATTR}]`)];
const marked = (): string[] => marks().map((m) => m.textContent ?? '');
const current = (): HTMLElement | null =>
  host.querySelector<HTMLElement>(`mark[${FEED_MATCH_CURRENT_ATTR}]`);

describe('marking the term the bar is looking for', () => {
  it('wraps every occurrence, and says which one find is sitting on', () => {
    const b1 = block(1, '<div>ENOENT in the postbuild step</div>');
    const b2 = block(2, '<div>npm ERR! ENOENT, and again ENOENT</div>');

    const got = markFeedMatches(host, { term: 'ENOENT' }, b2);

    expect(marked()).toEqual(['ENOENT', 'ENOENT', 'ENOENT']);
    // the current mark is in the block the jump LANDED in, not the first on
    // screen — the whole point is that the eye goes where the scroll went
    expect(got).toBe(marks()[1]);
    expect(b2.contains(current()!)).toBe(true);
    expect(b1.contains(current()!)).toBe(false);
    expect(host.querySelectorAll(`[${FEED_MATCH_CURRENT_ATTR}]`)).toHaveLength(1);
  });

  it('leaves the TEXT exactly as it was — a mark is an element, not words', () => {
    const b = block(1, '<div>npm ERR! ENOENT</div>');
    const before = b.textContent;
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(b.textContent).toBe(before);
    clearFeedMarks(host);
    expect(b.textContent).toBe(before);
    expect(b.innerHTML).toBe('<div>npm ERR! ENOENT</div>');
  });

  it('cannot change what the copy button puts on the clipboard (#477)', () => {
    // A match INSIDE a code fence is the case that matters: `runCopy` copies
    // `pre.textContent`, and a wrapper element contributes nothing to it.
    const fence = ['```sh', 'npm run build', '```'].join(String.fromCharCode(10));
    const b = block(1, decorateFeedMarkdown(renderMarkdown(fence), LABELS));
    const button = b.querySelector('[data-feed-copy]')!;
    const before = codeForCopyButton(button);
    expect(before).toContain('npm run build');

    markFeedMatches(host, { term: 'build' }, b);
    expect(marked()).toEqual(['build']);
    expect(current()!.closest('pre')).not.toBeNull();
    expect(codeForCopyButton(button)).toBe(before);
  });

  it('never marks the chrome the feed injects INTO a block', () => {
    // A code fence gets a language label and a Copy button (#477) that the
    // session never said. Marking them makes the count disagree with the
    // screen, can put the current mark — and the scroll — on the label ABOVE
    // the fence, and `runCopy` eats the mark when it restores the button's
    // word after the flash.
    const fence = ['```sh', 'npm run build', '```'].join(String.fromCharCode(10));
    const b = block(1, decorateFeedMarkdown(renderMarkdown(fence), LABELS));
    expect(b.textContent).toContain('sh');
    expect(b.textContent).toContain('Copy');

    expect(markFeedMatches(host, { term: 'sh' }, b)).toBeNull();
    expect(markFeedMatches(host, { term: 'Copy' }, b)).toBeNull();
    expect(marks()).toHaveLength(0);
  });

  it('falls back to the first match when the landed block holds none', () => {
    block(1, '<div>ENOENT here</div>');
    const b2 = block(2, '<div>nothing to see</div>');
    const got = markFeedMatches(host, { term: 'ENOENT' }, b2);
    // the bar's position must always have something on screen answering to it
    expect(got).toBe(marks()[0]);
  });

  it('marks nothing, and says so, for an empty term or no match', () => {
    block(1, '<div>ENOENT</div>');
    expect(markFeedMatches(host, { term: '' }, null)).toBeNull();
    expect(markFeedMatches(host, null, null)).toBeNull();
    expect(markFeedMatches(host, { term: 'nowhere' }, null)).toBeNull();
    expect(marks()).toHaveLength(0);
  });

  it('never marks the feed’s own chrome — only blocks', () => {
    const chrome = document.createElement('div');
    chrome.textContent = 'ENOENT';
    host.append(chrome);
    block(1, '<div>ENOENT</div>');
    markFeedMatches(host, { term: 'ENOENT' }, null);
    expect(marks()).toHaveLength(1);
    expect(chrome.querySelector('mark')).toBeNull();
  });

  it('re-marking replaces the previous pass rather than nesting inside it', () => {
    const b = block(1, '<div>ENOENT ENOENT</div>');
    markFeedMatches(host, { term: 'ENOENT' }, b);
    markFeedMatches(host, { term: 'ENO' }, b);
    expect(marked()).toEqual(['ENO', 'ENO']);
    expect(host.querySelectorAll('mark mark')).toHaveLength(0);
  });

  it('finds a match that straddles a previous pass’s split', () => {
    // the reason the unwrap normalizes: without it the tree keeps three
    // adjacent text nodes and the NEXT search cannot see across the joins
    const b = block(1, '<div>ENOENT</div>');
    markFeedMatches(host, { term: 'OE' }, b);
    clearFeedMarks(host);
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(marked()).toEqual(['ENOENT']);
  });
});

describe('stepping does not re-walk the buffer', () => {
  it('moves the current mark over the marks already on the page', () => {
    const b1 = block(1, '<div>ENOENT one</div>');
    const b2 = block(2, '<div>ENOENT two</div>');
    markFeedMatches(host, { term: 'ENOENT' }, b1);
    const before = marks();

    const moved = moveCurrentMark(host, b2);

    expect(moved).toBe(before[1]);
    // the SAME elements — a re-wrap would have built new ones
    expect(marks()).toEqual(before);
    expect(host.querySelectorAll(`[${FEED_MATCH_CURRENT_ATTR}]`)).toHaveLength(1);
    expect(b2.contains(moved!)).toBe(true);
  });

  it('says so when the block it stepped to has no marks yet', () => {
    // that block was hidden when the last pass ran, so the caller has to do the
    // full one after all
    const b1 = block(1, '<div>ENOENT one</div>');
    const b2 = block(2, '<div>nothing here</div>');
    markFeedMatches(host, { term: 'ENOENT' }, b1);
    expect(moveCurrentMark(host, b2)).toBeNull();
  });

  it('is a no-op on an unmarked feed', () => {
    const b = block(1, '<div>ENOENT</div>');
    expect(moveCurrentMark(host, b)).toBeNull();
  });
});

describe('the toggles the bar ships', () => {
  it('is case-insensitive by default and exact when the bar says so', () => {
    const b = block(1, '<div>Build the build</div>');
    markFeedMatches(host, { term: 'build' }, b);
    expect(marked()).toEqual(['Build', 'build']);
    markFeedMatches(host, { term: 'build', caseSensitive: true }, b);
    expect(marked()).toEqual(['build']);
  });

  it('honours whole-word the way the engine defines it', () => {
    const b = block(1, '<div>rebuild the build now</div>');
    markFeedMatches(host, { term: 'build', wholeWord: true }, b);
    expect(marked()).toEqual(['build']);
  });

  it('whole-word means "not inside a longer word", even for a punctuated term', () => {
    // `\b` would give `--force` the OPPOSITE of the intended meaning; the
    // engine uses lookarounds for exactly this, and the marks must agree
    const b = block(1, '<div>run with --force today</div>');
    markFeedMatches(host, { term: '--force', wholeWord: true }, b);
    expect(marked()).toEqual(['--force']);
  });

  it('treats a term with regex punctuation as the text the user typed', () => {
    const b = block(1, '<div>call foo() and fooX</div>');
    markFeedMatches(host, { term: 'foo()' }, b);
    expect(marked()).toEqual(['foo()']);
  });

  it('builds no matcher for an empty term, and one for anything else', () => {
    expect(feedMarkMatcher({ term: '' })).toBeNull();
    expect(feedMarkMatcher(null)).toBeNull();
    expect(feedMarkMatcher({ term: 'a' })?.flags).toBe('gi');
    expect(feedMarkMatcher({ term: 'a', caseSensitive: true })?.flags).toBe('g');
  });
});

describe('the React-ownership rule', () => {
  it('splits a lone text child — React sets those with textContent', () => {
    const b = block(1, '');
    const pre = document.createElement('pre');
    pre.textContent = 'npm ERR! ENOENT';
    b.append(pre);
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(marked()).toEqual(['ENOENT']);
  });

  it('leaves a text node that shares its parent with React siblings alone', () => {
    // `{icon} {label}` — React creates a fiber per child and KEEPS the node
    // reference. Splitting it is a lost update, or a removeChild on a detached
    // node in the middle of a streaming session. A missing mark is the cheaper
    // of the two, and this is the boundary written down.
    const b = block(1, '');
    const span = document.createElement('span');
    span.append(document.createTextNode('ENOENT'), document.createElement('b'));
    b.append(span);
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(marks()).toHaveLength(0);
  });

  it('...unless it is inside markdown, which React does not own at all', () => {
    const b = block(1, '');
    const md = document.createElement('div');
    md.className = 'feed-md';
    md.innerHTML = '<p>npm said <code>x</code> about ENOENT</p>';
    b.append(md);
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(marked()).toEqual(['ENOENT']);
  });

  it('leaves a STILL-ARRIVING reply alone, class or no class', () => {
    // `<Markdown>`'s streaming branch is real JSX in a `.feed-md` container:
    // `{text}` beside a caret span, with React writing that text node on every
    // token and removing it when the branch flips to HTML. Splitting it freezes
    // the reply and then throws. Rendered markdown always wraps its text in a
    // block element, so "parent is the container itself" is the tell.
    const b = block(1, '');
    const streaming = document.createElement('div');
    streaming.className = 'feed-md';
    const caret = document.createElement('span');
    caret.textContent = '▌';
    streaming.append(document.createTextNode('half an answer about ENOENT so'), caret);
    b.append(streaming);
    markFeedMatches(host, { term: 'ENOENT' }, b);
    expect(marks()).toHaveLength(0);
  });
});

describe('marks are ours, and the conversation cannot forge one', () => {
  it('the guard takes data-feed-match back off assistant HTML before we write any', () => {
    // `data-feed-match*` lives inside FEED_DECORATION's `data-feed` prefix, so
    // a reply that arrives already carrying one is stripped by the guard-first
    // pass — and `clearFeedMarks` therefore never unwraps somebody else's
    // markup (#465/#500).
    const forged = '<p><mark data-feed-match="0" data-feed-match-current>trust me</mark></p>';
    const out = decorateFeedMarkdown(forged, LABELS);
    expect(out).not.toContain('data-feed-match');
    expect(out).toContain('trust me');
  });
});

describe('sameFindQuery', () => {
  it('is about the question, not the object', () => {
    expect(sameFindQuery({ term: 'a' }, { term: 'a' })).toBe(true);
    expect(sameFindQuery({ term: 'a' }, { term: 'a', wholeWord: false })).toBe(true);
    expect(sameFindQuery({ term: 'a' }, { term: 'a', wholeWord: true })).toBe(false);
    expect(sameFindQuery({ term: 'a' }, { term: 'b' })).toBe(false);
    expect(sameFindQuery(null, null)).toBe(true);
    expect(sameFindQuery(null, { term: 'a' })).toBe(false);
  });
});
