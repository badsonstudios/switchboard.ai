// P1-E2-06 done-when check (LOCAL ONLY — needs a logged-in claude CLI and
// SPENDS REAL SUBSCRIPTION TOKENS on the turn whose transcript it reads, so it
// can never run in CI; recorded in .github/workflows/ci.yml and enforced by
// src/main/check-scripts.test.ts — #182):
// TranscriptWatcher binds a REAL session's transcript (real slug rules, real
// schema) and live token totals appear. This is the check that would have
// caught the case-sensitive-slug binding bug. Run: npm run check:transcripts
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptWatcher } from './watcher';
import { LogSink, createLogger } from '../log/logger';
import { resolveCliPath } from '../providers/claude';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-check-'));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tw-check-log-'));
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

async function main(): Promise<number> {
  const watcher = new TranscriptWatcher({
    projectsRoot,
    log: createLogger(new LogSink({ dir: logDir }), 'transcripts'),
  });
  watcher.watch('check-1', { cwd: workDir });
  console.log(`[transcript-check] watching for a session in ${workDir}`);

  const cli = resolveCliPath()!;
  const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  execFileSync(
    isCmd ? 'cmd.exe' : cli,
    [...(isCmd ? ['/c', cli] : []), '-p', 'Reply with exactly: OK'],
    { cwd: workDir, encoding: 'utf8', timeout: 180000, env }
  );

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const s = watcher.snapshot('check-1')!;
    if (s.bound && s.usage.output > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const s = watcher.snapshot('check-1')!;
  console.log(
    `[transcript-check] bound=${s.bound} binding=${s.binding} native=${s.nativeSessionId} ` +
      `tokens(in/out/cacheRead)=${s.usage.input}/${s.usage.output}/${s.usage.cacheRead} ` +
      `lines=${s.lines} malformed=${s.malformed}`
  );
  // The §5.26 drift detector against a REAL transcript from the installed CLI —
  // the only check in the tree that can catch a release adding a field, since
  // every unit fixture is a shape we wrote ourselves. Reported, never fatal:
  // "the CLI grew a key" is news, not a broken build.
  if (s.driftKeys.length > 0) {
    console.log(
      `[transcript-check] SCHEMA DRIFT — ${s.driftKeys.length} unknown key(s) vs ` +
        `src/main/transcripts/schema.ts:\n  ${s.driftKeys.join('\n  ')}`
    );
  } else {
    console.log('[transcript-check] no schema drift against this CLI build');
  }
  const ok = s.bound && s.usage.output > 0 && s.lines > 0;
  console.log(ok ? '[transcript-check] PASS' : '[transcript-check] FAIL');
  watcher.stop();
  return ok ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (err) => {
    console.error('[transcript-check] ERROR', err);
    process.exit(1);
  }
);
