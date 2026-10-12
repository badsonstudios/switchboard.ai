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
import { errorText } from '../../shared/error-text';
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

/**
 * Why `resolve` said no.
 *
 * NARROWER THAN `FileReadRefusal`, and narrowed deliberately (#521 layer 2):
 * `not-a-file` is `read-file.ts`'s word, decided after the scope check by
 * looking at what the path turned out to BE, and this module never returns it.
 * Saying so in the type means a second consumer of the scope — the Files tab's
 * `listDir`, whose mirror-image refusal is `not-a-directory` — does not have to
 * carry a dead branch for a case that cannot happen.
 */
export type ScopeRefusal = Exclude<FileReadRefusal, 'not-a-file'>;

/** What `ReadScope.resolve` answers. */
export type ScopeDecision =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: ScopeRefusal };

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
  /**
   * Describe a path WITHOUT following it, and read where a link points. Used
   * only on a path that did not resolve, to find the link that led nowhere
   * (#1028). Injectable for the same reason `realpath` is.
   */
  lstat?: (p: string) => { isSymbolicLink(): boolean };
  readlink?: (p: string) => string;
}

/**
 * The longest path `resolve` will look at, in characters (#1028).
 *
 * `resolve` is synchronous and runs on the main process, the one every
 * session's plumbing goes through, and a caller chooses the string. Linux
 * cannot open a path longer than this at all; nothing real on Windows comes
 * near it. Past it the answer is `invalid-path`, before the filesystem is
 * asked anything.
 */
export const MAX_SCOPE_PATH_CHARS = 4096;

/**
 * How many links that lead nowhere `resolve` will follow, one into the next,
 * before it gives up (#1028).
 *
 * SMALL ON PURPOSE. An honest broken link is one hop, occasionally two. And
 * the number CANNOT be made to agree with the operating system's own limit,
 * which is the trap the first version fell into: it used 40, "about what the
 * OS allows", and Windows follows 63. A chain of 41 links to a target outside
 * the scope then RESOLVED when the target existed (the OS followed all of it:
 * `out-of-scope`) and ran out of hops here when it did not, which answered
 * something else. Found by review, reproduced on Windows and Linux.
 *
 * So running out is not an answer of its own. It is "could not work out where
 * this leads", which is `out-of-scope`, the same thing a link out of the
 * scope answers when its target is there. Whatever the limit, present and
 * absent then agree.
 */
export const MAX_DANGLING_HOPS = 8;

/**
 * The most times one `resolve` may ask the filesystem to resolve something
 * while deciding about a path that did not resolve (#1028).
 *
 * THE BOUND ON MAIN'S TIME, and the only one that holds against a caller who
 * can also plant links. The binary search makes one miss cheap, but each hop
 * through a planted chain searches again over everything beneath it: measured
 * in review at 576 calls and 126 ms for a 41-link chain under a 4,096-
 * character path, which is WORSE than the 106 ms walk this change set out to
 * remove. With this budget the worst case is this many calls and no more,
 * whatever is planted. Running out answers `out-of-scope`, for the reason
 * above.
 */
export const MAX_MISSING_LOOKUPS = 64;

/**
 * A link's text, split into names on the separators this platform reads in
 * one: `/` everywhere, and the backslash as well on Windows. By character
 * code rather than a pattern, for `list-dir.ts`'s reason.
 */
function splitLinkText(text: string): string[] {
  const BACKSLASH = String.fromCharCode(92);
  return (path.sep === BACKSLASH ? text.split(BACKSLASH).join('/') : text).split('/');
}

/** Does this path begin with two separators: another machine, or a device? */
function isNetworkOrDevice(p: string): boolean {
  const isSep = (c: string | undefined): boolean => c === '/' || c === String.fromCharCode(92);
  return isSep(p[0]) && isSep(p[1]);
}

/** Thrown-shaped errors from `fs` carry a string `code`. */
function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
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
  /** folders the APP ships and granted itself — see `addBundled` */
  private readonly bundled = new Set<string>();
  private readonly realpath: (p: string) => string;
  private readonly lstat: (p: string) => { isSymbolicLink(): boolean };
  private readonly readlink: (p: string) => string;

  constructor(private readonly deps: ReadScopeDeps) {
    this.realpath = deps.realpath ?? ((p: string) => fs.realpathSync.native(p));
    this.lstat = deps.lstat ?? ((p: string) => fs.lstatSync(p));
    this.readlink = deps.readlink ?? ((p: string) => fs.readlinkSync(p));
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
   * Add a folder the APP ITSELF ships — today exactly one, the bundled user
   * manual behind Help ▸ User manual.
   *
   * A FOLDER, where a pick is a file, and that is the point: the manual's
   * pages link to each other, and a one-file grant refuses every one of those
   * links (the "picked file grants that file" note above). It is not the
   * widening that note declines to make, because nothing here is the user's:
   * the folder is the installer's own, its contents are ours, and the caller
   * is main — the renderer cannot name a folder to this method, it can only
   * ask for the manual and be told where it is.
   *
   * A SEPARATE SET from `picked`, so `pickedPaths()` and the "widened by the
   * user" log line stay true statements about what the user did.
   *
   * Answers whether the grant was made, because unlike a pick the caller has
   * something to do about a no — a manual that is not on disk is a menu item
   * that must say so rather than open an error page.
   */
  addBundled(dir: string): boolean {
    if (typeof dir !== 'string' || dir.length === 0) return false;
    const real = this.tryRealpath(path.resolve(dir));
    if (!real) return false;
    if (!this.bundled.has(real)) {
      this.bundled.add(real);
      this.deps.log.info('fs read scope includes a bundled folder', { path: real });
    }
    return true;
  }

  /**
   * Every root, RESOLVED — realpath'd session folders plus the picked and
   * bundled sets, which are stored resolved already.
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
    out.push(...this.picked, ...this.bundled);
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
        error: errorText(err),
      });
      return [];
    }
  }

  /**
   * The longest leading part of `p` that resolves, and what comes after it.
   *
   * `real` is that part as the OS sees it; `segment` is the next component of
   * `p`, the one resolution stopped at; `rest` is everything after that.
   * `segment` is undefined when all of `p` resolves. Undefined altogether when
   * not even the filesystem root does (an unplugged drive).
   *
   * A BINARY SEARCH, not a walk (#1028). On a POSIX filesystem, whether a
   * leading part resolves can only go from yes to no as it gets longer: to
   * resolve `a/b/c` the kernel has to get through `a` and `a/b` first. So the
   * longest one that resolves is found in about log2(depth) attempts. The walk
   * this replaces went up one segment at a time, each a blocking call on the
   * main process: measured at ~106 ms for a 2,000-segment path, which a
   * renderer can ask for a thousand times without waiting. The same path is
   * now about a dozen calls.
   *
   * (Windows can open `a\b\c` while refusing `a\b`, so the search may settle
   * on a shorter part than the longest there. That costs accuracy about WHICH
   * refusal a caller gets and never the refusal itself: whatever it settles on
   * is still checked against the scope.)
   *
   * `budget.left` is spent one per attempt and shared across a whole
   * `resolve`; when it is gone this answers undefined. See
   * `MAX_MISSING_LOOKUPS`.
   */
  private deepestReal(
    p: string,
    budget: { left: number }
  ): { real: string; segment: string | undefined; rest: string[] } | undefined {
    const root = path.parse(p).root;
    const segs = p
      .slice(root.length)
      .split(path.sep)
      .filter((seg) => seg.length > 0);
    const leading = (n: number): string => (n === 0 ? root : root + segs.slice(0, n).join(path.sep));
    const attemptAt = (n: number): string | undefined => {
      budget.left -= 1;
      return this.tryRealpath(leading(n));
    };
    let real = attemptAt(0);
    if (real === undefined) return undefined;
    let best = 0;
    let lo = 1;
    let hi = segs.length;
    while (lo <= hi) {
      if (budget.left <= 0) return undefined;
      const mid = (lo + hi) >> 1;
      const attempt = attemptAt(mid);
      if (attempt === undefined) {
        hi = mid - 1;
      } else {
        real = attempt;
        best = mid;
        lo = mid + 1;
      }
    }
    return { real, segment: segs[best], rest: segs.slice(best + 1) };
  }

  /**
   * Where a link that leads nowhere POINTS, as a path to carry on from: the
   * link's own text applied to the real folder it sits in, then whatever was
   * asked for beneath it. Undefined when that cannot be worked out safely.
   *
   * ⚠️ A `..` AFTER A NAME IS NOT FOLLOWED, AND THAT IS THE SAFETY OF THIS
   * FUNCTION. `sub/other/../x` means "x beside wherever `other` REALLY is" to
   * a POSIX kernel, and `other` may itself be a link out of the scope; worked
   * out on the string it means `sub/x`. A link written that way would read as
   * staying inside while leading out, which is the whole class of mistake this
   * file exists to refuse. LEADING `..`s are different: they are applied to
   * `realDir`, which has no links left in it, so climbing it as a string and
   * climbing it for real are the same thing. That covers the ordinary relative
   * link (`../README.md`); anything stranger gets the cautious answer.
   */
  private leadsTo(realDir: string, link: string, rest: readonly string[]): string | undefined {
    let base: string;
    let names: string[];
    if (path.isAbsolute(link)) {
      // NOT ANOTHER MACHINE, AND NOT A DEVICE. Working out where
      // `\\host\share\x` leads means asking that host, a login handshake to a
      // machine a planted link chose; the first attempt to resolve the path
      // already made one, and this must not make more.
      if (isNetworkOrDevice(link)) return undefined;
      base = path.parse(link).root;
      names = splitLinkText(link.slice(base.length));
    } else {
      base = realDir;
      names = splitLinkText(link).filter((n) => n.length > 0);
      while (names[0] === '..' || names[0] === '.') {
        if (names[0] === '..') base = path.dirname(base);
        names = names.slice(1);
      }
    }
    names = names.filter((n) => n.length > 0 && n !== '.');
    if (names.includes('..')) return undefined;
    const led = path.join(base, ...names, ...rest);
    // a link's text plus what was asked beneath it can be longer than either
    return led.length > MAX_SCOPE_PATH_CHARS ? undefined : led;
  }

  /**
   * A path did not resolve. What may the caller be told?
   *
   * THE RULE (#1028): THE ANSWER IS DECIDED BY WHERE THE PATH LEADS, NOT BY
   * WHETHER ANYTHING IS THERE. A caller may be told "that is not there" about
   * a place inside the scope, and about nowhere else.
   *
   * The first version of this asked one question: is the nearest thing that
   * DOES resolve in scope? That closed the oracle for any path spelled outside
   * the scope, and left it open for one spelled inside. Plant `root/probe`, a
   * link to anywhere on the machine. If the target exists the path resolves,
   * out of scope, and the answer is `out-of-scope`. If it does not, the
   * nearest thing that resolves is `root`, in scope, and the answer was
   * `not-found`. Two answers for one link, differing only in whether a path
   * the caller may not read exists: an existence check for the whole disk,
   * spelled from inside a folder the user did grant. (The same held for
   * `unreadable`, and for a link in the middle of a path.)
   *
   * So a link that leads nowhere is FOLLOWED ON PAPER: read where it points,
   * and ask the question again about that place. The answer is `not-found`
   * only if the place it leads to is itself inside the scope, which is the
   * honest broken link in somebody's project, and the viewer can still say so.
   * A link out of the scope answers `out-of-scope` whether or not its target
   * exists.
   *
   * EVERY WAY OF NOT KNOWING IS `out-of-scope`: a link whose text cannot be
   * worked out safely, a chain longer than `MAX_DANGLING_HOPS`, a search that
   * spent `MAX_MISSING_LOOKUPS`. Those are the answer a link out of the scope
   * gets when its target IS there, so none of them can be told apart from it.
   *
   * `lstat` and `readlink` are only ever asked about the direct child of a
   * folder that is in scope. (`realpath` is asked about places outside it, as
   * it always was: that is how a place is found to BE outside.)
   *
   * ⚠️ WHAT THIS DOES NOT CLOSE, said here so nobody reads "closed" into it:
   *
   *  - A LINK THAT GOES OUT AND COMES BACK, on Linux and macOS. `root/via`
   *    with the text `/outside/X/../../project/README.md` resolves, into the
   *    scope, exactly when `X` is a folder, and the answer is `ok`; otherwise
   *    it is a refusal. That is a path that DID resolve, so it never reaches
   *    this function, and it tells a caller whether `X` exists and is a
   *    folder. Closing it means walking a path that resolved and refusing a
   *    route that left the scope on the way, which is a change to the SUCCESS
   *    path and its own piece of work. (Windows collapses the `..` in a
   *    link's text on the string, so both cases answer the same there.)
   *  - TIMING. The reason is the same for present and absent; the work is
   *    not. A link out of the scope costs two lookups when its target is
   *    there and about a dozen when it is not, which a caller who repeats the
   *    question can measure.
   */
  private whyMissing(
    unresolved: string,
    roots: readonly string[],
    code: string | undefined
  ): ScopeRefusal {
    const inScope = (real: string): boolean => roots.some((root) => isWithinRoot(root, real));
    const missing: ScopeRefusal =
      // ENOENT (gone) and ENOTDIR (a segment in the middle is a file) are both
      // "that path is not there"
      code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable';
    const budget = { left: MAX_MISSING_LOOKUPS };
    let at = unresolved;
    for (let hop = 0; hop <= MAX_DANGLING_HOPS; hop += 1) {
      const found = this.deepestReal(at, budget);
      if (!found || !inScope(found.real)) return 'out-of-scope';
      // Everything resolves after all (a link was repaired under us, or the OS
      // and this walk disagree). In scope, so it may be named; and it is not
      // "missing", because something is there.
      if (found.segment === undefined) return 'unreadable';
      const stopped = path.join(found.real, found.segment);
      let link: string | undefined;
      try {
        if (this.lstat(stopped).isSymbolicLink()) link = this.readlink(stopped);
      } catch (err) {
        const why = errorCode(err);
        if (why !== 'ENOENT' && why !== 'ENOTDIR') return 'unreadable';
      }
      // Nothing there, or a plain file in the way: a miss inside the scope.
      if (link === undefined) return missing;
      const next = this.leadsTo(found.real, link, found.rest);
      if (next === undefined) return 'out-of-scope';
      at = next;
    }
    // More links than we follow. NOT a reason of its own: see
    // `MAX_DANGLING_HOPS` for the oracle that made of one.
    return 'out-of-scope';
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
    // Before the filesystem is asked anything: see `MAX_SCOPE_PATH_CHARS`.
    if (target.length > MAX_SCOPE_PATH_CHARS) return { ok: false, reason: 'invalid-path' };
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
    // exists to prevent? No, and `whyMissing` is why: a path that does not
    // resolve is only reported as missing when the place it LEADS TO is itself
    // in scope (#1028). `whyMissing` says exactly what that covers, and the
    // two things it does not.
    let real: string;
    try {
      real = this.realpath(resolved);
    } catch (err) {
      return { ok: false, reason: this.whyMissing(resolved, roots, errorCode(err)) };
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
