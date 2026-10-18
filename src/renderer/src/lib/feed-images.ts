// Pictures in the conversation (#1235).
//
// The owner: "I want the ability to show images in the session. For example,
// if I ask Claude to mock something up, it can show it to me right in the
// session." Until this, nothing was ever drawn: a reply's `![mock](mock.svg)`
// reached the page as a bare `<img>` whose source resolved against the app's
// own origin, and showed the broken-picture glyph.
//
// THIS IS THE DOCUMENT VIEWER'S MACHINERY (#1080), NOT A SECOND ONE. A local
// picture is a NEW `<img>` pointing at the one scheme main answers, and main
// answers it only for a file the read scope allows (`main/fs/doc-image.ts`).
// Everything else is a chip. So:
//
//   - a picture by PATH, relative to the session's folder or absolute: shown;
//   - SVG: shown, and only ever through `<img>`, where it cannot run script.
//     This is what makes "mock it up" work, because an agent cannot paint a
//     PNG but writes SVG happily;
//   - a REMOTE picture: a chip, never fetched. Fetching one is a beacon;
//   - a picture that will not load (missing, too large, outside the folders
//     switchboard may read): the same chip, saying so, never a broken glyph.
//
// EVERY PICTURE IS A BUTTON. It is capped in height so one screenshot cannot
// take over the conversation, so there has to be a way to see all of it, and
// that way has to work from the keyboard: the picture sits in a `<button>`
// that opens the file in whatever the system uses for it.
//
// AN HTML MOCKUP IS SHOWN AS A PICTURE OF THE PAGE (#1239), never as the page.
// The conversation has no frames, and the owner kept that rule when he was
// offered a live one: "I like the rule for now, so maybe we just do pictures
// of mockups." So a picture reference or a link to a local `.html` file gets
// an `<img>` like any other, pointing at the same scheme, and MAIN draws the
// page (scripts off, no network: `main/fs/page-snapshot.ts`) and answers with
// a PNG. The picture is a button that opens the real page, and a line under
// it says what it is: a picture, of the page as it is now.
//
// A PAGE THE SESSION WROTE, NAMED IN CODE TYPE (#1278), is drawn the same
// way. #1239 drew a page only under a link or a picture reference to it, and
// that is not how Claude hands one over: asked for "an HTML mock-up of a login
// screen", it writes the file with the Write tool and ends with "The file is
// saved at `C:\work\login.html`", or names it bare (`multi-ai.html`) beside
// the folder it is in. No link, so no picture, and what was on screen was the
// Write step's box: the page's source. So a code span that names a page THIS
// CONVERSATION WROTE OR EDITED (`writtenPages`) is drawn under the words it is
// in. Only those: a reply that mentions `index.html` in passing, in a project
// with one, is not asking for a picture of it.
//
// WHILE A REPLY IS STILL ARRIVING, every picture is a chip. The tail of a
// streaming reply is re-rendered on each chunk, and main serves pictures
// `no-store`: an `<img>` there would be re-fetched per chunk.
import { PAGE_SHOT_HEIGHT, PAGE_SHOT_WIDTH, docImagePath, docImageUrl, isPageFile } from '../../../shared/doc-image';
import { classifyHref, isAbsolutePath, resolveRelativePath } from './document-link';
import type { FeedBlockDto } from './feed';
import { decorateImages, imageChip, type DecorationLabels } from './document-render';

/** The attribute that says "a click here opens this local file". Ours: the
 *  feed's namespace is stripped from a reply before this pass writes it. */
export const FEED_OPEN_PATH_ATTR = 'data-feed-open-path';

/** How tall a picture may be drawn in the conversation, in px. The stylesheet
 *  carries the same number as its backstop (`.feed-md .doc-image`). */
export const FEED_IMAGE_MAX_HEIGHT = 420;

/**
 * How many pages one reply may have drawn (#1239). Each is a window opened in
 * main, and a reply that lists every page of a site is a list, not a gallery:
 * the rest stay what they were, a link or a chip that opens the page.
 */
export const MAX_PAGE_SHOTS_PER_REPLY = 2;

/**
 * Fit a picture whose size is KNOWN under the height cap, by its attributes.
 *
 * The viewer's machinery writes `width` and `height` onto a picture it has
 * seen before, so the room is there before the bytes are. Those are the
 * picture's own pixels, and a 900-pixel-tall screenshot would then reserve
 * 900 and be squashed to the cap by the stylesheet. Scaling BOTH attributes
 * keeps the shape, reserves exactly what will be drawn, and needs no inline
 * style. A picture never seen has no attributes; the stylesheet's two caps
 * scale it in proportion once it loads, and this is then called on it.
 */
export function capFeedImage(img: Element | null): void {
  if (!img) return;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  if (!(w > 0) || !(h > FEED_IMAGE_MAX_HEIGHT)) return;
  img.setAttribute('width', String(Math.max(1, Math.round((w * FEED_IMAGE_MAX_HEIGHT) / h))));
  img.setAttribute('height', String(FEED_IMAGE_MAX_HEIGHT));
}

/** THE CONVERSATION IS ONE TAB STOP (`lib/feed-keys`): a control inside it is
 *  reached with the arrow keys, and must not claim a Tab stop of its own. */
function arrowStop(el: Element): void {
  el.setAttribute('tabindex', '-1');
}

export interface FeedImageLabels extends DecorationLabels {
  /** "Open {name} at full size" — the picture button's accessible name */
  openPicture: (name: string) => string;
  /** "Open in browser", on a local HTML file */
  openPage: string;
  /** why a picture that would not load is a chip */
  notShown: string;
  /** "Open {name} in your browser" — the accessible name of a page's picture */
  openPageNamed: (name: string) => string;
  /** "A picture of the page {name}" — the text alternative of a page's picture */
  pagePicture: (name: string) => string;
  /** the line under a page's picture: what it is, and what it leaves out */
  pageNote: string;
}

/** A file standing in for "somewhere in this folder", for `classifyHref`,
 *  which resolves against the directory of the file a link is IN. */
function insideFolder(folder: string): string {
  const sep = folder.includes('\\') && !folder.startsWith('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}reply`;
}

/**
 * Turn a reply's pictures into shown pictures or chips, and mark its links to
 * local HTML files as openable.
 *
 * `folder` is the session's working folder: what a relative path in a reply is
 * relative to. Without one (a caller that was not told, or `streaming`), every
 * picture is a chip — the safe reading of "I do not know where this is".
 *
 * `pages` is the pages this conversation wrote or edited (`writtenPages`), and
 * `at` the place of this reply in it: the only pages a code span may have
 * drawn are ones written in this reply's own turn, before it (#1278).
 */
export function decorateFeedImages(
  root: ParentNode,
  labels: FeedImageLabels,
  {
    folder,
    streaming = false,
    pages,
    at,
  }: { folder?: string; streaming?: boolean; pages?: readonly WrittenPage[]; at?: number }
): void {
  const from = folder && !streaming ? insideFolder(folder) : undefined;
  const classify = from ? (href: string | null) => localTarget(href, from) : undefined;
  decorateImages(root, labels, classify);
  if (!from) return;

  // every picture we decided to show becomes the content of a button
  for (const img of [...root.querySelectorAll('img.doc-image')]) {
    const path = docImagePath(img.getAttribute('src'));
    if (!path) continue;
    const doc = img.ownerDocument;
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'feed-image-open';
    open.setAttribute(FEED_OPEN_PATH_ATTR, path);
    const name = (img.getAttribute('alt') ?? '').trim() || fileName(path);
    open.setAttribute('aria-label', labels.openPicture(name));
    open.setAttribute('title', labels.openPicture(name));
    arrowStop(open);
    img.replaceWith(open);
    open.append(img);
    capFeedImage(img);
  }
  // (a remote picture's "Open in browser", written by the viewer's pass)
  for (const external of [...root.querySelectorAll('button[data-doc-external]')]) arrowStop(external);

  // A LOCAL HTML FILE (#1239). Written with picture syntax it is a chip by
  // now; written as a link it is a link that goes nowhere (a reply's relative
  // href is refused by the link guard). Either way it can be opened, and the
  // first few in a reply are drawn: each page once, however often it is named.
  const drawn = new Set<string>();
  const draw = (target: string): boolean => {
    if (drawn.has(target) || drawn.size >= MAX_PAGE_SHOTS_PER_REPLY) return false;
    drawn.add(target);
    return true;
  };
  // ONE pass, in the order the reply reads, so "the first few" means that.
  for (const el of [...root.querySelectorAll('.doc-image-chip, a[href], code')]) {
    if (el.nodeName === 'CODE') {
      // inline code only: a fence's `<pre><code>` is code someone is reading,
      // and code inside a link is the link's, which this pass reads already
      if (el.parentElement?.nodeName === 'PRE' || el.closest('a')) continue;
      const target = pageNamedInCode(el.textContent ?? '', from, pages, at);
      if (!target || !draw(target)) continue;
      // a picture that fails just goes, as under a link: the words that named
      // the page are still there
      placeUnder(el, pageShot(el.ownerDocument, target, '', labels, true));
      continue;
    }
    if (el.nodeName !== 'A') {
      const target = localHtml(el.getAttribute('title'), from);
      if (!target) continue;
      if (draw(target)) {
        const alt = el.querySelector('.doc-image-name')?.textContent ?? '';
        el.replaceWith(pageShot(el.ownerDocument, target, alt, labels, false));
      } else {
        el.append(openPageButton(el.ownerDocument, target, labels));
      }
      continue;
    }
    const target = localHtml(el.getAttribute('href'), from);
    if (!target) continue;
    el.setAttribute(FEED_OPEN_PATH_ATTR, target);
    el.setAttribute('title', `${labels.openPage}: ${target}`);
    if (!draw(target)) continue;
    placeUnder(el, pageShot(el.ownerDocument, target, '', labels, true));
  }
}

/**
 * Put a page's picture UNDER the words `el` is in, not in the middle of them.
 * After a paragraph or a heading; at the end of anything else that holds text
 * (a list item, a table cell), where a sibling would not be valid.
 */
function placeUnder(el: Element, shot: HTMLElement): void {
  const block = el.closest('p, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6');
  if (!block) el.after(shot);
  else if (/^(P|H[1-6])$/.test(block.nodeName)) block.after(shot);
  else block.append(shot);
}

/** Longer than this, a code span is not a path somebody typed into a sentence. */
const MAX_CODE_PATH = 1024;

/**
 * One page the conversation wrote or edited, in one turn (#1278): its path as
 * the tool step spelled it, the `seq` of the LAST step in that turn that wrote
 * it, and the `seq` of the prompt that ended the turn (`Infinity` while it is
 * the turn in progress). A reply at `at` may have it drawn when
 * `seq < at < until`: after it was written, and before you spoke again.
 */
export interface WrittenPage {
  readonly path: string;
  readonly seq: number;
  readonly until: number;
}

/** Is this a Windows path, where `Login.html` and `login.html` are one file? */
function windowsPath(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.includes(String.fromCharCode(92));
}

/** a path, for comparing: forward slashes, no `./` in front */
function slashed(p: string): string {
  return p.split(String.fromCharCode(92)).join('/').replace(/^(\.\/)+/, '');
}

/**
 * The page this conversation wrote that a code span names, or null (#1278).
 *
 * THE SPAN IS NOT TRUSTED TO BE A PATH: it is matched against `pages`, which
 * come from the session's own Write and Edit steps, and only a match is drawn.
 * An absolute path must be one of them exactly. A relative one may be spelled
 * from the session's folder, or be the END of one of them, whole segments
 * only: `multi-ai.html` names `C:\p\mockups\multi-ai.html`, and `ai.html` does
 * not. Main still decides whether the file may be read; this only decides
 * whether to ask.
 *
 * ONLY IN THE TURN THAT WROTE IT, and only after the write (`WrittenPage`).
 * "I'll put the mock-up in `login.html`" said BEFORE the Write is not drawn,
 * and neither is every later reply that happens to name the page: in a web
 * project that is `index.html` under half the conversation. Two pages that
 * end the same way: the one written most recently. Case is ignored for a
 * Windows path only, where the agent may spell one either way.
 */
export function pageNamedInCode(
  text: string,
  from: string,
  pages: readonly WrittenPage[] | undefined,
  at: number | undefined
): string | null {
  if (!pages || pages.length === 0 || at === undefined) return null;
  const named = text.trim();
  if (named.length === 0 || named.length > MAX_CODE_PATH || /[\r\n]/.test(named) || !isPageFile(named)) return null;
  const exact = slashed(resolveRelativePath(from, named));
  const tail = isAbsolutePath(named) ? null : `/${slashed(named)}`;
  let best: WrittenPage | null = null;
  for (const page of pages) {
    if (!(page.seq < at && at < page.until) || (best && best.seq > page.seq)) continue;
    const fold = windowsPath(page.path) ? (s: string) => s.toLowerCase() : (s: string) => s;
    const key = fold(slashed(page.path));
    if (key === fold(exact) || (tail !== null && key.endsWith(fold(tail)))) best = page;
  }
  return best?.path ?? null;
}

/**
 * The pages this conversation wrote or edited, one entry per page per turn
 * (#1278): the files of its finished, successful Write and Edit steps that are
 * web pages by name. What `pageNamedInCode` may draw. A turn ends at the next
 * prompt of the main conversation (a subagent's prompt does not end yours).
 * A prompt you send while the session is still working ends it too, on
 * purpose: what comes after it answers you, and is not that answer.
 *
 * A NETWORK PATH (`\\host\share\x.html`) is left out: the conversation never
 * asks main for one (`localTarget`), so neither does this.
 */
export function writtenPages(blocks: readonly FeedBlockDto[]): WrittenPage[] {
  const out: Array<{ path: string; seq: number; until: number }> = [];
  let open = new Map<string, { path: string; seq: number; until: number }>();
  for (const b of blocks) {
    if (b.kind === 'user' && !b.sidechain) {
      for (const page of open.values()) page.until = b.seq;
      open = new Map();
      continue;
    }
    const tool = b.tool;
    if (b.kind !== 'tool' || !tool || tool.category !== 'edit' || tool.failed === true || tool.out === undefined) continue;
    const file = tool.editPath ?? tool.filePath;
    if (!file || !isAbsolutePath(file) || /^[\\/]{2}/.test(file) || /[\r\n]/.test(file) || file.includes(FIELD) || file.includes(PAGE) || !isPageFile(file)) continue;
    const key = windowsPath(file) ? slashed(file).toLowerCase() : slashed(file);
    const same = open.get(key);
    if (same) {
      same.seq = b.seq;
      same.path = file;
      continue;
    }
    const page = { path: file, seq: b.seq, until: Infinity };
    open.set(key, page);
    out.push(page);
  }
  return out;
}

// What no path holds: NUL between the fields, SOH between the pages.
const FIELD = String.fromCharCode(0);
const PAGE = String.fromCharCode(1);

/**
 * `writtenPages` as ONE string, and back (#1278). The conversation keys what
 * every reply is told on this, so the reply is told again when a page is
 * written or a turn ends, and not on every chunk of a streaming reply, which
 * hands the conversation a new list of blocks each time.
 */
export function writtenPagesKey(pages: readonly WrittenPage[]): string {
  return pages.map((p) => [p.seq, p.until === Infinity ? '' : p.until, p.path].join(FIELD)).join(PAGE);
}

export function writtenPagesFromKey(key: string): WrittenPage[] {
  if (key === '') return [];
  return key.split(PAGE).map((entry) => {
    const [seq, until, ...rest] = entry.split(FIELD);
    return { seq: Number(seq), until: until === '' ? Infinity : Number(until), path: rest.join(FIELD) };
  });
}

/** the "Open in browser" on a chip for a local page */
function openPageButton(doc: Document, target: string, labels: FeedImageLabels): HTMLElement {
  const open = doc.createElement('button');
  open.type = 'button';
  open.className = 'doc-image-open';
  open.textContent = labels.openPage;
  open.setAttribute(FEED_OPEN_PATH_ATTR, target);
  arrowStop(open);
  return open;
}

/**
 * A picture of the page at `target`, as a button that opens the page, with
 * the line that says what it is.
 *
 * ITS SIZE IS KNOWN BEFORE IT EXISTS: main draws every page at one size
 * (`PAGE_SHOT_WIDTH` x `PAGE_SHOT_HEIGHT`), so the room is reserved from the
 * first render and a picture that takes a second to draw moves nothing.
 *
 * `linked` says the reply's own link is still there above it. If the picture
 * then fails, it just goes: the link already says everything a chip would.
 */
function pageShot(
  doc: Document,
  target: string,
  alt: string,
  labels: FeedImageLabels,
  linked: boolean
): HTMLElement {
  const name = fileName(target);
  const holder = doc.createElement('span');
  holder.className = linked ? 'feed-page-shot feed-page-shot-linked' : 'feed-page-shot';
  const open = doc.createElement('button');
  open.type = 'button';
  open.className = 'feed-image-open';
  open.setAttribute(FEED_OPEN_PATH_ATTR, target);
  open.setAttribute('aria-label', labels.openPageNamed(name));
  open.setAttribute('title', labels.openPageNamed(name));
  arrowStop(open);
  const img = doc.createElement('img');
  img.className = 'doc-image feed-page-image';
  img.setAttribute('src', docImageUrl(target));
  img.setAttribute('alt', alt.trim() && alt.trim() !== name ? alt.trim() : labels.pagePicture(name));
  img.setAttribute('data-doc-image-src', target);
  img.setAttribute('width', String(PAGE_SHOT_WIDTH));
  img.setAttribute('height', String(PAGE_SHOT_HEIGHT));
  capFeedImage(img);
  open.append(img);
  const note = doc.createElement('span');
  note.className = 'feed-page-note';
  note.textContent = labels.pageNote;
  holder.append(open, note);
  return holder;
}

/**
 * Where a reply's href points, for this pass: a local path, or not.
 *
 * `//host/share/a.png` AND `\\host\share\a.png` ARE NOT LOCAL. The link
 * classifier reads a leading double slash as an absolute path, which for a
 * document on disk is fair; in a reply it is a network address an agent (or
 * whatever the agent read) chose, and asking main for it would be a request
 * to another machine. Main refuses a UNC path outside its roots as well; this
 * does not rely on that.
 */
function localTarget(href: string | null, from: string): { kind: string; target: string } {
  if (typeof href === 'string' && /^\s*[\\/]{2}/.test(href)) return { kind: 'blocked', target: '' };
  return classifyHref(href, from);
}

/** the absolute path of a local `.html` file this href names, or null */
function localHtml(href: string | null, from: string): string | null {
  const where = localTarget(href, from);
  return where.kind === 'relative' && isPageFile(where.target) ? where.target : null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * A picture we offered did not load: swap its button for a chip that says so.
 *
 * Main knows which reason it was (missing, too large, outside the read scope,
 * not really a picture) and writes it to its log; an `<img>` is told only
 * that it failed. So the chip names the file and lists what it can be, rather
 * than guessing one. Answers false for anything that is not one of ours.
 */
export function chipForFailedFeedImage(target: EventTarget | null, labels: FeedImageLabels): boolean {
  const img = target as HTMLElement | null;
  if (!img || img.nodeName !== 'IMG' || !img.classList?.contains('doc-image')) return false;
  const src = img.getAttribute('data-doc-image-src') ?? '';
  // A picture of a PAGE that main could not draw (#1239). The page may well
  // be there (it took too long, or it is outside what the app may read), so
  // what is left is what there was before pages were drawn: the reply's own
  // link, or a chip that offers to open the page. Main decides whether it can.
  const page = img.closest('.feed-page-shot');
  if (page) {
    if (page.classList.contains('feed-page-shot-linked')) {
      page.remove();
      return true;
    }
    const chip = imageChip(img.ownerDocument, src, fileName(src), labels);
    chip.append(openPageButton(img.ownerDocument, src, labels));
    page.replaceWith(chip);
    return true;
  }
  const chip = imageChip(img.ownerDocument, src, img.getAttribute('alt') ?? '', labels);
  chip.setAttribute('title', `${labels.notShown} ${src}`.trim());
  const why = img.ownerDocument.createElement('span');
  why.className = 'feed-image-why';
  why.textContent = labels.notShown;
  chip.append(why);
  // the button around it goes too: it would open a file that did not load
  const holder = img.closest('.feed-image-open') ?? img;
  holder.replaceWith(chip);
  return true;
}
