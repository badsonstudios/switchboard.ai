// THE CONTAINMENT PROOF for the Files tab's directory listing (#521 layer 2).
//
// This is the app's first directory-enumeration channel and the only genuinely
// new security surface in the item, so the tests below are written as an
// ATTACKER's list rather than as a feature's list: each one is a thing a
// compromised or merely buggy renderer could send, and what stops it.
//
// Every escape attempt here is built with REAL filesystem objects under a
// `tempDir()` fixture — a real `..` walk, a real Windows junction, a real
// symlink — because the whole bug class this guards is "the string looked fine
// and the bytes came from somewhere else", and a mocked `fs` cannot exhibit it.
//
// ⚠️ NOTHING HERE TOUCHES ANYTHING OUTSIDE ITS OWN FIXTURE. The "outside" root
// is a sibling directory inside the same `tempDir()`, never `%TEMP%` itself and
// never a real system path.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { tempDir } from '../../test-temp-dirs';
import type { Logger } from '../log/logger';
import { MAX_DIR_ENTRIES } from '../../shared/ipc/fs';
import { listDirectory, compareEntries, kindOf } from './list-dir';
import { ReadScope } from './read-scope';

const quietLog = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  const at = (level: string) => (msg: string): void => void lines.push(`${level}: ${msg}`);
  const log = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => log,
  } as unknown as Logger;
  return { log, lines };
};

const BASE = tempDir('sb-listdir-');
/** The session folder — the ONLY thing in scope. */
const ROOT = path.join(BASE, 'project');
/** A sibling inside the same fixture. Stands in for anything off-limits. */
const OUTSIDE = path.join(BASE, 'secrets');

/** Does this machine let us make the link we are about to test? */
let symlinkWorks = false;
let junctionWorks = false;

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'empty'), { recursive: true });
  // A `.GIT` in ITS OWN folder, because on a case-insensitive filesystem it
  // cannot sit beside the `.git` above — the OS would treat them as one name.
  fs.mkdirSync(path.join(ROOT, 'casefold', '.GIT'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'casefold', 'keep.txt'), 'keep');
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'PROGRESS.md'), '# progress\n');
  fs.writeFileSync(path.join(ROOT, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(ROOT, 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(ROOT, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(OUTSIDE, 'id_rsa'), 'PRIVATE\n');

  // A SYMLINK INSIDE THE ROOT, POINTING OUT OF IT. On Windows this needs
  // either developer mode or an admin shell, so it is attempted and skipped
  // rather than assumed — an unconditional `symlinkSync` here would have made
  // this whole file red on a stock Windows box.
  try {
    fs.symlinkSync(OUTSIDE, path.join(ROOT, 'escape-link'), 'dir');
    symlinkWorks = true;
  } catch {
    symlinkWorks = false;
  }
  // A WINDOWS JUNCTION, which is the one that matters on Dan's machine: it
  // needs no privilege at all, so it is the escape a real renderer could
  // actually be pointed at. Node can make one directly; `mklink /J` is the
  // fallback and is only reached if the API refuses.
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(OUTSIDE, path.join(ROOT, 'escape-junction'), 'junction');
      junctionWorks = true;
    } catch {
      try {
        execFileSync('cmd', ['/c', 'mklink', '/J', path.join(ROOT, 'escape-junction'), OUTSIDE], {
          stdio: 'ignore',
        });
        junctionWorks = true;
      } catch {
        junctionWorks = false;
      }
    }
  }
});

/** A scope holding exactly the one session folder. */
function scopeOf(...folders: string[]): ReadScope {
  return new ReadScope({ sessionFolders: () => folders, log: quietLog().log });
}

const listIn = (root: string, dir?: string, folders: string[] = [ROOT], cap?: number) => {
  const { log, lines } = quietLog();
  return listDirectory({ root, path: dir }, { scope: scopeOf(...folders), log, cap }).then((r) => ({
    result: r,
    lines,
  }));
};

describe('listDirectory — the happy path', () => {
  it('lists the root when no path is given', async () => {
    const { result } = await listIn(ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(false);
    expect(result.cap).toBe(MAX_DIR_ENTRIES);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('PROGRESS.md');
    expect(names).toContain('src');
  });

  it('lists ONE level — a nested folder is a name, not a subtree', async () => {
    const { result } = await listIn(ROOT);
    if (!result.ok) throw new Error('expected a listing');
    const src = result.entries.find((e) => e.name === 'src');
    expect(src?.kind).toBe('dir');
    // Nothing from inside `src` is in the root's listing: the tree expands by
    // asking again, never by main walking ahead of it.
    expect(result.entries.map((e) => e.name)).not.toContain('index.ts');
  });

  it('answers a child directory when asked for one', async () => {
    const { result } = await listIn(ROOT, path.join(ROOT, 'src'));
    if (!result.ok) throw new Error('expected a listing');
    expect(result.entries.map((e) => e.name).sort()).toEqual(['deep', 'index.ts']);
  });

  it('folders before files, then by name', async () => {
    const { result } = await listIn(ROOT);
    if (!result.ok) throw new Error('expected a listing');
    // Said plainly: the listing is already in its own sorted order. The earlier
    // version of this compared `lastIndexOf('dir')` against a `findIndex` with
    // an `Infinity` fallback, which was vacuously true for an all-folders
    // listing and unreadable for every other one.
    expect(result.entries.map((e) => e.name)).toEqual(
      [...result.entries].sort(compareEntries).map((e) => e.name)
    );
    // …and every folder really is ahead of every non-folder
    const kinds = result.entries.map((e) => e.kind);
    const firstNonDir = kinds.findIndex((k) => k !== 'dir');
    if (firstNonDir >= 0) expect(kinds.slice(firstNonDir)).not.toContain('dir');
  });

  it('never lists .git', async () => {
    const { result } = await listIn(ROOT);
    if (!result.ok) throw new Error('expected a listing');
    expect(result.entries.map((e) => e.name)).not.toContain('.git');
  });

  it("...nor `.GIT`, which on Windows IS the git directory", async () => {
    // The filter was a case-SENSITIVE `Set` on a case-INSENSITIVE filesystem, so
    // a repo whose directory is spelled `.GIT` had all forty thousand of its
    // objects listed. Found by review.
    //
    // ⚠️ AND THE FIRST VERSION OF THIS TEST PROVED NOTHING: it asserted that no
    // name lowercased to `.git`, over a fixture that only ever contained a
    // lowercase one — true before the fix and true after it. It needs a `.GIT`
    // on disk, which needs its own folder, which is why the fixture has one.
    const { result } = await listIn(ROOT, path.join(ROOT, 'casefold'));
    if (!result.ok) throw new Error('expected a listing');
    expect(result.entries.map((e) => e.name)).toEqual(['keep.txt']);
  });

  it('an empty folder is an empty listing, not a refusal', async () => {
    const { result } = await listIn(ROOT, path.join(ROOT, 'empty'));
    expect(result).toMatchObject({ ok: true, entries: [] });
  });

  it('the entry paths it hands back are themselves listable', async () => {
    // The round trip the tree actually makes: take a `dir` entry's `path`
    // verbatim and ask about it. A path main built from a resolved parent must
    // not come back out-of-scope.
    const { result } = await listIn(ROOT);
    if (!result.ok) throw new Error('expected a listing');
    const src = result.entries.find((e) => e.name === 'src');
    const again = await listIn(ROOT, src!.path);
    expect(again.result.ok).toBe(true);
  });
});

describe('listDirectory — THE CONTAINMENT PROOF', () => {
  it('refuses a `..` walk out of the root', async () => {
    const escape = path.join(ROOT, '..', 'secrets');
    const { result, lines } = await listIn(ROOT, escape);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
    // and the names it was after never crossed the bridge
    expect(JSON.stringify(result)).not.toContain('id_rsa');
    expect(lines).toEqual([]); // the handler logs; the guard itself is quiet
  });

  it('refuses a deeper `..` walk that lands back inside a plausible name', async () => {
    // `<root>/src/../../secrets` — a spelling whose PREFIX is the root for its
    // first two segments, which is exactly what a string-prefix check passes.
    const escape = path.join(ROOT, 'src', '..', '..', 'secrets');
    const { result } = await listIn(ROOT, escape);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses a sibling whose NAME starts with the root', async () => {
    // `<base>/project-secrets` vs `<base>/project`: one string does start with
    // the other, and the separator on the boundary is the only thing that says
    // no. Made here rather than in `beforeAll` so it is not in any listing.
    const sibling = `${ROOT}-secrets`;
    fs.mkdirSync(sibling, { recursive: true });
    const { result } = await listIn(ROOT, sibling);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it.runIf(process.platform === 'win32')(
    'refuses a WINDOWS JUNCTION pointing out of the root',
    async () => {
      if (!junctionWorks) {
        // Said out loud rather than passed silently: a skipped security test
        // that looks green is worse than a red one.
        expect(junctionWorks).toBe(false);
        return;
      }
      const viaJunction = path.join(ROOT, 'escape-junction');
      const { result } = await listIn(ROOT, viaJunction);
      // The junction RESOLVES to `<base>/secrets`, which is not under the root.
      // The requested string is under the root, character for character.
      expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
      const deeper = await listIn(ROOT, path.join(viaJunction, '.'));
      expect(deeper.result).toEqual({ ok: false, reason: 'out-of-scope' });
    }
  );

  it('refuses a SYMLINK pointing out of the root', async () => {
    if (!symlinkWorks) {
      expect(symlinkWorks).toBe(false);
      return;
    }
    const { result } = await listIn(ROOT, path.join(ROOT, 'escape-link'));
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('reports a link as a LINK and never as an expandable folder', async () => {
    if (!symlinkWorks && !junctionWorks) return;
    const { result } = await listIn(ROOT);
    if (!result.ok) throw new Error('expected a listing');
    const links = result.entries.filter((e) => e.name.startsWith('escape-'));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.kind).toBe('link');
  });

  it('refuses a root the caller invented — declaring one grants nothing', async () => {
    // The sharpest renderer-side lie available: claim the off-limits folder IS
    // your root. It has to be refused on the ROOT check, before anything reads.
    const { result } = await listIn(OUTSIDE, OUTSIDE, [ROOT]);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses a target in ANOTHER session folder even when both are in scope', async () => {
    // Both folders are readable by `fs:read` — that is the app-wide read scope
    // and this channel does not widen it. What it adds is that ONE CALL cannot
    // straddle them: the root a call declares is the boundary for that call.
    const { result } = await listIn(ROOT, OUTSIDE, [ROOT, OUTSIDE]);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
    // …and the same target IS listable when it is the declared root, which is
    // what proves the refusal above is the narrowing and not a scope bug.
    const asRoot = await listIn(OUTSIDE, OUTSIDE, [ROOT, OUTSIDE]);
    expect(asRoot.result.ok).toBe(true);
  });

  it('refuses a relative path — main’s cwd is a root nobody granted', async () => {
    expect((await listIn(ROOT, 'src')).result).toEqual({ ok: false, reason: 'invalid-path' });
    expect((await listIn('project', undefined, [ROOT])).result).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });

  it('refuses the junk an untyped caller can send', async () => {
    const { log } = quietLog();
    const scope = scopeOf(ROOT);
    for (const req of [undefined, null, {}, { root: 42 }, { root: '' }, 'nope', []]) {
      expect(await listDirectory(req, { scope, log })).toEqual({
        ok: false,
        reason: 'invalid-path',
      });
    }
    // a NUL in either half is `ReadScope`'s refusal, not a crash
    expect(await listDirectory({ root: `${ROOT}\0` }, { scope, log })).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    expect(await listDirectory({ root: ROOT, path: `${ROOT}\0x` }, { scope, log })).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });

  it('refuses an absurdly long or deep path WITHOUT resolving it', async () => {
    // A DENIAL-OF-SERVICE BOUND, not a containment one. `ReadScope.resolve` is
    // synchronous and walks up one segment at a time on an unresolvable path, so
    // a 2000-segment string costs ~100ms of frozen main process and a renderer
    // can fire a thousand of them un-awaited. Measured, and the reason this
    // guard runs before either resolve.
    const deep = path.join(ROOT, ...Array<string>(200).fill('x'));
    expect((await listIn(ROOT, deep)).result).toEqual({ ok: false, reason: 'invalid-path' });
    const long = `${ROOT}${path.sep}${'x'.repeat(5000)}`;
    expect((await listIn(ROOT, long)).result).toEqual({ ok: false, reason: 'invalid-path' });
    // …and the bound applies to the ROOT half too
    expect((await listIn(long, undefined, [ROOT])).result).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    // The bound is far past anything real: a genuine 60-deep path still works.
    const realDeep = path.join(ROOT, 'src', 'deep');
    expect((await listIn(ROOT, realDeep)).result.ok).toBe(true);
  });

  it('an empty read scope refuses everything', async () => {
    const { result } = await listIn(ROOT, undefined, []);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('a file is not a folder', async () => {
    const { result } = await listIn(ROOT, path.join(ROOT, 'PROGRESS.md'));
    expect(result).toEqual({ ok: false, reason: 'not-a-directory' });
  });

  it('a missing folder INSIDE the root says so; one outside says out-of-scope', async () => {
    // The existence-oracle rule `read-scope.ts` establishes, inherited whole:
    // the difference between `not-found` and `out-of-scope` must not be a map
    // of the filesystem.
    expect((await listIn(ROOT, path.join(ROOT, 'nope'))).result).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect((await listIn(ROOT, path.join(OUTSIDE, 'nope'))).result).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });
});

describe('THE NARROWING, ISOLATED — check 3 with nothing behind it', () => {
  // ⚠️ WHY THIS BLOCK EXISTS, and it was found by MUTATION rather than by
  // reading: with the containment check above deleted, every escape test in the
  // block above STILL PASSED. They have to — the read scope holds only `ROOT`,
  // so `ReadScope` refuses `<base>/secrets` on its own and the narrowing never
  // gets asked. That is defence in depth working exactly as intended, and it is
  // also a suite that would have gone green with the new check gone.
  //
  // So every escape is run again here with the WHOLE FIXTURE in scope
  // (`sessionFolders: () => [BASE]`). `ReadScope` now says yes to all of it, and
  // the only thing left standing between a caller and a sibling folder is the
  // check this item added. Break it and this block reddens; break `ReadScope`
  // and the block above reddens. Neither one can pass for the other.
  const wide = [BASE];

  it('the fixture really IS all in scope now — otherwise this block proves nothing', async () => {
    // The guard's guard. Without this, a typo in `wide` would make every
    // assertion below pass for the wrong reason.
    expect((await listIn(OUTSIDE, OUTSIDE, wide)).result.ok).toBe(true);
  });

  it('refuses a `..` walk even when the destination is readable', async () => {
    const { result } = await listIn(ROOT, path.join(ROOT, '..', 'secrets'), wide);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
    expect(JSON.stringify(result)).not.toContain('id_rsa');
  });

  it('refuses a deeper `..` walk whose prefix IS the root', async () => {
    const { result } = await listIn(ROOT, path.join(ROOT, 'src', '..', '..', 'secrets'), wide);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses a sibling whose NAME starts with the root', async () => {
    const sibling = `${ROOT}-secrets`;
    fs.mkdirSync(sibling, { recursive: true });
    expect((await listIn(ROOT, sibling, wide)).result).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it.runIf(process.platform === 'win32')(
    'refuses a WINDOWS JUNCTION even when its destination is readable',
    async () => {
      // THE ONE THAT MATTERS ON A WINDOWS DEV BOX: a junction needs no
      // privilege, so it is the escape a real renderer could actually be
      // pointed at. The requested string is under the root character for
      // character; only the RESOLVED path is not.
      if (!junctionWorks) {
        expect(junctionWorks).toBe(false);
        return;
      }
      const { result } = await listIn(ROOT, path.join(ROOT, 'escape-junction'), wide);
      expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
      expect(JSON.stringify(result)).not.toContain('id_rsa');
    }
  );

  it('refuses a SYMLINK even when its destination is readable', async () => {
    if (!symlinkWorks) {
      expect(symlinkWorks).toBe(false);
      return;
    }
    const { result } = await listIn(ROOT, path.join(ROOT, 'escape-link'), wide);
    expect(result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses the root’s own PARENT — the plainest escape of all', async () => {
    expect((await listIn(ROOT, BASE, wide)).result).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('still allows what it should — the narrowing is not just "no"', async () => {
    expect((await listIn(ROOT, ROOT, wide)).result.ok).toBe(true);
    expect((await listIn(ROOT, path.join(ROOT, 'src'), wide)).result.ok).toBe(true);
    expect((await listIn(ROOT, path.join(ROOT, 'src', 'deep'), wide)).result.ok).toBe(true);
  });
});

describe('listDirectory — the bounds', () => {
  const BIG = path.join(ROOT, 'big');
  beforeAll(() => {
    fs.mkdirSync(BIG, { recursive: true });
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(BIG, `f${i}.txt`), 'x');
  });

  it('stops at the cap and SAYS it stopped', async () => {
    const { result, lines } = await listIn(ROOT, BIG, [ROOT], 10);
    if (!result.ok) throw new Error('expected a listing');
    expect(result.entries).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.cap).toBe(10);
    // the truncation is written down, so "the tab is missing files" is
    // answerable from the log rather than from guessing
    expect(lines.some((l) => l.startsWith('info: fs:listDir capped'))).toBe(true);
  });

  it('does not claim truncation when the folder fits exactly', async () => {
    // The off-by-one that would make every full-cap folder claim "there is
    // more": the read asks for one dirent past the cap and uses its ABSENCE.
    const { result } = await listIn(ROOT, BIG, [ROOT], 30);
    expect(result).toMatchObject({ ok: true, truncated: false });
    if (result.ok) expect(result.entries).toHaveLength(30);
  });

  it('closes the directory handle even when it walks away at the cap', async () => {
    // Asserted through behaviour rather than through a descriptor count, which
    // is not portable: 200 capped reads of the same folder would exhaust the
    // process's handles if the `finally` were missing.
    for (let i = 0; i < 200; i += 1) {
      const { result } = await listIn(ROOT, BIG, [ROOT], 2);
      expect(result.ok).toBe(true);
    }
  });

  it('a read that fails part-way through is unreadable, not a throw', async () => {
    const { log, lines } = quietLog();
    const boom = {
      read: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
      close: async () => {},
    } as unknown as fs.Dir;
    const result = await listDirectory(
      { root: ROOT },
      { scope: scopeOf(ROOT), log, opendir: async () => boom }
    );
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
    expect(lines.some((l) => l.startsWith('warn: fs:listDir failed part-way'))).toBe(true);
  });

  it('an unopenable directory is unreadable, not a throw', async () => {
    const { log } = quietLog();
    const result = await listDirectory(
      { root: ROOT },
      {
        scope: scopeOf(ROOT),
        log,
        opendir: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }
    );
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a close that throws does not lose a good answer', async () => {
    const { log } = quietLog();
    const one = { name: 'x', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
    let read = 0;
    const dir = {
      read: async () => (read++ === 0 ? one : null),
      close: async () => {
        throw new Error('ERR_DIR_CLOSED');
      },
    } as unknown as fs.Dir;
    const result = await listDirectory(
      { root: ROOT },
      { scope: scopeOf(ROOT), log, opendir: async () => dir }
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('the pure halves', () => {
  it('kindOf asks about the LINK first', () => {
    // A reparse point that claims to be a directory too. Classifying it as
    // `dir` is the bug: the tree would offer to expand a road out of the root.
    expect(kindOf({ isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false })).toBe(
      'link'
    );
    expect(kindOf({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false })).toBe(
      'dir'
    );
    expect(kindOf({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true })).toBe(
      'file'
    );
    expect(
      kindOf({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false })
    ).toBe('other');
  });

  it('compareEntries is a TOTAL order, so a refresh never reshuffles', () => {
    const e = (name: string, kind: 'dir' | 'file') => ({ name, path: `/r/${name}`, kind }) as const;
    const sorted = [e('b.txt', 'file'), e('A', 'dir'), e('a', 'dir'), e('A.txt', 'file')].sort(
      compareEntries
    );
    expect(sorted.map((x) => x.name)).toEqual(['A', 'a', 'A.txt', 'b.txt']);
    // and it is stable under its own output
    expect([...sorted].sort(compareEntries).map((x) => x.name)).toEqual(sorted.map((x) => x.name));
  });
});
