// Probe C (#1285 Q5, Q3-deny): resume probe B's conversation after its process
// exited, in FRESH codex-acp processes.
//
//   C1 (captures/c-resume.jsonl): session/list, session/resume  - no model turn
//   C2 (captures/c-load.jsonl):   session/load (replay), then TWO model turns:
//       T7 recall  - proves the model has the earlier context
//       T8 deny    - read-only mode, a shell write it must ask for; we REJECT
//
// Reads the session id probe B wrote to captures/b-session-id.txt.

import fs from 'node:fs';
import path from 'node:path';
import { RpcClient, ADAPTER, SANDBOX, CAPTURES, npxCmd, installExitGuard, codexProcesses, updateKinds } from './lib.mjs';

const clients = [];
installExitGuard(() => clients);
const sessionId = fs.readFileSync(path.join(CAPTURES, 'b-session-id.txt'), 'utf8').trim();
const INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'switchboard-probe-1285', version: '0.0.0' },
};
const deny2 = path.join(SANDBOX, 'probe2.txt');
fs.rmSync(deny2, { force: true });

function client(name) {
  const c = new RpcClient({
    name,
    cli: npxCmd(),
    args: ['-y', ADAPTER],
    cwd: SANDBOX,
    onRequest: (method, params, cl) => {
      if (method === 'session/request_permission') {
        const opt = params.options.find((o) => o.kind === 'reject_once') || params.options.find((o) => o.kind === 'reject_always');
        cl.note('permission request answered REJECT', { kinds: params.options.map((o) => o.kind), chose: opt?.optionId ?? null });
        return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
      }
      cl.note('agent->client request we do not implement', { method });
      return undefined;
    },
  });
  clients.push(c);
  return c.start();
}

async function turn(c, label, text) {
  c.note('PROMPT ' + label, { text });
  const i = c.frames.length;
  const t = Date.now();
  let result;
  try {
    result = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 150000);
  } catch (e) {
    c.notify('session/cancel', { sessionId });
    result = { error: String(e.message) };
  }
  const fr = c.frames.slice(i);
  const reply = fr.filter((f) => f.params?.update?.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content?.text ?? '').join('');
  c.note('TURN DONE ' + label, { ms: Date.now() - t, result, kinds: updateKinds(fr), reply: reply.slice(0, 500) });
  console.log(label + ': ' + JSON.stringify(result).slice(0, 200) + ' | reply=' + JSON.stringify(reply.slice(0, 300)) + ' | ' + JSON.stringify(updateKinds(fr)));
}

let turns = 0;
// ── C1: resume, no turn ──
{
  const c = client('c-resume');
  try {
    await c.request('initialize', INIT, 180000);
    const l = await c.request('session/list', {}, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
    c.note('session/list', { count: l.sessions?.length ?? null });
    const i = c.frames.length;
    const r = await c.request('session/resume', { sessionId, cwd: SANDBOX, mcpServers: [] }, 90000).catch((e) => ({ error: e.rpc ?? e.message }));
    await new Promise((res) => setTimeout(res, 1500));
    c.note('session/resume', { keys: Object.keys(r || {}), error: r.error ?? null, updatesAfter: updateKinds(c.frames.slice(i)) });
    console.log('resume keys', Object.keys(r || {}), 'updates', JSON.stringify(updateKinds(c.frames.slice(i))));
  } finally {
    await c.close();
  }
}
// ── C2: load (replay) + two turns ──
{
  const c = client('c-load');
  try {
    await c.request('initialize', INIT, 180000);
    const i = c.frames.length;
    const r = await c.request('session/load', { sessionId, cwd: SANDBOX, mcpServers: [] }, 90000).catch((e) => ({ error: e.rpc ?? e.message }));
    const replay = c.frames.slice(i);
    c.note('session/load', { keys: Object.keys(r || {}), error: r.error ?? null, replayKinds: updateKinds(replay) });
    console.log('load keys', Object.keys(r || {}), 'replay', JSON.stringify(updateKinds(replay)));
    const mode = (r.configOptions || []).find((o) => o.id === 'mode')?.currentValue;
    const model = (r.configOptions || []).find((o) => o.id === 'model')?.currentValue;
    const effort = (r.configOptions || []).find((o) => o.id === 'reasoning_effort')?.currentValue;
    c.note('state after load', { mode, model, effort, currentModelId: r.models?.currentModelId });
    console.log('after load: mode', mode, 'model', model, 'effort', effort, 'currentModelId', r.models?.currentModelId);
    // keep it cheap whatever load restored
    await c.request('session/set_model', { sessionId, modelId: 'gpt-6-luna[low]' }, 30000).catch(() => {});
    turns += 1;
    await turn(c, 'T7-recall', 'What single word, after the code word, did you reply with in your very first reply in this conversation? Answer with that word only.');
    await c.request('session/set_mode', { sessionId, modeId: 'read-only' }, 30000).catch(() => {});
    turns += 1;
    await turn(c, 'T8-deny', 'Run this exact shell command in the current folder: Set-Content -LiteralPath probe2.txt -Value hello . If the sandbox blocks it, request approval to run it. Do nothing else.');
    c.note('probe2.txt exists after REJECT', { exists: fs.existsSync(deny2) });
    console.log('probe2.txt exists after REJECT:', fs.existsSync(deny2));
  } finally {
    c.note('model turns sent', { turns });
    c.note('processes before close', { codex: codexProcesses() });
    await c.close();
    c.note('processes after close', { codex: codexProcesses() });
  }
}
console.log('turns', turns, 'codex processes at end:', codexProcesses());
