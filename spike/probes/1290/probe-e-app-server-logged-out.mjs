// Probe E (#1290): `codex app-server` LOGGED OUT, for the detection and the
// limits reader's fail-open path. ZERO model turns, zero tokens.
//
// CODEX_HOME points at an EMPTY temp dir, so the real login in ~/.codex is
// never touched (the same trick #1285's probe A used over ACP). Sends:
//   initialize + initialized, account/read, account/rateLimits/read
// then closes stdin and records whether the process exits on EOF.
// Then the same three calls LOGGED IN (the real ~/.codex), with timings, as the
// reader and detection will make them (still no model turn).
// Capture: captures/e-app-server-out.jsonl, captures/e-app-server-in.jsonl

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, installExitGuard, codexProcesses } from '../1285/lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPS = path.join(HERE, 'captures');
fs.mkdirSync(CAPS, { recursive: true });
const CODEX_CMD = path.join(process.env.APPDATA, 'npm', 'codex.cmd');
const clients = [];
installExitGuard(() => clients);

async function run(label, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1290-probe-cwd-'));
  const name = 'e-app-server-' + label;
  const c = new RpcClient({ name, cli: CODEX_CMD, args: ['app-server'], env, cwd, onRequest: () => ({ decision: 'decline' }) });
  // the 1285 lib writes into ITS captures folder; move this capture to ours
  const stray = c.capPath;
  c.capPath = path.join(CAPS, name + '.jsonl');
  fs.writeFileSync(c.capPath, '');
  fs.rmSync(stray, { force: true });
  clients.push(c);
  c.start();
  try {
    let t = Date.now();
    const init = await c.request('initialize', { clientInfo: { name: 'switchboard-probe-1290', version: '0.0.0', title: null }, capabilities: { experimentalApi: true } }, 60000);
    c.note('initialize ms', { ms: Date.now() - t });
    console.log(label, 'initialize', JSON.stringify(init).slice(0, 200));
    c.notify('initialized', undefined);
    t = Date.now();
    const acct = await c.request('account/read', { refreshToken: false }, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
    c.note('account/read ms', { ms: Date.now() - t });
    console.log(label, 'account/read', JSON.stringify(acct).slice(0, 300));
    t = Date.now();
    const rl = await c.request('account/rateLimits/read', undefined, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
    c.note('account/rateLimits/read ms', { ms: Date.now() - t });
    console.log(label, 'account/rateLimits/read', JSON.stringify(rl).slice(0, 400));
  } finally {
    c.note('processes before close', { codex: codexProcesses() });
    const t = Date.now();
    await c.close();
    c.note('close ms', { ms: Date.now() - t });
    c.note('processes after close', { codex: codexProcesses() });
    console.log(label, 'nonJson', c.nonJson.length, 'stderr bytes', c.stderr.length, 'codex at end', codexProcesses());
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-empty-1290-'));
await run('out', { CODEX_HOME: empty });
console.log('files left in the empty CODEX_HOME:', fs.readdirSync(empty));
fs.rmSync(empty, { recursive: true, force: true });
await run('in', {});
console.log('codex processes at end:', codexProcesses());
