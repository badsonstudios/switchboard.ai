// ⚠️ THIS PROBE'S CONCLUSION WAS WRONG — kept as the record of the trap.
// It reported "0 survivors" through the `cmd\git.exe` launcher, and that was
// true only because its git hangs ON STDIN: when the killed launcher's pipe
// closes, git reads EOF and exits by itself. A git busy on anything else
// survives `execFile`'s kill. `probe-kill-tree.ts` is the correction, and
// `spike/findings/e11-772-bus-cost.md` §5 has both tables. (#772 review)
//
// When `execFile`'s `timeout` kills git, is git actually GONE? (#772)
//
// On Windows `git` on PATH is one of two binaries: the real
// `mingw64\bin\git.exe`, or Git for Windows' `cmd\git.exe` LAUNCHER, which
// starts the real one as a child. Killing a launcher that does not take its
// child down with it would leave the real git running — a kill that frees our
// bookkeeping and none of the work. Which one a user gets depends on their PATH
// order, so both are measured.
//
// The subject is a git that hangs FOR EVER on purpose: `hash-object --stdin`
// with a stdin nobody writes to. A marker in its argv finds it afterwards.
//
// Usage: node spike/probes/772/probe-kill.mjs      (Windows only)
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

if (process.platform !== 'win32') {
  console.log('[772-kill] Windows only — posix has no launcher layer to ask about');
  process.exit(0);
}

const candidates = [
  'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  // The bare name, resolved the way `GitService` resolves it.
  'git',
].filter((p) => p === 'git' || fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function survivors(marker) {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`,
    ],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}

function killAll(marker) {
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ]);
}

for (const [i, bin] of candidates.entries()) {
  const marker = `sb772kill${process.pid}x${i}`;
  const t0 = performance.now();
  const settling = new Promise((resolve) => {
    execFile(bin, ['hash-object', '--stdin', `--path=${marker}`], { timeout: 2500, windowsHide: true }, (err) =>
      resolve({ ms: Math.round(performance.now() - t0), killed: err?.killed === true, signal: err?.signal ?? null })
    );
  });
  // THE POSITIVE CONTROL. A survivor count of zero means nothing unless the
  // same query sees the process while it is certainly alive — a query that
  // could never match would report "no survivors" for every binary.
  await sleep(1000);
  const alive = survivors(marker);
  const settled = await settling;
  await sleep(750);
  const left = survivors(marker);
  console.log(
    `[772-kill] ${bin.padEnd(44)} while hanging: ${alive} git.exe with the marker; ` +
      `callback after ${settled.ms}ms (killed=${settled.killed}, signal=${settled.signal}); still running after: ${left}`
  );
  if (left > 0) killAll(marker);
}
