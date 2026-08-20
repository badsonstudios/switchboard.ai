// Which files may be read at all (P2-E16-01, §5.30 + §5.29).
//
// THE CHECK LIVES IN MAIN. §5.23 says the main process is the sole enforcer,
// and for this channel that is not a style preference: a renderer-side scope
// check protects nobody, because the thing it would protect against is a
// renderer that has been talked into asking for `~/.ssh/id_rsa` — and a
// compromised or hostile caller simply does not run the check. Main is the only
// place that both knows the roots and cannot be argued out of them.
//
// THE SCOPE, from §5.30, and no wider: anything under an open session's folder,
// plus paths the user picked through the native dialog. That is it. The reason
// it is that and not "the user's home directory" is the threat model — an agent
// writes a document, the document contains a link, a viewer follows it. The
// blast radius of a followed link should be the folders the user already
// pointed this app at.
//
// HOW IT REFUSES A LIE. Every decision is made on the REAL path:
// `path.resolve` collapses `..` before anything looks at it, and `realpath`
// resolves symlinks, junctions and drive-relative spellings to the file the OS
// will actually open. A check on the string the caller typed would pass
// `root/link-to-etc/passwd` — the string starts with the root, and the bytes
// come from somewhere else entirely. That is the whole bug class, and resolving
// first is the whole fix.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';
import type { FileReadRefusal } from '../../shared/ipc/fs';

/**
 * How paths compare on the filesystem we are checking against.
 *
 * A parameter rather than a `process.platform` read inside the comparison, so
 * the rule can be tested against BOTH conventions on one machine — the Windows
 * table and the POSIX table run on the Linux CI runner and on Dan's box alike.
 * A test that can only assert its own platform's half is half a test for a
 * security check.
 */
export interface PathStyle {
  /** the separator these paths are written with */
  readonly sep: string;
  /**
   * Does this filesystem treat `Root` and `root` as the same directory?
   *
   * The direction of the risk decides this, and it points one way: comparing
   * case-INSENSITIVELY on a case-SENSITIVE filesystem would accept `/ROOT/x` as
   * being inside `/root/x`, which are two different directories on Linux — it
   * widens the scope. Comparing case-sensitively on a case-insensitive one only
   * ever REFUSES a path that would have been allowed, which is the safe way to
   * be wrong. So: true only where the OS itself says so.
   */
  readonly caseInsensitive: boolean;
}

export const WIN32_STYLE: PathStyle = { sep: '\\', caseInsensitive: true };
export const POSIX_STYLE: PathStyle = { sep: '/', caseInsensitive: false };

/** The style of the machine we are running on. */
export const HOST_STYLE: PathStyle = {
  sep: path.sep,
  // macOS is case-insensitive by default (APFS, and HFS+ before it). Linux is
  // not. Windows is not, ever.
  caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
};

const fold = (p: string, style: PathStyle): string => (style.caseInsensitive ? p.toLowerCase() : p);

/** `p` without its trailing separators — but never emptied (`/` stays `/`). */
function trimTrailingSep(p: string, sep: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === sep) end -= 1;
  return p.slice(0, end);
}

/**
 * Is `target` the root itself, or something underneath it?
 *
 * PURE, and takes both paths already resolved — the IO (realpath) is the
 * caller's, so this half is a table of strings and can be tested as one.
 *
 * The separator on the end of the root is the load-bearing detail: without it,
 * `/home/dan/project-secrets` compares as "inside" `/home/dan/project`, because
 * one string does start with the other. Prefix matching without a boundary is
 * the second-most-common way a check like this is wrong, after not resolving at
 * all.
 */
export function isWithinRoot(root: string, target: string, style: PathStyle = HOST_STYLE): boolean {
  if (!root || !target) return false;
  const r = fold(trimTrailingSep(root, style.sep), style);
  const t = fold(trimTrailingSep(target, style.sep), style);
  if (r === t) return true;
  // A root that already ENDS in a separator is a filesystem root — `/` on
  // POSIX, and `C:` after the trim on Windows. Appending a second one would
  // make `//etc` the boundary and refuse everything under it. Rare as a session
  // folder and absurd as a pick, but "the check silently refuses everything"
  // is a bad way for that to show up.
  const boundary = r.endsWith(style.sep) ? r : r + style.sep;
  return t.startsWith(boundary);
}

/** What `ReadScope.resolve` answers. */
export type ScopeDecision =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: FileReadRefusal };

export interface ReadScopeDeps {
  /**
   * The folders of the sessions that are OPEN — every card in the workspace,
   * live or suspended. Read on every call rather than captured: a session
   * opened a second ago is in scope, and a card closed a second ago is not.
   */
  sessionFolders: () => readonly string[];
  log: Logger;
  /**
   * Symlink resolution, injectable for tests. Defaults to `realpathSync.native`
   * where the platform has it — on Windows it is the variant that also
   * canonicalises the CASE of every segment, so the comparison above is
   * comparing what the OS thinks the path is rather than what the caller typed.
   */
  realpath?: (p: string) => string;
}

/** Thrown-shaped errors from `fs` carry a string `code`. */
function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String(err.code)
    : undefined;
}

/**
 * The read scope: open session folders, plus what the user picked.
 *
 * ONE object, held by main, consulted by the `fs:read` handler. The picked set
 * is the seam P2-E16-02's `Open file…` calls when the native dialog returns —
 * it is empty until something adds to it, and that is the correct starting
 * state rather than a stub with a TODO: a scope nobody has widened is a scope
 * of exactly the open sessions, which is a real and enforceable answer today.
 *
 * Nothing REMOVES a picked path. The set lives for the run of the app, because
 * the user's grant was "show me this file" and re-picking the same file after a
 * viewer closed should not be a second dialog. It does not survive a restart:
 * a persisted allow-list is a security decision with a much longer tail, and
 * §5.30 does not ask for one.
 *
 * A PICKED FILE GRANTS THAT FILE, NOT ITS FOLDER (noted P2-E16-02). `roots()`
 * puts the picked path in the same list as a session folder, and `isWithinRoot`
 * answers true only for the root itself or something under it — so a root that
 * IS a file grants exactly one file, and a relative link out of a picked
 * document ("[b](./b.md)") is refused. That is the literal reading of §5.30's
 * "paths the user picks through the native dialog", and it is deliberately not
 * widened here: granting the containing directory would mean one dialog click
 * opening a whole tree, which is a security decision for an owner and not a
 * side effect of a convenience. The cost is written down in
 * `docs/manual/15-document-viewer.md` so a user is not left guessing why one
 * link works inside a session folder and not outside it.
 */
export class ReadScope {
  private readonly picked = new Set<string>();
  private readonly realpath: (p: string) => string;

  constructor(private readonly deps: ReadScopeDeps) {
    this.realpath = deps.realpath ?? ((p: string) => fs.realpathSync.native(p));
  }

  /**
   * Add a path the user chose in the native dialog.
   *
   * Stored RESOLVED, so the set holds the same kind of string the check
   * compares against. A path that cannot be resolved (it vanished between the
   * dialog and here) is dropped rather than stored unresolved — an
   * unresolvable entry would be dead weight the check has to skip anyway.
   */
  addPicked(target: string): void {
    if (typeof target !== 'string' || target.length === 0) return;
    const real = this.tryRealpath(path.resolve(target));
    if (!real) return;
    this.picked.add(real);
    this.deps.log.info('fs read scope widened by the user', { path: real });
  }

  /** The picked set, for tests and for anything that wants to show the user. */
  pickedPaths(): string[] {
    return [...this.picked];
  }

  /**
   * Every root, RESOLVED — realpath'd session folders plus the picked set,
   * which is stored resolved already.
   *
   * One reading of the session list, and deduplicated, because the list
   * `index.ts` supplies is the union of the live sessions and the persisted
   * cards: every live session appears in both, and realpathing the same folder
   * twice per read is IO on main's event loop for nothing.
   *
   * An unresolvable root is dropped silently — a card whose folder is on an
   * unplugged drive is an ordinary state, not an error, and it simply contains
   * nothing readable right now.
   */
  roots(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const folder of this.sessionFolders()) {
      if (typeof folder !== 'string' || folder.length === 0) continue;
      const resolved = path.resolve(folder);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      const real = this.tryRealpath(resolved);
      if (real) out.push(real);
    }
    out.push(...this.picked);
    return out;
  }

  /**
   * The session folders, or none if asking for them throws.
   *
   * Fail-open is the app's hard constraint, but there is only one direction to
   * fail in for a scope: a list we could not read is a list we cannot check
   * against, so it becomes the empty scope and every read is refused. Refusing
   * is recoverable; the alternative is `fs:read` REJECTING, which is the one
   * thing this channel promises never to do.
   */
  private sessionFolders(): readonly string[] {
    try {
      return this.deps.sessionFolders();
    } catch (err) {
      this.deps.log.warn('fs read scope could not list session folders — refusing everything', {
        error: String(err),
      });
      return [];
    }
  }

  /**
   * The nearest ancestor of `p` that actually resolves, or undefined.
   *
   * Used ONLY to decide whether a caller is allowed to be told that something
   * is missing — see `resolve`. Walks up, so it terminates at the filesystem
   * root in the worst case, and the loop is bounded by the depth of the path.
   */
  private nearestRealAncestor(p: string): string | undefined {
    let dir = path.dirname(p);
    for (;;) {
      const real = this.tryRealpath(dir);
      if (real) return real;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /**
   * Resolve `target` and decide whether it may be read.
   *
   * Returns the REAL path on success, and the handler reads that one — not the
   * caller's string. Resolving twice (once to check, once to open) would be a
   * time-of-check/time-of-use gap wide enough to swap a symlink through.
   */
  resolve(target: unknown): ScopeDecision {
    if (typeof target !== 'string' || target.trim().length === 0 || target.includes('\0')) {
      return { ok: false, reason: 'invalid-path' };
    }
    if (!path.isAbsolute(target)) {
      // A relative path would resolve against MAIN's working directory, which
      // is wherever the app was launched from — a root nobody granted and the
      // caller cannot see. There is no correct answer to give it.
      return { ok: false, reason: 'invalid-path' };
    }
    const resolved = path.resolve(target);
    const roots = this.roots();

    // EVERY DECISION IS MADE ON THE RESOLVED PATH, and there is deliberately no
    // cheap "does the spelling look like it is under a root" pre-check in front
    // of it. That pre-check was written, and CI killed it: GitHub's Windows
    // runners hand out `C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 SHORT
    // NAME, which `realpath.native` expands to `runneradmin` — so a legitimate
    // read of a granted file was refused because the string it was spelled with
    // did not start with the string the root was spelled with. A symlinked
    // prefix anywhere above a session folder does the same thing. A path has
    // many true spellings and exactly one resolution; only the resolution can
    // be compared.
    //
    // Which leaves the disclosure question the pre-check was there to answer:
    // if resolving comes first, does the difference between `not-found` and
    // `out-of-scope` become an existence oracle for the whole filesystem —
    // `fs.probe` smuggled inside `fs.read`, the one conflation this capability
    // exists to prevent? No, and the `catch` below is why: a path that does not
    // resolve is only reported as missing when the nearest thing that DOES
    // resolve is itself in scope. Every path outside the scope gets the same
    // answer whether or not it is there.
    let real: string;
    try {
      real = this.realpath(resolved);
    } catch (err) {
      // It did not resolve. WHERE it failed to resolve decides what we may say
      // about it, and this is the whole of the oracle argument above: without
      // this branch, `/etc/shadow` would answer `out-of-scope` and `/etc/nope`
      // would answer `not-found`, and a caller that may read neither could map
      // the filesystem by watching which refusal it got.
      //
      // So: walk up to the nearest ancestor that DOES resolve, and run the
      // scope check on that. If the ancestor is outside the scope, the caller
      // learns only that it asked for something out of scope — the same answer
      // the present case gets. If it is inside, the caller was entitled to know
      // that a file in a folder it may read is not there.
      const anchor = this.nearestRealAncestor(resolved);
      if (!anchor || !roots.some((root) => isWithinRoot(root, anchor))) {
        return { ok: false, reason: 'out-of-scope' };
      }
      const code = errorCode(err);
      // ENOENT (gone, or a symlink pointing at nothing) and ENOTDIR (a segment
      // in the middle is a file) are both "that path is not there".
      return {
        ok: false,
        reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable',
      };
    }

    // The check, on what the OS says the path really is. This is what catches
    // the symlink, the junction and the `..` that climbed out: all three are
    // spellings that look like one place and open another.
    if (!roots.some((root) => isWithinRoot(root, real))) {
      return { ok: false, reason: 'out-of-scope' };
    }
    return { ok: true, path: real };
  }

  private tryRealpath(p: string): string | undefined {
    try {
      return this.realpath(p);
    } catch {
      return undefined;
    }
  }
}
