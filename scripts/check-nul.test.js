// #435 — tests for the NUL-byte lint gate.
//
// Two halves. The pure ones (`findNul`, `isScannable`, `formatReport`) are
// asserted directly on buffers and words. The scan is driven through its
// injected `read`, so a case can hand it a buffer containing a real `\x00`
// without any test ever WRITING one to disk — a fixture file with a NUL in it
// would be found by the very check under test, which is a circularity that ends
// with someone adding an exclusion to the production code.
//
// The one case that does touch the filesystem is the end-to-end run of the real
// CLI against the real repo: it must be green, because a red one means this
// repo has a NUL in it right now.
//
// #459 added a second, and the same circularity rule shapes it: the untracked
// case needs a REAL `git ls-files` answer, so it builds a scratch repo under
// `os.tmpdir()` — never in this tree — and the one file there that does contain
// a `\x00` is therefore somewhere `npm run lint` will never look.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  BINARY_EXTENSIONS,
  MAX_LISTED,
  isScannable,
  filesToScan,
  findNul,
  scan,
  formatReport,
  run,
} from './check-nul.js';
import { tempDir } from '../src/test-temp-dirs';

const ROOT = path.join(import.meta.dirname, '..');

/** A buffer from text, with `@` standing in for the byte no source may contain. */
const buf = (text) => Buffer.from(text.replace(/@/g, '\0'), 'utf8');

describe('findNul', () => {
  it('returns null for clean text', () => {
    expect(findNul(buf('const x = 1;\nexport default x;\n'))).toBeNull();
  });

  it('returns null for an empty file', () => {
    expect(findNul(Buffer.alloc(0))).toBeNull();
  });

  it('reports the first NUL on line 1', () => {
    expect(findNul(buf('ab@cd'))).toEqual({ offset: 2, line: 1, column: 3 });
  });

  it('counts lines and restarts the column after each newline', () => {
    expect(findNul(buf('one\ntwo\nth@ree'))).toEqual({ offset: 10, line: 3, column: 3 });
  });

  it('handles a NUL as the very first byte', () => {
    expect(findNul(buf('@rest'))).toEqual({ offset: 0, line: 1, column: 1 });
  });

  it('reports only the first of several', () => {
    expect(findNul(buf('a@b@c'))).toMatchObject({ offset: 1 });
  });

  it('counts columns in bytes, not characters', () => {
    // 'é' is two bytes in UTF-8; the honest coordinate for a byte-level
    // accident is the byte one, and the test says so on purpose.
    expect(findNul(buf('é@'))).toEqual({ offset: 2, line: 1, column: 3 });
  });
});

describe('isScannable', () => {
  it.each(['src/main/index.ts', 'docs/DESIGN.md', 'scripts/ev.js', 'e2e/app.spec.ts', 'a.json'])(
    'scans %s',
    (p) => expect(isScannable(p)).toBe(true)
  );

  it.each(['build/icon.png', 'build/icon.ico', 'x/font.woff2', 'x/native.node'])(
    'skips %s',
    (p) => expect(isScannable(p)).toBe(false)
  );

  it('is case-insensitive about the extension', () => {
    expect(isScannable('build/ICON.PNG')).toBe(false);
  });

  it('scans a windows-separated path', () => {
    expect(isScannable('src\\main\\index.ts')).toBe(true);
    expect(isScannable('build\\icon.png')).toBe(false);
  });

  it('scans an extensionless file', () => {
    // CODEOWNERS, .gitignore: text, and a NUL in one is as broken as anywhere.
    expect(isScannable('.github/CODEOWNERS')).toBe(true);
  });

  it('lists every binary extension with its dot, lower-case', () => {
    for (const ext of BINARY_EXTENSIONS) expect(ext).toMatch(/^\.[a-z0-9]+$/);
  });
});

describe('scan', () => {
  const files = ['src/clean.ts', 'src/dirty.ts', 'build/icon.png'];
  const contents = {
    'src/clean.ts': buf('ok\n'),
    'src/dirty.ts': buf('bad@\n'),
    'build/icon.png': buf('@@binary@@'),
  };
  const read = (abs) => {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const hit = contents[rel];
    if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return hit;
  };

  it('finds the NUL and names the file, posix-shaped', () => {
    const result = scan(ROOT, files, read);
    expect(result.hits).toEqual([{ file: 'src/dirty.ts', offset: 3, line: 1, column: 4 }]);
  });

  it('does not read binary extensions', () => {
    // the .png above is all NULs; counting it would be a false positive
    expect(scan(ROOT, files, read).skipped).toBe(1);
    expect(scan(ROOT, files, read).scanned).toBe(2);
  });

  it('skips a file that vanished between ls-files and the read', () => {
    const result = scan(ROOT, [...files, 'src/deleted.ts'], read);
    expect(result.hits).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it('is clean when nothing has a NUL', () => {
    expect(scan(ROOT, ['src/clean.ts'], read).hits).toEqual([]);
  });
});

describe('formatReport', () => {
  const hit = (file) => ({ file, offset: 3, line: 2, column: 1 });

  it('passes quietly with a count and a timing', () => {
    const { lines, failed } = formatReport({ scanned: 544, skipped: 5, hits: [] }, {
      elapsedMs: 123.4,
    });
    expect(failed).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('544');
    expect(lines[0]).toContain('123ms');
  });

  it('fails naming the file, the line and the column', () => {
    const { lines, failed } = formatReport({
      scanned: 2,
      skipped: 0,
      hits: [hit('src/main/broken.ts')],
    });
    expect(failed).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('src/main/broken.ts:2:1');
    expect(text).toContain('byte offset 3');
  });

  it('tells the reader what to do about a genuinely binary file', () => {
    const text = formatReport({ scanned: 1, skipped: 0, hits: [hit('x/thing.fnt')] }).lines.join(
      '\n'
    );
    expect(text).toContain('BINARY_EXTENSIONS');
    expect(text).toContain('scripts/check-nul.js');
  });

  it('truncates a long list rather than printing hundreds of lines', () => {
    const hits = Array.from({ length: MAX_LISTED + 7 }, (_, i) => hit(`src/f${i}.ts`));
    const text = formatReport({ scanned: hits.length, skipped: 0, hits }).lines.join('\n');
    expect(text).toContain(`src/f${MAX_LISTED - 1}.ts`);
    expect(text).not.toContain(`src/f${MAX_LISTED}.ts`);
    expect(text).toContain('...and 7 more');
  });
});

describe('filesToScan', () => {
  it('lists this repo, posix-shaped, on either platform', () => {
    const files = filesToScan(ROOT);
    // `git ls-files` prints forward slashes everywhere, which is why nothing
    // downstream has to normalise.
    expect(files).toContain('package.json');
    expect(files).toContain('scripts/bundle-guard.js');
    expect(files.some((f) => f.includes('\\'))).toBe(false);
  });

  it('keeps `node_modules/` out of this repo’s list', () => {
    // `--others` without `--exclude-standard` would put tens of thousands of
    // files in here and turn a 90ms check into a minute of I/O.
    expect(filesToScan(ROOT).some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('returns null instead of throwing when git cannot answer', () => {
    // A directory that is not a repo: the fail-open path. os.tmpdir() itself
    // could sit inside one on someone's machine; a path that does not exist
    // cannot, and git fails the same way.
    expect(filesToScan(path.join(ROOT, 'no-such-directory-for-check-nul'))).toBeNull();
  });
});

describe('a scratch repo (#459 — the untracked hole)', () => {
  let repo;

  const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text.replace(/@/g, '\0'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

  beforeAll(() => {
    // Lives for the whole FILE; `test-setup.ts`'s afterAll net deletes it (#213).
    repo = tempDir('sb-check-nul-');
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@test');
    git('config', 'user.name', 'test');
    write('.gitignore', 'ignored.md\n');
    write('committed.md', 'clean\n');
    git('add', '.');
    git('commit', '-m', 'init');
    write('untracked.md', 'oops@here\n'); // the file #414 lost a cycle to
    write('ignored.md', 'also@bad\n');
  });

  it('lists the untracked file alongside the tracked one', () => {
    const files = filesToScan(repo);
    expect(files).toContain('committed.md');
    expect(files).toContain('untracked.md');
  });

  it('still leaves an ignored file out', () => {
    expect(filesToScan(repo)).not.toContain('ignored.md');
  });

  it('lists each path once', () => {
    const files = filesToScan(repo);
    expect(new Set(files).size).toBe(files.length);
  });

  it('FAILS on a NUL in a file that was never `git add`ed', () => {
    // The whole point of #459: before it, this run was green until someone
    // staged the file, and the gate fired in the wrong debugging session.
    const { lines, failed } = run(repo);
    expect(failed).toBe(true);
    expect(lines.join('\n')).toContain('untracked.md:1:5');
  });

  it('does not fail on the ignored one', () => {
    expect(run(repo).lines.join('\n')).not.toContain('ignored.md');
  });
});

describe('run', () => {
  it('finds no NUL byte anywhere in this repo', () => {
    const { lines, failed } = run(ROOT);
    expect(failed, lines.join('\n')).toBe(false);
  });

  it('scans the whole tree, not just one directory', () => {
    // guards the __dirname-vs-cwd trap called out in the CLI block
    const { scanned } = scan(ROOT, filesToScan(ROOT) ?? []);
    expect(scanned).toBeGreaterThan(100);
  });

  it('stays cheap enough to sit in front of every lint', () => {
    // Measured on this repo (544 files): ~90ms warm, ~500ms on a cold file
    // cache, plus node's own startup. The ceiling is deliberately far above
    // that — it is a smoke test for a SCOPE regression (someone pointing the
    // scan at node_modules or `out/`, which is seconds), not a benchmark. A
    // tight bound here would flake on a loaded CI runner and teach nobody
    // anything.
    const started = Date.now();
    run(ROOT);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('the CLI', () => {
  it('exits 0 on this repo and prints the summary to stderr', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-nul.js')], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('no NUL bytes');
  });
});
