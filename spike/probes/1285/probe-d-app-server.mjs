// Probe D (#1285, the app-server comparison): ONLY for what ACP failed on —
// structured plan limits (5h / weekly). Spawns the PATH `codex.cmd app-server`
// (stdio JSON-RPC), and:
//   - initialize + initialized, account/read, account/rateLimits/read  (no model turn)
//   - thread/start + ONE turn/start "pong" on the cheapest model, to see which
//     usage / limit notifications the native protocol PUSHES per turn
// Capture: captures/d-app-server.jsonl

import path from 'node:path';
import { RpcClient, SANDBOX, installExitGuard, codexProcesses } from './lib.mjs';

const clients = [];
installExitGuard(() => clients);
const CODEX_CMD = path.join(process.env.APPDATA, 'npm', 'codex.cmd');

const c = new RpcClient({
  name: 'd-app-server',
  cli: CODEX_CMD,
  args: ['app-server'],
  cwd: SANDBOX,
  onRequest: (method, _params, cl) => {
    cl.note('server->client request (declining)', { method });
    return { decision: 'decline' };
  },
});
clients.push(c);
c.start();
let turns = 0;
try {
  const init = await c.request('initialize', { clientInfo: { name: 'switchboard-probe-1285', version: '0.0.0', title: null }, capabilities: { experimentalApi: true } }, 60000);
  console.log('initialize keys', Object.keys(init || {}), JSON.stringify(init).slice(0, 300));
  c.notify('initialized', undefined);
  const acct = await c.request('account/read', { refreshToken: false }, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
  console.log('account/read', JSON.stringify(acct).slice(0, 300));
  const rl = await c.request('account/rateLimits/read', undefined, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
  console.log('account/rateLimits/read', JSON.stringify(rl).slice(0, 1200));

  const th = await c.request('thread/start', { cwd: SANDBOX, model: 'gpt-6-luna' }, 60000);
  const threadId = th.thread.id;
  console.log('thread', threadId, 'model', th.model, 'effort', th.reasoningEffort);
  turns += 1;
  const done = c.waitFor((m) => m.method === 'turn/completed', 150000).catch(() => null);
  const ts = await c.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the single word pong.', text_elements: [] }], effort: 'low' }, 60000);
  console.log('turn/start', JSON.stringify(ts).slice(0, 200));
  const fin = await done;
  console.log('turn/completed', JSON.stringify(fin?.params ?? null).slice(0, 300));
  await new Promise((r) => setTimeout(r, 1500));
  const methods = {};
  for (const f of c.frames) if (f.method) methods[f.method] = (methods[f.method] || 0) + 1;
  console.log('notifications seen', JSON.stringify(methods));
  for (const f of c.frames.filter((x) => x.method === 'thread/tokenUsage/updated' || x.method === 'account/rateLimits/updated')) {
    console.log(f.method, JSON.stringify(f.params).slice(0, 700));
  }
  c.note('thread id (app-server)', { threadId });
} finally {
  c.note('model turns sent', { turns });
  c.note('processes before close', { codex: codexProcesses() });
  await c.close();
  c.note('processes after close', { codex: codexProcesses() });
  console.log('turns', turns, 'nonJson', c.nonJson.length, 'stderr bytes', c.stderr.length, 'codex at end', codexProcesses());
}
