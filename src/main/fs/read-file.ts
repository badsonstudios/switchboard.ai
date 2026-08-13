// The capped read itself (P2-E16-01, §5.30).
//
// Two rules, both from §5.30's "very large text → truncate with a tail option,
// never 'the app froze'":
//
//  1. AT MOST `MAX_FILE_READ_BYTES` LEAVE THE DISK. Not "read it and slice it"
//     — a 4 GB log read into a buffer is an out-of-memory crash of the whole
//     app before the slice ever runs, and this is a path an agent's link can
//     aim at. One `read` of the cap, into one buffer of the cap.
//  2. ASYNC, so the bridge is not the thing that hangs. Main's event loop
//     serves every session's IPC, PTY plumbing and hook round-trips; a
//     synchronous read off a network share stalls all of it. `sessions:
//     isDirectory` stats synchronously and gets away with it because a stat is
//     bounded — bytes are not.
import { promises as fsp } from 'fs';
import { MAX_FILE_READ_BYTES, FileReadResult, FileTextEncoding } from '../../shared/ipc/fs';

/**
 * How much of the front of a file decides "is this text?" (P2-E16-02).
 *
 * 8 KiB, which is git's own answer (`buffer_is_binary` looks at the first 8000
 * bytes) and is the right shape of answer: a file that is text for its first
 * eight thousand bytes and binary afterwards does not exist in practice, and
 * scanning a whole 2 MiB for a decision that the first page already made is
 * work nobody asked for. It is also the EARLY STOP — a binary file is answered
 * after one page, so opening a 500 MB `.mp4` by accident costs 8 KiB.
 */
export const SNIFF_BYTES = 8192;

/** What `sniffEncoding` decided about the front of a file. */
export interface Sniff {
  /** the decoder to use, or undefined when the bytes are not text at all */
  readonly encoding?: FileTextEncoding;
  /** bytes of byte-order mark to skip before decoding */
  readonly bomBytes: number;
  /** true when the bytes are not text — nothing is decoded */
  readonly binary: boolean;
}

/**
 * Text or not, and in which encoding — decided on the first page of bytes.
 *
 * PURE and exported so the table can be tested as a table.
 *
 * The order is the whole of it: a BOM is a STATEMENT by the writer and beats
 * any heuristic, so it is checked first. Only a file with no BOM is guessed
 * at, and the guess is the conservative one — a NUL byte in the first page
 * means binary.
 *
 * WHAT THAT COSTS, said out loud: UTF-16 written WITHOUT a BOM is full of NULs
 * and lands in the binary branch, so it gets §5.30's "open externally" card
 * rather than a render. That is the deliberate half of the carry-forward from
 * P2-E16-01. There is no way to tell BOM-less UTF-16LE from an arbitrary
 * binary blob except by guessing at the statistics of the bytes, and a wrong
 * guess in the other direction is the failure this whole function exists to
 * prevent: a wall of mojibake presented as if it were the document. A card
 * that says "this is not text, open it in your editor" is wrong in a way the
 * reader can see and act on; mojibake is wrong in a way that looks like our
 * bug. Windows Notepad, PowerShell redirection and .NET all write the BOM, so
 * the common producers of UTF-16 on the one platform that still emits it are
 * covered by the branch above.
 */
export function sniffEncoding(buf: Uint8Array): Sniff {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', bomBytes: 3, binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // ...unless it is the FOUR-byte UTF-32LE BOM, whose first two bytes are the
    // UTF-16LE one. Decoded as UTF-16 it is text interleaved with NULs, i.e.
    // mojibake with none of the tells; the card is the honest answer, and it is
    // what the NUL scan below would have said if this branch had not caught the
    // prefix first.
    if (!(buf.length >= 4 && buf[2] === 0x00 && buf[3] === 0x00)) {
      return { encoding: 'utf-16le', bomBytes: 2, binary: false };
    }
    return { bomBytes: 0, binary: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', bomBytes: 2, binary: false };
  }
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return { bomBytes: 0, binary: true };
  }
  return { encoding: 'utf-8', bomBytes: 0, binary: false };
}

/**
 * Decode `bytes` as `encoding`, never throwing.
 *
 * `fatal: false` throughout — a cap can land in the middle of a multi-byte
 * character, and the last glyph of a truncated view rendering as U+FFFD is a
 * better answer than throwing away the 2 MB in front of it.
 *
 * UTF-16BE is byte-swapped and decoded as LE rather than trusted to the
 * platform's label support: `utf-16be` is a WHATWG label that Node answers
 * only with a full ICU build. Node 22 ships one, Electron ships one, and a
 * viewer that renders nothing on some future stripped build because of a label
 * is a bad trade against six lines of swap.
 */
export function decodeText(bytes: Uint8Array, encoding: FileTextEncoding): string {
  if (encoding === 'utf-16be') {
    // an odd trailing byte is half a code unit the cap cut in two — drop it
    const pairs = bytes.length - (bytes.length % 2);
    const swapped = new Uint8Array(pairs);
    for (let i = 0; i < pairs; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
  }
  if (encoding === 'utf-16le') {
    const pairs = bytes.length - (bytes.length % 2);
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(0, pairs));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Thrown-shaped errors from `fs` carry a string `code`. */
function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Read at most `cap` bytes of `file` as UTF-8.
 *
 * `file` must already be the REAL, in-scope path — `ReadScope.resolve` answers
 * one and this takes nothing else. It does not re-check the scope, deliberately:
 * two copies of that rule is one copy that can disagree with the other.
 *
 * The stat comes from the OPEN HANDLE (`fstat`), not from the path. Statting
 * the path and then opening it is two lookups with a gap between them, and the
 * gap is where a file becomes a symlink to somewhere else. One handle, opened
 * once, described and read.
 *
 * WHAT IS NOT CLOSED, and why that is the right call: the gap between
 * `ReadScope.resolve` resolving this path and this function opening it. An
 * attacker who can replace a file inside an open session folder with a symlink
 * in that window could redirect the read — but they already have write access
 * INSIDE a folder the user granted, so they can simply put the content in the
 * file instead. Closing it properly means `O_NOFOLLOW` on the final component
 * and a re-check, which Windows does not offer in the same shape; buying a
 * platform-specific mechanism against an attacker who has a simpler path is not
 * a trade worth making. The threat this scope defends against is a document
 * that steers the viewer, not a local race.
 */
export async function readCappedText(
  file: string,
  cap: number = MAX_FILE_READ_BYTES
): Promise<FileReadResult> {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    // EISDIR is POSIX's answer to opening a directory for reading; Windows
    // opens it and fails at the stat, which the branch below catches.
    if (code === 'EISDIR') return { ok: false, reason: 'not-a-file' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
    const size = stat.size;
    const want = Math.min(size, Math.max(cap, 0));
    const buffer = Buffer.allocUnsafe(want);
    let filled = 0;
    // One `read` is not guaranteed to fill the buffer — a pipe-backed or
    // network file can answer short. Loop until it is full or the file ends,
    // because a short read would silently truncate a file that is not over the
    // cap and report `truncated: false` about it.
    //
    // THE FIRST PAGE IS READ ON ITS OWN (P2-E16-02) so that a binary file can
    // stop here: the sniff below only ever looks at `SNIFF_BYTES`, and reading
    // the remaining 2 MiB of an `.mp4` to then throw it away is IO for a
    // decision that was already made.
    const firstPage = Math.min(want, SNIFF_BYTES);
    while (filled < firstPage) {
      const { bytesRead } = await handle.read(buffer, filled, firstPage - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const sniff = sniffEncoding(buffer.subarray(0, filled));
    if (sniff.binary || !sniff.encoding) {
      // `text: ''` and `truncated: false` — nothing was decoded, so nothing was
      // cut. The card the viewer shows is built from `path` and `size`.
      return { ok: true, path: file, text: '', size, truncated: false, binary: true };
    }
    while (filled < want) {
      const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const text = decodeText(buffer.subarray(sniff.bomBytes, filled), sniff.encoding);
    // `size > want`, not `size > filled`: the flag means THE CAP CUT THIS, and
    // the viewer's copy says so ("showing the first 2 MB of 500 MB"). A short
    // read — a file being rewritten under us, which is E16-04's whole scenario
    // — would otherwise claim the cap truncated a file it read whole.
    return {
      ok: true,
      path: file,
      text,
      size,
      truncated: size > want,
      encoding: sniff.encoding,
      bytes: filled,
    };
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EISDIR') return { ok: false, reason: 'not-a-file' };
    return { ok: false, reason: 'unreadable' };
  } finally {
    // A leaked handle per opened file is exactly the kind of thing that only
    // shows up at session 12.
    await handle.close().catch(() => {});
  }
}
