// Q2b — THE END-TO-END ROUND TRIP. ⚠️ THE ONLY PROBE HERE THAT SPENDS A TURN.
//
// Everything else in this directory is free: `mcp_status` proves the CLI
// launched our server and listed its tools without a model ever running. What
// it CANNOT prove is that a real agent can actually invoke one and get the
// host's answer back — agent -> CLI -> our stdio server -> named pipe ->
// switchboard host -> back. That needs one real turn, so this file is the one
// the README marks, in the same spirit as 721's `probe-mcp-add-live.mjs`.
//
// TWO SAFETY DECISIONS, BOTH DELIBERATE:
//
//   1. **It runs in a fresh temp directory OUTSIDE the working tree.** It uses
//      `--permission-mode bypassPermissions`, and the honest way to make that
//      safe is to give the model nothing to reach — not to trust the prompt.
//      The first version put the scratch dir six levels INSIDE the repo, which
//      review correctly called out: a cwd is not a sandbox, and with the
//      approval gate removed the only thing between a misbehaving turn and
//      tracked source was a relative path.
//   2. **It does not guess the tool-name format.** The obvious move is
//      `--allowedTools mcp__sbbus__sb_probe_echo`, which would bake an
//      unverified naming convention into the probe AND hide it if wrong. So the
//      probe asks for nothing by name and REPORTS the name the CLI actually
//      used — turning the convention #764/#765 will need into a measurement.
//
//   node spike/probes/760/probe-toolcall.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHost } from './pipe-host.mjs';
import { artifact, pipePathFor, resolveCli } from './common.mjs';

const SERVER = path.join(import.meta.dirname, 'mcp-bus-server.mjs');
const artifactsDir = path.join(import.meta.dirname, 'artifacts');
// OUTSIDE the working tree — see the safety note in the header.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sb760-toolcall-'));

const pipePath = pipePathFor('toolcall');
const logPath = path.join(artifactsDir, 'server-toolcall.log');
try {
  fs.unlinkSync(logPath);
} catch {
  /* first run */
}

const SESSION_ID = 'sb-session-toolcall-760';
const configPath = path.join(artifactsDir, 'bus-config-toolcall.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: {
      sbbus: {
        type: 'stdio',
        command: process.execPath,
        args: [SERVER, '--session', SESSION_ID, '--pipe', pipePath],
        env: { SB_PROBE_SESSION: SESSION_ID, SB_PROBE_LOG: logPath },
      },
    },
  })
);

const host = await startHost(pipePath);
const findings = { pipePath, configPath, scratch, toolUses: [], toolResults: [], result: null };

const child = spawn(
  resolveCli(),
  [
    '-p',
    'Call the sb_probe_echo tool with the text "round trip 760". Then reply with the tool output verbatim and nothing else. Do not use any other tool.',
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
        console.log('TOOL_USE', b.name, JSON.stringify(b.input));
      }
      if (b.type === 'tool_result') {
        const t = JSON.stringify(b.content).slice(0, 600);
        findings.toolResults.push(t);
        console.log('TOOL_RESULT', t);
      }
    }
    if (m.type === 'result') {
      findings.result = { subtype: m.subtype, text: m.result, isError: m.is_error };
      console.log('\nRESULT:', m.subtype, '\n', String(m.result).slice(0, 800));
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
findings.serverLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

// The verdict rests on what the HOST saw, not on what the model said. A model
// can claim it called a tool; only the host's own record proves the bytes
// crossed the pipe.
const reached = host.seen.some((r) => String(r.text ?? '').includes('round trip 760'));
// ⚠️ NOT `toolUses[0]`. The first tool the agent reached for was the CLI's own
// `ToolSearch` — MCP tools are DEFERRED in 2.1.261 and have to be searched for
// by name before they can be called. Taking element 0 reported the tool name as
// "ToolSearch", which is both wrong and the kind of wrong that reads as right.
const ourCall = findings.toolUses.find((t) => t.name?.startsWith('mcp__')) ?? null;
findings.Q2b = {
  question: 'can a real agent call a bus tool and get the host answer back?',
  hostReceivedTheCall: reached,
  toolNameTheCliUsed: ourCall?.name ?? null,
  toolsTheAgentReachedForInOrder: findings.toolUses.map((t) => t.name),
  verdict: reached
    ? `YES — the host saw the call, and the CLI addressed the tool as "${ourCall?.name}"`
    : 'NO / UNPROVEN — the host never saw the text; see toolUses and serverLog',
};

console.log('\n\n########## Q2b ##########');
console.log(findings.Q2b.verdict);
console.log('host saw:', JSON.stringify(host.seen));
console.log('\nartifact:', artifact('toolcall.json', findings));
host.close();
process.exit(0);
