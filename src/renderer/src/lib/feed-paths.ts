// A file path the AI wrote becomes something you can click (#1611).
//
// Dan, 2026-11-14: "When you, in your session, print out a path ... I want to
// be able to click on that path: if it's a Markdown file, open it, or if it's
// any other kind of file, just click it and it opens in whatever external app
// is associated with it."
//
// THIS FILE DECIDES WHAT TO OFFER, AND NOTHING ELSE. It finds the paths in a
// reply (inline code, plain prose, and links whose href is a local path),
// resolves the relative ones against the session's folder, and marks the ones
// MAIN HAS ALREADY SAID ARE THERE (`link-path-cache.ts`). What a click does is
// main's decision, made again on the real path (`fs:openFromReply`): a program
// or a script is never run, only shown in its folder.
//
// CONSERVATIVE IN PROSE. A sentence is full of things with a dot or a slash in
// them ("e.g.", "and/or", "v0.8.142", "Node.js"). A word is only asked about
// when it has a separator, or a real extension (two characters at least, one
// of them a letter); and nothing is drawn as a link until main has found a
// file or a folder there, so a false guess costs one lookup and is never seen.
//
// NOT INSIDE A FENCE. A `<pre>` is code someone is reading; its paths are the
// code's, and a link in the middle of it would get in the way of selecting it.
import { classifyHref, resolveRelativePath } from './document-link';
import type { KnownKind } from './link-path-cache';
import { isMarkdownFile, isRunnableFile } from '../../../shared/runnable-file';

/** The absolute path a click opens. Ours: the feed's namespace is stripped first. */
export const FEED_PATH_ATTR = 'data-feed-path';
/** 'file' or 'dir', as main answered when the link was drawn. */
export const FEED_PATH_KIND_ATTR = 'data-feed-path-kind';

/** The most distinct paths one reply asks about. A file listing is a list, not links. */
export const MAX_PATHS_PER_REPLY = 100;

/** Longer than this, a code span is not a path somebody typed into a sentence. */
const MAX_PATH_CHARS = 1024;

export interface FeedPathLabels {
  /** "Open {name}" — an ordinary file */
  open: (name: string) => string;
  /** "Open {name} in the document viewer" — Markdown */
  openInViewer: (name: string) => string;
  /** "Open the folder {name}" */
  openFolder: (name: string) => string;
  /** "Show {name} in its folder…" — a program or a script */
  showInFolder: (name: string) => string;
}

/** A path as a reply spelled it, cleaned for the lookup. */
export interface PathCandidate {
  /** the path, without quotes, trailing punctuation or a `:line` suffix */
  readonly path: string;
  /** the line a `:42` suffix named, when there was one */
  readonly line?: number;
}

// What no file name holds on Windows, and what no sentence-path holds anywhere.
const NEVER_IN_A_PATH = /[<>|*?"]/;
/** a control character: never in a path a reply means */
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32);
// `:42`, `:42:7`, `:42-50`, `#L42`, `#L42-L50`
const LINE_SUFFIX = /(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/;
// What a sentence puts after a path: `see foo.md.` `(in a/b.ts)` `"x.md",`
const TRAILING_PUNCT = /[.,;:!?)\]}>'"`\u2019\u201d]+$/;
const LEADING_PUNCT = /^[([{<'"`\u2018\u201c]+/;

/** Does the last segment of `p` carry an extension (or is it a dotfile)? */
function hasExtension(p: string, prose: boolean): boolean {
  const name = p.split(/[\\/]/).pop() ?? '';
  // a dotfile: `.env`, `.gitignore`
  if (/^\.[A-Za-z][\w.-]*$/.test(name)) return true;
  const m = /^[^.].*\.([\w-]{1,12})$/.exec(name);
  if (!m) return false;
  const ext = m[1];
  if (!/[A-Za-z]/.test(ext)) return false; // `v1.2`, `0.8.142`
  return prose ? ext.length >= 2 : true; // "e.g" in a sentence is not a file
}

/**
 * The path in `raw`, or null when it does not look like one.
 *
 * `prose` is the stricter reading, for a word in a sentence: no spaces, and
 * the punctuation a sentence wraps a word in is taken off. A code span may
 * hold spaces (`C:\Program Files\x.txt`) and is trimmed of quotes only.
 */
export function pathFromText(raw: string, prose: boolean): PathCandidate | null {
  let s = raw.trim();
  if (s.length === 0 || s.length > MAX_PATH_CHARS || /[\r\n]/.test(s)) return null;
  if (prose) {
    s = s.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
  } else {
    // a code span of a QUOTED path: `"C:\My Docs\a.md"`
    const q = /^(["'])(.*)\1$/.exec(s);
    if (q) s = q[2].trim();
    s = s.replace(/[.,;:]+$/, '');
  }
  let line: number | undefined;
  const suffix = LINE_SUFFIX.exec(s);
  if (suffix && suffix.index > 0) {
    line = Number(suffix[1] ?? suffix[2]);
    s = s.slice(0, suffix.index);
  }
  // a folder named with its separator on the end: `.claude/work_files/`, `docs/`.
  // The separator still counts as one: it is what says "a folder".
  const separated = /[\\/]/.test(s);
  if (s.length > 1) s = s.replace(/(?<=[^\\/:])[\\/]+$/, '');
  if (s.length === 0 || NEVER_IN_A_PATH.test(s) || hasControl(s)) return null;
  if (prose && /\s/.test(s)) return null;
  // a web address, an email, a home-relative path (the renderer does not know
  // where home is), another machine's share
  if (/^[a-zA-Z][\w+.-]+:/.test(s) || s.includes('://')) return null;
  if (s.startsWith('~') || /^[\\/]{2}/.test(s)) return null;
  if (prose && /^[^\\/]*@/.test(s)) return null;
  // a drive or a root on its own is not something a reply hands over
  if (/^([a-zA-Z]:)?[\\/]?$/.test(s) || /^\.{1,2}[\\/]?$/.test(s)) return null;
  if (!separated && !hasExtension(s, prose)) return null;
  // `and/or`, `1/2`: a separator, but nothing that names a file or a folder
  if (separated && !/[A-Za-z]/.test(s)) return null;
  return line === undefined ? { path: s } : { path: s, line };
}

/** A file standing in for "somewhere in this folder", for the resolvers. */
function insideFolder(folder: string): string {
  const sep = folder.includes('\\') && !folder.startsWith('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}reply`;
}

/**
 * `p`, absolute, in the folder's own spelling: a relative path joined to the
 * session's folder, an absolute one only normalised (`C:/a/b` → `C:\a\b`).
 */
export function resolveFeedPath(p: string, folder: string): string {
  return resolveRelativePath(insideFolder(folder), p);
}

/** The name a link is called by: the last segment. */
function nameOf(abs: string): string {
  return abs.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? abs;
}

/** What a click on this path will do, in words: the link's title. */
export function pathLinkTitle(abs: string, kind: 'file' | 'dir', labels: FeedPathLabels): string {
  const name = nameOf(abs);
  if (isRunnableFile(abs)) return labels.showInFolder(name);
  if (kind === 'dir') return labels.openFolder(name);
  if (isMarkdownFile(abs)) return labels.openInViewer(name);
  return labels.open(name);
}

/** Mark `el` as a link to `abs`. THE CONVERSATION IS ONE TAB STOP: arrow keys reach it. */
function markLink(el: Element, abs: string, kind: 'file' | 'dir', labels: FeedPathLabels): void {
  el.setAttribute(FEED_PATH_ATTR, abs);
  el.setAttribute(FEED_PATH_KIND_ATTR, kind);
  el.setAttribute('title', pathLinkTitle(abs, kind, labels));
  el.setAttribute('tabindex', '-1');
}

function linkSpan(doc: Document, abs: string, kind: 'file' | 'dir', labels: FeedPathLabels): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'feed-path';
  span.setAttribute('role', 'link');
  markLink(span, abs, kind, labels);
  return span;
}

export interface DecorateFeedPathsOptions {
  /** the session's folder: what a relative path is relative to */
  readonly folder: string;
  readonly labels: FeedPathLabels;
  /** what main has said about an absolute path (the cache), synchronously */
  readonly known: (abs: string) => KnownKind | undefined;
}

// Where a word in a sentence is never a path to linkify: code (handled on its
// own), a link (the href decides), our controls, and the picture pass's work.
const NOT_PROSE = 'pre, code, a, button, [role="link"], .doc-image-chip, .feed-page-shot';

/**
 * Mark the paths in a reply that main says are files or folders, and answer
 * every path it NAMED (absolute, de-duplicated, capped), so the caller can ask
 * main about the ones it has not heard of. Runs on an inert tree.
 */
export function decorateFeedPaths(root: ParentNode, opts: DecorateFeedPathsOptions): string[] {
  const { folder, labels, known } = opts;
  const named: string[] = [];
  const seen = new Set<string>();
  /** the kind to draw `abs` as, or null; and it is recorded as named either way */
  const lookup = (abs: string): 'file' | 'dir' | null => {
    if (!seen.has(abs)) {
      if (seen.size >= MAX_PATHS_PER_REPLY) return null;
      seen.add(abs);
      named.push(abs);
    }
    const k = known(abs);
    return k === 'file' || k === 'dir' ? k : null;
  };
  const docOf = (n: Node): Document => n.ownerDocument ?? (n as Document);

  // ── a link whose href is a path on this machine ──────────────────────────
  const from = insideFolder(folder);
  for (const a of [...root.querySelectorAll('a[href]')]) {
    // a local web page the picture pass already answers (#1235)
    if (a.hasAttribute('data-feed-open-path') || a.closest('pre')) continue;
    const href = a.getAttribute('href') ?? '';
    if (/^\s*[\\/]{2}/.test(href)) continue; // another machine
    const where = classifyHref(href, from);
    if (where.kind !== 'relative') continue;
    const cand = pathFromText(where.target, false);
    if (!cand) continue;
    const abs = resolveRelativePath(from, cand.path);
    const kind = lookup(abs);
    if (kind) markLink(a, abs, kind, labels);
  }

  // ── inline code ─────────────────────────────────────────────────────────
  for (const code of [...root.querySelectorAll('code')]) {
    if (code.parentElement?.nodeName === 'PRE' || code.closest('pre, a, button, [role="link"]')) continue;
    const cand = pathFromText(code.textContent ?? '', false);
    if (!cand) continue;
    const abs = resolveFeedPath(cand.path, folder);
    const kind = lookup(abs);
    if (!kind) continue;
    const span = linkSpan(docOf(code), abs, kind, labels);
    code.replaceWith(span);
    span.append(code);
  }

  // ── plain prose ─────────────────────────────────────────────────────────
  const doc = docOf(root);
  // 4 = NodeFilter.SHOW_TEXT, spelled as the number so this runs where the
  // global is missing
  const walker = doc.createTreeWalker(root, 4);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (parent && !parent.closest(NOT_PROSE)) texts.push(n as Text);
  }
  for (const text of texts) {
    const value = text.data;
    if (!/[\\/.]/.test(value)) continue;
    const pieces: Array<{ start: number; end: number; abs: string; kind: 'file' | 'dir' }> = [];
    for (const m of value.matchAll(/\S+/g)) {
      const word = m[0];
      const cand = pathFromText(word, true);
      if (!cand) continue;
      // where the cleaned path sits inside the word
      const lead = word.length - word.replace(LEADING_PUNCT, '').length;
      const at = word.indexOf(cand.path, lead);
      if (at < 0) continue;
      // the `:42` stays part of the link: it is what the reply said
      let end = at + cand.path.length;
      if (cand.line !== undefined) {
        const rest = word.slice(end);
        const suffix = /^(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)/.exec(rest);
        if (suffix) end += suffix[0].length;
      }
      const abs = resolveFeedPath(cand.path, folder);
      const kind = lookup(abs);
      if (kind) pieces.push({ start: (m.index ?? 0) + at, end: (m.index ?? 0) + end, abs, kind });
    }
    if (pieces.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const p of pieces) {
      if (p.start > last) frag.append(doc.createTextNode(value.slice(last, p.start)));
      const span = linkSpan(doc, p.abs, p.kind, labels);
      span.textContent = value.slice(p.start, p.end);
      frag.append(span);
      last = p.end;
    }
    if (last < value.length) frag.append(doc.createTextNode(value.slice(last)));
    text.replaceWith(frag);
  }
  return named;
}
