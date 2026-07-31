// Where a provider's transcripts live on disk, and whether a given conversation
// is really there.
//
// Split out of `watcher.ts` in P2-E15-01. These are pure path/fs helpers about
// a transcript LAYOUT, and the provider adapters need them to answer §5.3's
// `resume` capability — an adapter importing the host's watcher to ask "does
// this file exist" inverts the dependency the seam exists to establish (the
// host asks the adapter, not the other way round). `watcher.ts` re-exports both
// so existing consumers are unaffected.
import fs from 'fs';
import path from 'path';

/** The directory name a provider derives from a project folder. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/:. ]/g, '-');
}

/**
 * Does a resumable conversation actually exist for this session id? Claude
 * only writes the transcript once a real turn happens, so `--resume <id>` on
 * a session that never got a prompt errors with "No conversation found" and
 * exits — checking the file first lets us fall back to a fresh session.
 * Slug matched case-insensitively (real paths lowercase the drive letter).
 */
export function conversationExists(projectsRoot: string, folder: string, nativeId: string): boolean {
  // The id is interpolated into a path below, and it reaches us from the
  // persisted workspace store and from hook payloads. A native id is a uuid
  // shape; anything else is not a conversation we wrote, and `..` would turn
  // this into an existence oracle for arbitrary files (§5.29 — validate where
  // the untrusted value enters, not where it lands).
  if (!/^[A-Za-z0-9._-]+$/.test(nativeId)) return false;
  const wantSlug = slugForCwd(folder).toLowerCase();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of dirs) {
    if (d.isDirectory() && d.name.toLowerCase() === wantSlug) {
      try {
        if (fs.statSync(path.join(projectsRoot, d.name, `${nativeId}.jsonl`)).isFile()) return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}
