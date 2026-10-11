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
// AN HTML MOCKUP IS NOT DRAWN HERE, and that is a decision, not an oversight:
// the conversation has no frames and should not gain one casually. A link or
// picture reference to a local `.html` file gets an "Open in browser" action
// instead. Drawing a snapshot of the page inline is its own ticket.
//
// WHILE A REPLY IS STILL ARRIVING, every picture is a chip. The tail of a
// streaming reply is re-rendered on each chunk, and main serves pictures
// `no-store`: an `<img>` there would be re-fetched per chunk.
import { docImagePath } from '../../../shared/doc-image';
import { classifyHref } from './document-link';
import { decorateImages, imageChip, type DecorationLabels } from './document-render';

/** The attribute that says "a click here opens this local file". Ours: the
 *  feed's namespace is stripped from a reply before this pass writes it. */
export const FEED_OPEN_PATH_ATTR = 'data-feed-open-path';

/** How tall a picture may be drawn in the conversation, in px. The stylesheet
 *  carries the same number as its backstop (`.feed-md .doc-image`). */
export const FEED_IMAGE_MAX_HEIGHT = 420;

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
}

const HTML_FILE_RE = /\.html?$/i;

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
 */
export function decorateFeedImages(
  root: ParentNode,
  labels: FeedImageLabels,
  { folder, streaming = false }: { folder?: string; streaming?: boolean }
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

  // a chip for a local HTML file (written with picture syntax) can be opened
  for (const chip of [...root.querySelectorAll('.doc-image-chip')]) {
    const target = localHtml(chip.getAttribute('title'), from);
    if (!target) continue;
    const open = chip.ownerDocument.createElement('button');
    open.type = 'button';
    open.className = 'doc-image-open';
    open.textContent = labels.openPage;
    open.setAttribute(FEED_OPEN_PATH_ATTR, target);
    arrowStop(open);
    chip.append(open);
  }

  // ...and so can a plain link to one, which is otherwise a link that goes
  // nowhere: a reply's relative href is refused by the link guard
  for (const a of [...root.querySelectorAll('a[href]')]) {
    const target = localHtml(a.getAttribute('href'), from);
    if (!target) continue;
    a.setAttribute(FEED_OPEN_PATH_ATTR, target);
    a.setAttribute('title', `${labels.openPage}: ${target}`);
  }
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
  return where.kind === 'relative' && HTML_FILE_RE.test(where.target) ? where.target : null;
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
