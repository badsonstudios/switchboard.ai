// What a link inside a rendered document means, and where it points
// (P2-E16-02, §5.30).
//
// Pure, and separate from the DOM decoration that uses it, because this is the
// security-shaped half: the strings arriving here came out of a file we did not
// write, and "which of these four things is this href" is a decision worth
// being able to test as a table.
//
// FOUR ANSWERS, and the fourth is the one that matters. §5.30: "`http`/`https`/
// `mailto` links open in the OS browser via `shell.openExternal` against a
// scheme allowlist; every other scheme is refused. No in-app navigation to
// remote content, ever." So `javascript:`, `data:`, `file:`, `vbscript:` and
// every scheme nobody has thought of yet land in `blocked` and do NOTHING —
// not "open a warning", not "open in the browser". Nothing.
import { directoryName } from './document-kind';
import { ALLOWED_LINK_SCHEMES } from '../../../shared/link-schemes';

export type LinkKind =
  /** `#heading` — scroll this document */
  | 'anchor'
  /** http/https/mailto — hand to the OS browser */
  | 'external'
  /** a path relative to this document — navigate the viewer */
  | 'relative'
  /** everything else, including every scheme not on the allowlist */
  | 'blocked';

export interface LinkTarget {
  readonly kind: LinkKind;
  /** the anchor id, the URL, or the resolved absolute path — '' when blocked */
  readonly target: string;
  /** the `#fragment` a relative link carried, without the '#' */
  readonly hash?: string;
}

/**
 * The schemes a document may send to the browser.
 *
 * IS main's allowlist since #527, rather than mirroring it: the list lives in
 * `shared/link-schemes.ts` and main re-exports the same constant. A mirror is
 * a copy that drifts, and the drift shows up as a link that looks live and
 * does nothing (or the reverse) — see that file for why the renderer holds a
 * copy of a list it is not the guard for.
 */
const EXTERNAL_SCHEMES = new Set<string>(ALLOWED_LINK_SCHEMES);

/**
 * Does this href name a scheme at all?
 *
 * Hand-written rather than handed to `new URL`, because `new URL('C:/x/y.md')`
 * parses as the scheme `c:` on a Windows path — which would turn every absolute
 * Windows path in a document into a blocked link. The RFC 3986 shape is
 * `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, and requiring two or
 * more characters is what keeps a drive letter out of it.
 */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+\-.]+):/;

/** Is this an absolute filesystem path, in either platform's spelling? */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p);
}

/** Percent-decode, or hand back the original when it is not valid encoding. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve `rel` against the file `fromFile`, in that file's own path spelling.
 *
 * Written by hand rather than with `new URL(rel, 'file://…')` because the
 * round trip through a URL mangles Windows paths, spaces and `#` in filenames,
 * and because the ONLY thing this needs to do is join and collapse. The result
 * is still checked by main against the read scope — this function is a
 * convenience for the user, not a boundary.
 */
export function resolveRelativePath(fromFile: string, rel: string): string {
  const windows = fromFile.includes('\\') && !fromFile.startsWith('/');
  const sep = windows ? '\\' : '/';
  const base = isAbsolutePath(rel) ? rel : `${directoryName(fromFile)}${sep}${rel}`;
  const parts = base.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    // `..` above the root is dropped, not kept: a path with a leading `..` is
    // meaningless as an absolute path, and keeping it would hand main a string
    // it can only refuse.
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join(sep);
  // A POSIX path lost its leading '/' to the split (the first element is '').
  return joined.length > 0 ? joined : sep;
}

/**
 * Classify one href from a rendered document.
 *
 * `fromFile` is the document the link is IN — a relative link means nothing
 * without it.
 */
export function classifyHref(href: unknown, fromFile: string): LinkTarget {
  if (typeof href !== 'string') return { kind: 'blocked', target: '' };
  const raw = href.trim();
  if (raw.length === 0) return { kind: 'blocked', target: '' };
  if (raw.startsWith('#')) return { kind: 'anchor', target: decode(raw.slice(1)) };

  const scheme = SCHEME_RE.exec(raw);
  if (scheme) {
    // `new URL` only after we know it has a scheme, so a drive letter never
    // reaches it. Its own parse decides the protocol — matching the string
    // ourselves would miss `HTTPS:` and `http:\\`, both of which browsers take.
    let protocol: string;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      return { kind: 'blocked', target: '' };
    }
    return EXTERNAL_SCHEMES.has(protocol)
      ? { kind: 'external', target: raw }
      : { kind: 'blocked', target: '' };
  }

  // No scheme: a path. Split the fragment off before resolving, so
  // `00-process.md#the-hand-off` opens the file AND lands on the heading.
  const hashAt = raw.indexOf('#');
  const pathPart = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const hash = hashAt >= 0 ? decode(raw.slice(hashAt + 1)) : undefined;
  // A query string on a local path is not a query, it is part of nothing —
  // markdown links to files do not have them, and a `?` in a filename is
  // illegal on Windows and vanishingly rare elsewhere. Cut it.
  const queryAt = pathPart.indexOf('?');
  const cleaned = decode(queryAt >= 0 ? pathPart.slice(0, queryAt) : pathPart);
  if (cleaned.length === 0) {
    // `#frag` was handled above, so this is `?x` or similar — nothing to open.
    return hash ? { kind: 'anchor', target: hash } : { kind: 'blocked', target: '' };
  }
  return { kind: 'relative', target: resolveRelativePath(fromFile, cleaned), hash };
}
