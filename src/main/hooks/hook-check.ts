// P1-E2-05 done-when check (local only — needs a logged-in claude CLI):
// the INTEGRATED product path — SessionManager.create() with hook settings
// injected via settingsFor, spawning a real interactive claude through the
// real PtyService — flips status from hook events alone; invalid listener
// requests are rejected; and a user kill() lands as done, not crashed.
// Run: npm run check:hooks
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { HookListener } from './hook-listener';
import { SessionManager } from '../sessions/session-manager';
import { ContributionRegistry } from '../extensibility/registry';
import { claudeAdapter } from '../providers/claude';
import { PtyService } from '../pty/pty-service';
import { LogSink, createLogger } from '../log/logger';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hook-check-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hook-check-work-'));

// stripping ANSI control sequences requires control chars in the regexes
/* eslint-disable no-control-regex */
const strip = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
/* eslint-enable no-control-regex */

async function main(): Promise<number> {
  const sink = new LogSink({ dir: stateDir });
  const registry = new ContributionRegistry();
  registry.register('provider-adapter', claudeAdapter);
  const ptys = new PtyService();
  const manager = new SessionManager(registry, ptys, createLogger(sink, 'sessions'), stateDir);
  const listener = new HookListener({ stateDir, manager, log: createLogger(sink, 'hooks') });
  const port = await listener.start();

  // §5.29 negative tests
  const noToken = await rawPost(port, '{}', {});
  const badHost = await rawPost(port, '{}', { host: 'evil.example' });
  console.log(`[hook-check] no-token=${noToken} bad-host=${badHost}`);

  // THE integrated path: create() wires hook settings itself
  const record = manager.create(
    { title: 'hook-check', folder: workDir, providerId: 'claude-code' },
    { settingsFor: (id) => listener.buildHookSettings(id) }
  );
  console.log(`[hook-check] session ${record.id} spawned interactively (pid ${record.pid})`);

  const pty = ptys.get(record.id)!;
  let screen = '';
  pty.onData((d) => (screen += strip(d)));

  // trust dialog (fresh temp folder) then composer-ready; text and Enter must
  // be separate writes (paste detection — S-03 driver lesson)
  await waitFor(() => /(Do\s*you\s*trust|trust\s*this\s*folder|Accessing\s*workspace|\?\s*for\s*shortcuts)/i.test(screen), 60000, 'startup');
  if (/(trust|Accessing)/i.test(screen) && !/\?\s*for\s*shortcuts/i.test(screen)) {
    pty.write('\r');
    await waitFor(() => /\?\s*for\s*shortcuts/i.test(screen), 30000, 'ready-after-trust');
  }
  await sleep(1500);
  pty.write('Reply with exactly: OK');
  await sleep(900);
  pty.write('\r');

  // hook-driven flips: working (UserPromptSubmit) then done (Stop)
  await waitFor(() => manager.get(record.id)!.status === 'working', 30000, 'status=working');
  console.log('[hook-check] status=working (hook-driven)');
  await waitFor(() => manager.get(record.id)!.status === 'done', 120000, 'status=done');
  console.log('[hook-check] status=done (hook-driven)');

  // user kill of a live session must not read as crashed
  const record2 = manager.create(
    { title: 'kill-check', folder: workDir, providerId: 'claude-code' },
    { settingsFor: (id) => listener.buildHookSettings(id) }
  );
  await sleep(5000); // let it reach the TUI
  manager.kill(record2.id);
  await waitFor(() => manager.get(record2.id)!.exitCode !== null, 20000, 'kill-exit');
  const killStatus = manager.get(record2.id)!.status;
  console.log(`[hook-check] killed session status=${killStatus} (exit ${manager.get(record2.id)!.exitCode})`);

  const t = manager.transitions(record.id);
  console.log(`[hook-check] transitions: ${t.map((x) => `${x.from}->${x.to} (${x.cause})`).join(', ')}`);
  const causes = t.map((x) => x.cause);
  const ok =
    noToken === 401 &&
    badHost === 403 &&
    causes.includes('hook:UserPromptSubmit') &&
    causes.includes('hook:Stop') &&
    manager.get(record.id)!.nativeSessionId !== undefined &&
    killStatus === 'done';
  console.log(ok ? '[hook-check] PASS' : '[hook-check] FAIL');
  manager.kill(record.id);
  ptys.killAll();
  listener.stop();
  return ok ? 0 : 1;
}

function rawPost(port: number, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(-1));
    req.end(body);
  });
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().then(
  (c) => setTimeout(() => process.exit(c), 500),
  (err) => {
    console.error('[hook-check] ERROR', err);
    process.exit(1);
  }
);
