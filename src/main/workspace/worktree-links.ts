// Shared folders in a worktree (E42 step 2, #1506): a git-ignored folder such
// as `node_modules`, LINKED from the primary checkout instead of copied.
//
// ⚠️ **UNLINK BEFORE DELETE, ALWAYS (#916).** Removing a worktree through a
// `node_modules` junction once wiped the REAL `node_modules` it pointed at: a
// recursive delete that walks into a junction deletes the target's contents.
// So every path in this app that deletes a worktree folder goes through
// `removeWorktreeFolder` (or `unlinkShared` first), which takes each link out
// as a link — the link entry itself, never what it points at — and then checks
// that none is left before anything recursive runs. The test beside this file
// proves the target survives.
//
// On Windows a link is a directory JUNCTION: it needs no administrator rights
// or Developer Mode (a symlink does), and Node creates one when asked for type
// `junction`. Elsewhere the same call makes an ordinary directory symlink.
import fs from 'fs';
import path from 'path';

/** Is `p` itself a link (symlink or junction)? Never follows it. */
export async function isLink(p: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Link `linkPath` to the directory `target` (a junction on Windows). */
export async function linkDir(target: string, linkPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.promises.symlink(target, linkPath, 'junction');
}

/**
 * Remove one link entry, leaving its target alone. `unlink` removes a junction
 * or a directory symlink on Windows as the reparse point it is; `rmdir` is the
 * fallback for a platform that insists a directory link is a directory. Both
 * act on the entry: neither descends.
 */
async function removeLinkEntry(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p);
  } catch {
    await fs.promises.rmdir(p);
  }
}

/**
 * Take out every link at `rels` under `dir`. Returns what is STILL a link
 * afterwards (empty means safe to delete). A path that is not a link is left
 * alone: it is a real folder the worktree owns.
 */
export async function unlinkShared(dir: string, rels: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const rel of rels) {
    const p = path.join(dir, rel);
    if (!(await isLink(p))) continue;
    try {
      await removeLinkEntry(p);
    } catch {
      /* reported below */
    }
    if (await isLink(p)) left.push(rel);
  }
  return left;
}

/**
 * Every link in the top `depth` levels of `dir`, as paths relative to it. The
 * safety net under `unlinkShared`: a shared folder the settings no longer list
 * (it was removed from them after the worktree was made) is still a link, and
 * still must not be walked into. Links are not descended into; nor is `.git`.
 */
export async function findLinks(dir: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, level: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) found.push(r);
      else if (e.isDirectory() && e.name !== '.git' && level < depth) await walk(r, level + 1);
    }
  };
  await walk('', 1);
  return found;
}

/**
 * Delete a worktree folder this app made, safely: unlink the named shared
 * folders and any other link near the top, refuse if one is still there, and
 * only then delete. `deleteFolder` is the caller's deleter (git's `worktree
 * remove --force`, then a plain recursive delete for whatever git left).
 *
 * Returns null on success, or why it stopped (nothing deleted in that case).
 */
export async function removeWorktreeFolder(
  dir: string,
  sharedRels: readonly string[],
  deleteFolder: (dir: string) => Promise<void>
): Promise<string | null> {
  const named = await unlinkShared(dir, sharedRels);
  const others = await unlinkShared(dir, await findLinks(dir));
  const left = [...named, ...others];
  if (left.length > 0) return `a linked folder could not be unlinked (${left.join(', ')})`;
  await deleteFolder(dir);
  return null;
}
