// The read scope (P2-E16-01, §5.30 + §5.29).
//
// This is a SECURITY CHECK, so the tests are the deliverable in the way
// `refusal.test.ts`'s are: nothing in the shipped app can currently ask for a
// path outside a session folder, and the whole value of the check is what it
// does on the day something can. Table-driven for the same reason it takes a
// `PathStyle` — the Windows convention and the POSIX one both get asserted on
// whichever machine runs the suite, instead of half the rule going untested on
// each.
//
// Every hostile path here is a STRING inside this fixture, or a file under a
// temp directory this file made. Nothing is written outside the repo or the
// tracked temp dirs, and nothing outside them is read.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createLogger, LogSink } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';
import {
  HOST_STYLE,
  MAX_DANGLING_HOPS,
  MAX_MISSING_LOOKUPS,
  MAX_SCOPE_PATH_CHARS,
  isWithinRoot,
  POSIX_STYLE,
  ReadScope,
  WIN32_STYLE,
} from './read-scope';

const LOG_DIR = tempDir('sb-fsscope-log-');
const log = createLogger(new LogSink({ dir: LOG_DIR }), 'fs');

describe('isWithinRoot — the containment rule', () => {
  // [what it is, root, target, expected]
  const posix: Array<[string, string, string, boolean]> = [
    ['the root itself', '/home/dan/project', '/home/dan/project', true],
    ['a file directly inside', '/home/dan/project', '/home/dan/project/PROGRESS.md', true],
    ['a file deep inside', '/home/dan/project', '/home/dan/project/docs/plans/00.md', true],
    ['a root written with a trailing slash', '/home/dan/project/', '/home/dan/project/a.md', true],
    ['the parent', '/home/dan/project', '/home/dan', false],
    ['a sibling', '/home/dan/project', '/home/dan/other/a.md', false],
    // The one that catches a naive `startsWith`: the sibling's name BEGINS with
    // the root's, so without the separator boundary it reads as "inside".
    ['a sibling whose name extends the root', '/home/dan/project', '/home/dan/project-secrets/k', false],
    ['a totally unrelated path', '/home/dan/project', '/etc/passwd', false],
    ['the user home the scope exists to refuse', '/home/dan/project', '/home/dan/.ssh/id_rsa', false],
    ['a differently-cased root, on a case-sensitive fs', '/home/dan/project', '/home/dan/Project/a.md', false],
    ['an empty root', '', '/home/dan/project/a.md', false],
    ['an empty target', '/home/dan/project', '', false],
    // The filesystem root as a root: absurd as a session folder, but a
    // boundary built by appending a separator would make it `//` and refuse
    // everything — a check that silently allows nothing is a check nobody
    // notices is broken.
    ['the filesystem root', '/', '/etc/passwd', true],
    ['the filesystem root against itself', '/', '/', true],
  ];

  for (const [what, root, target, expected] of posix) {
    it(`posix: ${what} → ${expected ? 'inside' : 'outside'}`, () => {
      expect(isWithinRoot(root, target, POSIX_STYLE)).toBe(expected);
    });
  }

  const win: Array<[string, string, string, boolean]> = [
    ['the root itself', 'C:\\Projects\\app', 'C:\\Projects\\app', true],
    ['a file inside', 'C:\\Projects\\app', 'C:\\Projects\\app\\PROGRESS.md', true],
    ['a root with a trailing backslash', 'C:\\Projects\\app\\', 'C:\\Projects\\app\\a.md', true],
    ['a drive root', 'C:\\', 'C:\\Projects\\app\\a.md', true],
    ['a sibling whose name extends the root', 'C:\\Projects\\app', 'C:\\Projects\\app-secrets\\k', false],
    ['another drive entirely', 'C:\\Projects\\app', 'D:\\Projects\\app\\a.md', false],
    ['the parent', 'C:\\Projects\\app', 'C:\\Projects', false],
    // Windows does not distinguish case, so refusing this one would refuse a
    // legitimate read of the very same file.
    ['a differently-cased path, which is the SAME file here', 'C:\\Projects\\app', 'c:\\projects\\APP\\a.md', true],
    ['a UNC share it was not given', '\\\\server\\share', '\\\\server\\other\\a.md', false],
    ['a file under the UNC share it WAS given', '\\\\server\\share', '\\\\server\\share\\a.md', true],
  ];

  for (const [what, root, target, expected] of win) {
    it(`win32: ${what} → ${expected ? 'inside' : 'outside'}`, () => {
      expect(isWithinRoot(root, target, WIN32_STYLE)).toBe(expected);
    });
  }

  it('the host style matches the platform we are on', () => {
    expect(HOST_STYLE.sep).toBe(path.sep);
    expect(HOST_STYLE.caseInsensitive).toBe(
      process.platform === 'win32' || process.platform === 'darwin'
    );
  });
});

// ── ReadScope, with the filesystem faked ───────────────────────────────────
//
// A fake `realpath` is what makes a SYMLINK testable as a table: the resolver
// is the only thing that knows a path was a link, so a map from "what was
// asked" to "what it really is" reproduces every escape without needing the
// privilege to create one. The real-filesystem version of the same case is at
// the bottom of the file — both, because the fake proves the rule and the real
// one proves the wiring.
const ROOT = path.resolve(path.sep === '\\' ? 'C:\\Projects\\app' : '/home/dan/app');
const OUTSIDE = path.resolve(path.sep === '\\' ? 'C:\\Users\\dan\\.ssh' : '/home/dan/.ssh');
const inRoot = (...segs: string[]): string => path.join(ROOT, ...segs);
const outside = (...segs: string[]): string => path.join(OUTSIDE, ...segs);

/**
 * Every path is itself, except the ones this map re-points (the symlinks).
 *
 * Links are followed BEFORE `missing` is consulted, because that is the order
 * the real thing works in: a symlink to a file that is not there fails at the
 * destination, not at the link.
 */
function fakeRealpath(links: Record<string, string> = {}, missing: string[] = []) {
  return (p: string): string => {
    const resolved = path.resolve(p);
    let mapped = resolved;
    for (const [from, to] of Object.entries(links)) {
      if (isWithinRoot(from, resolved)) {
        mapped = path.join(to, path.relative(from, resolved));
        break;
      }
    }
    if (missing.includes(mapped) || missing.includes(resolved)) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${mapped}`);
      err.code = 'ENOENT';
      throw err;
    }
    return mapped;
  };
}

function scopeWith(opts: {
  folders?: string[];
  links?: Record<string, string>;
  missing?: string[];
}): ReadScope {
  return new ReadScope({
    sessionFolders: () => opts.folders ?? [ROOT],
    log,
    realpath: fakeRealpath(opts.links, opts.missing),
    // This fake models a link as a re-pointed prefix, so nothing it is asked
    // to DESCRIBE is one. (Without this the default would be the real disk,
    // asked about paths that exist only in this file.) Links that lead
    // nowhere have a fuller fake of their own, further down.
    lstat: (q: string) => {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${q}`);
      err.code = 'ENOENT';
      throw err;
    },
  });
}

describe('ReadScope.resolve', () => {
  it('allows a file inside an open session folder', () => {
    expect(scopeWith({}).resolve(inRoot('PROGRESS.md'))).toEqual({
      ok: true,
      path: inRoot('PROGRESS.md'),
    });
  });

  it('allows a file deep inside one', () => {
    const r = scopeWith({}).resolve(inRoot('docs', 'plans', '04.md'));
    expect(r.ok).toBe(true);
  });

  it('refuses a path outside every open session folder', () => {
    expect(scopeWith({}).resolve(outside('id_rsa'))).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses when there are no open sessions at all', () => {
    // The empty scope refuses everything, which is the right starting state:
    // a fresh workspace grants nothing.
    expect(scopeWith({ folders: [] }).resolve(inRoot('PROGRESS.md'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  // ── the escapes ─────────────────────────────────────────────────────────
  const traversals: Array<[string, string]> = [
    ['a plain ../ climb', inRoot('..', '..', 'Users', 'dan', '.ssh', 'id_rsa')],
    ['a climb that returns into a sibling', inRoot('docs', '..', '..', 'app-secrets', 'k')],
    ['a doubled climb hidden mid-path', inRoot('a', 'b', '..', '..', '..', 'other', 'x')],
  ];
  for (const [what, target] of traversals) {
    it(`refuses ${what}`, () => {
      expect(scopeWith({}).resolve(target)).toEqual({ ok: false, reason: 'out-of-scope' });
    });
  }

  it('allows a ../ that stays inside — the check is on the destination, not the spelling', () => {
    // Refusing every path containing `..` would be a string check pretending to
    // be a path check; this one lands back in the root and is perfectly fine.
    const r = scopeWith({}).resolve(inRoot('docs', '..', 'PROGRESS.md'));
    expect(r).toEqual({ ok: true, path: inRoot('PROGRESS.md') });
  });

  it('refuses a symlink inside the root that points OUT of it', () => {
    const scope = scopeWith({ links: { [inRoot('escape')]: OUTSIDE } });
    expect(scope.resolve(inRoot('escape', 'id_rsa'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('refuses a symlink AT the root pointing out, rather than trusting the name', () => {
    const scope = scopeWith({ links: { [inRoot('link.md')]: outside('id_rsa') } });
    expect(scope.resolve(inRoot('link.md'))).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('allows a symlink that lands back inside the root', () => {
    const scope = scopeWith({ links: { [inRoot('alias.md')]: inRoot('PROGRESS.md') } });
    expect(scope.resolve(inRoot('alias.md'))).toEqual({ ok: true, path: inRoot('PROGRESS.md') });
  });

  it('answers with the REAL path, so the reader cannot be swapped afterwards', () => {
    const scope = scopeWith({ links: { [inRoot('alias.md')]: inRoot('docs', 'real.md') } });
    const r = scope.resolve(inRoot('alias.md'));
    expect(r.ok && r.path).toBe(inRoot('docs', 'real.md'));
  });

  it('follows a session folder that is ITSELF a symlink', () => {
    // The root resolves too, or a perfectly legitimate read of a card whose
    // folder is a symlink would be refused — fail-closed, but wrong.
    const real = path.resolve(path.sep === '\\' ? 'D:\\real\\app' : '/mnt/real/app');
    const scope = scopeWith({ links: { [ROOT]: real } });
    expect(scope.resolve(inRoot('PROGRESS.md'))).toEqual({
      ok: true,
      path: path.join(real, 'PROGRESS.md'),
    });
  });

  // ── inputs that are not paths ───────────────────────────────────────────
  const invalid: Array<[string, unknown]> = [
    ['a relative path', path.join('docs', 'a.md')],
    ['a bare filename', 'PROGRESS.md'],
    ['the empty string', ''],
    ['whitespace', '   '],
    ['a NUL-truncation attempt', `${path.join(ROOT, 'PROGRESS.md')}\0.png`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { path: '/etc/passwd' }],
    ['an array', ['/etc/passwd']],
  ];
  for (const [what, target] of invalid) {
    it(`refuses ${what} as invalid, without touching the disk`, () => {
      expect(scopeWith({}).resolve(target)).toEqual({ ok: false, reason: 'invalid-path' });
    });
  }

  it('says not-found for a path that resolves nowhere', () => {
    const gone = inRoot('gone.md');
    expect(scopeWith({ missing: [gone] }).resolve(gone)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('is not an EXISTENCE ORACLE: an out-of-scope path answers the same either way', () => {
    // The bug this pins. If the scope check ran after the realpath, an
    // out-of-scope ask would answer `not-found` for a path that is not there
    // and `out-of-scope` for one that is — and a caller could map a filesystem
    // it may read none of by watching which refusal it got. That is `fs.probe`
    // smuggled inside `fs.read`, which is the one conflation this capability
    // exists to prevent. Present and absent must be indistinguishable.
    const present = outside('id_rsa');
    const absent = outside('nope');
    const scope = scopeWith({ missing: [absent] });
    expect(scope.resolve(present)).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(scope.resolve(absent)).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('a symlink INSIDE the root is not an oracle for what is on the other side', () => {
    // The sharper version of the same bug, and the one that survives a naive
    // fix. `root/escape` is planted by whoever can write in the repository —
    // one line for an agent — and it points out. Both asks pass the first pass
    // by SPELLING, so the answer has to come out the same whether the file
    // behind the link exists or not, or `fs.read` is `fs.probe` for the whole
    // disk from inside a folder the user did grant.
    const scope = scopeWith({
      links: { [inRoot('escape')]: OUTSIDE },
      missing: [outside('nope')],
    });
    expect(scope.resolve(inRoot('escape', 'id_rsa'))).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(scope.resolve(inRoot('escape', 'nope'))).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('still says not-found for a missing file whose PARENT is genuinely in scope', () => {
    // The other side of the fix: the anchor check must not turn every miss into
    // "out of scope", or the viewer can never say "that file is gone".
    const gone = inRoot('docs', 'gone.md');
    expect(scopeWith({ missing: [gone] }).resolve(gone)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('accepts a path SPELLED unlike the root it resolves into', () => {
    // The regression CI found. GitHub's Windows runners hand out
    // `C:\Users\RUNNER~1\AppData\Local\Temp` — an 8.3 short name — which
    // `realpath.native` expands to `runneradmin`. An earlier version of this
    // check refused anything whose spelling was not under a root BEFORE
    // resolving it, and so refused a legitimate read of a granted file because
    // two true spellings of the same directory are different strings. A
    // symlinked prefix above a session folder does exactly the same thing.
    const alias = path.resolve(path.sep === '\\' ? 'C:\\PROGRA~1\\app' : '/short/app');
    const scope = scopeWith({ links: { [alias]: ROOT } });
    expect(scope.resolve(path.join(alias, 'PROGRESS.md'))).toEqual({
      ok: true,
      path: inRoot('PROGRESS.md'),
    });
  });
});

describe('the picked set — the seam for the native dialog (§5.30)', () => {
  it('starts empty: open session folders and nothing else', () => {
    const scope = scopeWith({});
    expect(scope.pickedPaths()).toEqual([]);
    expect(scope.resolve(outside('notes.md'))).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('a picked path becomes readable, and only it', () => {
    const scope = scopeWith({});
    scope.addPicked(outside('notes.md'));
    expect(scope.resolve(outside('notes.md'))).toEqual({ ok: true, path: outside('notes.md') });
    // its siblings did NOT come with it
    expect(scope.resolve(outside('id_rsa'))).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('picking a DIRECTORY opens what is under it, and nothing above it', () => {
    const scope = scopeWith({});
    scope.addPicked(OUTSIDE);
    expect(scope.resolve(outside('a', 'b.md')).ok).toBe(true);
    expect(scope.resolve(path.join(OUTSIDE, '..', 'elsewhere.md'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('stores the picked path RESOLVED, so a symlinked pick cannot widen it', () => {
    const scope = scopeWith({ links: { [outside('alias')]: outside('real') } });
    scope.addPicked(outside('alias'));
    expect(scope.pickedPaths()).toEqual([outside('real')]);
  });

  it('ignores a pick that cannot be resolved, and anything that is not a path', () => {
    const scope = scopeWith({ missing: [outside('vanished')] });
    scope.addPicked(outside('vanished'));
    scope.addPicked('');
    expect(scope.pickedPaths()).toEqual([]);
  });
});

describe('the bundled set — a folder the app ships (Help ▸ User manual)', () => {
  it('grants the FOLDER, so one page can link to the next', () => {
    const scope = scopeWith({});
    expect(scope.addBundled(OUTSIDE)).toBe(true);
    expect(scope.resolve(outside('00-day-one.md')).ok).toBe(true);
    expect(scope.resolve(outside('02-sessions.md')).ok).toBe(true);
    // …and nothing above it
    expect(scope.resolve(path.join(OUTSIDE, '..', 'elsewhere.md'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('is NOT a pick: the picked set stays a record of what the user chose', () => {
    const scope = scopeWith({});
    scope.addBundled(OUTSIDE);
    expect(scope.pickedPaths()).toEqual([]);
  });

  it('is stored RESOLVED, so a link out of the folder is still refused', () => {
    // the folder itself reached through an alias is the real folder…
    const scope = scopeWith({
      links: { [outside('alias')]: outside('real'), [outside('real', 'escape.md')]: inRoot('..', 'x') },
    });
    expect(scope.addBundled(outside('alias'))).toBe(true);
    expect(scope.resolve(outside('real', 'page.md')).ok).toBe(true);
    // …and a member that RESOLVES somewhere else is judged on where it lands
    expect(scope.resolve(outside('real', 'escape.md'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('answers false for a folder that is not there, and grants nothing', () => {
    const scope = scopeWith({ missing: [outside('vanished')] });
    expect(scope.addBundled(outside('vanished'))).toBe(false);
    expect(scope.addBundled('')).toBe(false);
    expect(scope.roots()).toEqual(scopeWith({}).roots());
  });
});

// ---------------------------------------------------------------------------
// #1028. What a path that does NOT resolve may be told.
//
// The fake above models a link as a re-pointed prefix, which cannot express
// the case this is about: a link that leads NOWHERE. This one is a small
// filesystem in memory (folders, files, links with their own text), resolved
// the way a POSIX kernel resolves: one component at a time, a link followed
// where it stands, `..` climbing from wherever resolution really is.
// ---------------------------------------------------------------------------
interface MemFs {
  realpath: (p: string) => string;
  lstat: (p: string) => { isSymbolicLink(): boolean };
  readlink: (p: string) => string;
  /** every path `realpath` and `lstat` were asked about, in order */
  asked: { realpath: string[]; lstat: string[] };
}

function memFs(spec: { dirs?: string[]; files?: string[]; links?: Record<string, string>; denied?: string[] }): MemFs {
  const fail = (code: string, p: string): never => {
    const err: NodeJS.ErrnoException = new Error(`${code}: ${p}`);
    err.code = code;
    throw err;
  };
  const dirs = new Set<string>();
  const files = new Set((spec.files ?? []).map((f) => path.resolve(f)));
  const links = new Map(Object.entries(spec.links ?? {}).map(([k, v]) => [path.resolve(k), v]));
  const denied = new Set((spec.denied ?? []).map((d) => path.resolve(d)));
  const withAncestors = (p: string): void => {
    for (let d = path.resolve(p); ; d = path.dirname(d)) {
      dirs.add(d);
      if (path.dirname(d) === d) break;
    }
  };
  for (const d of spec.dirs ?? []) withAncestors(d);
  for (const f of [...files, ...links.keys()]) withAncestors(path.dirname(f));

  const asked = { realpath: [] as string[], lstat: [] as string[] };
  const walk = (p: string, hops: number): string => {
    // 63, which is what Windows was measured to follow, and deliberately NOT
    // the number `resolve` stops at: a fake that gave up where the code under
    // test gives up could never show the two disagreeing, which was the bug
    if (hops > 63) fail('ELOOP', p);
    const root = path.parse(p).root;
    const segs = p.slice(root.length).split(path.sep).filter((seg) => seg.length > 0);
    let at = root;
    for (let i = 0; i < segs.length; i += 1) {
      if (segs[i] === '.') continue;
      if (segs[i] === '..') {
        at = path.dirname(at);
        continue;
      }
      const next = path.join(at, segs[i]);
      const link = links.get(next);
      if (link !== undefined) {
        // the link's text, then whatever was asked for beneath it, UNNORMALISED
        const from = path.isAbsolute(link) ? link : `${at}${path.sep}${link}`;
        return walk([from, ...segs.slice(i + 1)].join(path.sep), hops + 1);
      }
      if (denied.has(next)) fail('EACCES', next);
      if (files.has(next)) {
        if (i < segs.length - 1) fail('ENOTDIR', next);
      } else if (!dirs.has(next)) {
        fail('ENOENT', next);
      }
      at = next;
    }
    return at;
  };
  return {
    asked,
    realpath: (p) => {
      asked.realpath.push(p);
      return walk(path.resolve(p), 0);
    },
    lstat: (p) => {
      asked.lstat.push(p);
      const r = path.resolve(p);
      if (links.has(r)) return { isSymbolicLink: () => true };
      if (dirs.has(r) || files.has(r)) return { isSymbolicLink: () => false };
      return fail('ENOENT', r);
    },
    readlink: (p) => links.get(path.resolve(p)) ?? fail('EINVAL', p),
  };
}

function scopeOn(fsys: MemFs, folders: string[] = [ROOT]): ReadScope {
  return new ReadScope({
    sessionFolders: () => folders,
    log,
    realpath: fsys.realpath,
    lstat: fsys.lstat,
    readlink: fsys.readlink,
  });
}

const OUT = { ok: false, reason: 'out-of-scope' } as const;
const GONE = { ok: false, reason: 'not-found' } as const;

describe('a path that does not resolve: the answer is where it LEADS, never whether it is there (#1028)', () => {
  it('a link planted in the root is not an existence check for its target', () => {
    // THE BUG. `root/probe` is one line for an agent to write, and it can point
    // anywhere on the machine. Present and absent used to answer differently.
    const present = memFs({ dirs: [ROOT], files: [outside('id_rsa')], links: { [inRoot('probe')]: outside('id_rsa') } });
    const absent = memFs({ dirs: [ROOT, OUTSIDE], links: { [inRoot('probe')]: outside('id_rsa') } });
    expect(scopeOn(present).resolve(inRoot('probe'))).toEqual(OUT);
    expect(scopeOn(absent).resolve(inRoot('probe'))).toEqual(OUT);
  });

  it('...nor when the target’s whole folder is missing, nor for a path BENEATH the link', () => {
    const nowhere = path.resolve(path.sep === '\\' ? 'C:\\no\\such\\place' : '/no/such/place');
    const fsys = memFs({ dirs: [ROOT], links: { [inRoot('probe')]: nowhere } });
    expect(scopeOn(fsys).resolve(inRoot('probe'))).toEqual(OUT);
    expect(scopeOn(fsys).resolve(inRoot('probe', 'deeper', 'file.txt'))).toEqual(OUT);
    // ...and with the place there but not the thing in it
    const partly = memFs({ dirs: [ROOT, nowhere], links: { [inRoot('probe')]: nowhere } });
    expect(scopeOn(partly).resolve(inRoot('probe', 'deeper', 'file.txt'))).toEqual(OUT);
  });

  it('...nor a link in the MIDDLE of a path', () => {
    const fsys = (files: string[]): MemFs =>
      memFs({ dirs: [inRoot('docs'), OUTSIDE], files, links: { [inRoot('docs', 'keys')]: OUTSIDE } });
    expect(scopeOn(fsys([outside('id_rsa')])).resolve(inRoot('docs', 'keys', 'id_rsa'))).toEqual(OUT);
    expect(scopeOn(fsys([])).resolve(inRoot('docs', 'keys', 'id_rsa'))).toEqual(OUT);
  });

  it('"it is there but may not be read" and "it is not there" are one answer too', () => {
    const unreadable = memFs({ dirs: [ROOT, OUTSIDE], denied: [outside('vault')], links: { [inRoot('probe')]: outside('vault', 'x') } });
    const absent = memFs({ dirs: [ROOT, OUTSIDE], links: { [inRoot('probe')]: outside('vault', 'x') } });
    expect(scopeOn(unreadable).resolve(inRoot('probe'))).toEqual(OUT);
    expect(scopeOn(absent).resolve(inRoot('probe'))).toEqual(OUT);
  });

  it('an honest broken link INSIDE the scope is still "not found": the viewer can say so', () => {
    // the trade the ticket was afraid of, not made
    const absolute = memFs({ dirs: [inRoot('docs')], links: { [inRoot('docs', 'latest.md')]: inRoot('docs', 'v2.md') } });
    expect(scopeOn(absolute).resolve(inRoot('docs', 'latest.md'))).toEqual(GONE);
    // the ordinary RELATIVE link, sideways and upwards
    const sideways = memFs({ dirs: [inRoot('docs')], links: { [inRoot('docs', 'latest.md')]: 'v2.md' } });
    expect(scopeOn(sideways).resolve(inRoot('docs', 'latest.md'))).toEqual(GONE);
    const upwards = memFs({ dirs: [inRoot('docs')], links: { [inRoot('docs', 'README.md')]: ['..', 'README.md'].join(path.sep) } });
    expect(scopeOn(upwards).resolve(inRoot('docs', 'README.md'))).toEqual(GONE);
  });

  it('a relative link that CLIMBS OUT of the scope is out of scope, present or absent', () => {
    const up = ['..', '..', 'elsewhere', 'x'].join(path.sep);
    const elsewhere = path.join(path.dirname(ROOT), 'elsewhere');
    const absent = memFs({ dirs: [inRoot('docs')], links: { [inRoot('docs', 'probe')]: up } });
    const present = memFs({ dirs: [inRoot('docs')], files: [path.join(elsewhere, 'x')], links: { [inRoot('docs', 'probe')]: up } });
    expect(scopeOn(absent).resolve(inRoot('docs', 'probe'))).toEqual(OUT);
    expect(scopeOn(present).resolve(inRoot('docs', 'probe'))).toEqual(OUT);
  });

  it('a chain of links is followed to its end: out if it ends out, missing if it ends in', () => {
    const endsOut = memFs({
      dirs: [ROOT, OUTSIDE],
      links: { [inRoot('a')]: inRoot('b'), [inRoot('b')]: outside('nope') },
    });
    expect(scopeOn(endsOut).resolve(inRoot('a'))).toEqual(OUT);
    const endsIn = memFs({ dirs: [ROOT], links: { [inRoot('a')]: inRoot('b'), [inRoot('b')]: inRoot('c.md') } });
    expect(scopeOn(endsIn).resolve(inRoot('a'))).toEqual(GONE);
  });

  it('a `..` AFTER a name in a link’s text is not worked out on the string', () => {
    // `sub/esc/../x` is "x beside wherever `esc` REALLY is", and `esc` leads
    // out. Collapsed as a string it is `sub/x`, inside. The link leads out
    // whether or not `x` is there, and both must say so.
    const text = ['sub', 'esc', '..', 'x'].join(path.sep);
    const spec = { dirs: [inRoot('sub'), outside('deep')], links: { [inRoot('probe')]: text, [inRoot('sub', 'esc')]: outside('deep') } };
    expect(scopeOn(memFs({ ...spec, files: [outside('x')] })).resolve(inRoot('probe'))).toEqual(OUT);
    expect(scopeOn(memFs(spec)).resolve(inRoot('probe'))).toEqual(OUT);
  });

  it('links that only lead to each other end, and are not an answer of their own', () => {
    const fsys = memFs({ dirs: [ROOT], links: { [inRoot('a')]: inRoot('b'), [inRoot('b')]: inRoot('a') } });
    expect(scopeOn(fsys).resolve(inRoot('a'))).toEqual(OUT);
    expect(fsys.asked.lstat.length).toBeLessThanOrEqual(MAX_DANGLING_HOPS + 1);
  });

  // THE BUG THE REVIEW FOUND IN THE FIRST VERSION OF THIS FIX. A chain longer
  // than `resolve` follows, and no longer than the OS follows: with the target
  // there the OS resolves all of it; with the target gone, `resolve` used to
  // run out of hops and say something different.
  for (const length of [MAX_DANGLING_HOPS, MAX_DANGLING_HOPS + 1, MAX_DANGLING_HOPS + 2, 41, 62]) {
    it(`a chain of ${length} links out of the scope: present and absent are one answer`, () => {
      const chain = (files: string[]): MemFs => {
        const links: Record<string, string> = {};
        for (let i = 1; i < length; i += 1) links[inRoot('c', `j${i}`)] = inRoot('c', `j${i + 1}`);
        links[inRoot('c', `j${length}`)] = outside('T');
        return memFs({ dirs: [inRoot('c'), OUTSIDE], files, links });
      };
      const present = scopeOn(chain([outside('T')])).resolve(inRoot('c', 'j1'));
      const absent = scopeOn(chain([])).resolve(inRoot('c', 'j1'));
      expect(present).toEqual(OUT);
      expect(absent).toEqual(present);
    });
  }

  it('a link to another machine, or to a device, is not asked about again', () => {
    if (path.sep !== '\\') return; // a POSIX path that starts `//` is just a path
    const unc = ['', '', 'attacker', 'share', 'x'].join(path.sep);
    const fsys = memFs({ dirs: [ROOT], links: { [inRoot('p')]: unc } });
    expect(scopeOn(fsys).resolve(inRoot('p'))).toEqual(OUT);
    // the one attempt to resolve what was asked for, and nothing that names the host after it
    expect(fsys.asked.realpath.slice(1).some((q) => q.includes('attacker'))).toBe(false);
  });

  it('an ABSOLUTE link whose text has a `..` in it is not worked out on the string either', () => {
    const text = [outside('deep'), '..', '..', path.basename(ROOT), 'x'].join(path.sep);
    const spec = { dirs: [ROOT, OUTSIDE], links: { [inRoot('probe')]: text } };
    expect(scopeOn(memFs({ ...spec, dirs: [ROOT, outside('deep')] })).resolve(inRoot('probe'))).toEqual(OUT);
    expect(scopeOn(memFs(spec)).resolve(inRoot('probe'))).toEqual(OUT);
  });

  it('a failure to DESCRIBE what is in the way is "unreadable", inside the scope', () => {
    const fsys = memFs({ dirs: [ROOT] });
    const denied: NodeJS.ErrnoException = new Error('EACCES');
    denied.code = 'EACCES';
    const scope = new ReadScope({
      sessionFolders: () => [ROOT],
      log,
      realpath: fsys.realpath,
      lstat: () => {
        throw denied;
      },
      readlink: fsys.readlink,
    });
    expect(scope.resolve(inRoot('locked', 'x'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a link whose text cannot be READ is a miss inside the scope, not a throw', () => {
    const fsys = memFs({ dirs: [ROOT], links: { [inRoot('odd')]: inRoot('gone') } });
    const scope = new ReadScope({
      sessionFolders: () => [ROOT],
      log,
      realpath: fsys.realpath,
      lstat: fsys.lstat,
      readlink: () => {
        const err: NodeJS.ErrnoException = new Error('EINVAL');
        err.code = 'EINVAL';
        throw err;
      },
    });
    expect(scope.resolve(inRoot('odd'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a path the walk finds whole, though the OS said no, is not called "not found"', () => {
    // the OS and the on-paper walk disagreeing: something IS there
    let calls = 0;
    const scope = new ReadScope({
      sessionFolders: () => [ROOT],
      log,
      realpath: (q: string) => {
        calls += 1;
        // the root list asks first, then the path itself: refuse that one ask
        if (calls === 2) {
          const err: NodeJS.ErrnoException = new Error('EIO');
          err.code = 'EIO';
          throw err;
        }
        return path.resolve(q);
      },
      lstat: () => ({ isSymbolicLink: () => false }),
    });
    expect(scope.resolve(inRoot('flaky.md'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('never DESCRIBES or READS a link outside the scope to decide (it may resolve one: that is how outside is found)', () => {
    const fsys = memFs({
      dirs: [ROOT, OUTSIDE],
      links: { [inRoot('a')]: outside('link2'), [outside('link2')]: inRoot('real.md') },
    });
    scopeOn(fsys).resolve(inRoot('a'));
    scopeOn(fsys).resolve(outside('nope'));
    for (const p of fsys.asked.lstat) expect(isWithinRoot(ROOT, p), p).toBe(true);
  });

  it('a plain miss, and a file in the way, are still "not found" inside the scope', () => {
    const fsys = memFs({ dirs: [inRoot('docs')], files: [inRoot('notes.txt')] });
    expect(scopeOn(fsys).resolve(inRoot('docs', 'gone.md'))).toEqual(GONE);
    expect(scopeOn(fsys).resolve(inRoot('docs', 'a', 'b', 'c.md'))).toEqual(GONE);
    expect(scopeOn(fsys).resolve(inRoot('notes.txt', 'inside'))).toEqual(GONE);
    expect(scopeOn(fsys).resolve(outside('gone.md'))).toEqual(OUT);
  });
});

describe('`resolve` cannot be made to hold the main process (#1028)', () => {
  it('finds the deepest folder that exists in a handful of asks, however deep the path', () => {
    // 2,000 segments was ~106 ms of frozen main process, one blocking call per
    // segment, and a renderer can send a thousand of them without waiting
    const fsys = memFs({ dirs: [inRoot('a', 'b')] });
    const deep = inRoot('a', 'b', ...Array.from({ length: 1500 }, () => 'x'));
    expect(deep.length).toBeLessThanOrEqual(MAX_SCOPE_PATH_CHARS);
    expect(scopeOn(fsys).resolve(deep)).toEqual(GONE);
    // one for the root folder, one for the path, then a binary search
    expect(fsys.asked.realpath.length).toBeLessThan(20);
  });

  it('does the same for a deep path OUTSIDE the scope, and says only that it is outside', () => {
    const fsys = memFs({ dirs: [ROOT, OUTSIDE] });
    const deep = outside(...Array.from({ length: 1500 }, () => 'x'));
    expect(scopeOn(fsys).resolve(deep)).toEqual(OUT);
    expect(fsys.asked.realpath.length).toBeLessThan(20);
  });

  it('a planted chain of links under a very long path cannot multiply the cost', () => {
    // THE OTHER THING THE REVIEW FOUND: each hop searched again over everything
    // beneath it. 41 links and a 4,096-character path measured 576 lookups and
    // 126 ms of held main process, worse than the walk this replaced.
    const links: Record<string, string> = {};
    for (let i = 1; i <= 41; i += 1) links[inRoot('w', `k${i}`)] = inRoot('w', `k${i + 1}`);
    const fsys = memFs({ dirs: [inRoot('w')], links });
    const tail = Array.from({ length: 1700 }, () => 'x');
    const deep = inRoot('w', 'k1', ...tail);
    expect(deep.length).toBeLessThanOrEqual(MAX_SCOPE_PATH_CHARS);
    expect(scopeOn(fsys).resolve(deep)).toEqual(OUT);
    // one for the root folder, one for the path, and never more than the budget after that
    expect(fsys.asked.realpath.length).toBeLessThanOrEqual(MAX_MISSING_LOOKUPS + 2);
    expect(fsys.asked.lstat.length).toBeLessThanOrEqual(MAX_DANGLING_HOPS + 1);
  });

  it('a link’s text cannot carry the path past the length limit', () => {
    const long = inRoot(...Array.from({ length: 1900 }, () => 'y'));
    const fsys = memFs({ dirs: [ROOT], links: { [inRoot('far')]: long } });
    const deep = inRoot('far', ...Array.from({ length: 1900 }, () => 'z'));
    expect(deep.length).toBeLessThanOrEqual(MAX_SCOPE_PATH_CHARS);
    expect(scopeOn(fsys).resolve(deep)).toEqual(OUT);
  });

  it('refuses a path past the length limit before asking the filesystem anything', () => {
    const fsys = memFs({ dirs: [ROOT] });
    const huge = inRoot(...Array.from({ length: 3000 }, () => 'xx'));
    expect(huge.length).toBeGreaterThan(MAX_SCOPE_PATH_CHARS);
    expect(scopeOn(fsys).resolve(huge)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(fsys.asked.realpath).toEqual([]);
    // exactly at the limit is still looked at
    const pad = MAX_SCOPE_PATH_CHARS - inRoot('').length - 1;
    const atLimit = inRoot('y'.repeat(pad));
    expect(atLimit.length).toBeLessThanOrEqual(MAX_SCOPE_PATH_CHARS);
    expect(scopeOn(fsys).resolve(atLimit)).toEqual(GONE);
  });
});

// ── the same rule, against a real filesystem ───────────────────────────────
//
// The fake resolver above proves the RULE; this proves the WIRING — that the
// default `realpath` is actually resolving links, and that a real `..` behaves
// the way the table says. Symlink creation needs a privilege on Windows that a
// developer box may not have (a junction does not, which is why the directory
// case uses one), so the file case skips rather than fails when the OS says no.
describe('against a real filesystem', () => {
  const base = tempDir('sb-fsscope-');
  const root = path.join(base, 'project');
  const secrets = path.join(base, 'secrets');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(root, 'PROGRESS.md'), '# progress\n');
  fs.writeFileSync(path.join(secrets, 'id_rsa'), 'PRIVATE KEY\n');

  const scope = new ReadScope({ sessionFolders: () => [root], log });

  /**
   * Make a link, and say whether it happened.
   *
   * A creation that fails must SKIP the test, not pass it: a `return` in the
   * body is a green tick for a check that never ran, and this is the one file
   * where a vacuous pass is worth less than nothing. Junctions need no
   * privilege on Windows; file symlinks need Developer Mode, and CI (Linux)
   * needs neither.
   */
  const link = (target: string, at: string, type: 'junction' | 'file'): boolean => {
    try {
      fs.symlinkSync(target, at, type);
      return true;
    } catch {
      return false;
    }
  };
  const junction = path.join(root, 'escape');
  const fileLink = path.join(root, 'key.md');
  const madeJunction = link(secrets, junction, 'junction');
  const madeFileLink = link(path.join(secrets, 'id_rsa'), fileLink, 'file');

  it('reads a real file inside the root', () => {
    const r = scope.resolve(path.join(root, 'PROGRESS.md'));
    expect(r.ok).toBe(true);
  });

  it('refuses a real ../ climb into a sibling directory', () => {
    expect(scope.resolve(path.join(root, '..', 'secrets', 'id_rsa'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it.skipIf(!madeJunction)(
    'refuses a real DIRECTORY symlink (junction) pointing out of the root',
    () => {
      expect(scope.resolve(path.join(junction, 'id_rsa'))).toEqual({
        ok: false,
        reason: 'out-of-scope',
      });
    }
  );

  it.skipIf(!madeFileLink)('refuses a real FILE symlink pointing out of the root', () => {
    expect(scope.resolve(fileLink)).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it.skipIf(!madeJunction)('gives the same answer through a real junction, present or absent', () => {
    // The oracle, against a real filesystem rather than a fake resolver.
    expect(scope.resolve(path.join(junction, 'id_rsa'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
    expect(scope.resolve(path.join(junction, 'not-there'))).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('says not-found for a file that is not there', () => {
    expect(scope.resolve(path.join(root, 'nope.md'))).toEqual({ ok: false, reason: 'not-found' });
  });
});

// #1028, against a real filesystem: links that lead NOWHERE. A junction may be
// made to a folder that does not exist, with no privilege, so the directory
// case runs on a Windows developer box; the file cases run wherever a file
// symlink can be made (Linux CI always).
describe('a real link that leads nowhere (#1028)', () => {
  const base = tempDir('sb-fsscope-dangling-');
  const root = path.join(base, 'project');
  const secrets = path.join(base, 'secrets');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(secrets, 'id_rsa'), 'PRIVATE KEY\n');
  const scope = new ReadScope({ sessionFolders: () => [root], log });
  const link = (target: string, at: string, type: 'junction' | 'file'): boolean => {
    try {
      fs.symlinkSync(target, at, type);
      return true;
    } catch {
      return false;
    }
  };
  const OUT_OF_SCOPE = { ok: false, reason: 'out-of-scope' };
  const NOT_FOUND = { ok: false, reason: 'not-found' };

  // a folder link out of the root, to a folder that IS there and one that is NOT
  const toPresent = path.join(root, 'to-present');
  const toAbsent = path.join(root, 'to-absent');
  const madeDirs =
    link(secrets, toPresent, 'junction') && link(path.join(base, 'no-such-folder'), toAbsent, 'junction');
  // ...and a folder link to a missing place INSIDE the root: an honest broken link
  const brokenInside = path.join(root, 'docs', 'old');
  const madeInside = link(path.join(root, 'docs', 'archive'), brokenInside, 'junction');
  // file links, where the OS lets us make them
  const keyPresent = path.join(root, 'key-present');
  const keyAbsent = path.join(root, 'key-absent');
  const madeFiles =
    link(path.join(secrets, 'id_rsa'), keyPresent, 'file') && link(path.join(secrets, 'no-such-key'), keyAbsent, 'file');
  const latest = path.join(root, 'docs', 'latest.md');
  const madeHonest = link('v2.md', latest, 'file'); // relative, beside it, not there

  it.skipIf(!madeDirs)('a folder link out of the root answers the same whether its target is there or not', () => {
    expect(scope.resolve(toPresent)).toEqual(OUT_OF_SCOPE);
    expect(scope.resolve(toAbsent)).toEqual(OUT_OF_SCOPE);
    expect(scope.resolve(path.join(toPresent, 'id_rsa'))).toEqual(OUT_OF_SCOPE);
    expect(scope.resolve(path.join(toAbsent, 'id_rsa'))).toEqual(OUT_OF_SCOPE);
    expect(scope.resolve(path.join(toPresent, 'nope'))).toEqual(OUT_OF_SCOPE);
  });

  it.skipIf(!madeInside)('a broken folder link that stays INSIDE the root is still "not found"', () => {
    expect(scope.resolve(brokenInside)).toEqual(NOT_FOUND);
    expect(scope.resolve(path.join(brokenInside, 'notes.md'))).toEqual(NOT_FOUND);
  });

  it.skipIf(!madeFiles)('a file link out of the root answers the same whether its target is there or not', () => {
    expect(scope.resolve(keyPresent)).toEqual(OUT_OF_SCOPE);
    expect(scope.resolve(keyAbsent)).toEqual(OUT_OF_SCOPE);
  });

  it.skipIf(!madeHonest)('a broken relative file link inside the root is still "not found"', () => {
    expect(scope.resolve(latest)).toEqual(NOT_FOUND);
  });

  // The review's reproduction, on a real disk: 41 links in a row, which is more
  // than `resolve` follows and fewer than the OS does. Folder links, so it
  // runs on a Windows box with no privilege.
  const chainTo = (name: string, target: string): { head: string; made: boolean } => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    let made = true;
    for (let i = 1; i <= 41; i += 1) {
      made = made && link(i === 41 ? target : path.join(dir, `j${i + 1}`), path.join(dir, `j${i}`), 'junction');
    }
    return { head: path.join(dir, 'j1'), made };
  };
  const chainPresent = chainTo('chain-present', secrets);
  const chainAbsent = chainTo('chain-absent', path.join(base, 'no-such-folder'));

  it.skipIf(!chainPresent.made || !chainAbsent.made)(
    'a real chain of 41 links out of the root answers the same whether its end is there or not',
    () => {
      expect(scope.resolve(chainPresent.head)).toEqual(OUT_OF_SCOPE);
      expect(scope.resolve(chainAbsent.head)).toEqual(OUT_OF_SCOPE);
      expect(scope.resolve(path.join(chainPresent.head, 'id_rsa'))).toEqual(OUT_OF_SCOPE);
      expect(scope.resolve(path.join(chainAbsent.head, 'id_rsa'))).toEqual(OUT_OF_SCOPE);
    }
  );

  it('a deep missing path on a real disk is answered in a handful of lookups, not one per folder', () => {
    let lookups = 0;
    const counted = new ReadScope({
      sessionFolders: () => [root],
      log,
      realpath: (q: string) => {
        lookups += 1;
        return fs.realpathSync.native(q);
      },
    });
    const deep = path.join(root, ...Array.from({ length: 400 }, () => 'x'));
    expect(counted.resolve(deep)).toEqual(NOT_FOUND);
    // the walk this replaced made 400 of them
    expect(lookups).toBeLessThan(20);
  });
});
