// @vitest-environment jsdom
// The shared markdown path (P2-E16-01, §5.30 + §5.29).
//
// Two things are under test and they are different kinds of thing:
//
//  1. THE PIPELINE IS SINGULAR. §5.30 makes "one renderer, one sanitizer
//     configuration" a requirement rather than a preference, because two
//     pipelines drift and the security configuration drifts with them. A
//     comment cannot hold that; the last test in this file reads the source
//     tree and does.
//  2. THE SANITIZER ACTUALLY REFUSES. The viewer renders bytes we did not
//     write — a repository can contain hostile markdown, and an agent can be
//     talked into writing some. So the hostile input here is real markup with
//     real payloads, not a smoke test. It lives INSIDE this fixture: nothing in
//     this file touches a path outside the repo.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CSP_DEV, CSP_PROD } from '../../../shared/csp';
import { Markdown, MARKED_OPTIONS, renderMarkdown, STREAMING_CARET } from './markdown';

describe('renderMarkdown — the one pipeline', () => {
  it('renders ordinary markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders GFM: tables, task lists, strikethrough, autolinks', () => {
    // What agents actually emit. `gfm` is marked's default, which is exactly
    // why it is pinned: a default is not a decision until something asserts it.
    const html = renderMarkdown(
      ['| a | b |', '| - | - |', '| 1 | 2 |', '', '- [ ] todo', '- [x] done', '', '~~gone~~'].join(
        '\n'
      )
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>gone</del>');
  });

  it('does not turn a single newline into a <br> (breaks: false)', () => {
    // A hard-wrapped paragraph — every plan file in this repo is one — must not
    // render as a ladder of short lines.
    expect(renderMarkdown('one\ntwo')).not.toContain('<br');
    expect(MARKED_OPTIONS.breaks).toBe(false);
  });

  it('parses synchronously — useMemo cannot await', () => {
    expect(MARKED_OPTIONS.async).toBe(false);
    expect(typeof renderMarkdown('x')).toBe('string');
  });
});

describe('the sanitizer, on input we did not write (§5.29)', () => {
  // Each case is [what it is, the markdown, what must NOT survive]. Table-driven
  // so adding the next hostile shape is one line rather than a new test.
  const hostile: Array<[string, string, RegExp]> = [
    ['a raw script tag', 'before\n\n<script>globalThis.__pwned = 1;</script>\n\nafter', /<script/i],
    [
      'an onerror handler on an image',
      '<img src="x" onerror="globalThis.__pwned = 1">',
      /onerror/i,
    ],
    ['an onload handler on a body tag', '<body onload="globalThis.__pwned = 1">', /onload/i],
    ['a javascript: link', '[click me](javascript:globalThis.__pwned=1)', /javascript:/i],
    [
      'a javascript: link in raw HTML',
      '<a href="javascript:globalThis.__pwned=1">click me</a>',
      /javascript:/i,
    ],
    [
      'an inline SVG with a script payload',
      '<svg><script>globalThis.__pwned = 1;</script></svg>',
      /<svg|<script/i,
    ],
    [
      'an inline SVG with an onload handler',
      '<svg onload="globalThis.__pwned = 1"><circle r="9"/></svg>',
      /<svg|onload/i,
    ],
    ['an iframe', '<iframe src="https://example.invalid"></iframe>', /<iframe/i],
    ['an object tag', '<object data="x.swf"></object>', /<object/i],
    ['a base tag that would re-point every relative link', '<base href="https://example.invalid/">', /<base/i],
    ['an animated SVG attribute-setter', '<svg><set attributeName="href" to="javascript:1"/></svg>', /<svg|<set/i],
  ];

  for (const [what, markdown, forbidden] of hostile) {
    it(`strips ${what}`, () => {
      const html = renderMarkdown(markdown);
      expect(html).not.toMatch(forbidden);
    });
  }

  it('leaves the surrounding prose intact — it sanitizes, it does not blank', () => {
    // The failure mode worth naming: a sanitizer that answered '' for anything
    // suspicious would pass every test above and render nothing all day.
    const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('an inert payload is inert once it is in the DOM, not just in the string', () => {
    // The string assertions above are about text; this one mounts it. If the
    // sanitizer ever let a handler through, the flag is the proof.
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = renderMarkdown('<img src="does-not-exist" onerror="globalThis.__pwned = 1">');
    const img = host.querySelector('img');
    img?.dispatchEvent(new Event('error'));
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    host.remove();
  });

  it('a <form> survives the sanitizer, and the CSP is what makes that safe', () => {
    // DOMPurify keeps forms — they are ordinary HTML and it strips the parts
    // that execute. Recorded here rather than papered over with a FORBID_TAGS
    // entry, because the layer that actually stops a markdown file from posting
    // your clipboard somewhere is `form-action 'none'` in the policy, and that
    // is the line worth pinning. If it ever leaves the CSP, this goes red.
    expect(renderMarkdown('<form action="https://example.invalid"><input></form>')).toContain(
      '<form'
    );
    expect(CSP_PROD).toContain("form-action 'none'");
    expect(CSP_DEV).toContain("form-action 'none'");
  });

  it('keeps ordinary links and images — the allow-list is not a deny-all', () => {
    const html = renderMarkdown('[docs](https://example.invalid/x) and ![pic](./local.png)');
    expect(html).toContain('href="https://example.invalid/x"');
    expect(html).toContain('src="./local.png"');
  });
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

describe('<Markdown>', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  const mount = (el: React.ReactElement): HTMLDivElement => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  };

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it('renders through the shared pipeline, in the feed class by default', () => {
    const el = mount(<Markdown text="**hi**" />);
    const div = el.querySelector('.feed-md');
    expect(div?.innerHTML).toContain('<strong>hi</strong>');
  });

  it('takes another surface class without forking the pipeline', () => {
    const el = mount(<Markdown text="# h" className="doc-md" />);
    expect(el.querySelector('.doc-md')).not.toBeNull();
    expect(el.querySelector('.feed-md')).toBeNull();
  });

  it('while STREAMING it is plain text plus the caret — no markdown at all', () => {
    // P2-E18-10: half a document is not a document, and re-parsing per token is
    // quadratic in the length of the reply.
    const el = mount(<Markdown text="**not bold yet" streaming />);
    expect(el.querySelector('strong')).toBeNull();
    expect(el.textContent).toContain('**not bold yet');
    expect(el.textContent).toContain(STREAMING_CARET);
  });

  it('a streamed chunk cannot inject markup either', () => {
    const el = mount(<Markdown text="<script>globalThis.__pwned = 1;</script>" streaming />);
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>');
  });
});

describe('there is exactly one markdown pipeline', () => {
  it('no other production file imports marked or dompurify', () => {
    // §5.30 states the shared renderer as a REQUIREMENT: "The viewer uses the
    // same module and the same sanitizer configuration — stated as a
    // requirement because two pipelines would drift, and the security
    // configuration would drift with them." This test is that sentence,
    // enforced. Modelled on `shared/ipc/refusal.test.ts`'s brand-uniqueness
    // check, which reads source rather than trusting a comment.
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        // Any spelling that reaches either library: `from '…'`, a double-quoted
        // import, `require('…')`, a dynamic `import('…')`. A test whose whole
        // job is "there is exactly one pipeline" should not be defeated by a
        // quote character.
        if (/['"](marked|dompurify)['"]/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(['renderer/src/lib/markdown.tsx']);
  });
});
