// Probe B (#1285 Q2, Q3, Q4, Q6, Q7): one codex-acp process, one session in
// the sandbox with a stub MCP server attached through `session/new`
// `mcpServers`, switched to the cheapest model, then SIX tiny model turns:
//
//   T1 "pong"                          - every session/update variant, stopReason, usage
//   T2 instruction-file check          - which of AGENTS.md / CLAUDE.md it was given (no tools)
//   T3 call the stub's probe_echo tool - MCP tool-call shape + whether it asks
//   T4 write probe.txt, DENY           - session/request_permission payload, what a deny does
//   T5 write probe.txt, ALLOW once     - what an allow does
//   T6 long count, session/cancel      - cancel mid-turn
//
// plus `/status` (adapter-local, no model turn) for usage/limits text, and
// session/list before/after. Capture: captures/b-session.jsonl;
// the stub's own log: captures/b-mcp-stub.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { RpcClient, ADAPTER, SANDBOX, CAPTURES, HERE, NODE, npxCmd, installExitGuard, codexProcesses, updateKinds } from './lib.mjs';

const clients = [];
installExitGuard(() => clients);

const STUB_LOG = path.join(CAPTURES, 'b-mcp-stub.jsonl');
fs.writeFileSync(STUB_LOG, '');
const probeFile = path.join(SANDBOX, 'probe.txt');
fs.rmSync(probeFile, { force: true });

let decision = 'reject'; // what the next permission request gets
const permissionsSeen = [];

const c = new RpcClient({
  name: 'b-session',
  cli: npxCmd(),
  args: ['-y', ADAPTER],
  cwd: SANDBOX,
  onRequest: (method, params, cl) => {
    if (method === 'session/request_permission') {
      permissionsSeen.push(params);
      const kinds = (params.options || []).map((o) => o.kind);
      const want = decision === 'reject' ? ['reject_once', 'reject_always'] : ['allow_once', 'allow_always'];
      const opt = want.map((k) => params.options.find((o) => o.kind === k)).find(Boolean);
      cl.note('permission request answered', { decision, kinds, chose: opt?.optionId ?? null });
      if (!opt) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    }
    cl.note('agent->client request we do not implement', { method });
    return undefined; // -32601
  },
});
clients.push(c);
c.start();

let sessionId;
let turns = 0;
async function prompt(label, text, { timeoutMs = 150000, cancelOnFirstChunk = false } = {}) {
  turns += 1;
  c.note('PROMPT ' + label, { text });
  const startIdx = c.frames.length;
  let cancelSent = false;
  let watcher;
  if (cancelOnFirstChunk) {
    watcher = c
      .waitFor((m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk', timeoutMs)
      .then(() => {
        cancelSent = true;
        c.notify('session/cancel', { sessionId });
      })
      .catch(() => {});
  }
  const t = Date.now();
  let result;
  try {
    result = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs);
  } catch (e) {
    c.note('prompt failed/timeout; sending session/cancel', { label, err: String(e.message) });
    c.notify('session/cancel', { sessionId });
    result = { error: String(e.message), rpc: e.rpc };
  }
  await watcher;
  const frames = c.frames.slice(startIdx);
  const text_ = frames
    .filter((f) => f.method === 'session/update' && f.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map((f) => f.params.update.content?.text ?? '')
    .join('');
  c.note('TURN DONE ' + label, { ms: Date.now() - t, result, kinds: updateKinds(frames), reply: text_.slice(0, 400), cancelSent });
  console.log(label + ': ' + JSON.stringify(result).slice(0, 300) + ' | reply=' + JSON.stringify(text_.slice(0, 200)) + ' | ' + JSON.stringify(updateKinds(frames)));
  return { result, text: text_ };
}

try {
  await c.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'switchboard-probe-1285', version: '0.0.0' },
  }, 180000);

  const before = await c.request('session/list', {}, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
  c.note('session/list BEFORE', { count: before.sessions?.length ?? null });

  const sn = await c.request('session/new', {
    cwd: SANDBOX,
    mcpServers: [
      {
        name: 'probe-stub',
        command: NODE,
        args: [path.join(HERE, 'mcp-stub.mjs')],
        env: [
          { name: 'STUB_LOG', value: STUB_LOG },
          { name: 'PROBE_STUB_MARK', value: '1285' },
        ],
      },
    ],
  }, 90000);
  sessionId = sn.sessionId;
  console.log('sessionId', sessionId);
  fs.writeFileSync(path.join(CAPTURES, 'b-session-id.txt'), sessionId + '\n');

  // Q4: switch model + effort, both spellings
  for (const [m, p] of [
    ['session/set_config_option', { sessionId, configId: 'model', value: 'gpt-6-luna' }],
    ['session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'low' }],
    ['session/set_model', { sessionId, modelId: 'gpt-6-luna[low]' }],
  ]) {
    const r = await c.request(m, p, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
    console.log(m + ' ' + JSON.stringify(p) + ' -> ' + JSON.stringify(r).slice(0, 300));
  }

  await prompt('T1-pong', 'Reply with the single word pong.');
  await prompt('T2-instructions', 'Do not use any tools and do not read any files. From the instructions you were given for this project alone: which code word, if any, are you told to begin your replies with, and which instruction file name did it come from? Answer in one line.');

  const st = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/status' }] }, 60000).catch((e) => ({ error: e.rpc ?? e.message }));
  c.note('/status result', { st });

  await prompt('T3-mcp', 'Call the probe_echo tool from the probe-stub MCP server with text "hi" and reply with only its result.');

  // Q3: force approvals. Read-only mode requires approval to edit files.
  const sm = await c.request('session/set_mode', { sessionId, modeId: 'read-only' }, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
  c.note('set_mode read-only', { sm });
  decision = 'reject';
  await prompt('T4-write-deny', 'Create a file named probe.txt containing the word hello in the current folder. Do nothing else.');
  c.note('probe.txt exists after DENY', { exists: fs.existsSync(probeFile) });
  decision = 'allow';
  await prompt('T5-write-allow', 'Try again: create a file named probe.txt containing the word hello in the current folder. Do nothing else.');
  c.note('probe.txt exists after ALLOW', { exists: fs.existsSync(probeFile), content: fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8') : null });

  await prompt('T6-cancel', 'Count from 1 to 300, one number per line, no other text.', { cancelOnFirstChunk: true });

  const after = await c.request('session/list', {}, 30000).catch((e) => ({ error: e.rpc ?? e.message }));
  c.note('session/list AFTER', { count: after.sessions?.length ?? null, sessions: after.sessions });
} finally {
  c.note('model turns sent', { turns });
  c.note('permissions seen', { count: permissionsSeen.length });
  c.note('processes before close', { codex: codexProcesses() });
  await c.close();
  c.note('processes after close', { codex: codexProcesses() });
  console.log('turns', turns, 'permissions', permissionsSeen.length, 'nonJson', c.nonJson.length, 'stderr bytes', c.stderr.length);
  console.log('codex processes at end:', codexProcesses());
}
