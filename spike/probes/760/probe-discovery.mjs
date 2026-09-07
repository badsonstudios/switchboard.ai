// B1 — IS THE BUS DISCOVERABLE WITHOUT BEING NAMED? ⚠️ SPENDS ONE TURN.
//
// This probe exists because the first version of the findings note got this
// WRONG, and got it wrong in the most expensive direction: it concluded from
// `probe-toolcall.mjs` that "an agent that has never been told the bus exists
// will not stumble into `list_sessions`" — and shipped that to #764 and #765.
//
// The evidence did not support it. That probe's prompt NAMED the tool
// (`sb_probe_echo`), and the agent's first move was:
//
//     ToolSearch {"query":"select:mcp__sbbus__sb_probe_echo"}
//
// It produced the FULLY-QUALIFIED name — server included — before any search
// result came back. That is evidence the NAMES were visible and only the
// SCHEMAS were deferred, which is close to the opposite of what was claimed. It
// cannot distinguish "read the name from a deferred-tool index" from "guessed
// the `mcp__<server>__<tool>` convention", and the actual experiment was never
// run.
//
// So run it: a prompt that names no tool, no server, and no convention, and see
// whether the agent finds the bus on its own.
//
//   node spike/probes/760/probe-discovery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from './pipe-host.mjs';
import { artifact, pipePathFor, resolveCli } from './common.mjs';

const SERVER = path.join(import.meta.dirname, 'mcp-bus-server.mjs');
const artifactsDir = path.join(import.meta.dirname, 'artifacts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb760-discovery-'));

const pipePath = pipePathFor('discovery');
const SESSION_ID = 'sb-session-discovery-760';
const configPath = path.join(artifactsDir, 'bus-config-discovery.json');

// A tool whose NAME and DESCRIPTION are about the thing the prompt asks for, so
// that a failure to find it is a failure of discovery and not of relevance.
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: {
      sbbus: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER, '--session', SESSION_ID, '--pipe', pipePath],
        env: { SB_PROBE_SESSION: SESSION_ID },
      },
    },
  })
);

const host = await startHost(pipePath);
const findings = { pipePath, scratch, toolUses: [], result: null };

const child = spawn(
  resolveCli(),
  [
    // Names no tool, no server, no `mcp__` convention. If the bus is reachable
    // at all, this is the question it exists to answer.
    '-p',
    'What other switchboard sessions are currently running, and what are they working on? Answer from whatever tools you have available.',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    configPath,
    '--permission-mode',
    'bypassPermissions',
  ],
  { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] }
);

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use') {
        findings.toolUses.push({ name: b.name, input: b.input });
        console.log('TOOL_USE', b.name, JSON.stringify(b.input).slice(0, 200));
      }
    }
    if (m.type === 'result') {
      findings.result = { subtype: m.subtype, text: m.result };
      console.log('\nRESULT:', String(m.result).slice(0, 600));
    }
  }
});
const stderr = [];
child.stderr.on('data', (d) => stderr.push(d.toString()));

await new Promise((resolve) => {
  child.on('exit', resolve);
  setTimeout(() => {
    child.kill();
    resolve();
  }, 180000);
});

findings.stderr = stderr.join('').slice(0, 2000);
findings.hostSaw = host.seen;

// The verdict rests on the HOST's record again — a model can describe sessions
// it invented, and the fixture list in `pipe-host.mjs` is exactly the kind of
// plausible content a model could hallucinate.
const calledOurs = findings.toolUses.find((t) => t.name?.startsWith('mcp__sbbus__')) ?? null;
findings.B1 = {
  question: 'does an agent find the bus when the prompt names no tool?',
  hostWasContacted: host.seen.length > 0,
  ourToolCalled: calledOurs?.name ?? null,
  toolsReachedForInOrder: findings.toolUses.map((t) => t.name),
  verdict: calledOurs
    ? 'DISCOVERABLE — the agent found and called a bus tool with nothing naming it'
    : 'NOT DISCOVERABLE FROM THIS PROMPT — no bus tool was called; see toolsReachedForInOrder',
};

console.log('\n\n########## B1 ##########');
console.log(findings.B1.verdict);
console.log('tools in order:', findings.B1.toolsReachedForInOrder.join(' -> ') || '(none)');
console.log('host saw:', JSON.stringify(host.seen));
console.log('\nartifact:', artifact('discovery.json', findings));
host.close();
process.exit(0);
