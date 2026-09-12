// #776 round 3 — the review's claim that the round-2 remedy re-created the hole
// one layer down. Three claims to check, plus the cost of the fix it proposes.
//
// Usage: node spike/probes/776/probe-round3.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-776r3-'));
const tmpGlobal = path.join(root, 'g.cfg');
fs.writeFileSync(tmpGlobal, '[protocol "file"]\n\tallow = always\n');
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: tmpGlobal, GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, env = baseEnv) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: err.stdout ?? '', err: `(exit ${err.status}) ${(err.stderr ?? '').trim().split('\n')[0]}` };
  }
};
const posix = (p) => p.replace(/\\/g, '/');
const say = (l, v, x = '') => console.log(`[776r3] ${l.padEnd(52)} ${v}${x ? `  ${x}` : ''}`);
const MARKER = posix(path.join(root, 'RAN'));
const bump = (f, s) => {
  const t = new Date(Date.now() + s * 1000);
  fs.utimesSync(f, t, t);
};
const ran = () => {
  const y = fs.existsSync(MARKER);
  fs.rmSync(MARKER, { force: true });
  return y;
};

const EMPTY_HOOKS = fs.mkdtempSync(path.join(root, 'nohooks-'));
/** exactly what the service builds */
const GUARD_ARGS = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${posix(EMPTY_HOOKS)}`];
const guardEnv = (overrides) => {
  const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' };
  overrides.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(overrides.length);
  return env;
};
const STATUS = ['-c', 'core.quotePath=off', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'];
const DIFF = ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', 'HEAD'];

console.log(`[776r3] ${git(process.cwd(), ['--version']).out.trim()} on ${process.platform}\n`);

/** superproject `outer` with submodule `sub`, both committed */
function superproject(tag) {
  const inner = path.join(root, `inner-${tag}`);
  const outer = path.join(root, `outer-${tag}`);
  fs.mkdirSync(inner);
  fs.mkdirSync(outer);
  for (const d of [inner, outer]) {
    git(d, ['init', '-q', '-b', 'main']);
    git(d, ['config', 'user.email', 'p@p']);
    git(d, ['config', 'user.name', 'p']);
    git(d, ['config', 'commit.gpgsign', 'false']);
  }
  fs.writeFileSync(path.join(inner, '.gitattributes'), 's.txt filter=z\n');
  fs.writeFileSync(path.join(inner, 's.txt'), 'hello\n');
  git(inner, ['add', '-A']);
  git(inner, ['commit', '-qm', 'i']);
  fs.writeFileSync(path.join(outer, 'top.txt'), 'top\n');
  git(outer, ['add', '-A']);
  git(outer, ['commit', '-qm', 'i']);
  git(outer, ['submodule', 'add', '-q', posix(inner), 'sub']);
  git(outer, ['commit', '-qm', 'sub']);
  return outer;
}

// ============================================================ B1: --no-includes
console.log('--- B1. `git config --file X --list` and include.path ---------------');
{
  const outer = superproject('b1');
  const subCfg = path.join(outer, '.git', 'modules', 'sub', 'config');
  const hidden = path.join(outer, '.git', 'modules', 'sub', 'hidden.cfg');
  // Written BY git, not by hand: a config value containing `"` has to be
  // escaped in the file, and hand-writing it produced a command that could not
  // run — a probe that reported "held" for the wrong reason.
  git(outer, ['config', '--file', hidden, 'filter.z.clean', `sh -c "touch '${MARKER}'; cat"`]);
  git(outer, ['config', '--file', subCfg, 'include.path', 'hidden.cfg']);

  const noInc = git(outer, ['config', '--file', subCfg, '--list', '-z']).out;
  const withInc = git(outer, ['config', '--file', subCfg, '--list', '--includes', '-z']).out;
  say('enumeration sees the driver, as shipped', noInc.includes('filter.z.clean') ? 'yes' : '*** NO — HIDDEN ***');
  say('enumeration sees it with --includes', withInc.includes('filter.z.clean') ? 'yes' : 'no');

  // THE CONTROL. Without it, "held" cannot be told apart from "never fired".
  bump(path.join(outer, 'sub', 's.txt'), 25);
  git(outer, STATUS);
  say('CONTROL: unguarded status runs it?', ran() ? 'RAN' : '*** did not run — probe is inert ***');

  // What the shipped guard would then send: nothing, because it saw nothing.
  bump(path.join(outer, 'sub', 's.txt'), 30);
  git(outer, [...GUARD_ARGS, ...STATUS], guardEnv([]));
  say('guarded status with the driver hidden', ran() ? '*** RAN — BYPASS ***' : 'held');
  bump(path.join(outer, 'sub', 's.txt'), 40);
  git(outer, [...GUARD_ARGS, ...DIFF], guardEnv([]));
  say('guarded diff-index (the bus path)', ran() ? '*** RAN — BYPASS ***' : 'held');
  // And with the name known, the override does reach it.
  bump(path.join(outer, 'sub', 's.txt'), 50);
  git(outer, [...GUARD_ARGS, ...STATUS], guardEnv([['filter.z.clean', '']]));
  say('...once the name is known', ran() ? '*** RAN ***' : 'held');
}

// ============================================================ B2: redirected gitdir
console.log('\n--- B2. A submodule whose .git file points elsewhere ----------------');
{
  const outer = superproject('b2');
  // Move the submodule's git dir somewhere the by-name scan does not look.
  const moved = path.join(outer, 'tools', 'cache', 'gd');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(path.join(outer, '.git', 'modules', 'sub'), moved);
  const dotGit = path.join(outer, 'sub', '.git');
  fs.rmSync(dotGit, { force: true }); // it exists already, and on Windows is hidden
  fs.writeFileSync(dotGit, `gitdir: ${posix(path.relative(path.join(outer, 'sub'), moved))}\n`);
  git(outer, ['config', '--file', path.join(moved, 'config'), 'filter.z.clean', `sh -c "touch '${MARKER}'; cat"`]);

  bump(path.join(outer, 'sub', 's.txt'), 25);
  git(outer, STATUS);
  say('CONTROL: unguarded status runs it?', ran() ? 'RAN' : '*** did not run — probe is inert ***');

  const modulesDir = path.join(outer, '.git', 'modules');
  say('.git/modules still holds anything?', fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir).join(',') || '(empty)' : '(gone)');
  const scoped = git(outer, ['config', '--list', '--show-scope', '-z']).out;
  say('superproject --show-scope sees filter.z?', scoped.includes('filter.z.clean') ? 'yes' : '*** no ***');

  bump(path.join(outer, 'sub', 's.txt'), 30);
  git(outer, [...GUARD_ARGS, ...STATUS], guardEnv([]));
  say('guarded status, redirected gitdir', ran() ? '*** RAN — BYPASS ***' : 'held');
  bump(path.join(outer, 'sub', 's.txt'), 40);
  git(outer, [...GUARD_ARGS, ...DIFF], guardEnv([]));
  say('guarded diff-index, redirected gitdir', ran() ? '*** RAN — BYPASS ***' : 'held');

  // The proposed enumeration: gitlinks from the INDEX, then ask git per path.
  const stage = git(outer, ['ls-files', '--stage', '-z']).out;
  const links = stage
    .split('\0')
    .filter(Boolean)
    .filter((r) => r.startsWith('160000 '))
    .map((r) => r.split('\t')[1]);
  say('gitlinks from the index', links.join(',') || '(none)');
  for (const l of links) {
    const c = git(path.join(outer, l), ['config', '--list', '--show-scope', '--includes', '-z']);
    say(`  git -C ${l} config sees filter.z?`, c.ok && c.out.includes('filter.z.clean') ? 'YES' : 'no');
  }
  bump(path.join(outer, 'sub', 's.txt'), 50);
  git(outer, [...GUARD_ARGS, ...STATUS], guardEnv([['filter.z.clean', '']]));
  say('  ...guarded with that name', ran() ? '*** RAN ***' : 'held');
}

// ============================================================ S1: -c beats env
console.log('\n--- S1. Precedence: does GIT_CONFIG_* really win? -------------------');
{
  const outer = superproject('s1');
  git(path.join(outer, 'sub'), ['config', 'filter.z.clean', `sh -c "touch '${MARKER}'; cat"`]);
  bump(path.join(outer, 'sub', 's.txt'), 30);
  git(outer, [...GUARD_ARGS, ...STATUS], guardEnv([['filter.z.clean', '']]));
  say('env override alone', ran() ? '*** RAN ***' : 'held');

  bump(path.join(outer, 'sub', 's.txt'), 40);
  git(
    outer,
    ['-c', `filter.z.clean=sh -c "touch '${MARKER}'; cat"`, ...GUARD_ARGS, ...STATUS],
    guardEnv([['filter.z.clean', '']])
  );
  say('env override vs a -c on the same key', ran() ? '*** -c WINS — env is not top ***' : 'env wins');

  const withParams = { ...guardEnv([['filter.z.clean', '']]) };
  withParams.GIT_CONFIG_PARAMETERS = `'filter.z.clean=sh -c "touch ${MARKER}; cat"'`;
  bump(path.join(outer, 'sub', 's.txt'), 50);
  git(outer, [...GUARD_ARGS, ...STATUS], withParams);
  say('env override vs GIT_CONFIG_PARAMETERS', ran() ? '*** PARAMETERS WINS ***' : 'env wins');
}

// ============================================================ cost
console.log('\n--- Cost of asking git per submodule --------------------------------');
{
  const here = process.cwd();
  const t = (label, args, n = 15) => {
    const s = Date.now();
    for (let i = 0; i < n; i++) git(here, args);
    say(label, `${((Date.now() - s) / n).toFixed(1)} ms`);
  };
  t('git ls-files --stage -z (this repo)', ['ls-files', '--stage', '-z']);
  t('git config --list --show-scope --includes -z', ['config', '--list', '--show-scope', '--includes', '-z']);
  say('ls-files --stage output size', `${(git(here, ['ls-files', '--stage', '-z']).out.length / 1024).toFixed(0)} KB`);
}

// ============================================================ S7
console.log('\n--- S7. Does `config --worktree --list` really fail? ----------------');
{
  const outer = superproject('s7');
  const r = git(outer, ['config', '--worktree', '--list', '-z']);
  say('--worktree --list without the extension', r.ok ? `exit 0, ${r.out.split('\0').filter(Boolean).length} entries` : `FAILS ${r.err}`);
}

console.log(`\n[776r3] scratch left at ${root}`);
