// The log parser, over FIXTURE BYTES (E24 Git v2 item 1).
//
// Deliberately not against a real repository: the framing is the hard part, and
// a test repository only produces the shapes its own history happens to have.
// Every fixture below is a byte layout MEASURED off real git
// (2.51.0.windows.2) and then written down, so a change to the parser has to
// keep working against the bytes rather than against today's test repo. The
// service's own suite proves the other half — that real git still emits this.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  diffBaseFor,
  isLogQuery,
  logArgs,
  parseLog,
  parseRefs,
  parseShortstat,
} from './git-log';
import { EMPTY_TREE } from './repo-config-guard';

/**
 * Build one record the way git frames it.
 *
 * `stats` is the line that trails AFTER the NUL, so this helper puts it where
 * git does rather than where it reads like it belongs — which is the single most
 * important thing about this format and the thing a hand-written fixture gets
 * wrong.
 */
function record(
  fields: {
    id: string;
    author?: string;
    email?: string;
    at?: string;
    ct?: string;
    parents?: string;
    refs?: string;
    body?: string;
  },
  stats?: string
): string {
  const f = fields;
  const head = [
    f.id,
    f.author ?? 'dheinz',
    f.email ?? 'dheinz@example.com',
    f.at ?? '1790943640',
    f.ct ?? '1790943640',
    f.parents ?? '',
    f.refs ?? '',
  ].join('\n');
  // The body ends with the newline git stores, then the NUL terminator, then —
  // if there is a diffstat — a newline, the line, and a newline.
  return `${head}\n${f.body ?? 'subject\n'}\0${stats === undefined ? '' : `\n${stats}\n`}`;
}

const SHA_A = 'b2723f662bfbcea739dd6d0d4849ef4166531d43';
const SHA_B = 'dc77cc0f4424df6372b9a554b1198aeb9f54b8d7';
const SHA_C = '35a9e031996aba7a70e67b487e6ff14d721149bc';
const SHA_D = 'ce19157415425635d568e1c02e3ae3ac1e9ede9f';

describe('parseLog — the framing', () => {
  it('parses one commit, fields and all (the done-when)', () => {
    const [c] = parseLog(
      record(
        {
          id: SHA_A,
          author: 'Dan Heinz',
          email: 'dan@example.com',
          at: '1790943640',
          ct: '1790943641',
          parents: SHA_B,
          refs: 'HEAD -> refs/heads/main',
          body: 'docs: the subject line\n',
        },
        ' 2 files changed, 10 insertions(+), 3 deletions(-)'
      )
    );
    expect(c).toMatchObject({
      id: SHA_A,
      parentIds: [SHA_B],
      displayId: 'b2723f66',
      subject: 'docs: the subject line',
      message: 'docs: the subject line',
      author: 'Dan Heinz',
      authorEmail: 'dan@example.com',
      timestamp: 1790943640,
      committedTimestamp: 1790943641,
      stats: { files: 2, insertions: 10, deletions: 3 },
    });
  });

  it('⚠️ attributes the diffstat BACKWARDS — it arrives after the NUL', () => {
    // THE WHOLE POINT OF THIS SUITE. `--shortstat` trails after the record
    // terminator, so chunk N holds commit N's fields with commit N-1's numbers
    // glued to the front. A parser that read the line at the end of its own
    // chunk would attribute every statistic to the wrong commit — and the
    // numbers would all look plausible, which is why this needs a test and not
    // a glance.
    const out =
      record({ id: SHA_A, parents: SHA_B }, ' 1 file changed, 1 insertion(+)') +
      record({ id: SHA_B, parents: SHA_C }, ' 7 files changed, 70 insertions(+), 7 deletions(-)');
    const commits = parseLog(out);
    expect(commits.map((c) => c.id)).toEqual([SHA_A, SHA_B]);
    expect(commits[0].stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(commits[1].stats).toEqual({ files: 7, insertions: 70, deletions: 7 });
  });

  it('⚠️ a body full of blank lines does not split the record', () => {
    // This repository's commit bodies are nothing but newlines, which is the
    // reason `-z` is in the command at all. A line-framed parser reads the
    // second paragraph of this message as the next commit's sha.
    const body = 'subject\n\nfirst paragraph\n\n\nthird, after two blanks\n\n* a bullet\n\n';
    const [c] = parseLog(record({ id: SHA_A, parents: SHA_B, body }, ' 1 file changed, 1 insertion(+)'));
    expect(c.subject).toBe('subject');
    expect(c.message).toBe(body.replace(/\s+$/, ''));
    expect(c.message).toContain('third, after two blanks');
  });

  it('⚠️ an EMPTY COMMIT prints no diffstat at all, and the next sha abuts the NUL', () => {
    // Measured: `git commit --allow-empty` produces `<fields>\0<next sha>` with
    // no line between. A parser that assumed the line was always there ate the
    // next record's sha as a statistic and then found no commit where one was.
    const out =
      record({ id: SHA_A, parents: SHA_B, body: 'empty commit\n' }) +
      record({ id: SHA_B, parents: SHA_C }, ' 1 file changed, 1 insertion(+)');
    const commits = parseLog(out);
    expect(commits.map((c) => c.id)).toEqual([SHA_A, SHA_B]);
    // `null`, NOT `{files: 0, …}`. "git said nothing" and "git said zero" are
    // different answers and only one of them is reachable.
    expect(commits[0].stats).toBeNull();
    expect(commits[1].stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it('a MERGE commit carries both parents', () => {
    const [c] = parseLog(
      record(
        { id: SHA_A, parents: `${SHA_C} ${SHA_D}`, body: 'merge side\n\nwith a body\n\nand blanks\n' },
        ' 1 file changed, 1 insertion(+)'
      )
    );
    expect(c.parentIds).toEqual([SHA_C, SHA_D]);
    // `--diff-merges=first-parent` is what gives a merge a diffstat at all;
    // without it every merge in the list reads as an empty commit.
    expect(c.stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
  });

  it('⚠️ a ROOT COMMIT has NO parents — not one empty one', () => {
    // `%P` is empty for a root commit, and `''.split(' ')` is `['']`. Left
    // unfiltered, the root commit claims a parent whose sha is the empty string
    // — item 3's lane allocator then draws an edge to nowhere and item 4 asks
    // git for `..<sha>`.
    const [c] = parseLog(record({ id: SHA_A, parents: '', body: 'root commit\n' }, ' 1 file changed, 1 insertion(+)'));
    expect(c.parentIds).toEqual([]);
  });

  it('%D empty means no references, and that is the common case', () => {
    const [c] = parseLog(record({ id: SHA_A, parents: SHA_B, refs: '' }, ' 1 file changed, 1 insertion(+)'));
    expect(c.references).toEqual([]);
  });

  it('⚠️ CRLF in a body survives, and does not become a blank subject', () => {
    // A commit made on Windows through a tool that writes CRLF leaves `\r` at
    // the end of every line of `%B`. The subject is trimmed (a trailing `\r`
    // drawn in a chip is an invisible character that pushes the layout around),
    // and the rest of the body keeps what the author wrote.
    const body = 'subject with crlf\r\n\r\nbody line\r\n';
    const [c] = parseLog(record({ id: SHA_A, parents: SHA_B, body }, ' 1 file changed, 1 insertion(+)'));
    expect(c.subject).toBe('subject with crlf');
    expect(c.message).toContain('body line');
    expect(c.subject.endsWith('\r')).toBe(false);
  });

  it('a trailing diffstat at the very end of the stream is not read as a commit', () => {
    // The real stream ends `…\0\n 1 file changed, 1 insertion(+)\n`, so the last
    // chunk is a diffstat and nothing else. It belongs to the last commit.
    const out = record({ id: SHA_A, parents: SHA_B }, ' 3 files changed, 4 insertions(+)');
    const commits = parseLog(out);
    expect(commits).toHaveLength(1);
    expect(commits[0].stats).toEqual({ files: 3, insertions: 4, deletions: 0 });
  });

  it('empty output is no commits, not a throw', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('⚠️ a chunk that is not a record is SKIPPED, and the rest still parses', () => {
    // git refuses to write a NUL into a commit message (measured: `commit-tree`
    // answers *"error: a NUL byte in commit log message not allowed."*), so this
    // should be unreachable. "Should be unreachable" is how most of this file's
    // warnings started, and the consumer is a pane that must not blank out
    // because one commit in two thousand surprised us.
    const out = `garbage with no sha\0${record({ id: SHA_B, parents: SHA_C }, ' 1 file changed, 1 insertion(+)')}`;
    const commits = parseLog(out);
    expect(commits.map((c) => c.id)).toEqual([SHA_B]);
  });

  it('⚠️ an ORPHAN diffstat does not overwrite the previous commit’s real numbers', () => {
    // Found in review. The recovery path for a malformed chunk introduced a
    // worse bug than the one it recovered from: the statistics that trail the
    // skipped chunk were attached to `commits[last]` — a DIFFERENT commit, whose
    // numbers were already correct. A confident wrong number, inherited from a
    // record that was thrown away.
    const out =
      record({ id: SHA_A, parents: SHA_B }, ' 1 file changed, 1 insertion(+)') +
      `garbage with no sha\0\n 99 files changed, 99 insertions(+)\n` +
      record({ id: SHA_C, parents: SHA_D }, ' 2 files changed, 2 insertions(+)');
    const commits = parseLog(out);
    expect(commits.map((c) => c.id)).toEqual([SHA_A, SHA_C]);
    // A's own numbers, NOT the orphaned 99.
    expect(commits[0].stats).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(commits[1].stats).toEqual({ files: 2, insertions: 2, deletions: 0 });
  });

  it('⚠️ an unparseable stats line costs the STATS, not the whole commit', () => {
    // Also found in review. A chunk beginning with a newline that is not a
    // diffstat used to make field 0 the empty string, which fails the sha test
    // and dropped the commit — contradicting this function's own promise to
    // return what it could read.
    const out = `\nI am not a shortstat\n${record({ id: SHA_B, parents: SHA_C }, ' 1 file changed, 1 insertion(+)')}`;
    const commits = parseLog(out);
    expect(commits.map((c) => c.id)).toEqual([SHA_B]);
  });

  it('an EMPTY commit message parses to an empty subject rather than failing', () => {
    // `git commit --allow-empty-message` is legal and some tools produce it.
    const [c] = parseLog(record({ id: SHA_A, parents: SHA_B, body: '' }, ' 1 file changed, 1 insertion(+)'));
    expect(c.id).toBe(SHA_A);
    expect(c.subject).toBe('');
    expect(c.message).toBe('');
  });

  it('⚠️ a huge run of trailing whitespace is TRIMMED INSTANTLY, not quadratically', () => {
    // Found in review, and the numbers are why this test exists: `/\s+$/`
    // backtracks per position, so 240,000 trailing spaces froze the Electron
    // MAIN PROCESS for 48 seconds — after git had already returned, so the
    // command budget could not save it. A commit message is a thing a session
    // writes, and "our breakage never blocks a session" is a hard constraint.
    const body = `subject\n\nbody${' '.repeat(240_000)}\n`;
    const started = Date.now();
    const [c] = parseLog(record({ id: SHA_A, parents: SHA_B, body }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(c.message).toBe('subject\n\nbody');
  });

  it('a sha-shaped-but-not-hex id is refused', () => {
    const out = record({ id: 'z'.repeat(40), parents: SHA_B });
    expect(parseLog(out)).toEqual([]);
  });

  it('parses a run of six commits in order', () => {
    const out = [SHA_A, SHA_B, SHA_C, SHA_D, SHA_A, SHA_B]
      .map((id, i) => record({ id, parents: SHA_C, body: `commit ${i}\n` }, ` ${i + 1} files changed, 1 insertion(+)`))
      .join('');
    const commits = parseLog(out);
    expect(commits).toHaveLength(6);
    expect(commits.map((c) => c.stats?.files)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('parseShortstat', () => {
  it('reads all three numbers', () => {
    expect(parseShortstat(' 6 files changed, 1849 insertions(+), 15 deletions(-)')).toEqual({
      files: 6,
      insertions: 1849,
      deletions: 15,
    });
  });

  it('⚠️ the SINGULARS are what git actually writes for a one-line change', () => {
    // The most common commit there is. A regex that spelled these plural
    // matched nothing here — and `files?` / `insertions?` is the whole fix.
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({
      files: 1,
      insertions: 1,
      deletions: 0,
    });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({
      files: 1,
      insertions: 0,
      deletions: 1,
    });
  });

  it('⚠️ an ABSENT clause is zero — git leaves it out rather than writing 0', () => {
    expect(parseShortstat(' 2 files changed, 9 insertions(+)')).toEqual({
      files: 2,
      insertions: 9,
      deletions: 0,
    });
    expect(parseShortstat(' 2 files changed, 9 deletions(-)')).toEqual({
      files: 2,
      insertions: 0,
      deletions: 9,
    });
    // A mode-change-only commit: files changed, no lines either way.
    expect(parseShortstat(' 1 file changed')).toEqual({ files: 1, insertions: 0, deletions: 0 });
  });

  it('⚠️ is ANCHORED, so a commit body ending in the phrase is not read as a stat', () => {
    expect(parseShortstat('…and then 2 files changed, 1 insertion(+)')).toBeNull();
  });

  it('is null for anything else', () => {
    expect(parseShortstat('')).toBeNull();
    expect(parseShortstat(SHA_A)).toBeNull();
  });
});

describe('parseRefs — %D under --decorate=full', () => {
  it('⚠️ `HEAD -> refs/heads/main` is ONE entry naming two things', () => {
    expect(parseRefs('HEAD -> refs/heads/main')).toEqual([
      { kind: 'branch', name: 'main', full: 'refs/heads/main', isHead: true },
    ]);
  });

  it('tells a tag from a branch of the SAME NAME, which the short form cannot', () => {
    // The reason `--decorate=full` is in the command. Short decoration gives
    // `release` and `release` with nothing between them, and the History tab
    // draws the two as different chips.
    expect(parseRefs('refs/heads/release, tag: refs/tags/release')).toEqual([
      { kind: 'branch', name: 'release', full: 'refs/heads/release' },
      { kind: 'tag', name: 'release', full: 'refs/tags/release' },
    ]);
  });

  it('reads a remote-tracking ref as a remote, keeping the remote name', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD')).toEqual([
      { kind: 'branch', name: 'main', full: 'refs/heads/main', isHead: true },
      { kind: 'remote', name: 'origin/main', full: 'refs/remotes/origin/main' },
      { kind: 'remote', name: 'origin/HEAD', full: 'refs/remotes/origin/HEAD' },
    ]);
  });

  it('a DETACHED HEAD is a bare `HEAD` with no branch to point at', () => {
    expect(parseRefs('HEAD')).toEqual([{ kind: 'head', name: 'HEAD', full: 'HEAD', isHead: true }]);
  });

  it('an unrecognised namespace is shown, not dropped', () => {
    // Fail-open means saying what we found. A `refs/pull/*` a forge wrote is
    // still a true thing about this commit even though we have no chip for it.
    expect(parseRefs('refs/pull/1037/head')).toEqual([
      { kind: 'other', name: 'refs/pull/1037/head', full: 'refs/pull/1037/head' },
    ]);
  });

  it('empty and whitespace-only decoration mean no refs', () => {
    expect(parseRefs('')).toEqual([]);
    expect(parseRefs('   ')).toEqual([]);
  });
});

describe('logArgs', () => {
  it('names the subcommand itself — a caller that had to remember could forget', () => {
    // It was missing in the first version, and every service-level test that
    // read a real history came back empty with an `unreadable` nobody had
    // asked for. Cheap assertion, and it is the one that would have said why.
    expect(logArgs()[0]).toBe('log');
  });

  it('carries the measured command shape', () => {
    const args = logArgs();
    // `-z` is the framing and is the one flag whose absence silently corrupts
    // every record with a multi-line body.
    expect(args).toContain('-z');
    expect(args).toContain('--shortstat');
    // Without this a merge commit has no diff at all.
    expect(args).toContain('--diff-merges=first-parent');
    // `-- ` is always last, so the format cannot be read as a pathspec.
    // Without this a tag and a branch of the same name are indistinguishable.
    expect(args).toContain('--decorate=full');
    // Item 3's lane allocator is a topological walk and would have to re-sort.
    expect(args).toContain('--topo-order');
    expect(args).toContain('--format=%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B');
  });

  it('⚠️ carries --no-show-signature — a #776 flag, not a cosmetic one', () => {
    // MEASURED: repo-local `log.showSignature = true` plus `gpg.program = <any
    // path>` makes `git log` SPAWN THAT PROGRAM, once per signed commit, while
    // exiting 0 with stdout that parses perfectly. Both keys are inside #776's
    // threat model, a `gpgsig` header needs no real gpg to forge, and neither
    // existing guard closes it. If this assertion is ever deleted, the hole
    // reopens silently.
    expect(logArgs()).toContain('--no-show-signature');
    expect(logArgs({ stats: false })).toContain('--no-show-signature');
  });

  it('⚠️ carries --encoding=UTF-8, so the repo cannot re-frame the whole stream', () => {
    // MEASURED: repo-local `i18n.logOutputEncoding = UTF-16LE` puts a NUL after
    // every byte git writes, the parser then finds no record anywhere, and git
    // exits 0 — so the tab would say "no commits yet" about a thousand-commit
    // repository.
    expect(logArgs()).toContain('--encoding=UTF-8');
    expect(logArgs({ stats: false })).toContain('--encoding=UTF-8');
  });

  it('defaults to HEAD, and always closes the revs with `--`', () => {
    const args = logArgs();
    expect(args).toContain('HEAD');
    // `--` even with no pathspec: it stops a rev that happens to share a name
    // with a file in the tree from being called ambiguous and refused.
    expect(args[args.length - 1]).toBe('--');
  });

  it('clamps the limit, and a nonsense one falls back to the default', () => {
    expect(logArgs({ limit: 25 })).toContain('--max-count=25');
    expect(logArgs({ limit: 10_000_000 })).toContain(`--max-count=${MAX_LOG_LIMIT}`);
    expect(logArgs({ limit: 0 })).toContain(`--max-count=${DEFAULT_LOG_LIMIT}`);
    expect(logArgs({ limit: -5 })).toContain(`--max-count=${DEFAULT_LOG_LIMIT}`);
    expect(logArgs({ limit: Number.NaN })).toContain(`--max-count=${DEFAULT_LOG_LIMIT}`);
  });

  it('⚠️ drops the EXPENSIVE flags when a caller says it wants no stats', () => {
    // Measured: `--shortstat` is 1,331 ms of a 1,395 ms query over 100 commits
    // on this repository — ~13 ms per commit, because git diffs every listed
    // commit against its first parent. A surface that draws subjects and refs
    // should not pay a second and a half for numbers it will not show.
    const lean = logArgs({ stats: false });
    expect(lean).not.toContain('--shortstat');
    expect(lean).not.toContain('--diff-merges=first-parent');
    // Everything that is not a diff is still there — this is a cost switch, not
    // a different query.
    expect(lean).toContain('-z');
    expect(lean).toContain('--decorate=full');
    expect(lean).toContain('--topo-order');
  });

  it('the default is stats ON, because the History row shows the numbers', () => {
    expect(logArgs()).toContain('--shortstat');
    expect(logArgs({ stats: true })).toContain('--shortstat');
  });

  it('defaults to fifty commits — the number the measurement chose', () => {
    expect(DEFAULT_LOG_LIMIT).toBe(50);
    expect(logArgs()).toContain('--max-count=50');
  });

  it('pages with --skip, and omits it at zero', () => {
    expect(logArgs({ skip: 100 })).toContain('--skip=100');
    expect(logArgs({ skip: 0 }).some((a) => a.startsWith('--skip'))).toBe(false);
  });

  it('⚠️ a ref that could be read as a FLAG drops the whole list to HEAD', () => {
    // Argument injection, and the reason the list is dropped rather than
    // filtered: "show me these three branches" answered with two of them draws
    // a history with a branch missing and nothing saying so. One lane where
    // three were expected is wrong too, but it is VISIBLY wrong.
    expect(logArgs({ refs: ['main', '--all'] })).toContain('HEAD');
    expect(logArgs({ refs: ['main', '--all'] })).not.toContain('main');
    expect(logArgs({ refs: ['-n1'] })).toContain('HEAD');
  });

  it('⚠️ a ref containing `..` is refused — it would turn one rev into a RANGE', () => {
    expect(logArgs({ refs: ['main..origin/main'] })).toContain('HEAD');
    expect(logArgs({ refs: ['main..origin/main'] })).not.toContain('main..origin/main');
  });

  it('accepts the two spellings worth asking for', () => {
    expect(logArgs({ refs: ['origin/main'] })).toContain('origin/main');
    // `@{u}` is how item 2's incoming/outgoing rows name the upstream.
    expect(logArgs({ refs: ['@{u}'] })).toContain('@{u}');
  });

  it('puts a path AFTER the `--`, with --follow only when asked', () => {
    const args = logArgs({ path: 'src/main/git/git-log.ts', follow: true });
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('src/main/git/git-log.ts'));
    expect(args).toContain('--follow');
    // `--follow` without a path is meaningless and git rejects it.
    expect(logArgs({ follow: true })).not.toContain('--follow');
  });

  it('normalises a Windows path, because git only speaks forward slashes', () => {
    expect(logArgs({ path: 'src\\main\\git\\git-log.ts' })).toContain('src/main/git/git-log.ts');
  });

  it('⚠️ a path with `..` is REFUSED — `--` does not confine a pathspec', () => {
    // MEASURED: git resolves a pathspec against the cwd, so in a monorepo session
    // rooted at `<repo>/sub`, `-- ../secret.txt` lists commits touching a file
    // the session was never scoped to. `git:fileVersions` has guarded this since
    // it shipped; this channel did not until review said so.
    const args = logArgs({ path: '../secret.txt' });
    expect(args).not.toContain('../secret.txt');
    // The unfiltered history instead: a WIDER answer, never a wrong one.
    expect(args[args.length - 1]).toBe('--');
    expect(logArgs({ path: 'a/../../b.txt' })).not.toContain('a/../../b.txt');
    // `--follow` goes with it — git rejects it without a pathspec.
    expect(logArgs({ path: '../x', follow: true })).not.toContain('--follow');
  });

  it('⚠️ an ABSOLUTE path is refused, in both spellings Windows has', () => {
    expect(logArgs({ path: '/etc/passwd' })).not.toContain('/etc/passwd');
    expect(logArgs({ path: 'C:\\Users\\dheinz\\secret.txt' })).not.toContain('C:/Users/dheinz/secret.txt');
    expect(logArgs({ path: '//server/share/x' })).not.toContain('//server/share/x');
  });

  it('⚠️ PATHSPEC MAGIC is refused — `:(exclude)` is read as magic after the `--`', () => {
    // Measured. Wrong answers rather than a leak, but a caller could silently ask
    // a different question than the one it looks like.
    expect(logArgs({ path: ':(exclude)src/**' })).not.toContain(':(exclude)src/**');
    expect(logArgs({ path: ':!src' })).not.toContain(':!src');
  });

  it('⚠️ a vast `skip` is clamped, because `1e+21` is not a number git reads', () => {
    // Found in review: `Number.isFinite(1e21)` is true, and interpolating it
    // spells `--skip=1e+21`, which git refuses — surfacing as an unreadable
    // history for a query that was only silly.
    expect(logArgs({ skip: 1e21 }).join(' ')).not.toContain('e+');
    expect(logArgs({ skip: 1e21 }).some((a) => a.startsWith('--skip='))).toBe(true);
    expect(logArgs({ skip: -1 }).some((a) => a.startsWith('--skip'))).toBe(false);
    expect(logArgs({ skip: Number.NaN }).some((a) => a.startsWith('--skip'))).toBe(false);
  });
});

describe('isLogQuery', () => {
  it('accepts the shapes a caller sends', () => {
    expect(isLogQuery({})).toBe(true);
    expect(isLogQuery({ limit: 50, skip: 0 })).toBe(true);
    expect(isLogQuery({ refs: ['main', 'origin/main'] })).toBe(true);
    expect(isLogQuery({ path: 'a.txt', follow: true })).toBe(true);
    expect(isLogQuery({ stats: false })).toBe(true);
  });

  it('refuses a wrong TYPE, which is what would reach a flag', () => {
    expect(isLogQuery({ limit: '50' })).toBe(false);
    expect(isLogQuery({ skip: {} })).toBe(false);
    expect(isLogQuery({ path: 123 })).toBe(false);
    expect(isLogQuery({ refs: 'main' })).toBe(false);
    expect(isLogQuery({ refs: [1, 2] })).toBe(false);
    expect(isLogQuery({ stats: 'no' })).toBe(false);
    expect(isLogQuery(null)).toBe(false);
    expect(isLogQuery('main')).toBe(false);
    expect(isLogQuery(undefined)).toBe(false);
  });
});

describe('diffBaseFor', () => {
  it('is the first parent for an ordinary commit', () => {
    expect(diffBaseFor({ parentIds: [SHA_B, SHA_C] })).toBe(SHA_B);
  });

  it('⚠️ is the EMPTY TREE for a root commit — the case that fails silently', () => {
    // Get this wrong and the repository's first commit renders as "changed
    // nothing", with no error anywhere to say otherwise.
    expect(diffBaseFor({ parentIds: [] })).toBe(EMPTY_TREE);
  });
});
