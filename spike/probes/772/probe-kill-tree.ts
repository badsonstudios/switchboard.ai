// The #772 review's correction to `probe-kill.mjs`, run through the REAL
// `GitService` against the REAL Git for Windows launcher.
//
// `probe-kill.mjs` hung git on `hash-object --stdin`, and a git blocked on
// stdin EXITS BY ITSELF when its dead launcher's pipe closes — so "0
// survivors" there was true for the wrong reason. Here git is busy running an
// alias (`!sleep 8`), which reads nothing, so only a real tree kill ends it.
//
// Bundle and run from the repo root (Windows only):
//   npx esbuild spike/probes/772/probe-kill-tree.ts --bundle --platform=node \
//     --format=cjs --outfile=.claude/work_files/probe772-tree.cjs
//   node .claude/work_files/probe772-tree.cjs
import { execFileSync } from 'child_process';
import os from 'os';
import { GitService } from '../../../src/main/git/git-service';

const LAUNCHER = 'C:/Program Files/Git/cmd/git.exe';
const count = (marker: string): number =>
  Number(
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -ne 'powershell.exe' }).Count`,
      ],
      { encoding: 'utf8' }
    ).trim()
  );
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const marker = `sb772tree${process.pid}`;
  // `: "$@"` swallows the diff's own arguments, which git appends to the alias.
  const svc = new GitService({ file: LAUNCHER, prefixArgs: ['-c', `alias.${marker}=!sleep 8; :`, marker] });
  const settled = svc.diff(os.tmpdir(), 1500).then(
    () => 'resolved',
    (e: unknown) => String(e)
  );
  await sleep(800);
  const alive = count(marker);
  const outcome = await settled;
  await sleep(1000);
  const after = count(marker);
  console.log(`[772-tree] via ${LAUNCHER}: while running ${alive} process(es) with the marker; diff → ${outcome}; after the kill: ${after}`);
  console.log(`[772-tree] verdict: ${alive > 0 && after === 0 ? 'the tree kill ends the real git' : 'SOMETHING SURVIVED (or the positive control failed)'}`);
}

void main();
