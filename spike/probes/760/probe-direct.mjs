// Q2a — does the pipe round-trip? NO CLI IN THE LOOP. Costs nothing.
//
// Drives `mcp-bus-server.mjs` over stdio ourselves, exactly as an MCP client
// would: initialize -> notifications/initialized -> tools/list -> tools/call.
// If this fails, nothing downstream is worth running, and the failure is ours
// rather than the CLI's — which is the whole reason it runs first.
//
//   node spike/probes/760/probe-direct.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startHost } from './pipe-host.mjs';
import { artifact, pipePathFor } from './common.mjs';

const SERVER = path.join(import.meta.dirname, 'mcp-bus-server.mjs');
const pipePath = pipePathFor('direct');
const findings = { pipePath, platform: process.platform, steps: [] };

const host = await startHost(pipePath);

const child = spawn(
  process.execPath,
  [SERVER, '--session', 'direct-probe-session', '--pipe', pipePath],
  { stdio: ['pipe', 'pipe', 'pipe'] }
);
const serverStderr = [];
child.stderr.on('data', (d) => serverStderr.push(d.toString()));

const pending = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

function record(step, result) {
  findings.steps.push({ step, result });
  console.log(`\n== ${step} ==`);
  console.log(JSON.stringify(result, null, 2).slice(0, 1200));
}

try {
  record(
    'initialize',
    (
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe-direct', version: '0' },
      })
    ).result
  );
  notify('notifications/initialized', {});

  record('tools/list', (await rpc('tools/list', {})).result);

  record(
    'tools/call sb_probe_local',
    (await rpc('tools/call', { name: 'sb_probe_local', arguments: {} })).result
  );

  record(
    'tools/call sb_probe_echo (THE PIPE)',
    (await rpc('tools/call', { name: 'sb_probe_echo', arguments: { text: 'hello from the agent' } }))
      .result
  );

  // The negative half. #762's done-when says a dead host must fail CLEANLY and
  // never hang — so prove the failure shape here, where it is cheap, instead of
  // discovering it in front of an agent. A probe that only ever exercises the
  // happy path cannot tell a working error path from an absent one.
  host.close();
  await new Promise((r) => setTimeout(r, 200));
  record(
    'tools/call sb_probe_echo AFTER KILLING THE HOST',
    (await rpc('tools/call', { name: 'sb_probe_echo', arguments: { text: 'nobody home' } })).result
  );

  findings.hostSaw = host.seen;
  findings.verdict = 'see steps';
} catch (err) {
  findings.error = String(err);
  console.error('\nFAILED:', err);
} finally {
  findings.serverStderr = serverStderr.join('');
  child.kill();
  try {
    host.close();
  } catch {
    /* already closed above on the happy path */
  }
  console.log('\nartifact:', artifact('direct.json', findings));
  process.exit(findings.error ? 1 : 0);
}
