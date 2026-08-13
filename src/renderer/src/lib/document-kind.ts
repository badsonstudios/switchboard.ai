// One dispatch table, honest about its edges (P2-E16-02, §5.30).
//
// §5.30 asks for exactly one of these — "One dispatch table, honest about its
// edges" — and this is the v1 half of it: markdown renders, other text opens in
// Monaco, and PDF-or-binary gets a card naming the file rather than a pane full
// of garbage. Images, JSON/JSONL and CSV get their own bodies in the Phase 3
// viewer (DESIGN §8); until then they take the card, which is the honest
// degrade rather than a promise the pane cannot keep.
//
// THE EXTENSION IS A HINT, NOT THE TRUTH. Main sniffs the actual bytes and can
// answer `binary` for anything, whatever it is called — a `.txt` that is really
// a JPEG takes the card. This table is what decides BEFORE the bytes arrive
// (which body to mount, which mode to default to) and what catches the file
// that is text but should not be READ as text: an `.svg` is XML, and rendering
// its source is a worse answer than saying "this is an image".
import { languageForPath } from './diff-language';

/** Which body the viewer mounts. */
export type DocumentKind =
  /** rendered markdown, with a source toggle */
  | 'markdown'
  /** Monaco, read-only, syntax-highlighted */
  | 'text'
  /** the "open externally" card: name, type, size, and two buttons */
  | 'external';

export type DocumentMode = 'rendered' | 'source';

export interface DocumentClass {
  readonly kind: DocumentKind;
  /** the Monaco language id for the source body */
  readonly language: string;
  /**
   * The mode this file type OPENS in.
   *
   * "The default is per file type, not per file" (§5.30) — an epic decision
   * taken up front, so it is a property of the table and not of a preference.
   */
  readonly defaultMode: DocumentMode;
  /** the file's own name, for the header and the card */
  readonly name: string;
  /** lower-case extension without the dot, or '' — what the card shows as type */
  readonly extension: string;
}

/** Markdown, in the spellings that actually occur. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

/**
 * Extensions that are never opened as text.
 *
 * Grouped by why they are here rather than sorted, because the reason is the
 * only thing that makes the list maintainable. It does not need to be complete
 * — main's NUL sniff catches everything it misses — it needs to catch the files
 * whose bytes could plausibly LOOK like text while being useless as text.
 */
const EXTERNAL_EXTENSIONS = new Set([
  // §5.30 names this one: "Chromium's PDF viewer inside a packaged Electron app
  // is a rabbit hole, and users own a PDF reader"
  'pdf',
  // images. `svg` is text — that is exactly why it is here: showing an image's
  // XML is not showing the image, and §5.30 gives images their own body in v2.
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'avif', 'svg',
  // office and friends: zip containers with an XML filling
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'key',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'iso', 'dmg',
  // executables and build output
  'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib', 'pdb', 'class', 'pyc', 'pyo',
  'wasm', 'node', 'msi', 'app', 'apk', 'deb', 'rpm',
  // media
  'mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // databases and other opaque state
  'sqlite', 'sqlite3', 'db', 'mdb', 'realm', 'pack', 'idx',
]);

/** The last path segment, whichever separator the platform wrote. */
export function baseName(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cut >= 0 ? cleaned.slice(cut + 1) : cleaned;
}

/** Everything before the last separator, or '' when there is none. */
export function directoryName(filePath: string): string {
  const cleaned = filePath.replace(/[\\/]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cut > 0 ? cleaned.slice(0, cut) : cut === 0 ? '/' : '';
}

/** The lower-cased extension without its dot. A dotfile has none. */
export function extensionOf(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf('.');
  // `dot > 0`, not `>= 0`: `.gitignore` is a file called ".gitignore" with no
  // extension, not a file with the extension "gitignore".
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** What kind of document is this path, and how should it open? */
export function classifyDocument(filePath: string): DocumentClass {
  const name = baseName(filePath);
  const extension = extensionOf(filePath);
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return { kind: 'markdown', language: 'markdown', defaultMode: 'rendered', name, extension };
  }
  if (EXTERNAL_EXTENSIONS.has(extension)) {
    return { kind: 'external', language: 'plaintext', defaultMode: 'source', name, extension };
  }
  // Everything else is text until main's sniff says otherwise. That is the
  // right default for a folder full of source: an unknown extension is far more
  // often a config file than a binary, and the sniff catches the binary.
  return {
    kind: 'text',
    language: languageForPath(filePath),
    defaultMode: 'source',
    name,
    extension,
  };
}
