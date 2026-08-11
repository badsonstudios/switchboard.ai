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
