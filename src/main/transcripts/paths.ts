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
  return conversationFile(projectsRoot, folder, nativeId) !== null;
}

/**
 * WHERE that conversation's transcript is, or null if it is not there.
 *
 * The same question `conversationExists` asks — it is now this function's
 * boolean — because #395 needs the PATH: a resumed Direct session replays the
 * history off this file into its Feed, since the CLI re-sends none of it over
 * the stream.
 *
 * ONE RESOLVER, so "is this resumable" and "where do I read it back from" cannot
 * answer differently for the same directory. They can still be asked about
 * DIFFERENT roots — `canResume` is a provider capability and the replay uses the
 * plan's `transcriptsRoot`, which is a second capability call — so an adapter
 * that ever declared two different roots would resume and then show nothing.
 * Identical for every shipped provider today; worth knowing before Phase 4 makes
 * these strings third-party.
 */
export function conversationFile(
  projectsRoot: string,
  folder: string,
  nativeId: string
): string | null {
  // The id is interpolated into a path below, and it reaches us from the
  // persisted workspace store and from hook payloads. A native id is a uuid
  // shape; anything else is not a conversation we wrote, and `..` would turn
  // this into an existence oracle for arbitrary files (§5.29 — validate where
  // the untrusted value enters, not where it lands).
  if (!/^[A-Za-z0-9._-]+$/.test(nativeId)) return null;
  const wantSlug = slugForCwd(folder).toLowerCase();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (d.isDirectory() && d.name.toLowerCase() === wantSlug) {
      const full = path.join(projectsRoot, d.name, `${nativeId}.jsonl`);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
