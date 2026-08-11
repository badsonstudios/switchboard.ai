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
import { MAX_FILE_READ_BYTES, FileReadResult } from '../../shared/ipc/fs';

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
    while (filled < want) {
      const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    // `fatal: false` — a cap can land in the middle of a multi-byte character,
    // and the last glyph of a truncated view rendering as U+FFFD is a better
    // answer than throwing away the 2 MB in front of it.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, filled));
    // `size > want`, not `size > filled`: the flag means THE CAP CUT THIS, and
    // the viewer's copy says so ("showing the first 2 MB of 500 MB"). A short
    // read — a file being rewritten under us, which is E16-04's whole scenario
    // — would otherwise claim the cap truncated a file it read whole.
    return { ok: true, path: file, text, size, truncated: size > want };
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
