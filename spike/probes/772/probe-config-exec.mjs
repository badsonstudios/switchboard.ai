// Can a repository's OWN config make our diff run a command? (#772, side finding)
//
// #764 closed `diff.external` with `--no-ext-diff`. Two other repo-config
// knobs execute commands during an ordinary read of the working tree, and the
// bus points `git` at a folder ANOTHER AGENT controls — an agent that may be
// allowed to edit files but not to run them:
//
//   - `core.fsmonitor` — a hook git runs to ask which files changed.
//   - a CLEAN filter (`.gitattributes` `filter=x` + `filter.x.clean`), run
//     when git must hash a working-tree file to compare it with the index.
//
// Each trial writes a marker file if the command ran. Measured against both the
// plumbing `diff-index` the bus now uses and the `status` the git pane uses.
//
// Usage: node spike/probes/772/probe-config-exec.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hermetic = { ...process.env, GIT_CONFIG_GLOBAL: '', GIT_CONFIG_SYSTEM: '', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, env: hermetic, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return `(exit ${err.status}) ${err.stderr ?? ''}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = (p) => p.replace(/\\/g, '/');

async function trial(label, configure, command) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-772-exec-'));
  const marker = path.join(repo, '..', `${path.basename(repo)}.ran`);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'probe@example.invalid']);
  git(repo, ['config', 'user.name', 'probe 772']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'initial']);
  configure(repo, posix(marker));
  await sleep(1500);
  // Stat-dirty, content-clean: the state that makes git re-hash the file.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  git(repo, command);
  const ran = fs.existsSync(marker);
  console.log(`[772-exec] ${label.padEnd(44)} ${ran ? 'RAN the repo-configured command' : 'did not run it'}`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
}

const fsmonitor = (repo, marker) => git(repo, ['config', 'core.fsmonitor', `touch '${marker}'; false`]);
const cleanFilter = (repo, marker) => {
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'a.txt filter=probe\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-qm', 'attributes']);
  git(repo, ['config', 'filter.probe.clean', `sh -c "touch '${marker}'; cat"`]);
};
const diffIndex = ['diff-index', '-p', '-M', '--no-color', '--no-textconv', '--no-ext-diff', 'HEAD'];

console.log(`[772-exec] ${git(process.cwd(), ['--version']).trim()} on ${process.platform}`);
await trial('core.fsmonitor   + diff-index (the bus)', fsmonitor, diffIndex);
await trial('core.fsmonitor   + status (the git pane)', fsmonitor, ['status', '--porcelain=v2']);
await trial('clean filter     + diff-index (the bus)', cleanFilter, diffIndex);
await trial('clean filter     + status (the git pane)', cleanFilter, ['status', '--porcelain=v2']);
await trial('core.fsmonitor   + diff-index -c core.fsmonitor=false', fsmonitor, ['-c', 'core.fsmonitor=false', ...diffIndex]);
