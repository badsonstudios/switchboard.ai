// Find a program on PATH, the way a shell would, without starting anything
// (E40 item 08, #1291).
//
// The S-01 rule is that a hosted CLI is launched by ABSOLUTE path: a PATH-
// relative `.cmd` run with the user's project as cwd is a planted-binary
// footgun. `providers/claude.ts` has its own scan for one known name; this is
// the general one, for any AI the catalog knows and any "Something else" a
// user typed. It only stats files — detection must never spawn just to ask
// "is it there".
import fs from 'fs';
import path from 'path';

/**
 * The candidate file names for `name` on `platform`. On Windows a bare name
 * gets PATHEXT's extensions (npm installs `.cmd` shims); a name that already
 * has an extension is tried as given first.
 */
export function candidateNames(name: string, platform: NodeJS.Platform, pathext: string): string[] {
  if (platform !== 'win32') return [name];
  const exts = pathext
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  const list = exts.length ? exts : ['.com', '.exe', '.bat', '.cmd'];
  const hasExt = path.win32.extname(name) !== '';
  return hasExt ? [name, ...list.map((e) => name + e)] : list.map((e) => name + e);
}

export interface FindOptions {
  envPath?: string;
  platform?: NodeJS.Platform;
  pathext?: string;
  /** test seam */
  isFile?: (p: string) => boolean;
}

function isFileOnDisk(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path `command` resolves to, or null.
 *
 * A command that is already a path (absolute, or containing a separator) is
 * checked as itself and never searched for: "C:\tools\agent.exe" missing is
 * missing, not "look for agent.exe somewhere else".
 */
export function findOnPath(command: string, opts: FindOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const isFile = opts.isFile ?? isFileOnDisk;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = command.trim();
  if (!name) return null;
  const pathext = opts.pathext ?? process.env.PATHEXT ?? '';
  if (p.isAbsolute(name) || name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    if (!p.isAbsolute(name)) return null; // relative-with-a-separator: refuse, cwd-dependent
    for (const c of candidateNames(name, platform, pathext)) if (isFile(c)) return c;
    return null;
  }
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of envPath.split(delimiter).filter(Boolean)) {
    for (const c of candidateNames(name, platform, pathext)) {
      const full = p.join(dir, c);
      if (isFile(full)) return full;
    }
  }
  return null;
}

export type PathLookup = (command: string) => string | null;

export interface PathIndexOptions {
  envPath?: string;
  platform?: NodeJS.Platform;
  pathext?: string;
  /** test seam: the file names in one directory */
  list?: (dir: string) => Promise<string[]>;
  /** test seam, for absolute commands */
  isFile?: (p: string) => boolean;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return []; // a PATH entry that does not exist, or cannot be read
  }
}

/**
 * Every program on PATH, read ASYNCHRONOUSLY and once: one `readdir` per PATH
 * directory, all concurrently, then each lookup is a map hit. For detection,
 * which asks about fifteen-odd programs at once: fifteen `findOnPath` calls are
 * thousands of synchronous `stat`s on the main thread (measured at 133 ms on
 * the desktop, with 37 PATH entries), which is a stall right after first paint.
 *
 * Same answers as `findOnPath`: the first PATH directory wins, Windows matches
 * case-insensitively through PATHEXT, an absolute command is checked as itself,
 * and a relative one with a separator is refused.
 */
export async function pathIndex(opts: PathIndexOptions = {}): Promise<PathLookup> {
  const platform = opts.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const pathext = opts.pathext ?? process.env.PATHEXT ?? '';
  const envPath = opts.envPath ?? process.env.PATH ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const fold = (n: string): string => (platform === 'win32' ? n.toLowerCase() : n);
  const dirs = envPath.split(delimiter).filter(Boolean);
  const listings = await Promise.all(dirs.map((d) => (opts.list ?? listFiles)(d)));
  const index = new Map<string, string>();
  dirs.forEach((dir, i) => {
    for (const name of listings[i]) {
      const key = fold(name);
      if (!index.has(key)) index.set(key, p.join(dir, name));
    }
  });
  return (command) => {
    const name = command.trim();
    if (!name) return null;
    if (p.isAbsolute(name) || name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
      return findOnPath(name, { platform, pathext, ...(opts.isFile ? { isFile: opts.isFile } : {}) });
    }
    for (const c of candidateNames(name, platform, pathext)) {
      const hit = index.get(fold(c));
      if (hit) return hit;
    }
    return null;
  };
}
