// @vitest-environment jsdom
// A streaming reply is rendered as the pieces of it that have settled, plus the
// tail still being written (#716).
//
// Two claims, and they pull in opposite directions, which is why they are in
// one file:
//
//  · SAME PICTURE. Cutting the reply must not change what it renders to — the
//    reader is shown the document `renderMarkdown` would have produced whole.
//  · LESS WORK. A piece that has settled is never written to the page again.
//    This is the entire point, and it is the half that fails silently: with it
//    broken the conversation looks identical and costs what it used to.
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completePartialMarkdown,
  Markdown,
  renderMarkdown,
  settledLength,
  STREAMING_ATTR,
  UNSPLITTABLE,
} from './markdown';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLElement;
let root: Root;

/** render, and let the frame `useCoalesced` owes fire — a streaming block shows the text a frame late */
function show(node: React.ReactElement): void {
  act(() => root.render(node));
}

const containers = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.feed-md')];
const settledOnes = (): HTMLElement[] => containers().filter((el) => !el.hasAttribute(STREAMING_ATTR));
/** what is on the page, as one string: every container's HTML in order */
const picture = (): string => containers().map((el) => el.innerHTML).join('');
/** whitespace BETWEEN tags is not part of the picture */
const tidy = (html: string): string => html.replace(/>\s+</g, '><').trim();

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // one frame is one synchronous call, so every `show` above lands the text it was given
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('settledLength', () => {
  it('is where the last block that has a whole line to itself starts', () => {
    const text = 'one\n\ntwo\n\nthree\n';
    expect(text.slice(settledLength(text))).toBe('three\n');
  });

  it('settles a paragraph as soon as a blank line follows it — nothing can join it after that', () => {
    const text = 'one\n\ntwo\n\nthr';
    expect(text.slice(settledLength(text))).toBe('thr');
    expect(settledLength('one\n\n')).toBe(5);
  });

  it('never looks at a last line that has not finished arriving', () => {
    // no blank line yet: `tw` is still, as far as anyone can tell, more of `one`
    expect(settledLength('one\ntw')).toBe(0);
    // ...and `# ` here is not evidence that the list above it has ended
    const text = 'intro\n\n- a\n- b\n# ';
    expect(text.slice(settledLength(text))).toBe('- a\n- b\n# ');
  });

  it('says nothing has settled while there is only one block', () => {
    expect(settledLength('one long paragraph that is still being written')).toBe(0);
    expect(settledLength('')).toBe(0);
  });

  it('does NOT settle a list or indented code on a blank line — both run across one', () => {
    for (const growing of ['- a\n- b\n\n', '    code line\n\n']) {
      const text = `intro\n\n${growing}`;
      expect(text.slice(settledLength(text)), JSON.stringify(growing)).toBe(growing);
    }
  });

  it('does not count trailing blank lines as a block — the one before them can still grow', () => {
    // a list followed by a blank line is still a list that can gain an item
    const text = 'intro\n\n- a\n- b\n\n';
    expect(text.slice(settledLength(text))).toBe('- a\n- b\n\n');
  });

  it('keeps a list, a fence and a table whole until something follows them', () => {
    for (const growing of ['- a\n\n- b\n', '```js\nconst a = 1;\n\nconst b = 2;\n', '| a | b |\n| - | - |\n| 1 | 2 |\n']) {
      const text = `intro\n\n${growing}`;
      expect(text.slice(settledLength(text))).toBe(growing);
    }
  });

  // Each of these is a line that LOOKS like a new block for exactly as long as
  // it is unfinished, and is a continuation of the block above once it is not.
  // `marked` accepts end of input where a newline would go; a rule that
  // believed it would cut a paragraph, a list item, a quote or a table in two.
  it.each([
    ['a paragraph, then "#" before it becomes "#716 …"', 'see the fix in\n#'],
    ['a paragraph, then "***" before it becomes "***bold***"', 'text\n***'],
    ['a list item, then "*" before it becomes "*emphasised* continuation"', '- item text\n*'],
    ['a list item, then "1." before it becomes "1.5 seconds"', '- took about\n1.'],
    ['a quote, then "#" before it becomes more of the quote', '> quote\n#'],
    ['a table, then "#" before it becomes another row', '| a |\n| - |\n| 1 |\n#'],
  ])('does not settle on the evidence of an unfinished line: %s', (_name, text) => {
    expect(settledLength(text)).toBe(0);
  });

  it('refuses a document whose blocks are not independent', () => {
    // a definition changes how a link ANYWHERE renders
    expect(settledLength('see [it][x]\n\n[x]: https://example.test\n\nmore')).toBe(UNSPLITTABLE);
    // an element opened in one block and closed in another is one element
    expect(settledLength('<div>\n\ninside\n\n</div>\n\nafter')).toBe(UNSPLITTABLE);
  });

  it('refuses raw HTML at ANY depth, not only a block of it', () => {
    // inside a paragraph: everything after `<details>` is hidden when whole
    expect(settledLength('intro <details>\n\nsecret\n\nmore')).toBe(UNSPLITTABLE);
    expect(settledLength('Use <b>bold\n\nstill bold</b>\n\nend')).toBe(UNSPLITTABLE);
    // inside a list item
    expect(settledLength('- <span>x\n\nafter\n\nend')).toBe(UNSPLITTABLE);
    // ...but an autolink in angle brackets is a link, not markup
    expect(settledLength('see <https://example.test>\n\nnext\n\nend')).toBeGreaterThan(0);
  });

  it('refuses carriage returns, because the lexer`s offsets are then into another string', () => {
    expect(settledLength('one\r\n\r\ntwo\r\n\r\nthree')).toBe(UNSPLITTABLE);
  });
});

/** a reply with one of everything that can be mid-write */
const REPLY = [
  '## A heading',
  'Some **bold** prose with `code` and a [link](https://example.test) in it, long enough to wrap.',
  '- first\n- second with *emphasis*\n- third',
  '1. one\n2. two',
  '```ts\nconst a = 1;\n\nconst b = 2;\n```',
  '> quoted **text**\n> on two lines',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  'Setext\n======',
  '- loose\n\n- list\n\n  with a second paragraph',
  // blocks that run across a blank line, so a blank line must not settle them
  '    indented code\n\n    more of the same block',
  '- item\n\n  its second paragraph\n\n- next item',
  // lines that look like a new block until they finish arriving (see above)
  'see the fix in\n#716 for details',
  'text\n***bold***',
  '- item text\n*emphasised* continuation',
  '- took about\n1.5 seconds',
  '> quote\n*emph* more',
  '| a |\n| - |\n| 1 |\n#5 | x',
  'The end.',
].join('\n\n');

describe('<Markdown streaming> — the same picture', () => {
  it('shows, at EVERY length, what rendering that much of the reply whole would show', () => {
    // Every prefix, in order, through ONE mounted component — which is how a
    // reply actually arrives, and the only way the pieces accumulate.
    let pieces = 0;
    for (let n = 1; n <= REPLY.length; n += 1) {
      const sofar = REPLY.slice(0, n);
      show(<Markdown text={sofar} streaming />);
      const whole = renderMarkdown(completePartialMarkdown(sofar));
      expect(tidy(picture()), `at ${n}: ${JSON.stringify(sofar.slice(-40))}`).toBe(tidy(whole));
      pieces = Math.max(pieces, settledOnes().length);
    }
    // the premise: it really was cut up on the way, or the loop compared a
    // whole render with itself
    expect(pieces).toBeGreaterThan(5);
    // A budget of its own: this is some hundreds of renders and twice as many
    // sanitiser passes under jsdom — half a second alone, and past the default
    // five when the whole suite is competing for the machine.
  }, 60_000);

  it('goes back to ONE container, rendered whole, the moment the turn ends', () => {
    show(<Markdown text={REPLY} streaming />);
    expect(containers().length).toBeGreaterThan(1);
    show(<Markdown text={REPLY} />);
    expect(containers()).toHaveLength(1);
    expect(containers()[0].innerHTML).toBe(renderMarkdown(REPLY));
  });

  it('keeps the "still typing" mark on the tail, and only there', () => {
    show(<Markdown text={'zero\n\none\n\ntwo\n\nthr'} streaming />);
    const all = containers();
    expect(all.length).toBeGreaterThan(1);
    expect(all.map((el) => el.hasAttribute(STREAMING_ATTR))).toEqual([...all.slice(1).map(() => false), true]);
    expect(all[all.length - 1].textContent?.trim()).toBe('thr');
  });

  it('takes its pieces BACK when a definition arrives late, and renders the reply whole', () => {
    // The link is in a stretch that settled before its definition existed. If
    // "whole" only meant "from here on", it would stay literal text until the
    // turn ended — where before there were pieces it linked the frame the
    // definition landed.
    show(<Markdown text={'see [it][x]\n\nmiddle\n\nmore\n'} streaming />);
    // the premise: something had settled
    expect(containers().length).toBeGreaterThan(1);
    expect(host.querySelector('a')).toBeNull();

    show(<Markdown text={'see [it][x]\n\nmiddle\n\nmore\n\n[x]: https://example.test\n\nlast'} streaming />);
    expect(containers()).toHaveLength(1);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test');
  });

  it('does the same for raw HTML that turns up after pieces have settled', () => {
    show(<Markdown text={'one\n\ntwo\n\nthree\n'} streaming />);
    expect(containers().length).toBeGreaterThan(1);
    const text = 'one\n\ntwo\n\nthree\n\nUse <b>bold\n\nstill bold</b>\n\nend';
    show(<Markdown text={text} streaming />);
    expect(containers()).toHaveLength(1);
    expect(tidy(picture())).toBe(tidy(renderMarkdown(completePartialMarkdown(text))));
  });

  it('does not hold one reply`s refusal against the next reply in the same place', () => {
    show(<Markdown text={'<div>\n\nx\n\n</div>\n\nafter\n'} streaming />);
    expect(containers()).toHaveLength(1);
    show(<Markdown text={'alpha\n\nbeta\n\ngamma\n\ndel'} streaming />);
    expect(containers().length).toBeGreaterThan(1);
  });

  it('starts again when the text is REPLACED rather than extended', () => {
    show(<Markdown text={'alpha\n\nbeta\n\ngam'} streaming />);
    expect(host.textContent).toContain('alpha');
    show(<Markdown text={'delta\n\neps'} streaming />);
    expect(host.textContent).not.toContain('alpha');
    expect(tidy(picture())).toBe(tidy(renderMarkdown('delta\n\neps')));
  });

  it('runs the surface pass over every piece — a piece is not a way round it', () => {
    const decorate = vi.fn((html: string) => html.replace(/<p>/g, '<p class="seen">'));
    show(<Markdown text={'one\n\ntwo\n\nthree\n\nfour'} streaming decorate={decorate} />);
    // the premise: there ARE pieces for the pass to have been skipped on
    expect(settledOnes().length).toBeGreaterThan(0);
    expect(host.querySelectorAll('p')).toHaveLength(4);
    expect(host.querySelectorAll('p.seen')).toHaveLength(4);
  });

  it('sanitises every piece — hostile markup in a settled block is as dead as in the tail', () => {
    // Markdown-borne, because raw HTML would (rightly) stop the reply being cut
    // at all and this would then be a test of the whole render.
    show(<Markdown text={'[click](javascript:alert(1)) ![x](javascript:alert(2))\n\nnext\n\nlast\n\nend'} streaming />);
    const first = settledOnes()[0];
    // the premise: the hostile block is in a SETTLED piece
    expect(first?.textContent).toContain('click');
    expect(first.innerHTML).not.toMatch(/javascript:/i);
    expect(host.innerHTML).not.toMatch(/javascript:/i);
  });
});

describe('<Markdown streaming> — less work', () => {
  it('never writes a settled piece to the page a second time', () => {
    // THE claim. React 19 compares `dangerouslySetInnerHTML` by the OBJECT, so
    // an equal string in a fresh `{ __html }` is a changed prop and the whole
    // subtree is rebuilt — which is what was happening to every finished
    // paragraph of a reply, twenty times a second. The node a piece first
    // rendered is the node it still has.
    show(<Markdown text={'first paragraph\n\nsecond paragraph\n\nthi'} streaming />);
    const [first] = settledOnes();
    const paragraph = first.firstChild;
    expect(paragraph?.textContent).toBe('first paragraph');

    for (const more of ['rd', 'rd one', 'rd one\n\nfourth', 'rd one\n\nfourth\n\nfifth and more']) {
      show(<Markdown text={`first paragraph\n\nsecond paragraph\n\nthi${more}`} streaming />);
    }
    expect(settledOnes().length).toBeGreaterThan(2);
    expect(settledOnes()[0]).toBe(first);
    expect(first.firstChild).toBe(paragraph);
  });

  it('does not rewrite the TAIL either when a render changes nothing', () => {
    // A streaming block renders twice per chunk: the text arrives, then the
    // frame that was owed fires. The first of those shows nothing new.
    const text = 'one\n\ntwo wor';
    show(<Markdown text={text} streaming />);
    const tail = containers().find((el) => el.hasAttribute(STREAMING_ATTR))!;
    const node = tail.firstChild;
    show(<Markdown text={text} streaming />);
    expect(tail.firstChild).toBe(node);
  });

  it('parses each settled block ONCE, however long the reply gets', () => {
    const decorate = vi.fn((html: string) => html);
    let text = 'intro';
    show(<Markdown text={text} streaming decorate={decorate} />);
    for (let i = 0; i < 20; i += 1) {
      text += `\n\nparagraph number ${i}`;
      show(<Markdown text={text} streaming decorate={decorate} />);
    }
    // what was handed to the pass: never the whole reply once it had grown
    const longest = Math.max(...decorate.mock.calls.map(([html]) => html.length));
    expect(longest).toBeLessThan(120);
    // ...and each paragraph was handed over on its own exactly TWICE — once as
    // the tail, the chunk it arrived in, and once as the settled piece it then
    // became — however many chunks came after it. Re-rendering a settled piece
    // per chunk would make this 20 for the first paragraph.
    for (const i of [0, 5, 10, 15]) {
      const alone = decorate.mock.calls.filter(([html]) => tidy(html) === `<p>paragraph number ${i}</p>`);
      expect(alone, `paragraph ${i}`).toHaveLength(2);
    }
    expect(tidy(picture())).toBe(tidy(renderMarkdown(text)));
  });
});
