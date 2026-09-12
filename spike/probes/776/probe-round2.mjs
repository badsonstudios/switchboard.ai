// #776 round 2 — the review claimed the fallback is not a blanket switch, that
// a HOOK needs no config at all, and that `GIT_CONFIG_COUNT` makes the precise
// guard total. Measure all three rather than believe any of them.
//
// Usage: node spike/probes/776/probe-round2.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpGlobal = path.join(os.tmpdir(), `sb-776r2-global-${process.pid}.gitconfig`);
fs.writeFileSync(tmpGlobal, '');
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: tmpGlobal, GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd, args, env = baseEnv) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: err.stdout ?? '', err: `(exit ${err.status}) ${(err.stderr ?? '').trim().split('\n')[0]}` };
  }
};
const posix = (p) => p.replace(/\\/g, '/');
const say = (label, verdict, extra = '') => console.log(`[776r2] ${label.padEnd(54)} ${verdict}${extra ? `  ${extra}` : ''}`);

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const STATUS = ['-c', 'core.quotePath=off', 'status', '--porcelain=v2', '--branch', '--untracked-files=all'];

let n = 0;
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-776r2-'));
  const marker = posix(path.join(dir, '..', `${path.basename(dir)}.ran`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'p@p.invalid']);
  git(dir, ['config', 'user.name', 'p']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return { dir, marker, n: ++n };
}
/** stat-dirty, content-clean: the state that forces a re-hash / index refresh */
function statDirty(dir) {
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello\n');
  const ahead = new Date(Date.now() + 20_000);
  fs.utimesSync(f, ahead, ahead);
}
function ran(marker) {
  const yes = fs.existsSync(marker);
  fs.rmSync(marker, { force: true });
  return yes;
}

console.log(`[776r2] ${git(process.cwd(), ['--version']).out.trim()} on ${process.platform}\n`);

// ============================================================ B1
// Does `--attr-source=<empty tree>` really suppress EVERY source of the
// `filter` attribute, as the shipped docstring claims?
console.log('--- B1. Where else a `filter` attribute can come from --------------');

for (const [label, place] of [
  ['.gitattributes (in the working tree)', (d) => fs.writeFileSync(path.join(d, '.gitattributes'), '* filter=ok\n')],
  ['.git/info/attributes', (d) => {
    fs.mkdirSync(path.join(d, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'info', 'attributes'), '* filter=ok\n');
  }],
  ['core.attributesFile -> a file in the repo', (d) => {
    fs.writeFileSync(path.join(d, 'my-attrs'), '* filter=ok\n');
    git(d, ['config', 'core.attributesFile', posix(path.join(d, 'my-attrs'))]);
  }],
]) {
  const { dir, marker } = repo();
  place(dir);
  git(dir, ['config', 'filter.ok.clean', `sh -c "touch '${marker}'; cat"`]);
  statDirty(dir);
  git(dir, [`--attr-source=${EMPTY_TREE}`, ...STATUS]);
  say(`--attr-source vs ${label}`, ran(marker) ? '*** RAN — NOT SUPPRESSED ***' : 'suppressed');
}

{
  // The bypass in full: one unsafe key forces the all-or-nothing fallback, and
  // the fallback does not cover `.git/info/attributes`.
  const { dir, marker } = repo();
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=ok\n');
  git(dir, ['config', 'filter.ok.clean', `sh -c "touch '${marker}'; cat"`]);
  git(dir, ['config', `filter.b=d.clean`, 'harmless']); // forces the fallback
  statDirty(dir);
  git(dir, [`--attr-source=${EMPTY_TREE}`, ...STATUS]);
  say('THE SHIPPED FALLBACK, end to end', ran(marker) ? '*** BYPASSED ***' : 'held');
  statDirty(dir);
  git(dir, ['-c', 'filter.ok.clean=', ...STATUS]);
  say('  same repo, precise override kept as well', ran(marker) ? '*** RAN ***' : 'held');
  statDirty(dir);
  git(dir, ['-c', 'filter.ok.clean=', '-c', `core.attributesFile=${posix(path.join(dir, 'no-such-file'))}`, ...STATUS]);
  say('  precise + core.attributesFile override', ran(marker) ? '*** RAN ***' : 'held');
}

// ============================================================ B2
console.log('\n--- B2. Hooks: no config file needed at all ------------------------');
const HOOKS = ['post-index-change', 'pre-auto-gc', 'reference-transaction', 'fsmonitor-watchman'];
for (const hook of HOOKS) {
  const { dir, marker } = repo();
  fs.writeFileSync(path.join(dir, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  statDirty(dir);
  git(dir, ['-c', 'core.fsmonitor=false', ...STATUS]);
  say(`.git/hooks/${hook} during status`, ran(marker) ? '*** RAN ***' : 'did not run');
}
{
  const { dir, marker } = repo();
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  statDirty(dir);
  git(dir, ['-c', 'core.fsmonitor=false', 'diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', 'HEAD']);
  say('.git/hooks/post-index-change during diff-index', ran(marker) ? '*** RAN ***' : 'did not run');

  // Candidate suppressions.
  statDirty(dir);
  git(dir, ['-c', 'core.fsmonitor=false', ...STATUS], { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' });
  say('  GIT_OPTIONAL_LOCKS=0', ran(marker) ? 'RAN' : 'suppressed');
  statDirty(dir);
  const nowhere = posix(path.join(dir, '..', 'no-such-hooks-dir'));
  git(dir, ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nowhere}`, ...STATUS]);
  say('  core.hooksPath=<absolute nonexistent>', ran(marker) ? 'RAN' : 'suppressed');

  // Does GIT_OPTIONAL_LOCKS=0 change what status REPORTS?
  const { dir: d2 } = repo();
  fs.writeFileSync(path.join(d2, 'b.txt'), 'new\n');
  fs.writeFileSync(path.join(d2, 'a.txt'), 'changed\n');
  git(d2, ['add', 'a.txt']);
  const withLocks = git(d2, STATUS).out;
  const without = git(d2, STATUS, { ...baseEnv, GIT_OPTIONAL_LOCKS: '0' }).out;
  say('  status output with vs without locks', withLocks === without ? 'byte-identical' : 'DIFFERENT');
}

// ============================================================ The better guard
console.log('\n--- C. GIT_CONFIG_COUNT: a key with `=` becomes expressible ---------');
{
  const { dir, marker } = repo();
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'attrs']);
  // The subsection name that defeats `-c`: it contains an `=`.
  const evil = `x.clean=touch '${marker}'`;
  git(dir, ['config', `filter.${evil}.clean`, 'harmless']);
  git(dir, ['config', 'filter.x.clean', `sh -c "touch '${marker}'; cat"`]);
  statDirty(dir);

  git(dir, STATUS);
  say('baseline, unguarded', ran(marker) ? 'RAN' : 'did not run');

  statDirty(dir);
  git(dir, ['-c', `filter.${evil}.clean=`, '-c', 'filter.x.clean=', ...STATUS]);
  say('naive -c on the `=` key (the self-inflicted one)', ran(marker) ? '*** RAN — mitigation became exploit ***' : 'held');

  statDirty(dir);
  git(dir, STATUS, {
    ...baseEnv,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `filter.${evil}.clean`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'filter.x.clean',
    GIT_CONFIG_VALUE_1: '',
  });
  say('GIT_CONFIG_KEY_n / VALUE_n', ran(marker) ? '*** RAN ***' : 'held');

  // Precedence: does it beat the repo-local config, like `-c` does?
  const { dir: d3, marker: m3 } = repo();
  fs.writeFileSync(path.join(d3, '.gitattributes'), '* filter=y\n');
  git(d3, ['add', '-A']);
  git(d3, ['commit', '-qm', 'attrs']);
  git(d3, ['config', 'filter.y.clean', `sh -c "touch '${m3}'; cat"`]);
  statDirty(d3);
  git(d3, STATUS, { ...baseEnv, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.y.clean', GIT_CONFIG_VALUE_0: '' });
  say('GIT_CONFIG_* beats repo-local config', ran(m3) ? '*** RAN ***' : 'held');
}

// ============================================================ S7
console.log('\n--- S7. A session folder that is not the repo root ------------------');
{
  const { dir } = repo();
  fs.mkdirSync(path.join(dir, 'sub-dir'));
  const r = git(path.join(dir, 'sub-dir'), ['rev-parse', '--show-toplevel']);
  say('rev-parse --show-toplevel from a subdirectory', r.ok ? 'answers the ROOT' : `failed ${r.err}`);
  const m = git(path.join(dir, 'sub-dir'), ['rev-parse', '--git-path', 'modules']);
  say('rev-parse --git-path modules from a subdirectory', m.ok ? m.out.trim() : `failed ${m.err}`);
}

fs.rmSync(tmpGlobal, { force: true });
