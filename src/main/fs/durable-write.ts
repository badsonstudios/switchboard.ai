// Crash-safe replace of a small state file (#1410).
//
// Every store under userData used to save as `writeFileSync(tmp)` then
// `renameSync(tmp, file)`. That survives the APP dying mid-write — the rename is
// atomic, so the old file or the new one is there, never half of each. It does
// NOT survive the OS dying: without a flush, the rename (metadata, journaled)
// can reach the disk before the data does, and the next boot finds the new name
// on a file of the right LENGTH whose every byte is zero. That is exactly what a
// video-driver crash left behind on 2026-10-21: `workspace.json`, 28,581 zero
// bytes, and a workspace that came back empty — every session, group and
// setting gone.
//
// The fix is the textbook one: flush the temp file before the rename, so the
// rename can only ever point at bytes that are on the disk. `flush: true` makes
// `writeFileSync` fsync the descriptor it already holds before closing it — no
// second open for an anti-virus scanner to trip over, and the write is still the
// one `writeFileSync` call every store's tests intercept to simulate a failing
// disk. The directory entry is flushed too where the OS lets us (POSIX);
// Windows cannot open a directory for flushing and NTFS journals the rename
// itself, so there it is skipped.
import fs from 'fs';
import path from 'path';

/** The calls this module makes — injectable, as `AisStore` injects its `fs`. */
export type DurableFs = Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'openSync' | 'fsyncSync' | 'closeSync'>;

/**
 * Best-effort flush of a directory entry, so a rename inside it is on the disk
 * too. POSIX only (see the header); a failure here is swallowed, because the
 * data flush that matters has already happened.
 */
function fsyncDir(dir: string, fsx: DurableFs): void {
  if (process.platform === 'win32') return;
  try {
    const fd = fsx.openSync(dir, 'r');
    try {
      fsx.fsyncSync(fd);
    } finally {
      fsx.closeSync(fd);
    }
  } catch {
    /* some filesystems refuse a directory fsync — the data is already flushed */
  }
}

/**
 * Write `data` to `tmp`, flushed to the disk, and rename it over `file`. Throws
 * whatever the write or rename throws — the callers already own the retry and
 * the logging, and a flush that fails is a save that did not happen.
 */
export function writeFileDurable(
  file: string,
  tmp: string,
  data: string,
  options?: { mode?: number },
  fsx: DurableFs = fs
): void {
  fsx.writeFileSync(tmp, data, { ...options, flush: true });
  fsx.renameSync(tmp, file);
  fsyncDir(path.dirname(file), fsx);
}
