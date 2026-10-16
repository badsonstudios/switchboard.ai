// Probe A (#1285 Q1): spawn codex-acp through the npx `.cmd` shim, `initialize`,
// and the auth answer logged in vs logged out. NO model turns.
//
// Run 1 ("in"): the owner's real CODEX_HOME (~/.codex), logged in.
// Run 2 ("out"): CODEX_HOME pointed at an EMPTY temp dir, so the logged-out
//                answer is measured without touching the real login.
// Each run: initialize, then session/new (no prompt), then stdin EOF.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpcClient, ADAPTER, SANDBOX, npxCmd, installExitGuard, codexProcesses } from './lib.mjs';

const clients = [];
installExitGuard(() => clients);

const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'switchboard-probe-1285', version: '0.0.0' },
};

async function run(label, env) {
  const c = new RpcClient({ name: 'a-init-' + label, cli: npxCmd(), args: ['-y', ADAPTER], env, cwd: SANDBOX });
  clients.push(c);
  c.start();
  c.note('processes at start', { codex: codexProcesses() });
  try {
    const t = Date.now();
    const init = await c.request('initialize', INIT, 180000);
    c.note('initialize ms', { ms: Date.now() - t });
    console.log(label + ' initialize:', JSON.stringify(init).slice(0, 400));
    try {
      const t2 = Date.now();
      const sn = await c.request('session/new', { cwd: SANDBOX, mcpServers: [] }, 90000);
      c.note('session/new ms', { ms: Date.now() - t2 });
      console.log(label + ' session/new ok, sessionId=' + sn.sessionId);
    } catch (e) {
      console.log(label + ' session/new error:', JSON.stringify(e.rpc ?? e.message));
    }
  } finally {
    c.note('processes before close', { codex: codexProcesses() });
    await c.close();
    c.note('processes after close', { codex: codexProcesses() });
    console.log(label + ' firstStdout', JSON.stringify(c.firstStdout), 'firstStderr', JSON.stringify(c.firstStderr), 'nonJson lines', c.nonJson.length);
  }
}

const which = process.argv[2] || 'both';
if (which === 'in' || which === 'both') await run('in', {});
if (which === 'out' || which === 'both') {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-empty-'));
  console.log('empty CODEX_HOME = ' + empty);
  await run('out', { CODEX_HOME: empty });
  console.log('files the adapter left in the empty CODEX_HOME:', fs.readdirSync(empty));
  fs.rmSync(empty, { recursive: true, force: true });
}
console.log('codex processes at end:', codexProcesses());
