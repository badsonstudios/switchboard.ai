// Does the bus's `git diff` WRITE the sibling's index — i.e. take
// `.git/index.lock` in a repo another agent is actively using? (#772)
//
// Why it matters twice over. (1) While our diff holds the lock, the sibling's
// own `git add` / `git commit` fails with "index.lock: File exists" — the bus
// reaching into another agent's work and breaking it. (2) #772 wants to be able
// to KILL a diff that runs away, and killing git while it holds the lock leaves
// the lock file behind, which breaks every later git command in that repo until
// a human deletes it.
//
// `git diff` refreshes the index "quietly" when it finds files whose stat info
// changed but whose content did not — exactly what an editor or formatter that
// rewrites a file in place produces. `GIT_OPTIONAL_LOCKS=0` is git's documented
// switch for background readers (it is what IDEs set for their status polls).
// Whether it covers `diff`'s refresh is the question; this measures it rather
// than trusting the documentation's list of commands.
//
// Usage: node spike/probes/772/probe-locks.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hermetic = { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args, env = hermetic) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const indexHash = (repo) =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trial(label, extraEnv, cmd = ['diff', '--no-textconv', '--no-ext-diff', 'HEAD']) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-772-locks-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.invalid']);
  git(repo, ['config', 'user.name', 'probe 772']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), `line ${i}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  // Past the racy-git window, so the index's own timestamps are not what makes
  // the entries look stale.
  await sleep(1500);
  // Rewrite ten files with IDENTICAL content: new mtime, same bytes. The
  // "stat-dirty, content-clean" state `git diff` refreshes. And one real edit,
  // so the diff has something to say.
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), `line ${i}\n`);
  fs.writeFileSync(path.join(repo, 'f19.txt'), 'changed\n');
  await sleep(50);

  const before = indexHash(repo);
  const out = git(repo, cmd, { ...hermetic, ...extraEnv });
  const after = indexHash(repo);
  const rewrote = before !== after;
  console.log(
    `[772-locks] ${label.padEnd(34)} diff ${out.length} chars; index ${rewrote ? 'REWRITTEN (the lock was taken)' : 'untouched (no lock)'}`
  );
  fs.rmSync(repo, { recursive: true, force: true });
  return { rewrote, out };
}

console.log(`[772-locks] ${git(process.cwd(), ['--version']).trim()} on ${process.platform}`);
// The SAME invocation `GitService.diff` made through #764.
const plain = await trial('porcelain diff, default env', {});
const optional = await trial('porcelain diff, GIT_OPTIONAL_LOCKS=0', { GIT_OPTIONAL_LOCKS: '0' });
// The plumbing equivalent. Plumbing never refreshes the index — that is the
// documented difference — so the question is whether its OUTPUT matches, since
// it sees the ten stat-dirty files as changed too.
const plumbing = await trial('plumbing diff-index -p', {}, ['diff-index', '-p', '--no-textconv', '--no-ext-diff', 'HEAD']);
console.log(
  `[772-locks] verdict: porcelain ${plain.rewrote ? 'WRITES' : 'does not write'} the index; ` +
    `GIT_OPTIONAL_LOCKS=0 ${optional.rewrote ? 'STILL WRITES it' : 'does not'}; ` +
    `diff-index ${plumbing.rewrote ? 'WRITES it' : 'does not'}, and its output ${plumbing.out === plain.out ? 'MATCHES' : 'DIFFERS'} byte for byte`
);
if (plumbing.out !== plain.out) {
  console.log('[772-locks] porcelain:\n' + plain.out);
  console.log('[772-locks] plumbing:\n' + plumbing.out);
}

// RENAMES. Porcelain `diff` detects them by default (`diff.renames`, on since
// git 2.9); plumbing does not unless told `-M`. A sibling that has staged a
// `git mv` would otherwise be reported as deleting one file and adding another.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-772-renames-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.invalid']);
  git(repo, ['config', 'user.name', 'probe 772']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'old-name.ts'), Array.from({ length: 30 }, (_, i) => `export const k${i} = ${i};`).join('\n') + '\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  git(repo, ['mv', 'old-name.ts', 'new-name.ts']);
  const porcelain = git(repo, ['diff', '--no-textconv', '--no-ext-diff', 'HEAD']);
  const bare = git(repo, ['diff-index', '-p', '--no-textconv', '--no-ext-diff', 'HEAD']);
  const withM = git(repo, ['diff-index', '-p', '-M', '--no-textconv', '--no-ext-diff', 'HEAD']);
  console.log(
    `[772-locks] staged rename: porcelain ${porcelain.length} chars (${/rename from/.test(porcelain) ? 'a rename' : 'delete + add'}); ` +
      `diff-index ${bare.length} (${/rename from/.test(bare) ? 'a rename' : 'delete + add'}); ` +
      `diff-index -M ${withM.length} (${/rename from/.test(withM) ? 'a rename' : 'delete + add'}), ` +
      `${withM === porcelain ? 'MATCHES' : 'DIFFERS FROM'} porcelain`
  );
  fs.rmSync(repo, { recursive: true, force: true });
}
