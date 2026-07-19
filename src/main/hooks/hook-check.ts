// P1-E2-05 done-when check (local only — needs a logged-in claude CLI):
// session status flips from hook events ALONE through a real CLI run, and
// invalid requests are rejected. Run: npm run check:hooks
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { HookListener } from './hook-listener';
import { SessionManager, PtyLike } from '../sessions/session-manager';
import { ContributionRegistry } from '../extensibility/registry';
import { claudeAdapter, resolveCliPath } from '../providers/claude';
import { LogSink, createLogger } from '../log/logger';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hook-check-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hook-check-work-'));

// fake PTY: the real CLI runs via child_process below; the manager just needs
// a session record to route hook events into
const fakePty: PtyLike = {
  spawn: () => ({ pid: 0, onExit: () => () => {}, kill: () => {} }),
  remove: () => {},
};

async function main(): Promise<number> {
  const sink = new LogSink({ dir: stateDir });
  const registry = new ContributionRegistry();
  registry.register('provider-adapter', claudeAdapter);
  const manager = new SessionManager(registry, fakePty, createLogger(sink, 'sessions'), stateDir);
  const listener = new HookListener({
    stateDir,
    manager,
    log: createLogger(sink, 'hooks'),
  });
  const port = await listener.start();

  // negative tests first (§5.29 floor)
  const noToken = await rawPost(port, '{}', {});
  const badHost = await rawPost(port, '{}', { host: 'evil.example' });
  console.log(`[hook-check] no-token=${noToken} bad-host=${badHost}`);

  // create the session record and its injected hook settings
  const record = manager.create(
    { title: 'hook-check', folder: workDir, providerId: 'claude-code' },
    {}
  );
  const settings = listener.buildHookSettings(record.id);
  const settingsPath = path.join(stateDir, 'inject-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  // real CLI run with ONLY hook wiring — no transcript polling anywhere
  const cli = resolveCliPath()!;
  const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  console.log('[hook-check] running claude -p with injected hooks...');
  execFileSync(
    isCmd ? 'cmd.exe' : cli,
    [...(isCmd ? ['/c', cli] : []), '--settings', settingsPath, '-p', 'Reply with exactly: OK'],
    { cwd: workDir, encoding: 'utf8', timeout: 180000, env }
  );

  await sleep(1000); // let trailing hook posts land
  const t = manager.transitions(record.id);
  console.log(`[hook-check] transitions: ${t.map((x) => `${x.from}->${x.to} (${x.cause})`).join(', ')}`);
  const seq = t.map((x) => x.to);
  const ok =
    noToken === 401 &&
    badHost === 403 &&
    seq.includes('working') &&
    seq[seq.length - 1] === 'done' &&
    manager.get(record.id)!.nativeSessionId !== undefined;
  console.log(
    `[hook-check] final=${manager.get(record.id)!.status} nativeId=${manager.get(record.id)!.nativeSessionId}`
  );
  console.log(ok ? '[hook-check] PASS' : '[hook-check] FAIL');
  listener.stop();
  return ok ? 0 : 1;
}

function rawPost(port: number, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/hook', method: 'POST', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', () => resolve(-1));
    req.end(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().then(
  (c) => process.exit(c),
  (err) => {
    console.error('[hook-check] ERROR', err);
    process.exit(1);
  }
);
