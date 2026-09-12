// #776 — what actually STOPS a repo's own config from running a command during
// our reads, and what does stopping it cost a legitimate repo?
//
// #772's probe (`spike/probes/772/probe-config-exec.mjs`) established the hole:
// `core.fsmonitor` and a clean filter BOTH execute during `diff-index` (the bus)
// and `status` (the git pane). It also established that `-c core.fsmonitor=false`
// closes the fsmonitor half. The clean-filter half had no known off switch.
//
// This probe answers four questions:
//   A. WHAT ELSE EXECUTES — `filter.<n>.process`, a smudge filter under
//      `git show HEAD:<path>` (what the Monaco diff pane calls), and whether the
//      `rev-parse` probe every call starts with runs fsmonitor too.
//   B. WHAT SWITCHES IT OFF — `-c filter.<n>.clean=`, `--attr-source=<empty>`,
//      `GIT_ATTR_SOURCE`.
//   C. WHAT IT COSTS — with the filter off, does an ordinary repo still read
//      correctly? Does a `required = true` filter (what git-lfs sets) turn a
//      read into a hard failure?
//   D. CAN WE TELL WHO WROTE IT — does `git config --show-scope` separate a
//      filter defined in `.git/config` from one defined globally (where
//      `git lfs install` puts it), through `include.path` and
//      `.git/config.worktree` too?
//
// Usage: node spike/probes/776/probe-filter-mitigations.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpGlobal = path.join(os.tmpdir(), `sb-776-global-${process.pid}.gitconfig`);
fs.writeFileSync(tmpGlobal, '');
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: tmpGlobal, GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd, args, env = baseEnv) => {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err) {
    return { ok: false, out: err.stdout ?? '', err: `(exit ${err.status}) ${(err.stderr ?? '').trim()}` };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = (p) => p.replace(/\\/g, '/');
const say = (label, verdict, extra = '') =>
  console.log(`[776] ${label.padEnd(52)} ${verdict}${extra ? `  ${extra}` : ''}`);

/**
 * A repo with one committed file, plus whatever `configure` adds. Returns the
 * repo path and the marker path the configured command touches when it runs.
 */
function makeRepo(tag) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sb-776-${tag}-`));
  const marker = posix(path.join(repo, '..', `${path.basename(repo)}.ran`));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.invalid']);
  git(repo, ['config', 'user.name', 'probe 776']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  return { repo, marker };
}

function cleanup(repo, marker) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
}

/** Make `a.txt` stat-dirty but content-clean: the state that forces a re-hash. */
async function touchWithoutChanging(repo) {
  await sleep(1200);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
}

const DIFF_INDEX = ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', 'HEAD'];
const STATUS = ['-c', 'core.quotePath=off', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'];

const attrs = (repo, line) => {
  fs.writeFileSync(path.join(repo, '.gitattributes'), line);
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attributes']);
};

// ---------------------------------------------------------------- A: vectors

async function ranIt(label, configure, command, { env = baseEnv, tag = 'v' } = {}) {
  const { repo, marker } = makeRepo(tag);
  configure(repo, marker);
  await touchWithoutChanging(repo);
  const r = git(repo, command, typeof env === 'function' ? env(marker) : env);
  const ran = fs.existsSync(marker);
  say(label, ran ? 'RAN the repo-configured command' : 'did not run it', r.ok ? '' : `[git failed: ${r.err}]`);
  cleanup(repo, marker);
  return ran;
}

const fsmonitor = (repo, marker) => git(repo, ['config', 'core.fsmonitor', `touch '${marker}'; false`]);
const cleanFilter = (repo, marker) => {
  attrs(repo, 'a.txt filter=probe\n');
  git(repo, ['config', 'filter.probe.clean', `sh -c "touch '${marker}'; cat"`]);
};
const processFilter = (repo, marker) => {
  attrs(repo, 'a.txt filter=probe\n');
  // A `process` filter speaks a packet protocol; it will fail the handshake.
  // We only care whether git STARTED it.
  git(repo, ['config', 'filter.probe.process', `sh -c "touch '${marker}'; exit 1"`]);
};
const smudgeFilter = (repo, marker) => {
  attrs(repo, 'a.txt filter=probe\n');
  git(repo, ['config', 'filter.probe.smudge', `sh -c "touch '${marker}'; cat"`]);
};

console.log(`[776] ${git(process.cwd(), ['--version']).out.trim()} on ${process.platform}`);
console.log('\n--- A. What executes during our reads -------------------------------');
await ranIt('core.fsmonitor  + rev-parse --is-inside-work-tree', fsmonitor, ['rev-parse', '--is-inside-work-tree']);
await ranIt('core.fsmonitor  + diff-index (bus)', fsmonitor, DIFF_INDEX);
await ranIt('core.fsmonitor  + status (git pane)', fsmonitor, STATUS);
await ranIt('clean filter    + diff-index (bus)', cleanFilter, DIFF_INDEX);
await ranIt('clean filter    + status (git pane)', cleanFilter, STATUS);
await ranIt('process filter  + diff-index (bus)', processFilter, DIFF_INDEX);
await ranIt('process filter  + status (git pane)', processFilter, STATUS);
await ranIt('smudge filter   + show HEAD:a.txt (Monaco pane)', smudgeFilter, ['show', 'HEAD:a.txt']);
await ranIt('clean filter    + show HEAD:a.txt (Monaco pane)', cleanFilter, ['show', 'HEAD:a.txt']);

// ------------------------------------------------------------ B: off switches

console.log('\n--- B. Candidate off switches ---------------------------------------');
await ranIt('fsmonitor       + diff-index  -c core.fsmonitor=false', fsmonitor, [
  '-c',
  'core.fsmonitor=false',
  ...DIFF_INDEX,
]);
await ranIt('fsmonitor       + status      -c core.fsmonitor=false', fsmonitor, [
  '-c',
  'core.fsmonitor=false',
  ...STATUS,
]);
await ranIt('clean filter    + diff-index  -c filter.probe.clean=', cleanFilter, [
  '-c',
  'filter.probe.clean=',
  ...DIFF_INDEX,
]);
await ranIt('clean filter    + status      -c filter.probe.clean=', cleanFilter, [
  '-c',
  'filter.probe.clean=',
  ...STATUS,
]);
await ranIt('process filter  + status      -c filter.probe.process=', processFilter, [
  '-c',
  'filter.probe.process=',
  ...STATUS,
]);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
await ranIt(`clean filter    + diff-index  --attr-source=<empty>`, cleanFilter, [
  `--attr-source=${EMPTY_TREE}`,
  ...DIFF_INDEX,
]);
await ranIt(`clean filter    + status      --attr-source=<empty>`, cleanFilter, [
  `--attr-source=${EMPTY_TREE}`,
  ...STATUS,
]);
await ranIt(`clean filter    + status      GIT_ATTR_SOURCE=<empty>`, cleanFilter, STATUS, {
  env: () => ({ ...baseEnv, GIT_ATTR_SOURCE: EMPTY_TREE }),
});

// ------------------------------------------------------------- C: what it costs

console.log('\n--- C. What switching it off costs ----------------------------------');

/**
 * The LFS shape, without LFS: the INDEX holds a short "pointer" and the working
 * tree holds the real content; the clean filter is what makes them agree. Turn
 * the filter off and git must report the file as modified — a wrong answer we
 * would be handing to the pane and to another agent.
 */
function lfsShapedRepo() {
  const { repo, marker } = makeRepo('lfs');
  attrs(repo, 'big.bin filter=fake\n');
  // clean: real content -> pointer. smudge: pointer -> real content.
  git(repo, ['config', 'filter.fake.clean', `sh -c "cat >/dev/null; echo POINTER"`]);
  git(repo, ['config', 'filter.fake.smudge', `sh -c "cat >/dev/null; echo REAL-CONTENT-XXXXXXXX"`]);
  fs.writeFileSync(path.join(repo, 'big.bin'), 'REAL-CONTENT-XXXXXXXX\n');
  git(repo, ['add', 'big.bin']);
  git(repo, ['commit', '-qm', 'add big']);
  return { repo, marker };
}

{
  const { repo, marker } = lfsShapedRepo();
  const withFilter = git(repo, STATUS);
  const withoutFilter = git(repo, ['-c', 'filter.fake.clean=', ...STATUS]);
  const attrSource = git(repo, [`--attr-source=${EMPTY_TREE}`, ...STATUS]);
  const dirty = (r) => (r.out.split('\n').some((l) => l.startsWith('1 ') || l.startsWith('2 ')) ? 'MODIFIED (wrong)' : 'clean (right)');
  say('LFS-shaped repo, filter on            ', dirty(withFilter));
  say('LFS-shaped repo, -c filter.fake.clean=', dirty(withoutFilter), withoutFilter.ok ? '' : `[${withoutFilter.err}]`);
  say('LFS-shaped repo, --attr-source=<empty>', dirty(attrSource), attrSource.ok ? '' : `[${attrSource.err}]`);
  cleanup(repo, marker);
}

{
  // git-lfs sets `filter.lfs.required = true`. Does neutralising a REQUIRED
  // filter turn our read into a hard failure?
  const { repo, marker } = lfsShapedRepo();
  git(repo, ['config', 'filter.fake.required', 'true']);
  const r = git(repo, ['-c', 'filter.fake.clean=', ...STATUS]);
  say('required=true, -c filter.fake.clean=  ', r.ok ? 'git SUCCEEDED' : 'git FAILED', r.ok ? '' : `[${r.err}]`);
  const r2 = git(repo, [`--attr-source=${EMPTY_TREE}`, ...STATUS]);
  say('required=true, --attr-source=<empty>  ', r2.ok ? 'git SUCCEEDED' : 'git FAILED', r2.ok ? '' : `[${r2.err}]`);
  cleanup(repo, marker);
}

{
  // The everyday cost of `core.fsmonitor=false` on a repo that has no fsmonitor:
  // it should be exactly nothing.
  const { repo, marker } = makeRepo('plain');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  const a = git(repo, STATUS);
  const b = git(repo, ['-c', 'core.fsmonitor=false', ...STATUS]);
  say('plain repo, status vs -c core.fsmonitor=false', a.out === b.out ? 'byte-identical' : 'DIFFERENT');
  cleanup(repo, marker);
}

// --------------------------------------------------- D: can we tell who wrote it

console.log('\n--- D. Telling a repo-local filter from a global one ----------------');

function scopedFilters(repo, env) {
  // `-z --show-scope` emits TWO NUL-terminated fields per entry: the scope,
  // then `key\nvalue`. A value may contain newlines; it can never contain NUL,
  // so the record boundary cannot be forged by a hostile config.
  const r = git(repo, ['config', '--list', '--show-scope', '-z'], env);
  const fields = r.out.split('\0');
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    const rest = fields[i + 1];
    const nl = rest.indexOf('\n');
    const key = nl === -1 ? rest : rest.slice(0, nl);
    if (/^filter\./.test(key)) out.push(`${scope}:${key}`);
  }
  return out;
}

{
  fs.writeFileSync(tmpGlobal, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\trequired = true\n');
  const { repo, marker } = makeRepo('scope');
  git(repo, ['config', 'filter.evil.clean', 'sh -c "pwned"']);
  say('scopes seen (global lfs + local evil) ', scopedFilters(repo).join(' | '));

  // include.path pointing INSIDE the repo — an agent can write both files.
  fs.writeFileSync(path.join(repo, '.git', 'extra.cfg'), '[filter "sneaky"]\n\tclean = sh -c "pwned"\n');
  git(repo, ['config', 'include.path', 'extra.cfg']);
  say('after include.path -> .git/extra.cfg  ', scopedFilters(repo).join(' | '));

  // .git/config.worktree (needs extensions.worktreeConfig)
  git(repo, ['config', 'extensions.worktreeConfig', 'true']);
  git(repo, ['config', '--worktree', 'filter.wt.clean', 'sh -c "pwned"']);
  say('after --worktree filter.wt.clean      ', scopedFilters(repo).join(' | '));
  cleanup(repo, marker);
}

{
  // The shadowing case: the repo redefines the GLOBAL lfs driver. Neutralising
  // by name would kill LFS unless we put the global value back.
  fs.writeFileSync(tmpGlobal, `[filter "fake"]\n\tclean = sh -c "cat >/dev/null; echo POINTER"\n`);
  const { repo, marker } = makeRepo('shadow');
  attrs(repo, 'big.bin filter=fake\n');
  fs.writeFileSync(path.join(repo, 'big.bin'), 'REAL-CONTENT-XXXXXXXX\n');
  git(repo, ['add', 'big.bin']);
  git(repo, ['commit', '-qm', 'add big']);
  git(repo, ['config', 'filter.fake.clean', `sh -c "touch '${marker}'; echo POINTER"`]);
  await touchWithoutChanging(repo);
  fs.writeFileSync(path.join(repo, 'big.bin'), 'REAL-CONTENT-XXXXXXXX\n');

  const globalValue = git(repo, ['config', '--global', '--get', 'filter.fake.clean']).out.trim();
  const r = git(repo, ['-c', `filter.fake.clean=${globalValue}`, ...STATUS]);
  const ran = fs.existsSync(marker);
  const clean = !r.out.split('\n').some((l) => l.startsWith('1 ') || l.startsWith('2 '));
  say(
    'shadowed driver, -c <global value>    ',
    `${ran ? 'RAN local cmd' : 'local cmd blocked'}, status ${clean ? 'clean (right)' : 'MODIFIED (wrong)'}`
  );
  cleanup(repo, marker);
}

fs.rmSync(tmpGlobal, { force: true });
