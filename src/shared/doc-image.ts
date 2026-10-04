// A picture inside a rendered document (#1080, §5.30 + §5.29).
//
// Shared because both ends have to agree on three things and none of them may
// drift: the SCHEME the renderer writes and main answers (and `csp.ts` allows),
// the URL SHAPE that carries a path across, and the list of file types that
// count as a picture — the renderer uses it to decide whether to offer an
// `<img>` at all, and main uses it to refuse everything else.
//
// WHY A SCHEME AND NOT `fs:read`. §5.30: "Local images are served through a
// scoped protocol handler that resolves the path and refuses anything outside
// the document's root, symlinks included." An `<img>` needs a URL, and the
// only URLs the CSP lets one have are our own origin's — `data:` and `blob:`
// are refused on purpose (`ComposerAttachments.tsx` paints a canvas for that
// reason). A canvas would keep the CSP untouched but cannot animate a GIF or
// draw an SVG, so this is the one scheme `img-src` gains, and it can only ever
// name a file the read scope already allows.

/** The scheme. Lower-case, because Chromium lower-cases it before we see it. */
export const DOC_IMAGE_SCHEME = 'sb-doc-image';

/** The fixed host, so the URL parses the same way under every URL parser. */
const DOC_IMAGE_HOST = 'local';

/**
 * What counts as a picture, by extension → the `content-type` main answers.
 *
 * AN ALLOW-LIST, and it is the whole of what the scheme will serve: without it
 * `<img src>` would be a way to make main open ANY in-scope file, and "it
 * failed to decode" is not the same as "it was never read". SVG is here because
 * §5.30 settles it — "SVG via `<img>` and never inlined so it cannot carry
 * script" — and an `<img>` is the only element this URL is ever written into.
 */
export const DOC_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/**
 * The most main will read for one picture.
 *
 * Ten times `MAX_FILE_READ_BYTES`, because a screenshot is routinely larger
 * than any document and is not decoded as text. Still a cap: the path is one a
 * document chooses, and a multi-gigabyte file with a `.png` name must cost a
 * refusal rather than a buffer.
 */
export const MAX_DOC_IMAGE_BYTES = 20 * 1024 * 1024;

/** The `content-type` for this path's extension, or undefined if not a picture. */
export function docImageMime(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(DOC_IMAGE_TYPES, ext)
    ? DOC_IMAGE_TYPES[ext]
    : undefined;
}

/**
 * The URL an `<img>` uses for the picture at `absPath`.
 *
 * The path rides in the QUERY, percent-encoded whole, rather than as the URL's
 * own path: a Windows path has a drive colon and backslashes, and a URL parser
 * normalises both (`C:` becomes a port or a scheme, `\` becomes `/`, `..` is
 * collapsed) before main ever sees them. Encoded in the query it arrives as
 * exactly the string the renderer resolved, and main's own resolution — the
 * real one — is the only one that happens.
 */
export function docImageUrl(absPath: string): string {
  return `${DOC_IMAGE_SCHEME}://${DOC_IMAGE_HOST}/?path=${encodeURIComponent(absPath)}`;
}

/** The path a `docImageUrl` carries, or null when this is not one of ours. */
export function docImagePath(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DOC_IMAGE_SCHEME}:` || parsed.hostname !== DOC_IMAGE_HOST) return null;
  const target = parsed.searchParams.get('path');
  return target && target.length > 0 ? target : null;
}
