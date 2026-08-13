// Reading a file's CONTENTS across the bridge (P2-E16-01, §5.30 + §5.29).
//
// Shared because both ends need the shape: main answers it, the §5.30 document
// viewer branches on it, and the cap is a number the renderer has to be able to
// SAY OUT LOUD ("showing the first 2 MB of this file") rather than infer from a
// truncation flag with no size attached.
//
// The capability behind it is `fs.read`, and it is deliberately NOT `fs.probe`.
// Probe answers "does this exist, and is it a directory"; this answers "here are
// the bytes". A Phase-4 contribution that needs the first must not acquire the
// second by holding one string — which is the entire argument for splitting the
// vocabulary at all (docs/extensibility.md → The vocabulary).

/**
 * The size cap, enforced in MAIN before the bytes cross the bridge.
 *
 * 2 MiB, which is roughly forty times the largest document in this repository
 * and still small enough that decoding it is not felt. §5.30's rule for a very
 * large file is "truncate with a tail option, never 'the app froze'": the read
 * stops at the cap and says so, and the file is never fully loaded, so a
 * multi-gigabyte log opened by accident costs one buffer instead of the
 * renderer.
 */
export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

/** Why a read did not happen. Every one of these is logged in main. */
export type FileReadRefusal =
  /** not a string, empty, relative, or containing a NUL — nothing was touched */
  | 'invalid-path'
  /**
   * Outside every open session folder and every user-picked path. The security
   * answer, and the one §5.30 exists to guarantee: "an agent must not be able
   * to steer the viewer at `~/.ssh`". Traversal (`../`) and a symlink pointing
   * out of the root both land here, because the check runs on the REAL,
   * resolved path rather than the one the caller typed.
   */
  | 'out-of-scope'
  /** resolved, in scope, and not there (or a broken symlink) */
  | 'not-found'
  /** a directory, a device, a socket — something that is not a file */
  | 'not-a-file'
  /** permissions, a busy handle, an I/O error — main logged the detail */
  | 'unreadable';

/**
 * How the bytes were decoded (P2-E16-02).
 *
 * The viewer showed mojibake for a UTF-16 file when this did not exist —
 * `TextDecoder('utf-8')` over UTF-16LE renders every ASCII character followed
 * by a NUL, so `hello` arrives as `h\0e\0l\0l\0o\0` — a wall of replacement
 * glyphs rather than a document. Main sniffs the
 * BOM and decodes accordingly, and says which one it used, because "this file
 * is UTF-16" is worth showing in the header rather than leaving the reader to
 * infer it from the damage.
 */
export type FileTextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** A successful read. `path` is the RESOLVED path, which may differ from the ask. */
export interface FileReadOk {
  readonly ok: true;
  /** the real path the bytes came from — symlinks followed, `..` collapsed */
  readonly path: string;
  /** UTF-8 text, at most `MAX_FILE_READ_BYTES` of it. Empty when `binary`. */
  readonly text: string;
  /** the file's FULL size on disk in bytes, whether or not it all came back */
  readonly size: number;
  /** true when `text` is the first `MAX_FILE_READ_BYTES` of a larger file */
  readonly truncated: boolean;
  /**
   * How many BYTES of the file `text` was decoded from (P2-E16-02).
   *
   * Not `text.length` and not a re-measure in the renderer: the viewer's
   * truncation strip says "showing the first X of Y", and X is a count only
   * main has. Re-deriving it renderer-side means measuring DECODED text in
   * UTF-8, which for a UTF-16 file is roughly half the truth.
   */
  readonly bytes?: number;
  /**
   * How `text` was decoded (P2-E16-02).
   *
   * Always present on a text read, never on a binary one — optional in the type
   * because of the second half of that sentence, not because it is sometimes
   * omitted for a text file. Reporting it even for the overwhelmingly common
   * `utf-8` is deliberate: a field that is sometimes there is a field every
   * caller has to remember the rule for.
   */
  readonly encoding?: FileTextEncoding;
  /**
   * The bytes are not text, and `text` is empty (P2-E16-02).
   *
   * Decided in MAIN, on the bytes, and the answer is deliberately not "read it
   * anyway and let the renderer cope": §5.30's rule for a binary file is a card
   * naming it, "not garbage", and the cheapest way to guarantee no garbage
   * crosses the bridge is for the garbage never to leave main. It also means a
   * `.txt` that is really a JPEG gets the card the same as a `.jpg` does — the
   * extension is a hint, the bytes are the truth.
   */
  readonly binary?: boolean;
}

export interface FileReadRefused {
  readonly ok: false;
  readonly reason: FileReadRefusal;
}

/**
 * What `fs:read` answers.
 *
 * A result union rather than the `null`-and-log convention (#347) because the
 * caller has something to SAY: "that file is gone" and "you may not read that"
 * are different strips in the viewer, and a bare null collapses them. The shape
 * follows `sessions:setTransport`, the handler that already answers
 * `{ ok: false, reason }`; it is not the broker's `IpcRefusal`, which is a
 * different refusal (the CAPABILITY was missing, not the scope) and carries its
 * own brand.
 */
export type FileReadResult = FileReadOk | FileReadRefused;
